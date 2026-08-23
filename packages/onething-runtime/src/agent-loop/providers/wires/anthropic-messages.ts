/**
 * anthropic-messages 线协议的消息 / 工具形状 —— 一份类型,一个 codec。
 *
 * `AnthropicPartCodec` 是这条线上**唯一**的序列化器,三家共用
 * (claude / claude-code / custom-* apiType=anthropic)。它是
 * `claude.ts` 退役前 `buildClaudeMessages` / `userContentBlocks` /
 * `toolResultContentBlocks` / `claudeThinkingReplayBlocks` 的**逐字搬运**
 * (P1-a 是纯搬运,门是 `__tests__/wire-snapshots/anthropic` 的 29 份快照)。
 *
 * 三条这条线独有、迁移最容易做丢的规则:
 *  1. **thinking 回放块只在 `request.thinking === 'enabled'` 时拼**,而且
 *     `blocks.length > 0` 才 unshift —— 只剩思考块的 assistant 消息会被 API 拒;
 *  2. **tool_result 的富内容是全有全无**:一块图都没有时整条退回纯文本
 *     (`agentToolMessageContentToText(content)`),而不是把攒好的文本块交出去;
 *  3. user 侧 PDF 走 `document` 块,其余二进制留成可见文本(`Undeliverable`);
 *     tool_result 侧**没有** `document` 块,PDF 在那边只会变成文本。
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
	Undeliverable,
	delivered,
	undeliverable,
	type PartCodec,
	type PartDelivery,
	type TurnContext,
	type UndeliverablePartLike,
} from "../base/index.js";

// ---------------------------------------------------------------------------
// 线上形状
// ---------------------------------------------------------------------------

export type AnthropicCacheControl = { type: "ephemeral" };

export type AnthropicTextBlock = {
	type: "text";
	text: string;
	cache_control?: AnthropicCacheControl;
};

export type AnthropicImageBlock = {
	type: "image";
	source:
		| { type: "base64"; media_type: string; data: string }
		| { type: "url"; url: string };
	cache_control?: AnthropicCacheControl;
};

export type AnthropicToolUseBlock = {
	type: "tool_use";
	id: string;
	name: string;
	input: AgentJsonValue;
	cache_control?: AnthropicCacheControl;
};

export type AnthropicDocumentBlock = {
	type: "document";
	source: { type: "base64"; media_type: string; data: string };
	cache_control?: AnthropicCacheControl;
};

export type AnthropicThinkingBlock = {
	type: "thinking";
	thinking: string;
	signature: string;
};

export type AnthropicRedactedThinkingBlock = {
	type: "redacted_thinking";
	data: string;
};

export type AnthropicToolResultContentBlock =
	| AnthropicTextBlock
	| AnthropicImageBlock;

export type AnthropicToolResultBlock = {
	type: "tool_result";
	tool_use_id: string;
	content: string | AnthropicToolResultContentBlock[];
	is_error?: boolean;
	cache_control?: AnthropicCacheControl;
};

export type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicImageBlock
	| AnthropicDocumentBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock
	| AnthropicThinkingBlock
	| AnthropicRedactedThinkingBlock;

export type AnthropicMessage =
	| { role: "user"; content: string | AnthropicContentBlock[] }
	| { role: "assistant"; content: string | AnthropicContentBlock[] };

export interface AnthropicTool {
	name: string;
	description?: string;
	input_schema: AgentJsonObject;
	cache_control?: AnthropicCacheControl;
}

export type AnthropicToolChoice =
	| { type: "auto" }
	| { type: "any" }
	| { type: "tool"; name: string };

/** codec 交出来的两种东西:一条消息,或者一条消息里的一块内容。 */
export type AnthropicWireValue = AnthropicMessage | AnthropicContentBlock;

/** `buildClaudeMessages` 的返回形状:system 抽走,其余按序落成消息。 */
export interface AnthropicRequestMessages {
	system?: string;
	messages: AnthropicMessage[];
}

export function toAnthropicTools(
	tools: AgentTool[] | undefined,
): AnthropicTool[] | undefined {
	if (!tools?.length) return undefined;
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));
}

export function toAnthropicToolChoice(
	choice: AgentToolChoice | undefined,
): AnthropicToolChoice | undefined {
	if (!choice || choice === "auto") return { type: "auto" };
	if (choice === "none") return undefined;
	// Anthropic spells "must use a tool, any tool" as `any`.
	if (choice === "required") return { type: "any" };
	return { type: "tool", name: choice.function.name };
}

// ---------------------------------------------------------------------------
// 纯函数(逐字搬自 claude.ts)
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
	const match = value.match(/^data:([^;,]+);base64,(.*)$/);
	if (!match) return undefined;
	return { mediaType: match[1]!, data: match[2]! };
}

function imageSourceFromData(
	data: string,
	mediaType?: string,
): AnthropicImageBlock {
	if (data.startsWith("http://") || data.startsWith("https://")) {
		return { type: "image", source: { type: "url", url: data } };
	}
	const parsed = parseDataUrl(data);
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: parsed?.mediaType ?? mediaType ?? "image/png",
			data: parsed?.data ?? data,
		},
	};
}

function documentSourceFromData(
	data: string,
	mediaType: string,
): AnthropicDocumentBlock | undefined {
	const parsed = parseDataUrl(data);
	const resolvedMediaType = (parsed?.mediaType ?? mediaType)
		.split(";")[0]
		?.trim()
		.toLowerCase();
	if (resolvedMediaType !== "application/pdf") return undefined;
	return {
		type: "document",
		source: {
			type: "base64",
			media_type: "application/pdf",
			data: parsed?.data ?? data,
		},
	};
}

function parseToolArguments(args: string): AgentJsonValue {
	const trimmed = args.trim();
	if (!trimmed) return {};
	try {
		return JSON.parse(trimmed) as AgentJsonValue;
	} catch {
		return {};
	}
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

/**
 * 上一回合捕获的思考块,原样回放。Anthropic 要求携带过 tool_use 的那条
 * assistant 消息在被送回时保留它的 thinking 块(含 signature),与 codex 的
 * encrypted-reasoning 往返同理。
 */
function thinkingReplayBlocks(message: AgentMessage): AnthropicContentBlock[] {
	const blocks: AnthropicContentBlock[] = [];
	for (const data of message.providerData ?? []) {
		if (data.provider !== "claude") continue;
		if (
			data.type === "thinking" &&
			typeof data.signature === "string" &&
			data.signature
		) {
			blocks.push({
				type: "thinking",
				thinking: typeof data.thinking === "string" ? data.thinking : "",
				signature: data.signature,
			});
			continue;
		}
		if (
			data.type === "redacted-thinking" &&
			typeof data.data === "string" &&
			data.data
		) {
			blocks.push({ type: "redacted_thinking", data: data.data });
		}
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// codec 契约(线级)
// ---------------------------------------------------------------------------

/**
 * `PartCodec` 之外多出来的一条 `toRequestMessages()`:anthropic-messages 把
 * system 抽成请求体的一个顶层字段,而 tool 消息落成 user 消息里的一块
 * `tool_result` —— 「一条 `AgentMessage` = 一条线上消息」在这条线上不成立,
 * 所以 wire 问的是整段。`PartCodec` 的四个成员仍是**投递契约**的入口
 * (设计稿 §2.3),P2 的「能力说行就必须 delivered」矩阵断言读的是它们。
 */
export interface AnthropicCodec extends PartCodec<AnthropicWireValue> {
	toRequestMessages(
		messages: AgentMessage[],
		turn?: TurnContext,
	): AnthropicRequestMessages;
}

export class AnthropicPartCodec implements AnthropicCodec {
	system(text: string): AnthropicWireValue {
		return { type: "text", text };
	}

	user(
		part: AgentContentPart,
		turn?: TurnContext,
	): PartDelivery<AnthropicWireValue> {
		if (part.type === "text") return delivered({ type: "text", text: part.text });
		if (part.type === "image") {
			return delivered(imageSourceFromData(part.image, part.mediaType));
		}
		if (part.type === "file") {
			if (part.mediaType.startsWith("image/")) {
				return delivered(imageSourceFromData(part.data, part.mediaType));
			}
			const pdf = documentSourceFromData(part.data, part.mediaType);
			if (pdf) return delivered(pdf);
		}
		// Text files are inlined as text parts upstream; whatever binary is
		// left has no Claude-native form — say so instead of dropping it.
		const note = Undeliverable.fromPart(
			undeliverablePartLike(part),
			"wire-has-no-part",
		);
		warnUndeliverable(note, part, turn);
		return undeliverable(note);
	}

	/**
	 * 思考回放块**前置**,但绝不单独出现 —— 只由思考块组成的 assistant 消息
	 * 会被 API 拒。开关是 `request.thinking === 'enabled'`,不是「历史里有没有」。
	 */
	assistant(message: AgentMessage, turn?: TurnContext): AnthropicWireValue[] {
		const blocks: AnthropicContentBlock[] = [];
		const text = textFromContent(message.content);
		if (text) blocks.push({ type: "text", text });
		for (const toolCall of message.toolCalls ?? []) {
			blocks.push({
				type: "tool_use",
				id: toolCall.id,
				name: toolCall.name,
				input: parseToolArguments(toolCall.arguments),
			});
		}
		if (turn?.request.thinking === "enabled" && blocks.length > 0) {
			blocks.unshift(...thinkingReplayBlocks(message));
		}
		return blocks;
	}

	toolResult(
		part: AgentContentPart,
		turn?: TurnContext,
	): PartDelivery<AnthropicWireValue> {
		if (part.type === "text") {
			return delivered({ type: "text", text: part.text });
		}
		if (part.type === "image") {
			return delivered(imageSourceFromData(part.image, part.mediaType));
		}
		if (part.type === "file" && part.mediaType.startsWith("image/")) {
			return delivered(imageSourceFromData(part.data, part.mediaType));
		}
		// tool_result 这一侧没有 document 块:非图附件只能变成文本。读不出文本
		// 的(音频/视频)就是这条线接不住的块。
		const text = agentToolMessageContentToText([part]);
		if (text) return delivered({ type: "text", text });
		const note = Undeliverable.fromPart(
			undeliverablePartLike(part),
			"tool-result-text-only",
		);
		warnUndeliverable(note, part, turn);
		return undeliverable(note);
	}

	toRequestMessages(
		messages: AgentMessage[],
		turn?: TurnContext,
	): AnthropicRequestMessages {
		const system: string[] = [];
		const result: AnthropicMessage[] = [];

		for (const message of messages) {
			if (message.role === "system") {
				const text = textFromContent(message.content).trim();
				if (text) system.push(text);
				continue;
			}

			if (message.role === "tool") {
				result.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: message.toolCallId ?? "",
							content: this.toolResultContent(message.content, turn),
							// Without is_error a failed tool reads to the model as a
							// successful result whose text merely describes a problem.
							...(message.isError === true && { is_error: true }),
						},
					],
				});
				continue;
			}

			if (message.role === "assistant") {
				const blocks = this.assistant(message, turn) as AnthropicContentBlock[];
				result.push({
					role: "assistant",
					content: blocks.length > 0 ? blocks : "",
				});
				continue;
			}

			result.push({
				role: "user",
				content: this.userContent(message.content, turn),
			});
		}

		return {
			...(system.length > 0 ? { system: system.join("\n\n") } : {}),
			messages: result,
		};
	}

	private userContent(
		content: AgentMessageContent,
		turn?: TurnContext,
	): string | AnthropicContentBlock[] {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";

		const blocks: AnthropicContentBlock[] = [];
		for (const part of content) {
			if (part.type !== "text" && part.type !== "image" && part.type !== "file") {
				// audio / video 这些模态归 core 的
				// `degradeUnsupportedAgentContentParts` 管,provider 这一层原样丢掉
				// (单一 owner,设计稿 §2.3)。
				continue;
			}
			const delivery = this.user(part, turn);
			if (delivery.kind === "delivered") {
				blocks.push(delivery.part as AnthropicContentBlock);
				continue;
			}
			blocks.push({ type: "text", text: delivery.note.toText() });
		}
		return blocks.length > 0 ? blocks : "";
	}

	/**
	 * **富内容是全有全无**:一块图都没有时整条退回
	 * `agentToolMessageContentToText(content)`,攒好的文本块被丢掉。这是今天的
	 * 行为,不是「应该的行为」—— 快照钉着它。
	 */
	private toolResultContent(
		content: AgentMessageContent,
		turn?: TurnContext,
	): string | AnthropicToolResultContentBlock[] {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";

		const blocks: AnthropicToolResultContentBlock[] = [];
		let hasRichContent = false;

		for (const part of content) {
			if (part.type === "text") {
				if (part.text) blocks.push({ type: "text", text: part.text });
				continue;
			}

			if (part.type === "image") {
				blocks.push(imageSourceFromData(part.image, part.mediaType));
				hasRichContent = true;
				continue;
			}

			if (part.type === "file" && part.mediaType.startsWith("image/")) {
				blocks.push(imageSourceFromData(part.data, part.mediaType));
				hasRichContent = true;
				continue;
			}

			const delivery = this.toolResult(part, turn);
			if (delivery.kind === "delivered") {
				blocks.push(delivery.part as AnthropicToolResultContentBlock);
			}
		}

		return hasRichContent ? blocks : agentToolMessageContentToText(content);
	}
}

export const anthropicParts: AnthropicCodec = new AnthropicPartCodec();
