/**
 * `openai-effort` —— OpenAI o 系 / gpt-5:只有 `reasoning_effort`,思考关不掉
 * (所以 `disabled` 什么都不发),`xhigh` / `max` 一律夹到 `high`。
 *
 * 逐字复刻 `openai-compatible.ts` 的 `'openai-effort'` 分支 +
 * `clampOpenAIReasoningEffort`。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { OpenAIChatThinkingWire } from "./openai-chat-thinking-wire.js";

export function clampOpenAIReasoningEffort(
	effort: string | undefined,
): "minimal" | "low" | "medium" | "high" {
	if (effort === "minimal" || effort === "low" || effort === "medium") return effort;
	return "high";
}

export class OpenAIEffortWire extends OpenAIChatThinkingWire {
	readonly id = "openai-effort";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		if (turn.request.thinking !== "enabled") return;
		builder.set(
			"reasoning_effort",
			clampOpenAIReasoningEffort(turn.request.reasoningEffort),
		);
	}
}

export const openAIEffortWire = new OpenAIEffortWire();
