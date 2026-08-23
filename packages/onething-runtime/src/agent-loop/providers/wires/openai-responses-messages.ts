/**
 * openai-responses(`/responses`)线协议的消息 / 工具形状 —— 一份类型,一个 codec。
 *
 * `ResponsesPartCodec` 是这条线上**唯一**的序列化器,是 `codex.ts` 退役前
 * `buildCodexPrompt` / `toCodexMessageContent` / `toolResultToCodexOutput` /
 * `codexEncryptedReasoning` 的**逐字搬运**(P1-c 是纯搬运,门是
 * `__tests__/wire-snapshots/responses` 的 9 份快照,**禁 `-u`**)。
 *
 * 五条这条线独有、迁移最容易做丢的规则:
 *  1. **system 抽成顶层 `instructions` 字符串**,多条 system 用 `\n\n` 连接,
 *     一条都没有时由 wire 补上方言的 `fallbackInstructions`;
 *  2. 输入不是 `messages` 而是 **`input` 项数组**:message / function_call /
 *     function_call_output / reasoning 四种项平铺在同一个数组里;
 *  3. **加密思维链回放**:assistant 的 `providerData` 里每条
 *     `<tag>/encrypted-reasoning` 摊成一个独立的 `{type:'reasoning', summary:[],
 *     encrypted_content}` 项,而且**排在同一条 assistant 消息的文本与
 *     function_call 之前**。`<tag>` 是**方言给的** `providerDataTag`
 *     (codex → `'codex'`,xAI 两条通路 → `'grok'`),不是硬编码的 `'codex'`
 *     —— 这条线上不只 codex 一家会回传加密思维链(P4-4);
 *  4. assistant 的文本块是 `output_text`,user 的是 `input_text` —— 同一个
 *     `toCodexMessageContent` 按 role 分岔;
 *  5. **`input_file` 是 PDF 专用通道且必须带 `filename`**(不带就是 400)。
 *     非 PDF 的文件块落成一段可见文本(`Undeliverable.toText()`,措辞与 core
 *     的 `undeliverableAttachmentText` 逐字相同,由架构测试守着);音频 /
 *     视频落成 `[Audio: …]` / `[Video: …]` 占位文本 —— 这条线收不下它们。
 *
 * codec 是**按方言构造**的(`ResponsesPartCodecOptions`):`input_image.detail`
 * 的值来自请求级 providerOptions 袋(哪家认、值域多宽写在配方上),加密思维链
 * 的 provider 标签也来自配方。不给选项 = 今天 codex 的行为逐字不变
 * (`detail:'auto'` 恒发、标签 `'codex'`),`responsesParts` 这个单例就是那一份。
 */
import { agentToolMessageContentToStructuredPayload } from "@onething/core/agent-loop";
import type {
	AgentContentPart,
	AgentJsonObject,
	AgentJsonValue,
	AgentMessage,
	AgentMessageContent,
	AgentProviderData,
	AgentTool,
	AgentToolResultContentPart,
	AgentTurnRequest,
} from "@onething/core/agent-loop";
import {
	openAIResponsesImageDetail,
	type OpenAIResponsesProviderOptionSupport,
} from "./openai-responses-provider-options.js";
import {
	delivered,
	isPdfMediaType,
	undeliverable,
	Undeliverable,
	type PartCodec,
	type PartDelivery,
	type TurnContext,
} from "../base/index.js";

// ---------------------------------------------------------------------------
// 线上形状
// ---------------------------------------------------------------------------

export type CodexInputContentPart =
	| { type: "input_text"; text: string }
	| { type: "input_image"; image_url: string; detail: string }
	| { type: "input_file"; filename?: string; file_data: string }
	| { type: "output_text"; text: string };

export type CodexInputItem =
	| {
			type: "message";
			role: "user" | "assistant" | "developer";
			content: CodexInputContentPart[];
	  }
	| { type: "function_call"; name: string; arguments: string; call_id: string }
	| {
			type: "function_call_output";
			call_id: string;
			output: string | CodexInputContentPart[];
	  }
	| { type: "reasoning"; summary: AgentJsonValue[]; encrypted_content: string };

export type CodexTool =
	| {
			type: "function";
			name: string;
			description?: string;
			strict: false;
			parameters: AgentJsonObject;
	  }
	| { type: "image_generation"; output_format: "png" };

/** codec 交出来的两种东西:一个 input 项,或者一条 message 里的一块内容。 */
export type ResponsesWireValue = CodexInputItem | CodexInputContentPart;

/** `buildCodexPrompt` 的返回形状:system 抽走,其余按序落成 input 项。 */
export interface CodexPromptPayload {
	input: CodexInputItem[];
	instructions?: string;
}

// ---------------------------------------------------------------------------
// 工具表 / tool_choice
// ---------------------------------------------------------------------------

/**
 * 函数工具表 + 方言自己的**原生工具**(codex 的 `image_generation`;xAI 的
 * Responses 收 `web_search` / `x_search` / `code_interpreter`,但我们不主动
 * 挂它们 —— 服务端工具会自己发起检索并计费,那是产品决定,不是线协议默认)。
 *
 * 原生工具**排在函数工具之后**,并且不参与函数名去重(它们没有 `name`)。
 */
export function toCodexTools(
	tools: AgentTool[] | undefined,
	nativeTools: readonly CodexTool[] = [],
): CodexTool[] {
	const seen = new Set<string>();
	const codexTools: CodexTool[] = [];
	for (const tool of tools ?? []) {
		if (!tool.name || seen.has(tool.name)) continue;
		seen.add(tool.name);
		codexTools.push({
			type: "function",
			name: tool.name,
			description: tool.description,
			strict: false,
			parameters: tool.parameters,
		});
	}
	codexTools.push(...nativeTools);
	return codexTools;
}

/**
 * Responses API dialect for `tool_choice` (W22).
 *
 * The string forms ("auto" / "none" / "required") are shared with Chat
 * Completions, but a NAMED tool is spelled flat here — `{type:'function',
 * name}` — where Chat Completions nests it under a `function` object. Passing
 * the nested shape through unchanged is a 400, so the one shape that differs is
 * translated and everything else rides on as before.
 */
export function toCodexToolChoice(
	choice: AgentTurnRequest["toolChoice"],
): AgentJsonValue {
	if (!choice) return "auto";
	if (typeof choice === "string") return choice;
	return { type: "function", name: choice.function.name };
}

// ---------------------------------------------------------------------------
// 纯函数(逐字搬自 codex.ts)
// ---------------------------------------------------------------------------

export function textFromContent(content: AgentMessageContent): string {
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

function dataToUrl(
	value: string | undefined,
	mediaType?: string,
): string | undefined {
	if (!value) return undefined;
	if (
		value.startsWith("data:") ||
		value.startsWith("http://") ||
		value.startsWith("https://")
	) {
		return value;
	}
	// Bare payloads without a media type cannot become a valid URL; returning
	// them verbatim gets the whole request rejected with a 400 by the API.
	return mediaType ? `data:${mediaType};base64,${value}` : undefined;
}

function parseToolArguments(args: string): AgentJsonValue {
	const trimmed = args.trim();
	if (!trimmed) return {};
	try {
		return JSON.parse(trimmed) as AgentJsonValue;
	} catch {
		return args;
	}
}

export function stringifyCodexToolInput(
	input: AgentJsonValue | undefined,
): string {
	if (typeof input === "string") return input;
	try {
		return JSON.stringify(input ?? {});
	} catch {
		return "{}";
	}
}

/**
 * assistant 上那几条 `<tag>/encrypted-reasoning` 的载荷,按声明顺序。
 *
 * `tag` 默认 `'codex'`(这条线上第一家,fixture 钉着);xAI 的两条通路共用
 * `'grok'` —— 与 `decodeGrokCitations` 同一个理由:错误消息 / dump / 账本按
 * providerId 归档,但**消息上的 provider-data 标签按家族**,于是同一段历史在
 * grok 与 grok-oauth 之间切换时回放不断。
 */
export function codexEncryptedReasoning(
	message: AgentMessage,
	tag = "codex",
): string[] {
	return (message.providerData ?? [])
		.filter(
			(data): data is AgentProviderData & { encryptedContent: string } =>
				data.provider === tag &&
				data.type === "encrypted-reasoning" &&
				typeof data.encryptedContent === "string" &&
				data.encryptedContent.length > 0,
		)
		.map((data) => data.encryptedContent);
}

function isAgentToolResultContentPartArray(
	value: unknown,
): value is AgentToolResultContentPart[] {
	return (
		Array.isArray(value) &&
		value.every((part) => {
			if (!part || typeof part !== "object") return false;
			const type = (part as { type?: unknown }).type;
			return type === "text" || type === "image" || type === "file";
		})
	);
}

// ---------------------------------------------------------------------------
// codec 契约(线级)
// ---------------------------------------------------------------------------

/**
 * `PartCodec` 之外多出来的一条 `toRequestPrompt()`:这条线把 system 抽成请求体
 * 的一个顶层字符串,而 assistant 的加密思维链 / 工具调用 / 工具结果都是**与
 * message 平级的 input 项** —— 「一条 `AgentMessage` = 一条线上消息」在这条线
 * 上不成立,所以 wire 问的是整段。`PartCodec` 的四个成员仍是**投递契约**的
 * 入口(设计稿 §2.3)。
 */
export interface ResponsesCodec extends PartCodec<ResponsesWireValue> {
	toRequestPrompt(
		messages: AgentMessage[],
		turn?: TurnContext,
	): CodexPromptPayload;
}

export interface ResponsesPartCodecOptions {
	/** 这家收不收 `input_image.detail`(见 `openai-responses-provider-options.ts`)。 */
	imageDetail?: boolean | readonly string[];
	/** 加密思维链回放认哪个 `providerData.provider` 标签。 */
	providerDataTag?: string;
}

export class ResponsesPartCodec implements ResponsesCodec {
	constructor(private readonly options: ResponsesPartCodecOptions = {}) {}

	/**
	 * `input_image.detail` 的值。**不给袋、这家不认、或者袋里没这一格** ⇒
	 * `'auto'` —— 与 P4-4 之前逐字相同(codex 的 fixture 钉着 `detail:'auto'`)。
	 */
	private imageDetail(turn: TurnContext | undefined): string {
		const support: OpenAIResponsesProviderOptionSupport =
			this.options.imageDetail === undefined
				? {}
				: { imageDetail: this.options.imageDetail };
		return openAIResponsesImageDetail(turn, support) ?? "auto";
	}

	/** system 在这条线上进 `instructions`;这里只给它一个合法的线上形状。 */
	system(text: string): ResponsesWireValue {
		return { type: "input_text", text };
	}

	/**
	 * `toCodexMessageContent` 的 user 分支,逐块。文件块是唯一会 `undeliverable`
	 * 的:`input_file` 只收 PDF。
	 */
	user(part: AgentContentPart, turn?: TurnContext): PartDelivery<ResponsesWireValue> {
		switch (part.type) {
			case "text":
				return delivered({ type: "input_text", text: part.text });
			case "image": {
				const imageUrl = dataToUrl(part.image, part.mediaType ?? "image/png");
				return imageUrl
					? delivered({
							type: "input_image",
							image_url: imageUrl,
							detail: this.imageDetail(turn),
						})
					: undeliverable(Undeliverable.fromPart(part, "wire-has-no-part"));
			}
			case "file": {
				// The Responses API's input_file is a PDF channel and requires a
				// filename alongside file_data (400 without one). Text files never
				// reach here — the engine inlines them as text parts — so anything
				// non-PDF gets a visible placeholder instead of an invalid request.
				const fileData = isPdfMediaType(part.mediaType)
					? dataToUrl(part.data, part.mediaType)
					: undefined;
				return fileData
					? delivered({
							type: "input_file",
							file_data: fileData,
							filename: part.filename ?? "attachment.pdf",
						})
					: undeliverable(Undeliverable.fromPart(part, "wire-has-no-part"));
			}
			case "audio":
				// Codex does not support audio input natively; fall back to a
				// descriptive text placeholder so the API request stays valid.
				return delivered({
					type: "input_text",
					text: `[Audio: ${part.mediaType ?? "unknown"}]`,
				});
			case "video":
				return delivered({
					type: "input_text",
					text: `[Video: ${part.mediaType ?? "unknown"}]`,
				});
			default:
				return delivered({ type: "input_text", text: "" });
		}
	}

	/**
	 * 一条 assistant 消息落成的 input 项:**加密思维链在前**,然后是文本
	 * message,最后是 function_call —— 次序是 `buildCodexPrompt` 的原样。
	 */
	assistant(message: AgentMessage): ResponsesWireValue[] {
		const items: CodexInputItem[] = [];
		for (const encryptedContent of codexEncryptedReasoning(
			message,
			this.options.providerDataTag,
		)) {
			items.push({
				type: "reasoning",
				summary: [],
				encrypted_content: encryptedContent,
			});
		}
		const content = this.messageContent(message.content, "assistant");
		if (content.length > 0) {
			items.push({ type: "message", role: "assistant", content });
		}
		for (const toolCall of message.toolCalls ?? []) {
			if (!toolCall.id || !toolCall.name) continue;
			items.push({
				type: "function_call",
				name: toolCall.name,
				arguments: stringifyCodexToolInput(
					parseToolArguments(toolCall.arguments),
				),
				call_id: toolCall.id,
			});
		}
		return items;
	}

	/** 单块工具结果 —— `function_call_output` 的 `output` 数组里的一项。 */
	toolResult(
		part: AgentContentPart,
		turn?: TurnContext,
	): PartDelivery<ResponsesWireValue> {
		return (
			this.toolResultPart(part as ToolResultPartLike, turn) ??
			delivered({ type: "input_text", text: "" })
		);
	}

	/** `buildCodexPrompt` 逐字。 */
	toRequestPrompt(
		messages: AgentMessage[],
		turn?: TurnContext,
	): CodexPromptPayload {
		const instructions: string[] = [];
		const input: CodexInputItem[] = [];

		for (const message of messages) {
			if (message.role === "system") {
				const text = textFromContent(message.content).trim();
				if (text) instructions.push(text);
				continue;
			}

			if (message.role === "user") {
				const content = this.messageContent(message.content, "user", turn);
				if (content.length > 0)
					input.push({ type: "message", role: "user", content });
				continue;
			}

			if (message.role === "assistant") {
				input.push(...(this.assistant(message) as CodexInputItem[]));
				continue;
			}

			if (message.role === "tool" && message.toolCallId) {
				input.push({
					type: "function_call_output",
					call_id: message.toolCallId,
					output: this.toolResultOutput(
						agentToolMessageContentToStructuredPayload(message.content),
						turn,
					),
				});
			}
		}

		return {
			input,
			instructions: instructions.filter(Boolean).join("\n\n") || undefined,
		};
	}

	/** `toCodexMessageContent` 逐字:空文本块不进请求体,非 user 的二进制块丢掉。 */
	private messageContent(
		content: AgentMessageContent,
		role: "user" | "assistant",
		turn?: TurnContext,
	): CodexInputContentPart[] {
		if (typeof content === "string") {
			if (!content) return [];
			return [
				{
					type: role === "assistant" ? "output_text" : "input_text",
					text: content,
				},
			];
		}
		if (!Array.isArray(content)) return [];

		const parts: CodexInputContentPart[] = [];
		for (const part of content) {
			if (part.type === "text") {
				if (part.text) {
					parts.push({
						type: role === "assistant" ? "output_text" : "input_text",
						text: part.text,
					});
				}
				continue;
			}
			// 二进制块只在 user 这一侧有出口(assistant 回放不带附件)。
			if (role !== "user") continue;
			if (
				part.type !== "image" &&
				part.type !== "file" &&
				part.type !== "audio" &&
				part.type !== "video"
			) {
				continue;
			}
			const delivery = this.user(part, turn);
			if (delivery.kind === "delivered") {
				parts.push(delivery.part as CodexInputContentPart);
				continue;
			}
			// 图片解析不出 URL 时今天什么都不 push;文件块才留可见文本。
			if (part.type === "file") {
				parts.push({ type: "input_text", text: delivery.note.toText() });
			}
		}
		return parts;
	}

	/** `toolResultToCodexOutput` 逐字。 */
	private toolResultOutput(
		payload: ReturnType<typeof agentToolMessageContentToStructuredPayload>,
		turn?: TurnContext,
	): string | CodexInputContentPart[] {
		if (typeof payload === "string") return payload;
		const rawContent = Array.isArray(payload)
			? payload
			: payload && typeof payload === "object"
				? (payload as { content?: unknown }).content
				: undefined;
		if (!isAgentToolResultContentPartArray(rawContent))
			return JSON.stringify(payload ?? "");

		const parts: CodexInputContentPart[] = [];
		for (const part of rawContent) {
			const delivery = this.toolResultPart(part as ToolResultPartLike, turn);
			if (!delivery) continue;
			parts.push(
				delivery.kind === "delivered"
					? (delivery.part as CodexInputContentPart)
					: { type: "input_text", text: delivery.note.toText() },
			);
		}
		return parts.length > 0 ? parts : "";
	}

	/**
	 * 一块工具结果 → 一块线上内容。`undefined` = 这一块今天什么都不产出
	 * (非 text/image/file,或者 text 里没有字符串)。
	 *
	 * Tool result parts carry the media type as either `mimeType` (raw tool
	 * output) or `mediaType` (the structured payload normalization).
	 */
	private toolResultPart(
		part: ToolResultPartLike,
		turn?: TurnContext,
	): PartDelivery<ResponsesWireValue> | undefined {
		const mediaType = part.mimeType ?? part.mediaType;
		if (part.type === "text" && typeof part.text === "string") {
			return delivered({ type: "input_text", text: part.text });
		}
		if (part.type === "image") {
			const imageUrl = dataToUrl(part.data, mediaType ?? "image/png");
			return imageUrl
				? delivered({
						type: "input_image",
						image_url: imageUrl,
						detail: this.imageDetail(turn),
					})
				: undefined;
		}
		if (part.type === "file") {
			const imageUrl = mediaType?.startsWith("image/")
				? dataToUrl(part.data, mediaType)
				: undefined;
			const fileData = isPdfMediaType(mediaType)
				? dataToUrl(part.data, mediaType)
				: undefined;
			if (imageUrl) {
				return delivered({
					type: "input_image",
					image_url: imageUrl,
					detail: this.imageDetail(turn),
				});
			}
			if (fileData) {
				return delivered({
					type: "input_file",
					file_data: fileData,
					filename: part.filename ?? part.path ?? "attachment.pdf",
				});
			}
			// **整块**交给 `Undeliverable` —— 今天 `undeliverableAttachmentText(part)`
			// 收的也是整块(那句 `as {filename, mimeType}` 只窄了类型,没有筛字段),
			// 而文案里 `mediaType` 压过 `mimeType`、`path` 会多出一句。
			return undeliverable(Undeliverable.fromPart(part, "wire-has-no-part"));
		}
		return undefined;
	}
}

/** `toolResultToCodexOutput` 读的那几个字段(两套命名并存)。 */
interface ToolResultPartLike {
	type?: string;
	text?: unknown;
	data?: string;
	mimeType?: string;
	mediaType?: string;
	filename?: string;
	path?: string;
}

export const responsesParts: ResponsesCodec = new ResponsesPartCodec();
