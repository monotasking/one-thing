/**
 * `deepseek-inferred` —— DeepSeek 的思考线型,和 `thinking-type` 的差别有三处,
 * 每一处都是**今天的行为**(P0a 如实复刻,不修):
 *
 *  1. **推断**:调用方什么都不说时,reasoner 类模型自己打开思考
 *     (`resolveDeepSeekThinking`)。这条规则曾经住在旧门面的 deepseek-only
 *     generate 路上,也正是那条路删不掉的原因 —— 丢了它,从没显式开过思考的
 *     调用方(最显眼的是上下文压缩)会被静默关掉思考。
 *  2. **档位**:只有调用方**真的要求**思考时 effort 才默认 `high`;仅由模型名
 *     推断出来的思考一个 effort 都不发(替没人拧过的旋钮花钱不是默认行为)。
 *     DeepSeek 只收 high/max,低于 high 的一律夹上去。
 *  3. **回读**:只认 `reasoning_content`,不认 OpenRouter 那套统一的
 *     `reasoning`(设计稿 §13:两边的语义差 P0a 原样保留)。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { OpenAIChatThinkingWire, openAIChatDelta } from "./openai-chat-thinking-wire.js";

export function isDeepSeekThinkingModel(modelId: string): boolean {
	const lower = modelId.toLowerCase();
	return (
		lower.includes("reasoner") ||
		lower.includes("thinking") ||
		/(^|[^a-z])v4/.test(lower)
	);
}

export function resolveDeepSeekThinking(
	modelId: string,
	requested: "enabled" | "disabled" | undefined,
): "enabled" | "disabled" | undefined {
	if (requested) return requested;
	return isDeepSeekThinkingModel(modelId) ? "enabled" : undefined;
}

export class DeepSeekInferredThinkingWire extends OpenAIChatThinkingWire {
	readonly id = "deepseek-inferred";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		const thinking = resolveDeepSeekThinking(turn.model, turn.request.thinking);
		if (thinking) builder.set("thinking", { type: thinking });
		if (thinking !== "enabled") return;
		const effort =
			turn.request.reasoningEffort ??
			(turn.request.thinking === "enabled" ? "high" : undefined);
		if (effort) builder.set("reasoning_effort", effort === "max" ? "max" : "high");
	}

	/** DeepSeek 不发 `delta.reasoning` —— 只读 `reasoning_content`。 */
	override decode(chunk: unknown): { reasoningDelta?: string } | undefined {
		const reasoning = openAIChatDelta(chunk)?.reasoning_content;
		return reasoning ? { reasoningDelta: reasoning } : undefined;
	}
}

export const deepSeekInferredThinkingWire = new DeepSeekInferredThinkingWire();
