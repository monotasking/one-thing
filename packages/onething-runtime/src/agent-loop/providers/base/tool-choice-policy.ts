/**
 * `ToolChoicePolicy` —— `tool_choice` 的拼法与降级(设计稿 §3)。
 *
 * 形状是 OpenAI 的:有工具就发 `request.toolChoice ?? 'auto'`。
 *
 * P0b-B 起多一道**降级**:账本(`ModelProfile.supports('forcedToolUse')`)说这
 * 个模型不收强制调用时,`'required'` / 指名函数一律降成 `'auto'` 并留一条
 * `tool-choice-downgraded` 的 warning。引擎那一层(core runner)已经不会对
 * `supportsForcedToolUse: false` 的模型发强制参数,这里是**第二道保险**:
 * 序列化器是最后一个能看见线上字节的人,「能力说不行就绝不发」在这里兜底,
 * 于是绕过引擎直接手搓 `toolChoice` 的调用方也炸不了端点。
 */
import type { RequestBodyBuilder } from "./request-body-builder.js";
import type { TurnContext } from "./turn-context.js";

export interface ToolChoicePolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void;
}

/** `'auto'` / `'none'` 以外的一切都是「强制这一轮必须调用工具」。 */
function isForcedToolChoice(choice: unknown): boolean {
	if (choice === undefined || choice === null) return false;
	if (typeof choice === "string") return choice !== "auto" && choice !== "none";
	// 指名函数:`{type:'function', function:{name}}`。
	return typeof choice === "object";
}

function describeToolChoice(choice: unknown): string {
	if (typeof choice === "string") return choice;
	const named = (choice as { function?: { name?: unknown } })?.function?.name;
	return typeof named === "string" ? `function:${named}` : "named";
}

export class OpenAIToolChoicePolicy implements ToolChoicePolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void {
		// 逐字复刻 openai-compatible.ts:tool_choice 只在真的带了工具时才发。
		const tools = builder.get<unknown[]>("tools");
		if (!Array.isArray(tools) || tools.length === 0) return;
		const requested = turn.request.toolChoice ?? "auto";
		if (isForcedToolChoice(requested) && !turn.profile.supports("forcedToolUse")) {
			const from = describeToolChoice(requested);
			turn.warn(
				"tool-choice-downgraded",
				`this model does not support forced tool use; tool_choice ${from} was sent as auto`,
				{ requested: from, sent: "auto", model: turn.model },
			);
			builder.set("tool_choice", "auto");
			return;
		}
		builder.set("tool_choice", requested);
	}
}

export const openAIToolChoicePolicy: ToolChoicePolicy = new OpenAIToolChoicePolicy();
