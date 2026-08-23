/**
 * `KimiFileExtractChannel` —— Kimi 的「**先上传再抽取**」文件通道(P4-6)。
 *
 * Kimi 的 chat-completions 接口**没有** `file` 内容块:文件走一条旁路
 * (platform.kimi.com/docs/guide/use-kimi-api-for-file-based-qa):
 *
 *  1. `POST /v1/files`,`multipart/form-data`,字段 `file` + `purpose=file-extract`;
 *  2. `GET /v1/files/{file_id}/content` → **纯文本**(`text/plain`),已经对齐成
 *     模型易读的格式;
 *  3. 把**文件内容**(官方原话:「请将文件内容放置在 prompt 中,而不是文件的
 *     `file_id`」)以一条 `role:'system'` 消息放进 messages;多文件 = 多条
 *     system,每个文件**单独一条**;
 *  4. `DELETE /v1/files/{file_id}` —— 单用户上限 1000 个文件 / 10G,官方的最佳
 *     实践就是抽完即删。我们不复用 file_id,所以取完文本立刻删。
 *
 * 限额(官方):单文件 ≤ 100MB、单用户 ≤ 1000 个、总量 ≤ 10G;文件解析服务
 * **限时免费**,高峰期可能限流。
 *
 * ## 纪律
 *
 * - **实例无状态**:去重表是 `prepare()` 的局部变量,活一个回合。
 * - **不改 `request.messages` 本体**:产出新数组走 `turn.replaceMessages()`。
 * - **失败不抛**:任何一步失败,那一块原样留在 user 消息里 —— codec 会把它落成
 *   可见的 `Undeliverable` 文本(模型知道有过这个附件,不会瞎编内容),同时记一条
 *   `attachment-extract-failed` warning。删除失败只 warn:那是配额的事,不是这
 *   一回合的事。
 * - **图不走这里**:`image/*` 归 codec 的 `image_url`(Kimi 的 Vision 收 data URL),
 *   通道一个字节都不上传。
 *
 * ## 今天不做的
 *
 * **跨回合缓存**。同一份 PDF 在多轮对话里每一轮都会重传重抽 —— 官方的「文件管理
 * 最佳实践」建议把抽取结果存在本地复用,但那需要一处**跨回合**的存储,而这一层
 * 的每个对象都是无状态的(设计稿 §3.1)。先正确再快:缓存是下一步,落点应该在
 * 装配层(会话级),不是这里。
 */
import type {
	AgentContentPart,
	AgentMessage,
	AgentMessageContent,
} from "@onething/core/agent-loop";
import type { AttachmentChannel, TurnContext, TurnTransport } from "../base/index.js";

/** 上传时的 `purpose` —— 内容抽取这一支(另外三个值是 image / video / batch)。 */
const FILE_EXTRACT_PURPOSE = "file-extract";

/**
 * 官方「支持的格式」表里**非图片**的那些(platform.kimi.com/docs/api/files-upload)。
 * 图片格式故意不列:它们归 codec 的 `image_url`。
 *
 * 判据是后缀而不是媒体类型,因为上游给的 `mediaType` 对源码类附件常常是
 * `text/plain` 或 `application/octet-stream` —— 后缀才是这张表的语言。媒体类型
 * 那一侧另有一条兜底(见 `EXTRACTABLE_MEDIA_TYPES` / `text/*`)。
 */
const EXTRACTABLE_EXTENSIONS = new Set([
	"pdf", "txt", "csv", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "md",
	"dot", "epub", "html", "json", "mobi", "log",
	"go", "h", "c", "cpp", "cxx", "cc", "cs", "java", "js", "css", "jsp",
	"php", "py", "py3", "asp", "yaml", "yml", "ini", "conf", "ts", "tsx",
]);

/** 后缀缺席时的兜底:这些媒体类型本身就说明了它是什么。 */
const EXTRACTABLE_MEDIA_TYPES = new Set([
	"application/pdf",
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/epub+zip",
	"application/json",
	"application/x-yaml",
]);

/** `{type:'file'}` 块上我们要读的那几个字段。 */
interface FilePartLike {
	readonly type: "file";
	readonly data: string;
	readonly mediaType: string;
	readonly filename?: string;
}

function isFilePart(part: AgentContentPart): part is AgentContentPart & FilePartLike {
	return part.type === "file";
}

function baseMediaType(mediaType: string | undefined): string {
	return (mediaType?.split(";")[0] ?? "").trim().toLowerCase();
}

function extensionOf(filename: string | undefined): string {
	if (!filename) return "";
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * base64 → 字节。`atob` 而不是 `Buffer`:这一层要能跟着 runtime 进浏览器构建,
 * 而 `atob` 在 Node 与浏览器里都是全局的。
 */
function base64ToBytes(base64: string): Uint8Array {
	// data URI 也认(上游偶尔递的是整条 URI 而不是裸载荷)。
	const payload = base64.startsWith("data:")
		? (base64.split(",")[1] ?? "")
		: base64;
	const binary = atob(payload);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

/** 上传那一跳是 multipart —— `Content-Type` 必须让 fetch 自己带 boundary。 */
function withoutContentType(
	headers: Record<string, string>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === "content-type") continue;
		result[key] = value;
	}
	return result;
}

interface UploadedFile {
	readonly id: string;
}

export class KimiFileExtractChannel implements AttachmentChannel {
	/**
	 * 归这条通道管的块:**非图片**的文件块,且格式在官方那张表上。
	 *
	 * 表外的格式(.zip 一类)不上传 —— 传上去也抽不出东西,只会白占配额。
	 * 它们留给 codec 落成 `Undeliverable` 可见文本,与这一期之前一模一样。
	 */
	handles(part: AgentContentPart): boolean {
		if (!isFilePart(part)) return false;
		const mediaType = baseMediaType(part.mediaType);
		if (mediaType.startsWith("image/")) return false;
		if (EXTRACTABLE_EXTENSIONS.has(extensionOf(part.filename))) return true;
		if (EXTRACTABLE_MEDIA_TYPES.has(mediaType)) return true;
		// 纯文本家族(text/markdown、text/x-python …)本来就抽得出来。
		return mediaType.startsWith("text/");
	}

	async prepare(turn: TurnContext): Promise<void> {
		const source = turn.messages;
		if (!source.some((message) => this.messageHasAttachment(message))) return;

		const transport = turn.transport;
		if (!transport) {
			// 直接 `new TurnContext(...)` 的调用方(测试)没有副请求通道。缺席是
			// 降级不是错误:块原样留下,codec 会留痕。
			turn.warn(
				"attachment-extract-failed",
				"Kimi file extraction needs a turn transport; the attachment stays undelivered",
			);
			return;
		}

		// 同一回合内**内容即键**:同一份文件被引用两次只上传一次。用 base64 载荷
		// 本身当键比摘要更准(不存在碰撞),也不必为此引一个 hash 实现。
		const extracted = new Map<string, Promise<string | undefined>>();
		const prepared: AgentMessage[] = [];

		for (const message of source) {
			if (!this.messageHasAttachment(message)) {
				prepared.push(message);
				continue;
			}
			const { systemMessages, content } = await this.extractInto(
				message.content as AgentContentPart[],
				turn,
				transport,
				extracted,
			);
			// 官方写法:每个文件**单独一条** system,放在提问的 user 消息**之前**。
			prepared.push(...systemMessages, { ...message, content });
		}

		turn.replaceMessages(prepared);
	}

	private messageHasAttachment(message: AgentMessage): boolean {
		if (message.role !== "user") return false;
		const content: AgentMessageContent = message.content;
		if (!Array.isArray(content)) return false;
		return content.some((part) => this.handles(part));
	}

	/**
	 * 一条 user 消息 → (它前面要插的 system 消息, 换过之后的内容块)。
	 *
	 * 抽到了:块从 user 消息里**移除**,内容进一条 system;抽不到:块原样留下
	 * (codec 落成 `Undeliverable`),已经记过 warning。
	 */
	private async extractInto(
		parts: AgentContentPart[],
		turn: TurnContext,
		transport: TurnTransport,
		extracted: Map<string, Promise<string | undefined>>,
	): Promise<{ systemMessages: AgentMessage[]; content: AgentContentPart[] }> {
		const systemMessages: AgentMessage[] = [];
		const content: AgentContentPart[] = [];

		for (const part of parts) {
			if (!this.handles(part) || !isFilePart(part)) {
				content.push(part);
				continue;
			}
			const filename = part.filename || "attachment";
			const key = `${baseMediaType(part.mediaType)}\u0000${part.data}`;
			let pending = extracted.get(key);
			if (!pending) {
				pending = this.uploadAndExtract(part, turn, transport);
				extracted.set(key, pending);
			}
			const text = await pending;
			if (text === undefined) {
				content.push(part);
				continue;
			}
			systemMessages.push({
				role: "system",
				content: `File: ${filename}\n${text}`,
			});
		}

		return { systemMessages, content };
	}

	/** 上传 → 取文本 → 删除。任何一步失败都返回 `undefined`(已留痕)。 */
	private async uploadAndExtract(
		part: FilePartLike,
		turn: TurnContext,
		transport: TurnTransport,
	): Promise<string | undefined> {
		const filename = part.filename || "attachment";
		let uploaded: UploadedFile | undefined;
		try {
			const headers = await transport.headers();
			uploaded = await this.upload(part, filename, transport, headers);
			return await this.readContent(uploaded.id, transport, headers);
		} catch (error) {
			turn.warn(
				"attachment-extract-failed",
				`Kimi could not extract "${filename}": ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ filename, mediaType: part.mediaType },
			);
			return undefined;
		} finally {
			// 不复用 file_id,所以抽完即删 —— 单用户 1000 个的配额不该被我们吃掉。
			// 删失败只是配额慢慢涨,不影响这一回合,所以只记一行日志。
			if (uploaded) void this.remove(uploaded.id, transport, turn);
		}
	}

	private async upload(
		part: FilePartLike,
		filename: string,
		transport: TurnTransport,
		headers: Record<string, string>,
	): Promise<UploadedFile> {
		const form = new FormData();
		form.append("purpose", FILE_EXTRACT_PURPOSE);
		form.append(
			"file",
			new Blob([base64ToBytes(part.data) as unknown as BlobPart], {
				type: baseMediaType(part.mediaType) || "application/octet-stream",
			}),
			filename,
		);

		const response = await transport.fetchImpl(`${transport.baseUrl}/files`, {
			method: "POST",
			headers: withoutContentType(headers),
			body: form,
		});
		if (!response.ok) {
			throw new Error(`upload failed with ${response.status}`);
		}
		const body = (await response.json()) as { id?: unknown };
		if (typeof body.id !== "string" || !body.id) {
			throw new Error("upload response carried no file id");
		}
		return { id: body.id };
	}

	/**
	 * 抽取结果。官方 OpenAPI 说这个接口返回 `text/plain`(纯文本),但历史上
	 * 它也返回过 `application/json` 的 `{content, filename, type, …}` —— 按
	 * **响应头**分派而不是猜:一个 `.json` 附件的抽取文本本身就是 JSON,靠
	 * 「能不能 parse」判会把它错拆开。
	 */
	private async readContent(
		fileId: string,
		transport: TurnTransport,
		headers: Record<string, string>,
	): Promise<string> {
		const response = await transport.fetchImpl(
			`${transport.baseUrl}/files/${encodeURIComponent(fileId)}/content`,
			{ method: "GET", headers },
		);
		if (!response.ok) {
			throw new Error(`content fetch failed with ${response.status}`);
		}
		const text = await response.text();
		if (!baseMediaType(response.headers.get("content-type") ?? "").includes("json")) {
			return text;
		}
		try {
			const parsed = JSON.parse(text) as { content?: unknown };
			return typeof parsed.content === "string" ? parsed.content : text;
		} catch {
			return text;
		}
	}

	private async remove(
		fileId: string,
		transport: TurnTransport,
		turn: TurnContext,
	): Promise<void> {
		try {
			const headers = await transport.headers();
			await transport.fetchImpl(
				`${transport.baseUrl}/files/${encodeURIComponent(fileId)}`,
				{ method: "DELETE", headers },
			);
		} catch (error) {
			turn.logger.debug("kimi file cleanup failed", {
				fileId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/** 两份配方共用同一只通道 —— 无状态,所以一个实例就够(设计稿 §3.1)。 */
export const kimiFileExtractChannel: AttachmentChannel = new KimiFileExtractChannel();
