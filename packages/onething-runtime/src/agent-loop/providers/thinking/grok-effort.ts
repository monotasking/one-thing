/**
 * `grok-effort` —— xAI 的 effort 旋钮,按模型定上限;思考关不掉,`disabled`
 * 什么都不发。
 *
 * `GrokEffortWire` 是 **chat-completions** 上的拼法(顶层 `reasoning_effort`)。
 * P4-4 之后 xAI 的两条生产通路(grok / grok-oauth)都走 openai-responses
 * (`reasoning: { effort }`,见 `grok-responses-reasoning.ts`),这个类只剩
 * `openai-compatible.ts` 那条按 `reasoningStyle` 取线型的遗留构造门面在用。
 *
 * `clampGrokReasoningEffort` 是**两条线共用**的一张表(线协议不同,合法值域
 * 是同一件事)。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { OpenAIChatThinkingWire } from "./openai-chat-thinking-wire.js";

/**
 * 收 `xhigh` 的模型族。**官方原文**(docs.x.ai
 * `/developers/model-capabilities/text/reasoning`,2026-08-23 核):
 *
 *  - 「`"xhigh"` is available on `grok-4.6` and later. On models that do not
 *     support it, such as `grok-4.5`, requests with `"xhigh"` are treated as
 *     `"high"`.」
 *  - 档位表里 `grok-4.20-multi-agent` 也列着 `xhigh`(那一档对它是**智能体
 *    条数** 16,不是思考深度)。
 *
 * 「and later」没法用正则表达 —— 新模型上线时**在这里加一行**(或者等账本的
 * `profile.efforts` 成为唯一来源,设计稿 §2.7)。宁可少发一档(服务端会把
 * `xhigh` 当 `high` 处理,不报错),也不猜一个没核过的模型名。
 */
const GROK_XHIGH_MODELS = /4\.6|4\.20/;

export function clampGrokReasoningEffort(
	effort: string | undefined,
	model: string,
): "low" | "medium" | "high" | "xhigh" {
	if (effort === "minimal" || effort === "low") return "low";
	if (effort === "medium") return "medium";
	if ((effort === "xhigh" || effort === "max") && GROK_XHIGH_MODELS.test(model.toLowerCase())) {
		return "xhigh";
	}
	return "high";
}

export class GrokEffortWire extends OpenAIChatThinkingWire {
	readonly id = "grok-effort";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		if (turn.request.thinking !== "enabled") return;
		builder.set(
			"reasoning_effort",
			clampGrokReasoningEffort(turn.request.reasoningEffort, turn.model),
		);
	}
}

export const grokEffortWire = new GrokEffortWire();
