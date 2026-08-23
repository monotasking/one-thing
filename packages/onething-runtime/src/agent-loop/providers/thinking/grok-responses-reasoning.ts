/**
 * `grok-responses` —— xAI 在 **`POST /v1/responses`** 上的思考线型(P4-4)。
 *
 * 与 chat-completions 上那条(`grok-effort.ts`,顶层 `reasoning_effort`)是
 * 同一个旋钮的两种拼法:Responses 把它嵌进 `reasoning: { effort }`。
 *
 * ## 官方原文(docs.x.ai,2026-08-23 核)
 *
 *  - `/developers/model-capabilities/text/reasoning`:
 *    「`grok-4.6` and `grok-4.5` support the `reasoning_effort` parameter…
 *      If not specified, `reasoning_effort` defaults to `"high"`.
 *      **Reasoning cannot be disabled.**」
 *    档位表:`low` / `medium` / `high`(默认)/ `xhigh`;
 *    「`"xhigh"` is available on `grok-4.6` and later. On models that do not
 *      support it, such as `grok-4.5`, requests with `"xhigh"` are treated as
 *      `"high"`.」
 *    `grok-4.20-multi-agent` 的 `reasoning.effort` 控制的是**智能体条数**
 *    (4 或 16),取值同样是四档。
 *  - Responses 的 curl 例子:`"reasoning": {"effort": "high"}`。
 *  - `/developers/rest-api-reference/inference/chat` 的 `POST /v1/responses`
 *    还列着一个顶层 `reasoning_effort`:「reasoning_effort alternative to
 *    reasoning configuration… We only look at this if the `reasoning` field is
 *    unset.」—— 我们发 `reasoning`,所以不发它。
 *
 * ## 两处官方自相矛盾(**待真机核**,不猜)
 *
 * REST 参考页对 `reasoning.effort` 写的是「Only supported by `grok-4.3`.
 * Possible values are `none` (disables reasoning completely), `low` (default),
 * `medium` and `high`」,与上面那页(4.6 / 4.5 支持、默认 high、**关不掉**、
 * 有 xhigh)直接打架,而且两页都没提 `grok-4`。
 *
 * 这一版按**能力页**走(它是讲这个参数的专页,且与 Release Notes 对得上:
 * 「Reasoning effort supports low, medium, high (default), and xhigh」),
 * 并保留今天 chat 通路上那条**保守**的规矩:`thinking === 'disabled'` 时
 * 一个字段都不发(关不掉 ⇒ 不发比发 `none` 安全,`none` 只在 4.3 那页出现过)。
 * `grok-4` / `grok-4.3` 的实际取值集合等一次真机打点再定。
 *
 * ## id 是 `'grok-effort'`,不是文件名
 *
 * `HttpAgentProvider.thinkingFor()` 拿 `ModelProfile.reasoningWire` 去
 * `find`,账本(`providers/model-capability.ts`)给 xAI 记的值是
 * `'grok-effort'` —— 两边得对得上。与 `responses-reasoning.ts` 用
 * `id = 'codex'` 是同一个理由(文件名说线协议,id 说账本)。
 */
import type { RequestBodyBuilder, ThinkingWire, TurnContext } from "../base/index.js";
import { clampGrokReasoningEffort } from "./grok-effort.js";
import {
	RESPONSES_ENCRYPTED_REASONING_INCLUDE,
	RESPONSES_INCLUDE_PATH,
	RESPONSES_REASONING_PATH,
} from "./responses-reasoning.js";

export interface GrokResponsesReasoningOptions {
	effort: "low" | "medium" | "high" | "xhigh";
}

export class GrokResponsesReasoningWire implements ThinkingWire {
	/** 账本的 `OnethingReasoningWire` 值(见文件头)。 */
	readonly id = "grok-effort";

	/**
	 * `include` 与 `reasoning` 在这条通路上**不同生共死**(与 codex 相反)。
	 *
	 * 理由是官方那句「Reasoning cannot be disabled」:xAI 的模型永远在想,
	 * 所以加密思维链**永远存在** —— 恒发
	 * `include: ['reasoning.encrypted_content']` 才拿得回它,回放才完整
	 * (`/developers/model-capabilities/text/reasoning` 的「Encrypted Reasoning
	 * Content」:「can be returned if you pass
	 * `include: ["reasoning.encrypted_content"]` to the Responses API. You can
	 * send the encrypted content back to provide more context to a previous
	 * conversation.」)。
	 */
	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		builder.set(RESPONSES_INCLUDE_PATH, [
			RESPONSES_ENCRYPTED_REASONING_INCLUDE,
		]);
		const reasoning = this.reasoning(turn);
		if (reasoning) builder.set(RESPONSES_REASONING_PATH, reasoning);
	}

	private reasoning(
		turn: TurnContext,
	): GrokResponsesReasoningOptions | undefined {
		const { thinking, reasoningEffort } = turn.request;
		// 关不掉 ⇒ 「关」在线上只能表达成「不发这个字段」(服务端按默认 high
		// 自己想)。与 chat 通路上的 `GrokEffortWire` 逐字同规。
		if (thinking !== "enabled") return undefined;
		const effort = clampGrokReasoningEffort(reasoningEffort, turn.model);
		if (reasoningEffort !== undefined && reasoningEffort !== effort) {
			turn.warn(
				"setting-clamped",
				"reasoning effort was clamped to a level this xAI model accepts",
				{ requested: reasoningEffort, sent: effort },
			);
		}
		return { effort };
	}
}

export const grokResponsesReasoningWire = new GrokResponsesReasoningWire();

/** xAI Responses 上可能出现的线型 —— 今天只有一条。 */
export const GROK_RESPONSES_THINKING_WIRES: ThinkingWire[] = [
	grokResponsesReasoningWire,
];
