/**
 * `anthropic-always-thinking` —— Fable / Mythos:思考永远开着,`thinking` 参数
 * 会被端点拒,**只发 `output_config.effort`**。
 *
 * 这条线型不在账本的 `OnethingReasoningWire` 枚举里(账本给 Fable 记的是
 * `anthropic-adaptive`)—— 选它的是 `AnthropicMessagesWire.thinkingFor()` 按
 * `onethingClaudeModelFamily(model).alwaysThinking` 做的判定,与今天
 * `claude.ts` 的分支顺序逐字一致。P2 把这条并进 `ModelProfile` 之后,id 才会
 * 回到账本的枚举里。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { AnthropicThinkingWire } from "./anthropic-effort.js";

export const ANTHROPIC_ALWAYS_THINKING_WIRE_ID = "anthropic-always-thinking";

export class AnthropicAlwaysThinkingWire extends AnthropicThinkingWire {
	readonly id = ANTHROPIC_ALWAYS_THINKING_WIRE_ID;

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		if (turn.request.thinking !== "enabled") return;
		builder.set("output_config", { effort: this.effort(turn) });
	}
}

export const anthropicAlwaysThinkingWire = new AnthropicAlwaysThinkingWire();
