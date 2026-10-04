/**
 * `zhipu-thinking` —— GLM-4.5+ 只有 `thinking: {type}`,没有档位旋钮。
 *
 * 逐字复刻 `openai-compatible.ts` 的 `'zhipu-thinking'` 分支。登记进 `thinkingWires` 由
 * `vendors/runtimes.ts` 做(本家的 `ZHIPU_RUNTIME.thinkingWires`)。
 */
import type { RequestBodyBuilder, TurnContext } from "../../base/provider-base.js";
import { OpenAIChatThinkingWire } from "../../thinking/openai-chat-thinking-wire.js";

export class ZhipuThinkingWire extends OpenAIChatThinkingWire {
	readonly id = "zhipu-thinking";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		if (turn.request.thinking) builder.set("thinking", { type: turn.request.thinking });
	}
}

export const zhipuThinkingWire = new ZhipuThinkingWire();
