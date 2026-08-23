/**
 * openai-responses 线上唯一的思考线型 —— `codex.ts` 退役前
 * `buildCodexRequestBody` 里那三行(`reasoning` / `include` /
 * `normalizeCodexReasoningEffort`)的**逐字搬运**(P1-c 是纯搬运,门是
 * `__tests__/wire-snapshots/responses` 的 9 份快照,**禁 `-u`**)。
 *
 * 三条别家没有、迁移最容易做丢的规则:
 *  1. **`include` 与 `reasoning` 同生共死**:发思考就发
 *     `include: ['reasoning.encrypted_content']`(加密思维链要能回放),不发
 *     思考时 `include` **退成空数组而不是不发** —— 请求体里恒有这个键;
 *  2. **不说话不等于不思考**:`thinking` 没给时,只要模型名认得出是推理模型
 *     (`isCodexReasoningModel`)或者显式给了 effort,就自己补上
 *     `effort: 'medium'`;
 *  3. **effort `max` 钳到 `high`** —— Responses 没有 `xhigh` 这一档,认不出的
 *     值一律落回 `medium`。
 *
 * id 用账本的 `OnethingReasoningWire` 值 **`'codex'`**(不是文件名里的
 * `responses-reasoning`):`HttpAgentProvider.thinkingFor()` 拿
 * `ModelProfile.reasoningWire` 去 `find`,两边得对得上。
 */
import type { RequestBodyBuilder, ThinkingWire, TurnContext } from "../base/index.js";

export type CodexReasoningEffort =
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

export interface CodexReasoningOptions {
	effort: CodexReasoningEffort;
	summary: "auto";
}

/** 请求体里的两个落点。 */
export const RESPONSES_REASONING_PATH = "reasoning";
export const RESPONSES_INCLUDE_PATH = "include";

/** 加密思维链要回放,就得让服务端把它带回来。 */
export const RESPONSES_ENCRYPTED_REASONING_INCLUDE =
	"reasoning.encrypted_content";

/** `isCodexReasoningModel` 逐字。 */
export function isCodexReasoningModel(model: string): boolean {
	const lower = model.toLowerCase();
	if (lower.includes("gpt-5.2-chat") || lower.includes("gpt-5.2-instant"))
		return false;
	return (
		lower.startsWith("gpt-5") ||
		lower.includes("codex") ||
		/\bo[13](?:-|$)/.test(lower) ||
		lower.includes("reasoning")
	);
}

/** `normalizeCodexReasoningEffort` 逐字:`max` 钳 `high`,认不出落 `medium`。 */
export function normalizeCodexReasoningEffort(
	effort: unknown,
): CodexReasoningEffort {
	if (effort === "max") return "high";
	if (
		effort === "minimal" ||
		effort === "low" ||
		effort === "medium" ||
		effort === "high"
	)
		return effort;
	return "medium";
}

export class ResponsesReasoningWire implements ThinkingWire {
	readonly id = "codex";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		const reasoning = this.reasoning(turn);
		// `include` 恒有键 —— 关掉思考时是 `[]`,不是「不发」。
		builder.set(
			RESPONSES_INCLUDE_PATH,
			reasoning ? [RESPONSES_ENCRYPTED_REASONING_INCLUDE] : [],
		);
		if (reasoning) builder.set(RESPONSES_REASONING_PATH, reasoning);
	}

	private reasoning(turn: TurnContext): CodexReasoningOptions | undefined {
		const { thinking, model, reasoningEffort } = turn.request;
		if (thinking === "disabled") {
			if (reasoningEffort !== undefined) {
				turn.warn(
					"thinking-unsupported",
					"reasoning effort is dropped while thinking is disabled",
					{ reasoningEffort },
				);
			}
			return undefined;
		}
		if (!isCodexReasoningModel(model) && !reasoningEffort) return undefined;
		const effort = normalizeCodexReasoningEffort(reasoningEffort);
		if (reasoningEffort !== undefined && reasoningEffort !== effort) {
			turn.warn(
				"setting-clamped",
				"reasoning effort was clamped to a level Responses accepts",
				{ requested: reasoningEffort, sent: effort },
			);
		}
		return { effort, summary: "auto" };
	}
}

export const responsesReasoningWire = new ResponsesReasoningWire();

/** 这条 wire 上可能出现的线型 —— 今天只有一条。 */
export const RESPONSES_THINKING_WIRES: ThinkingWire[] = [responsesReasoningWire];
