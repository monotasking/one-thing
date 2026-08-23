/**
 * openai-chat 线协议的消息/工具形状 —— 一份类型,一个 codec。
 *
 * `OpenAIChatPartCodec` 是这条线上**唯一**的序列化器,十一家共用
 * (`includeAssistantReasoning` 是它唯一的旋钮)。曾经并存的
 * `DeepSeekPartCodec`(user 内容压成纯文本、图和 PDF 静默消失)在 P0b-A
 * 随 DeepSeek vision 一起删除 —— 「能力说行、线协议做得到」的块必须
 * `delivered`,做不到的必须留成可见文本,没有第三种。
 */
import { agentToolMessageContentToText } from "@onething/core/agent-loop";
import type {
	AgentContentPart,
	AgentJsonObject,
	AgentMessage,
	AgentMessageContent,
	AgentTool,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import {
	Undeliverable,
	delivered,
	isPdfMediaType,
	undeliverable,
	type PartCodec,
	type PartDelivery,
	type TurnContext,
	type UndeliverablePartLike,
} from "../base/index.js";

// ---------------------------------------------------------------------------
// 线上形状
// ---------------------------------------------------------------------------

export interface OpenAIChatToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export type OpenAIChatUserContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } }
	/** chat-completions 的文件块。只走 `file_data`(base64 data URI)—— Files
	 *  API 的 `file_id` 路径要先上传、要管生命周期,不在这一层。 */
	| { type: "file"; file: { filename: string; file_data: string } };

export type OpenAIChatMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | OpenAIChatUserContentPart[] }
	| {
			role: "assistant";
			content: string | null;
			reasoning_content?: string;
			tool_calls?: OpenAIChatToolCall[];
	  }
	| { role: "tool"; tool_call_id: string; content: string };

export interface OpenAIChatTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: AgentJsonObject;
	};
}

/** codec 交出来的两种东西:一条消息,或者 user 消息里的一块内容。 */
export type OpenAIChatWireValue = OpenAIChatMessage | OpenAIChatUserContentPart;

export function toOpenAIChatTools(
	tools: AgentTool[] | undefined,
): OpenAIChatTool[] | undefined {
	if (!tools?.length) return undefined;
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

// ---------------------------------------------------------------------------
// codec 契约(线级)
// ---------------------------------------------------------------------------

/**
 * `PartCodec` 之外多出来的一条 `toWireMessage()`:openai-chat 的一条
 * `AgentMessage` 恰好落成一条线上消息,wire 直接问这一句。
 * `PartCodec` 的四个成员是**投递契约**的入口(设计稿 §2.3),P2 的
 * 「能力说行就必须 delivered」矩阵断言读的是它们。
 */
export interface OpenAIChatCodec extends PartCodec<OpenAIChatWireValue> {
	toWireMessage(message: AgentMessage, turn: TurnContext): OpenAIChatMessage;
}

function dataContentToImageUrl(data: string, mediaType?: string): string {
	if (
		data.startsWith("data:") ||
		data.startsWith("http://") ||
		data.startsWith("https://")
	) {
		return data;
	}
	return `data:${mediaType || "image/png"};base64,${data}`;
}

/**
 * `file` 块的 `file_data` 只收 data URI。已经是的原样交出去;裸 base64 补上
 * `application/pdf` 前缀(媒体类型在这里已经判过是 PDF,参数后缀不带进线上)。
 */
function pdfFileData(data: string): string {
	return data.startsWith("data:") ? data : `data:application/pdf;base64,${data}`;
}

/** `openai-compatible.ts` 的 `contentToText` —— 与 core 的 `agentContentToText`
 * 差一个 `filter(Boolean)`,那是两家今天的实际差别,不合并。 */
function contentToText(content: AgentMessageContent): string {
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

/** `AgentContentPart` 里 `Undeliverable` 会读的那几个字段,安全取出。 */
function undeliverablePartLike(part: AgentContentPart): UndeliverablePartLike {
	const candidate = part as {
		filename?: string;
		mediaType?: string;
		mimeType?: string;
		path?: string;
	};
	return {
		...(candidate.filename ? { filename: candidate.filename } : {}),
		...(candidate.mediaType ? { mediaType: candidate.mediaType } : {}),
		...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
		...(candidate.path ? { path: candidate.path } : {}),
	};
}

function toolCallsOf(message: AgentMessage): OpenAIChatToolCall[] | undefined {
	if (!message.toolCalls?.length) return undefined;
	return message.toolCalls.map((toolCall) => ({
		id: toolCall.id,
		type: "function" as const,
		function: { name: toolCall.name, arguments: toolCall.arguments },
	}));
}

function toolMessage(message: AgentMessage): OpenAIChatMessage {
	return {
		role: "tool",
		tool_call_id: message.toolCallId ?? "",
		content: agentToolMessageContentToText(message.content),
	};
}

/**
 * tool 消息只收文本 —— 非文本块进不了请求体(线协议没有那种块)。
 * 丢掉的块在 `turn` 上留一条 warning(§2.4:不静默)。
 */
function toolResultDelivery(
	part: AgentContentPart,
	turn?: TurnContext,
): PartDelivery<OpenAIChatUserContentPart> {
	if (part.type === "text") return delivered({ type: "text", text: part.text });
	const note = Undeliverable.fromPart(
		undeliverablePartLike(part),
		"tool-result-text-only",
	);
	warnUndeliverable(note, part, turn);
	return undeliverable(note);
}

/**
 * `TurnContext` 是可选的:codec 也被 P2 的投递契约矩阵直接调用(那里没有回合)。
 * 有回合就留痕,没有就只把 `Undeliverable` 交出去 —— 契约本身不变。
 */
function warnUndeliverable(
	note: Undeliverable,
	part: AgentContentPart,
	turn: TurnContext | undefined,
): void {
	turn?.warn("part-undeliverable", note.toText(), {
		partType: part.type,
		reason: note.reason,
	});
}

// ---------------------------------------------------------------------------
// openai-compatible 半边
// ---------------------------------------------------------------------------

/** 这条线上的 PDF 怎么投(P3-1)。 */
export type OpenAIChatFilePdfMode =
	/** chat-completions 的 `file` 内容块(OpenAI 官方 / OpenRouter 都是这个形状)。 */
	| "openai-file"
	/** 不投 —— 端点能力未知或没有可移植的 PDF 块,留可见文本。 */
	| "none";

export interface OpenAIChatPartCodecOptions {
	/** 多轮回传 `reasoning_content`(Kimi / Zhipu / Qwen / Grok 要,OpenAI 不要)。 */
	includeAssistantReasoning?: boolean;
	/**
	 * PDF 文件块。**默认 `'none'`** —— 十一家里只有确认收得下的才开
	 * (openai / openrouter),`custom-openai` 这类自建端点能力未知,保持今天的
	 * 可见留痕而不是发一个可能 400 的块。
	 */
	filePdf?: OpenAIChatFilePdfMode;
	/**
	 * 方言缝(设计稿 §5.1「图像输出」行):这条线上多出来的**响应侧**块。
	 * 一家给一个函数,codec 只负责把它接在 `PartCodec.decodeExtras` 上 ——
	 * wire 的 `parseStream` 每块调一次,不给就是空数组。
	 *
	 * 今天唯一的用户是 OpenRouter 的 `images[]`(见
	 * `dialects/openrouter.ts` 的 `decodeOpenRouterImageOutput`)。
	 */
	decodeExtras?(chunk: unknown, turn: TurnContext): AgentTurnStreamEvent[];
}

/**
 * 「本回合投递过 PDF」的回合级标记(`TurnContext.notes`)。OpenRouter 的配方
 * 读它决定要不要挂 `plugins: file-parser` —— codec 不直接写请求体。
 */
export const OPENAI_CHAT_PDF_DELIVERED_NOTE = "pdf-delivered";

export class OpenAIChatPartCodec implements OpenAIChatCodec {
	constructor(private readonly options: OpenAIChatPartCodecOptions = {}) {}

	system(text: string): OpenAIChatMessage {
		return { role: "system", content: text };
	}

	user(
		part: AgentContentPart,
		turn?: TurnContext,
	): PartDelivery<OpenAIChatUserContentPart> {
		if (part.type === "text") return delivered({ type: "text", text: part.text });
		if (part.type === "image") {
			return delivered({
				type: "image_url",
				image_url: { url: dataContentToImageUrl(part.image, part.mediaType) },
			});
		}
		if (part.type === "file" && part.mediaType.startsWith("image/")) {
			return delivered({
				type: "image_url",
				image_url: { url: dataContentToImageUrl(part.data, part.mediaType) },
			});
		}
		// PDF:认这个块的端点(openai / openrouter)按方言开关投真块;开关关着
		// 的家仍然走下面的可见文本。留一个回合级标记,`extraBody` 那一侧要用。
		if (
			part.type === "file" &&
			this.options.filePdf === "openai-file" &&
			isPdfMediaType(part.mediaType)
		) {
			turn?.notes.add(OPENAI_CHAT_PDF_DELIVERED_NOTE);
			return delivered({
				type: "file",
				file: {
					filename: part.filename ?? "document.pdf",
					file_data: pdfFileData(part.data),
				},
			});
		}
		// chat-completions 没有别的可移植 file 块:文本文件在上游已经内联过了,
		// 剩下的二进制留成可见文本,不静默丢。
		const note = Undeliverable.fromPart(
			undeliverablePartLike(part),
			"wire-has-no-part",
		);
		warnUndeliverable(note, part, turn);
		return undeliverable(note);
	}

	assistant(message: AgentMessage): OpenAIChatMessage[] {
		const content = contentToText(message.content);
		const toolCalls = toolCallsOf(message);
		return [
			{
				role: "assistant",
				content: content || null,
				...(this.options.includeAssistantReasoning && message.reasoningContent
					? { reasoning_content: message.reasoningContent }
					: {}),
				...(toolCalls ? { tool_calls: toolCalls } : {}),
			},
		];
	}

	toolResult(
		part: AgentContentPart,
		turn?: TurnContext,
	): PartDelivery<OpenAIChatUserContentPart> {
		return toolResultDelivery(part, turn);
	}

	/** 方言缝 —— 配方给了才有事件,没给就是空数组(基类不认识任何额外块)。 */
	decodeExtras(chunk: unknown, turn: TurnContext): AgentTurnStreamEvent[] {
		return this.options.decodeExtras?.(chunk, turn) ?? [];
	}

	toWireMessage(message: AgentMessage, turn?: TurnContext): OpenAIChatMessage {
		if (message.role === "tool") return toolMessage(message);
		if (message.role === "assistant") return this.assistant(message)[0]!;
		if (message.role === "user") return this.userMessage(message.content, turn);
		return this.system(contentToText(message.content));
	}

	private userMessage(
		content: AgentMessageContent,
		turn?: TurnContext,
	): OpenAIChatMessage {
		if (typeof content === "string") return { role: "user", content };
		if (!Array.isArray(content)) return { role: "user", content: "" };

		const parts: OpenAIChatUserContentPart[] = [];
		for (const part of content) {
			const delivery = this.user(part, turn);
			if (delivery.kind === "delivered") {
				parts.push(delivery.part);
				continue;
			}
			// 今天只有 file 块会留下可见替身;audio / video 这些模态归 core 的
			// `degradeUnsupportedAgentContentParts` 管,provider 这一层原样丢掉
			// (单一 owner,设计稿 §2.3)。
			if (part.type === "file") {
				parts.push({ type: "text", text: delivery.note.toText() });
			}
		}
		return { role: "user", content: parts.length > 0 ? parts : "" };
	}
}
