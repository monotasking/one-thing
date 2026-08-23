/**
 * openai-chat 线上思考线型的公共半边(设计稿 §3 `ThinkingWire`)。
 *
 * 这条线协议上「怎么把思维链**读回来**」是线级的事,不是每家的事:
 * `delta.reasoning_content ?? delta.reasoning`(`openai-compatible.ts` 逐字)。
 * 唯一的例外是 DeepSeek —— 它只读 `reasoning_content`,那条差异由
 * `deepseek-inferred` 自己覆盖 `decode()` 表达(P0a 如实复刻,见设计稿 §13
 * 「deepseek/OC 的 `delta.reasoning` 语义差进 reasoningFields 表」)。
 *
 * 每家不同的只有 `encode()` —— 一家一个子类,一个文件。
 */
import type { RequestBodyBuilder, ThinkingWire, TurnContext } from "../base/index.js";

/** `delta` 这一小块的读法 —— 线级形状,不是某一家的。 */
export interface OpenAIChatReasoningDelta {
	content?: string | null;
	reasoning_content?: string | null;
	reasoning?: string | null;
}

export function openAIChatDelta(chunk: unknown): OpenAIChatReasoningDelta | undefined {
	if (typeof chunk !== "object" || chunk === null) return undefined;
	const choices = (chunk as { choices?: Array<{ delta?: OpenAIChatReasoningDelta }> })
		.choices;
	return choices?.[0]?.delta;
}

export abstract class OpenAIChatThinkingWire implements ThinkingWire {
	abstract readonly id: string;

	abstract encode(turn: TurnContext, builder: RequestBodyBuilder): void;

	decode(chunk: unknown): { reasoningDelta?: string } | undefined {
		const delta = openAIChatDelta(chunk);
		const reasoning = delta?.reasoning_content ?? delta?.reasoning;
		return reasoning ? { reasoningDelta: reasoning } : undefined;
	}
}
