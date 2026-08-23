/**
 * `grok-effort` —— xAI 的 `reasoning_effort`,按模型定上限:只有 grok-4.20
 * 多智能体族收 `xhigh`,其余封顶 `high`;思考关不掉,`disabled` 什么都不发。
 *
 * 逐字复刻 `openai-compatible.ts` 的 `'grok-effort'` 分支 +
 * `clampGrokReasoningEffort`。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { OpenAIChatThinkingWire } from "./openai-chat-thinking-wire.js";

export function clampGrokReasoningEffort(
	effort: string | undefined,
	model: string,
): "low" | "medium" | "high" | "xhigh" {
	if (effort === "minimal" || effort === "low") return "low";
	if (effort === "medium") return "medium";
	if ((effort === "xhigh" || effort === "max") && model.toLowerCase().includes("4.20")) {
		return "xhigh";
	}
	return "high";
}

export class GrokEffortWire extends OpenAIChatThinkingWire {
	readonly id = "grok-effort";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		if (turn.request.thinking !== "enabled") return;
		builder.set(
			"reasoning_effort",
			clampGrokReasoningEffort(turn.request.reasoningEffort, turn.model),
		);
	}
}

export const grokEffortWire = new GrokEffortWire();
