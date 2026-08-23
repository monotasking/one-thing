/**
 * gemini(`generateContent`)线协议的消息 / 工具形状 —— 一份类型,一个 codec。
 *
 * `GeminiPartCodec` 是这条线上**唯一**的序列化器,是 `gemini.ts` 退役前
 * `buildGeminiContents` / `userPartsFromContent` / `dataPart` /
 * `toolResultResponse` 的**逐字搬运**(P1-b 是纯搬运,门是
 * `__tests__/wire-snapshots/gemini` 的 11 份快照,**禁 `-u`**)。
 *
 * 四条这条线独有、迁移最容易做丢的规则:
 *  1. **system 抽成顶层 `systemInstruction.parts`**,多条 system 各成一块;
 *  2. assistant 的 `functionCall` **不带 id** —— 名字就是配对键,所以要边走边
 *     记 `toolCallId → toolName`;
 *  3. 工具结果是一条 **`role: 'function'`** 的 content,名字靠上面那张表反查,
 *     **表里没有就退回 `toolCallId` 本身**(孤儿结果,快照钉着这条兜底;
 *     设计稿 §9 P1 门 ① 把「记一条 warning」排在后面);
 *  4. 二进制块一律走 `dataPart`:http(s) URL 变 `fileData`,其余当 base64 或
 *     data URI 变 `inlineData` —— 这条线上**没有 `Undeliverable`**,音频/视频
 *     都有对应的块。
 */
import { agentToolMessageContentToText } from "@onething/core/agent-loop";
import type {
	AgentContentPart,
	AgentJsonObject,
	AgentJsonValue,
	AgentMessage,
	AgentMessageContent,
	AgentTool,
	AgentToolChoice,
} from "@onething/core/agent-loop";
import {
	delivered,
	type Logger,
	type PartCodec,
	type PartDelivery,
	type ProviderMediaReader,
	type TurnContext,
} from "../base/index.js";

// ---------------------------------------------------------------------------
// 线上形状
// ---------------------------------------------------------------------------

export type GeminiPart =
	| { text: string; thought?: boolean }
	| { inlineData: { mimeType: string; data: string } }
	| { fileData: { mimeType?: string; fileUri: string } }
	| { functionCall: { name: string; args?: AgentJsonObject } }
	| { functionResponse: { name: string; response: AgentJsonObject } };

export interface GeminiContent {
	role: "user" | "model" | "function";
	parts: GeminiPart[];
}

export interface GeminiSystemInstruction {
	parts: Array<{ text: string }>;
}

export interface GeminiTool {
	functionDeclarations: Array<{
		name: string;
		description?: string;
		parameters?: AgentJsonObject;
	}>;
}

export interface GeminiToolConfig {
	functionCallingConfig: {
		mode: "AUTO" | "ANY";
		allowedFunctionNames?: string[];
	};
}

/** codec 交出来的两种东西:一条 content,或者一条 content 里的一块 part。 */
export type GeminiWireValue = GeminiContent | GeminiPart;

/** `buildGeminiContents` 的返回形状:system 抽走,其余按序落成 content。 */
export interface GeminiRequestContents {
	systemInstruction?: GeminiSystemInstruction;
	contents: GeminiContent[];
}

export function toGeminiTools(
	tools: AgentTool[] | undefined,
): GeminiTool[] | undefined {
	if (!tools?.length) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		},
	];
}

export function toGeminiToolConfig(
	choice: AgentToolChoice | undefined,
): GeminiToolConfig | undefined {
	if (!choice || choice === "auto") {
		return { functionCallingConfig: { mode: "AUTO" } };
	}
	if (choice === "none") return undefined;
	// Gemini's ANY mode means "must call a function"; narrowing to one name is
	// what turns it into a specific-tool choice.
	if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
	return {
		functionCallingConfig: {
			mode: "ANY",
			allowedFunctionNames: [choice.function.name],
		},
	};
}

// ---------------------------------------------------------------------------
// 纯函数(逐字搬自 gemini.ts)
// ---------------------------------------------------------------------------

function textFromContent(content: AgentMessageContent): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is Extract<AgentContentPart, { type: "text" }> =>
				part.type === "text",
		)
		.map((part) => part.text)
		.filter(Boolean)
		.join("\n");
}

function parseDataUrl(
	value: string,
): { mediaType: string; data: string } | undefined {
	const match = /^data:([^;,]+);base64,(.*)$/i.exec(value);
	if (!match) return undefined;
	return { mediaType: match[1]!, data: match[2]! };
}

/** http(s) → `fileData`,其余 → `inlineData`(data URI 先拆头)。 */
export function geminiDataPart(data: string, mediaType?: string): GeminiPart {
	if (data.startsWith("http://") || data.startsWith("https://")) {
		return { fileData: { mimeType: mediaType, fileUri: data } };
	}
	const parsed = parseDataUrl(data);
	return {
		inlineData: {
			mimeType: parsed?.mediaType ?? mediaType ?? "application/octet-stream",
			data: parsed?.data ?? data,
		},
	};
}

function parseToolArguments(args: string): AgentJsonObject {
	const trimmed = args.trim();
	if (!trimmed) return {};
	try {
		const parsed = JSON.parse(trimmed) as AgentJsonValue;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: { value: parsed };
	} catch {
		return { value: trimmed };
	}
}

function toolResultResponse(content: AgentMessageContent): AgentJsonObject {
	const text = agentToolMessageContentToText(content);
	return text ? { result: text } : {};
}

// ---------------------------------------------------------------------------
// 多轮改图:从正文里认出「这条 model 回复画过哪几张图」(P4-2)
// ---------------------------------------------------------------------------

/**
 * 生图落在消息上的**唯一**痕迹是一段 markdown —— `provider-data.ts` 的
 * `buildOnethingGeneratedImageMarkdown` 写的那段:
 *
 * ```
 * ![Generated Image|mediaId:<id>](media://<id>.png)
 * ```
 *
 * (`planOnethingProviderDataPart` 对 `image-generation-result` 返回 `'text'`
 * —— 消息上**没有**第二份记录,所以回放只能从正文认。)
 *
 * 两个来源都认:alt 里的 `mediaId:<id>` 标记,以及 URL 里的 `media://<id>.<ext>`。
 * 远端 URL 的那一支(`buildOnethingRemoteImageMarkdown`)故意**不带** `mediaId:`
 * —— 它没进过媒体库,认不出来正是对的。
 */
const GENERATED_IMAGE_ALT_MEDIA_ID = /!\[[^\]]*\bmediaId:([A-Za-z0-9._-]+)[^\]]*\]/g;
const GENERATED_IMAGE_URL_MEDIA_ID = /\bmedia:\/\/([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9]+)?/g;

/** 按出现顺序去重。 */
export function generatedImageMediaIdsFromText(text: string): string[] {
	const ids: string[] = [];
	const push = (id: string | undefined): void => {
		if (id && !ids.includes(id)) ids.push(id);
	};
	for (const match of text.matchAll(GENERATED_IMAGE_ALT_MEDIA_ID)) push(match[1]);
	for (const match of text.matchAll(GENERATED_IMAGE_URL_MEDIA_ID)) push(match[1]);
	return ids;
}

// ---------------------------------------------------------------------------
// codec 契约(线级)
// ---------------------------------------------------------------------------

/**
 * `PartCodec` 之外多出来的一条 `toRequestContents()`:gemini 把 system 抽成请求
 * 体的一个顶层字段,工具结果落成一条 `role: 'function'` 的 content,而
 * `functionCall` 与 `functionResponse` 的配对键是**函数名**(要跨消息记表)
 * —— 「一条 `AgentMessage` = 一条线上消息」在这条线上不成立,所以 wire 问的是
 * 整段。`PartCodec` 的四个成员仍是**投递契约**的入口(设计稿 §2.3)。
 */
export interface GeminiCodec extends PartCodec<GeminiWireValue> {
	toRequestContents(
		messages: AgentMessage[],
		turn?: TurnContext,
	): GeminiRequestContents;
	/**
	 * 多轮改图(P4-2):把每条 `role: 'model'` content 正文里提到的**生成图**
	 * 从媒体库取回来,作为额外的 `inlineData` part 放回同一条 content —— Gemini
	 * 官方的图像编辑示例就是把上一条 model 回复的 parts(含 `inlineData`)原样
	 * 放回 `contents`。
	 *
	 * 为什么不写在 `assistant()` 里:`PartCodec.assistant` 是**同步**的投递契约
	 * 入口(四条线共用一个签名),而这一步要 `await` 一次磁盘读。所以逻辑仍然
	 * 住在 codec 上,只是换了一个方法,由 wire 在 `buildBody` 里紧接着
	 * `toRequestContents()` 调用。
	 */
	replayGeneratedImages?(
		contents: GeminiContent[],
		media: ProviderMediaReader,
		logger?: Logger,
	): Promise<void>;
}

export class GeminiPartCodec implements GeminiCodec {
	system(text: string): GeminiWireValue {
		return { text };
	}

	/**
	 * 这条线接得住全部五种块(文本 / 图 / 文件 / 音频 / 视频),所以永远
	 * `delivered` —— `Undeliverable` 在 gemini 上没有出口。
	 */
	user(part: AgentContentPart): PartDelivery<GeminiWireValue> {
		if (part.type === "text") return delivered({ text: part.text });
		if (part.type === "image") {
			return delivered(geminiDataPart(part.image, part.mediaType ?? "image/png"));
		}
		if (part.type === "file") {
			return delivered(geminiDataPart(part.data, part.mediaType));
		}
		if (part.type === "audio") {
			return delivered(geminiDataPart(part.audio, part.mediaType ?? "audio/mpeg"));
		}
		if (part.type === "video") {
			return delivered(geminiDataPart(part.video, part.mediaType ?? "video/mp4"));
		}
		// 契约上到不了这里(五种块已穷尽);兜底成空文本块,不静默丢。
		return delivered({ text: "" });
	}

	/**
	 * 文本在前、`functionCall` 按声明顺序在后。**没有思维链回传** —— 这条线
	 * 今天不带 `thoughtSignature` 回去(官方要求见设计稿 §5.2,排 P3)。
	 */
	assistant(message: AgentMessage): GeminiWireValue[] {
		const parts: GeminiPart[] = [];
		const text = textFromContent(message.content);
		if (text) parts.push({ text });
		for (const toolCall of message.toolCalls ?? []) {
			parts.push({
				functionCall: {
					name: toolCall.name,
					args: parseToolArguments(toolCall.arguments),
				},
			});
		}
		return parts;
	}

	/**
	 * 单块的工具结果 —— 名字这一层 codec 看不到(它在 `toRequestContents` 的
	 * 表里),所以这里只把内容折成 `{ result: <text> }`,名字留给调用方。
	 */
	toolResult(part: AgentContentPart): PartDelivery<GeminiWireValue> {
		return delivered({
			functionResponse: { name: "", response: toolResultResponse([part]) },
		});
	}

	toRequestContents(messages: AgentMessage[]): GeminiRequestContents {
		const systemParts: Array<{ text: string }> = [];
		const contents: GeminiContent[] = [];
		const toolNamesByCallId = new Map<string, string>();

		for (const message of messages) {
			if (message.role === "system") {
				const text = textFromContent(message.content).trim();
				if (text) systemParts.push({ text });
				continue;
			}

			if (message.role === "assistant") {
				for (const toolCall of message.toolCalls ?? []) {
					toolNamesByCallId.set(toolCall.id, toolCall.name);
				}
				const parts = this.assistant(message) as GeminiPart[];
				if (parts.length > 0) contents.push({ role: "model", parts });
				continue;
			}

			if (message.role === "tool") {
				// 孤儿结果(assistant 没声明过这个 id)退回 toolCallId 当函数名 ——
				// 今天的行为,快照钉着(设计稿 §9 P1 门 ①)。
				const name =
					toolNamesByCallId.get(message.toolCallId ?? "") ??
					message.toolCallId ??
					"tool";
				contents.push({
					role: "function",
					parts: [
						{
							functionResponse: {
								name,
								response: toolResultResponse(message.content),
							},
						},
					],
				});
				continue;
			}

			const parts = this.userParts(message.content);
			if (parts.length > 0) contents.push({ role: "user", parts });
		}

		return {
			...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
			contents,
		};
	}

	/**
	 * 见 `GeminiCodec.replayGeneratedImages` 的抬头。
	 *
	 * 三条规矩:
	 *  1. **只动 `role: 'model'`** —— user 侧的图早就是真正的 `inlineData`;
	 *  2. **文本在前、图在后**:图插在最后一个文本块之后,`functionCall` 仍然
	 *     押尾(与 `assistant()` 的块序一致);
	 *  3. **读不到就跳过 + 一条 warning**,不抛:少一块历史上下文不该让这一回合
	 *     失败(端口缺席时 wire 压根不会调到这里)。
	 */
	async replayGeneratedImages(
		contents: GeminiContent[],
		media: ProviderMediaReader,
		logger?: Logger,
	): Promise<void> {
		for (const content of contents) {
			if (content.role !== "model") continue;

			const mediaIds: string[] = [];
			let insertAt = 0;
			content.parts.forEach((part, index) => {
				if (!("text" in part)) return;
				insertAt = index + 1;
				for (const id of generatedImageMediaIdsFromText(part.text)) {
					if (!mediaIds.includes(id)) mediaIds.push(id);
				}
			});
			if (mediaIds.length === 0) continue;

			const images: GeminiPart[] = [];
			for (const mediaId of mediaIds) {
				let image: Awaited<ReturnType<ProviderMediaReader["readImageBase64"]>>;
				try {
					image = await media.readImageBase64(mediaId);
				} catch (error) {
					logger?.warn("generated image replay failed", { mediaId }, error);
					continue;
				}
				if (!image?.base64) {
					logger?.warn("generated image not found for replay", { mediaId });
					continue;
				}
				images.push({
					inlineData: {
						mimeType: image.mediaType || "image/png",
						data: image.base64,
					},
				});
			}
			if (images.length > 0) content.parts.splice(insertAt, 0, ...images);
		}
	}

	/** `userPartsFromContent` 逐字:空文本块不进请求体。 */
	private userParts(content: AgentMessageContent): GeminiPart[] {
		if (typeof content === "string") return content ? [{ text: content }] : [];
		if (!Array.isArray(content)) return [];

		const parts: GeminiPart[] = [];
		for (const part of content) {
			if (part.type === "text") {
				if (part.text) parts.push({ text: part.text });
				continue;
			}
			if (
				part.type !== "image" &&
				part.type !== "file" &&
				part.type !== "audio" &&
				part.type !== "video"
			) {
				continue;
			}
			const delivery = this.user(part);
			if (delivery.kind === "delivered") parts.push(delivery.part as GeminiPart);
		}
		return parts;
	}
}

export const geminiParts: GeminiCodec = new GeminiPartCodec();
