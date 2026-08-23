/**
 * `openai-effort` —— OpenAI o 系 / gpt-5:只有 `reasoning_effort`,
 * `xhigh` / `max` 一律夹到 `high`。
 *
 * **关得掉与关不掉是按模型分的**(P3-3):gpt-5.1 起这条线多一个
 * `reasoning_effort: 'none'` 档 —— 那是这一家唯一的「别想」开关(它始终没有
 * `thinking` 参数)。判据只有一个,就是账本:`profile.reasoningProfile.efforts`
 * 里有没有 `'none'`。没有(o 系列、gpt-5.0)就保持今天的行为:`disabled` 什么
 * 都不发。wire 自己不认模型名。
 *
 * `enabled` 一路逐字未变(`clampOpenAIReasoningEffort` 的值域仍是四档):
 * `'none'` 不是一个可选的思考强度,它是思考的缺席。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { OpenAIChatThinkingWire } from "./openai-chat-thinking-wire.js";

export function clampOpenAIReasoningEffort(
	effort: string | undefined,
): "minimal" | "low" | "medium" | "high" {
	if (effort === "minimal" || effort === "low" || effort === "medium") return effort;
	return "high";
}

/** 这个模型收不收 `reasoning_effort: 'none'` —— 账本说了算。 */
export function openAIAcceptsNoneEffort(turn: TurnContext): boolean {
	return turn.profile.reasoningProfile?.efforts.includes("none") ?? false;
}

export class OpenAIEffortWire extends OpenAIChatThinkingWire {
	readonly id = "openai-effort";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		if (turn.request.thinking === "disabled") {
			if (openAIAcceptsNoneEffort(turn)) builder.set("reasoning_effort", "none");
			return;
		}
		if (turn.request.thinking !== "enabled") return;
		builder.set(
			"reasoning_effort",
			clampOpenAIReasoningEffort(turn.request.reasoningEffort),
		);
	}
}

export const openAIEffortWire = new OpenAIEffortWire();
