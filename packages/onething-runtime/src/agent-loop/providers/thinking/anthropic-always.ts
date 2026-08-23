/**
 * `anthropic-always` —— Fable / Mythos:思考永远开着,`thinking` 参数
 * 会被端点拒,**只发 `output_config.effort`**。
 *
 * P2-a 起这条线型在账本的 `OnethingReasoningWire` 枚举里:选它的是
 * `ModelProfile.reasoningWire`(账本的 `claudeReasoningWire` 读
 * `onethingClaudeModelFamily(model).alwaysThinking`),基类按 id 找。
 * wire 层那份重复的家族分支随之删除。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { AnthropicThinkingWire } from "./anthropic-effort.js";

export const ANTHROPIC_ALWAYS_THINKING_WIRE_ID = "anthropic-always";

export class AnthropicAlwaysThinkingWire extends AnthropicThinkingWire {
	readonly id = ANTHROPIC_ALWAYS_THINKING_WIRE_ID;

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		if (turn.request.thinking !== "enabled") return;
		builder.set("output_config", { effort: this.effort(turn) });
	}
}

export const anthropicAlwaysThinkingWire = new AnthropicAlwaysThinkingWire();
