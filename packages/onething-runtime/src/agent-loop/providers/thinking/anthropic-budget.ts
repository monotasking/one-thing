/**
 * `anthropic-budget` —— 4.6 以下的 extended thinking:
 * `thinking: {type:'enabled', budget_tokens}`,预算表是账本的
 * `ONETHING_CLAUDE_THINKING_BUDGETS`(effort 缺省按 `high` 取)。
 *
 * **`budget_tokens` 必须小于 `max_tokens`**:调用方给的 max_tokens 不够时,把
 * 它顶到 `budget + 4096`。这一步之所以能留在思考线型里而不是请求体构建器里,
 * 是因为模板方法保证 `buildBody`(写 `max_tokens`)先于 `thinking.encode`。
 *
 * 思考关掉时这条线**什么都不发**(与今天一致:显式 `disabled` 只有 adaptive
 * 家族要)。
 */
import { ONETHING_CLAUDE_THINKING_BUDGETS } from "../../../providers/model-capability.js";
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { AnthropicThinkingWire } from "./anthropic-effort.js";

export class AnthropicBudgetThinkingWire extends AnthropicThinkingWire {
	readonly id = "anthropic-budget";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		if (turn.request.thinking !== "enabled") return;
		const budget =
			ONETHING_CLAUDE_THINKING_BUDGETS[turn.request.reasoningEffort ?? "high"];
		builder.set("thinking", { type: "enabled", budget_tokens: budget });
		const maxTokens = builder.get<number>("max_tokens");
		if (maxTokens !== undefined && maxTokens <= budget) {
			builder.set("max_tokens", budget + 4096);
		}
	}
}

export const anthropicBudgetThinkingWire = new AnthropicBudgetThinkingWire();
