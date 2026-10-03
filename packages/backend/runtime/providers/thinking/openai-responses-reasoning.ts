/**
 * `openai-responses` —— OpenAI 官方在 **`POST /v1/responses`** 上的思考线型
 * (P4-5)。
 *
 * 与 chat-completions 上那条(`openai-effort.ts`,顶层 `reasoning_effort`)是
 * 同一个旋钮的两种拼法:Responses 把它嵌进 `reasoning: { effort }`。**判据一个
 * 字没变**,两条线共用 `clampOpenAIReasoningEffort` 与 `openAIAcceptsNoneEffort`
 * —— 换线不是换语义。
 *
 * ## 官方原文(platform.openai.com,2026-08-23 核)
 *
 *  - `/docs/guides/reasoning`:「Supported values are model-dependent and can
 *    include `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.」
 *    「Defaults are also model-dependent rather than universal. `gpt-5.5`
 *     defaults to `medium` reasoning effort.」
 *  - 各模型页那一句(逐个核过):
 *    | 模型 | `Reasoning.effort supports` |
 *    |---|---|
 *    | `gpt-5` | minimal, low, medium, high |
 *    | `gpt-5.4` | none(默认), low, medium, high, xhigh |
 *    | `gpt-5.5` | none, low, medium(默认), high, xhigh |
 *    | `gpt-5.6` | none, low, medium(默认), high, xhigh, max |
 *  - `reasoning.summary`(`/docs/guides/reasoning` →「Reasoning summaries」):
 *    「To access the most detailed summarizer available for a model, set the
 *     value of this parameter to `auto`.」「This output will not be included
 *     unless you explicitly opt in to including reasoning summaries.」
 *  - `include`(同页「Preserve reasoning without stored responses」):
 *    「When you create a response in **stateless mode**, reasoning items in the
 *     response's `output` array include an `encrypted_content` property **by
 *     default**. Stateless mode applies when `store` is `false`… The API still
 *     accepts the legacy `reasoning.encrypted_content` value in `include` for
 *     compatibility, but doesn't require it.」
 *    我们恒发 `store:false`,所以加密思维链本来就会回来;`include` 那一条**带上
 *    无害**(官方明说仍然接受),而带上之后这条线与 codex / xAI 逐字同规 ——
 *    三家共用 `ResponsesPartCodec` 的同一条回放路径。
 *
 * ## 两处刻意的**不变**(换线 ≠ 改行为)
 *
 *  1. **`thinking` 没说 = 什么都不发**。codex 那条线会从模型名反推
 *     (`isCodexReasoningModel` ⇒ 自动补 `effort:'medium'`),这一家**今天不**
 *     ——`OpenAIEffortWire` 只认 `'enabled'` / `'disabled'` 两个显式意图。
 *     不发 = 服务端按模型自己的默认(gpt-5.5 是 `medium`)想,与 chat 通路
 *     上今天的字节等价。反推是 codex 的怪癖,不是这条线协议的。
 *  2. **effort 的钳法与 chat 通路共用一支**(`clampOpenAIReasoningEffort`)。
 *     P4-9(拍板 #14)起它按**账本的 per-model 档位表**钳,不再是写死的四档:
 *     gpt-5.5 收 `xhigh`,于是 `max` 退到 `xhigh` 而不是 `high`;5.1+ 没有
 *     `minimal`,于是 `minimal` 退到 `low`。档位表本身在
 *     `providers/model-capability.ts`(官方各模型页逐条核过)。
 *
 * ## `none` 与 `summary` 的关系
 *
 * `thinking: 'disabled'` 时是否发得出「别想」,判据仍只有账本一个:
 * `profile.reasoningProfile.efforts` 里有没有 `'none'`(gpt-5.1+ 有,
 * gpt-5 / o 系没有)。有就发 `reasoning: { effort: 'none' }`,没有就一个字段
 * 都不发 —— 与 `openai-effort.ts` 逐字同规,wire 自己不认模型名。
 *
 * **`effort: 'none'` 时不发 `summary`**:官方那句「不显式 opt in 就不会有
 * summary」说明 `summary` 是一个独立的开关,而「一个思考 token 都不产」的回合
 * 要一份思考摘要是自相矛盾的。宁可少发一个键(确定安全)也不赌它不是 400。
 * **待真机核**:`{effort:'none', summary:'auto'}` 服务端到底收不收。
 *
 * ## id 是 `'openai-effort'`,不是文件名
 *
 * `HttpAgentProvider.thinkingFor()` 拿 `ModelProfile.reasoningWire` 去 `find`,
 * 账本(`providers/model-capability.ts` 的 `OPENAI_PROFILE.wire`)给这一家记的
 * 值是 `'openai-effort'` —— 两边得对得上。与 `grok-responses-reasoning.ts` 用
 * `id = 'grok-effort'` 是同一个理由(文件名说线协议,id 说账本)。
 */
import type { RequestBodyBuilder, ThinkingWire, TurnContext } from "../base/index.js";
import {
	clampOpenAIReasoningEffort,
	openAIAcceptsNoneEffort,
	openAIReasoningEffortsFor,
	type OpenAIReasoningEffort,
} from "./openai-effort.js";
import {
	RESPONSES_ENCRYPTED_REASONING_INCLUDE,
	RESPONSES_INCLUDE_PATH,
	RESPONSES_REASONING_PATH,
} from "./responses-reasoning.js";

export interface OpenAIResponsesReasoningOptions {
	effort: "none" | OpenAIReasoningEffort;
	summary?: "auto";
}

export class OpenAIResponsesReasoningWire implements ThinkingWire {
	/** 账本的 `OnethingReasoningWire` 值(见文件头)。 */
	readonly id = "openai-effort";

	/**
	 * `include` 与 `reasoning` **不同生共死**(与 codex 相反,与 xAI 同)。
	 *
	 * `store:false` 下加密思维链是默认返回的,与这一回合想不想没关系;恒发
	 * `include` 让回放路径永远拿得到它,而 `reasoning` 才随意图进出。
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
	): OpenAIResponsesReasoningOptions | undefined {
		const { thinking, reasoningEffort } = turn.request;
		if (thinking === "disabled") {
			// 「别想」这一档只有账本说有的模型收得下(gpt-5.1+)。
			if (openAIAcceptsNoneEffort(turn)) return { effort: "none" };
			if (reasoningEffort !== undefined) {
				turn.warn(
					"thinking-unsupported",
					"reasoning effort is dropped while thinking is disabled",
					{ reasoningEffort },
				);
			}
			return undefined;
		}
		// 显式说了「想」才发 —— 没说话不等于不想,但也不等于要我们替它决定。
		if (thinking !== "enabled") return undefined;
		const effort = clampOpenAIReasoningEffort(
			reasoningEffort,
			openAIReasoningEffortsFor(turn),
		);
		if (reasoningEffort !== undefined && reasoningEffort !== effort) {
			turn.warn(
				"setting-clamped",
				"reasoning effort was clamped to a level this OpenAI model accepts",
				{ requested: reasoningEffort, sent: effort },
			);
		}
		return { effort, summary: "auto" };
	}
}

export const openAIResponsesReasoningWire = new OpenAIResponsesReasoningWire();

/** OpenAI Responses 上可能出现的线型 —— 今天只有一条。 */
export const OPENAI_RESPONSES_THINKING_WIRES: ThinkingWire[] = [
	openAIResponsesReasoningWire,
];
