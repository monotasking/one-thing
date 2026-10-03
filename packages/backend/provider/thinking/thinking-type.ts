/**
 * `thinking-type` —— Kimi / DeepSeek 系兼容端点的写法:`thinking: {type}` 直发,
 * `reasoning_effort` 原样透传(不钳位)。
 *
 * 逐字复刻 `openai-compatible.ts` `applyReasoningParams` 的 `'thinking-type'` 分支。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { OpenAIChatThinkingWire } from "./openai-chat-thinking-wire.js";

export class ThinkingTypeWire extends OpenAIChatThinkingWire {
	readonly id = "thinking-type";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		const { thinking, reasoningEffort } = turn.request;
		if (thinking) builder.set("thinking", { type: thinking });
		if (reasoningEffort) builder.set("reasoning_effort", reasoningEffort);
	}
}

export const thinkingTypeWire = new ThinkingTypeWire();
