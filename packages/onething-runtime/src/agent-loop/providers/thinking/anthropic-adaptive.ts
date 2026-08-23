/**
 * `anthropic-adaptive` —— 4.6+ 家族(Sonnet 5 / Opus 4.6+):
 * `thinking: {type:'adaptive'}` + `output_config.effort`,而**思考关掉时要显式
 * 发 `{type:'disabled'}`** —— 这一家在参数缺席时自己就会开思考。
 *
 * 逐字复刻 `claude.ts` 退役前 `streamTurn` 里 `family.adaptive` 的两条分支。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { AnthropicThinkingWire } from "./anthropic-effort.js";

export class AnthropicAdaptiveThinkingWire extends AnthropicThinkingWire {
	readonly id = "anthropic-adaptive";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		if (turn.request.thinking === "enabled") {
			builder.set("thinking", { type: "adaptive" });
			builder.set("output_config", { effort: this.effort(turn) });
			return;
		}
		// Sonnet 5 runs adaptive thinking when the param is omitted; an explicit
		// off must be sent. Fable rejects 'disabled', hence its own wire.
		if (turn.request.thinking === "disabled") {
			builder.set("thinking", { type: "disabled" });
		}
	}
}

export const anthropicAdaptiveThinkingWire = new AnthropicAdaptiveThinkingWire();
