/**
 * `ToolChoicePolicy` —— `tool_choice` 的拼法与降级(设计稿 §3)。
 *
 * P0a 只落「今天的行为」:OpenAI 形状,有工具就发
 * `request.toolChoice ?? 'auto'`,一个字不多。按 `profile` 把 `required`
 * 降成 `auto` + warning 是 P0b 的事(账本里 `supportsForcedToolUse` 还没有
 * per-model 的行)。
 */
import type { RequestBodyBuilder } from "./request-body-builder.js";
import type { TurnContext } from "./turn-context.js";

export interface ToolChoicePolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void;
}

export class OpenAIToolChoicePolicy implements ToolChoicePolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void {
		// 逐字复刻 openai-compatible.ts:tool_choice 只在真的带了工具时才发。
		const tools = builder.get<unknown[]>("tools");
		if (!Array.isArray(tools) || tools.length === 0) return;
		builder.set("tool_choice", turn.request.toolChoice ?? "auto");
	}
}

export const openAIToolChoicePolicy: ToolChoicePolicy = new OpenAIToolChoicePolicy();
