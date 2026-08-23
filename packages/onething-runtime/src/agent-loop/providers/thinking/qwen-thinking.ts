/**
 * `qwen-thinking` —— 千问的 `enable_thinking` 布尔开关。
 *
 * `reasoning_effort` 只随**文档里收它的那几族**一起发:qwen3.8-max 收
 * low|medium|xhigh,转售的 GLM / DeepSeek 收 high|max;其余模型是
 * thinking_budget 驱动的,effort 和 budget 一起到会 400,所以什么都不发。
 *
 * 逐字复刻 `openai-compatible.ts` 的 `'qwen-thinking'` 分支 +
 * `clampQwenReasoningEffort`。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { OpenAIChatThinkingWire } from "./openai-chat-thinking-wire.js";

export function clampQwenReasoningEffort(
	effort: string | undefined,
	model: string,
): string | undefined {
	if (!effort) return undefined;
	const lower = model.toLowerCase();
	if (lower.includes("qwen3.8-max")) {
		if (effort === "minimal" || effort === "low") return "low";
		if (effort === "medium") return "medium";
		return "xhigh";
	}
	if (/^glm-|^deepseek-v[34]/.test(lower)) {
		return effort === "max" || effort === "xhigh" ? "max" : "high";
	}
	return undefined;
}

export class QwenThinkingWire extends OpenAIChatThinkingWire {
	readonly id = "qwen-thinking";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		const { thinking, reasoningEffort } = turn.request;
		if (thinking === "enabled") {
			builder.set("enable_thinking", true);
			const effort = clampQwenReasoningEffort(reasoningEffort, turn.model);
			if (effort) builder.set("reasoning_effort", effort);
			return;
		}
		if (thinking === "disabled") builder.set("enable_thinking", false);
	}
}

export const qwenThinkingWire = new QwenThinkingWire();
