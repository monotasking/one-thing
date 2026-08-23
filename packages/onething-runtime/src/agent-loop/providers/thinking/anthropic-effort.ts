/**
 * anthropic-messages 三条思考线型的公共件。
 *
 * `clampClaudeReasoningEffort` 是 `claude.ts` 退役前 `claudeEffort()` 的逐字
 * 搬运:`minimal → low`,`xhigh` 只在**支持**的家族上活下来(否则钳成
 * `high`),`low / medium / max` 原样,其余(含 `undefined`)一律 `high`。
 *
 * 家族判定用的是账本的 `onethingClaudeModelFamily(model)` —— **原样保留**,
 * 包括老式带日期 id(`claude-3-7-sonnet-20250219`)的日期段被当版本号那条现状
 * (快照 `thinking-high.claude-3-7-sonnet.request.json` 钉着它;修正排 P1-d)。
 */
import type { AgentReasoningEffort } from "@onething/core/agent-loop";
import {
	onethingClaudeModelFamily,
	type OnethingClaudeModelFamily,
} from "../../../providers/model-capability.js";
import type {
	RequestBodyBuilder,
	ThinkingWire,
	TurnContext,
} from "../base/index.js";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export function clampClaudeReasoningEffort(
	effort: AgentReasoningEffort | undefined,
	family: OnethingClaudeModelFamily,
): ClaudeEffort {
	if (effort === "minimal") return "low";
	if (effort === "xhigh") return family.supportsXhigh ? "xhigh" : "high";
	if (effort === "low" || effort === "medium" || effort === "max") return effort;
	return "high";
}

/**
 * 这条线上的三种线型共享的壳:`decode` / `replay` 都不在这里 —— thinking 增量
 * 与签名块的累积是 `AnthropicMessagesWire.parseStream` 的状态机的事(线协议把
 * 它们编成了独立的 content block),回放则由 `AnthropicPartCodec.assistant` 拼。
 */
export abstract class AnthropicThinkingWire implements ThinkingWire {
	abstract readonly id: string;
	abstract encode(turn: TurnContext, builder: RequestBodyBuilder): void;

	protected family(turn: TurnContext): OnethingClaudeModelFamily {
		return onethingClaudeModelFamily(turn.model);
	}

	protected effort(turn: TurnContext): ClaudeEffort {
		return clampClaudeReasoningEffort(turn.request.reasoningEffort, this.family(turn));
	}
}
