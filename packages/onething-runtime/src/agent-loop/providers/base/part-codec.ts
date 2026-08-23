/**
 * 投递契约 —— **每个 part 要么进请求体,要么留可见文本**(设计稿 §2.3)。
 *
 * 单一 owner:core 的 `degradeUnsupportedAgentContentParts` 负责「能力说不行」
 * 的模态降级(`[Image]` 一类);这里的 `Undeliverable` **只**负责「能力说行、
 * 线协议做不到」(chat-completions 的 tool_result 图、PDF)。两套文案词汇
 * 不重叠,P2 的架构测试把「不许打架」定为不变式。
 *
 * 可见文案只在 `Undeliverable.toText()` 一处。措辞逐字沿用今天
 * `openai-compatible.ts` 用的那句(core 的 `undeliverableAttachmentText`);
 * `__tests__/architecture.test.ts` 拿两边对同一个 part 的输出做等值断言,
 * 谁先改了谁红。
 */
import type {
	AgentContentPart,
	AgentMessage,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import type { TurnContext } from "./turn-context.js";

/** 这个 part 为什么进不了请求体。P0a 只有一条 —— 线协议没有这种块。 */
export type UndeliverableReason =
	/** chat-completions 之类的端点没有对应的内容块类型(二进制附件、PDF)。 */
	| "wire-has-no-part"
	/** 线协议的 tool 消息只收文本(OpenAI chat-completions)。 */
	| "tool-result-text-only";

/** `Undeliverable` 构造要读的那几个字段 —— 与 `AgentFileContentPart` 兼容。 */
export interface UndeliverablePartLike {
	filename?: string;
	mediaType?: string;
	mimeType?: string;
	path?: string;
}

export class Undeliverable {
	constructor(
		readonly label: string,
		readonly reason: UndeliverableReason,
		private readonly part: UndeliverablePartLike = {},
	) {}

	static fromPart(
		part: UndeliverablePartLike,
		reason: UndeliverableReason,
	): Undeliverable {
		return new Undeliverable(part.filename || "attachment", reason, part);
	}

	/**
	 * 模型看得见的替身。**逐字**沿用 core `undeliverableAttachmentText` 的措辞
	 * —— provider 不静默丢块,模型知道有过一个附件,也就不会瞎编它的内容。
	 */
	toText(): string {
		const name = this.part.filename || "attachment";
		const kind = this.part.mediaType || this.part.mimeType || "unknown type";
		const base = `[Attachment "${name}" (${kind}) could not be delivered: this model does not accept this file type.`;
		return this.part.path
			? `${base} The file is on disk at "${this.part.path}" — use your file tools to read it.]`
			: `${base}]`;
	}
}

export type PartDelivery<W> =
	| { kind: "delivered"; part: W }
	| { kind: "undeliverable"; note: Undeliverable };

export function delivered<W>(part: W): PartDelivery<W> {
	return { kind: "delivered", part };
}

export function undeliverable<W>(note: Undeliverable): PartDelivery<W> {
	return { kind: "undeliverable", note };
}

/**
 * 一条 wire 的消息序列化器。`W` 是那条线协议的消息/内容块类型。
 *
 * `assistant()` 返回数组是因为思维链回传与块序是它的事:Anthropic 的
 * thinking 块必须前置且带 signature、codex 的 encrypted 块、OpenRouter 的
 * `reasoning_details` 原样回传 —— 一条 `AgentMessage` 可能落成好几块。
 */
export interface PartCodec<W = unknown> {
	system(text: string, turn: TurnContext): W;
	user(part: AgentContentPart, turn: TurnContext): PartDelivery<W>;
	assistant(message: AgentMessage, turn: TurnContext): W[];
	toolResult(part: AgentContentPart, turn: TurnContext): PartDelivery<W>;
	/** 方言缝:reasoning_details / images[] / 顶层 citations / web_search。 */
	decodeExtras?(chunk: unknown, turn: TurnContext): AgentTurnStreamEvent[];
}
