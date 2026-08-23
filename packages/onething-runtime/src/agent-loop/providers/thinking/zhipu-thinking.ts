/**
 * `zhipu-thinking` —— GLM-4.5+ 只有 `thinking: {type}`,没有档位旋钮。
 *
 * 逐字复刻 `openai-compatible.ts` 的 `'zhipu-thinking'` 分支。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { OpenAIChatThinkingWire } from "./openai-chat-thinking-wire.js";

export class ZhipuThinkingWire extends OpenAIChatThinkingWire {
	readonly id = "zhipu-thinking";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		if (turn.request.thinking) builder.set("thinking", { type: turn.request.thinking });
	}
}

export const zhipuThinkingWire = new ZhipuThinkingWire();
