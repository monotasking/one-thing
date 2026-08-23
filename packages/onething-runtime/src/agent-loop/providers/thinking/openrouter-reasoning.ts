/**
 * `openrouter-reasoning` —— OpenRouter 统一的 `reasoning: {}` 对象:
 * 开 = `{effort}`(不给档位默认 `high`),关 = `{enabled:false}`。
 *
 * 逐字复刻 `openai-compatible.ts` 的 `'openrouter-reasoning'` 分支。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { OpenAIChatThinkingWire } from "./openai-chat-thinking-wire.js";

export class OpenRouterReasoningWire extends OpenAIChatThinkingWire {
	readonly id = "openrouter-reasoning";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		const { thinking, reasoningEffort } = turn.request;
		if (thinking === "enabled") {
			builder.set("reasoning", { effort: reasoningEffort ?? "high" });
			return;
		}
		if (thinking === "disabled") builder.set("reasoning", { enabled: false });
	}
}

export const openRouterReasoningWire = new OpenRouterReasoningWire();
