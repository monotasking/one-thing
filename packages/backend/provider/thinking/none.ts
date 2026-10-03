/**
 * `none` —— 这家的线协议上没有思考参数(github-copilot),请求体一个字不多。
 *
 * 它仍然**读**得回思维链:copilot 的上游会转发 `reasoning_content`,今天
 * `openai-compatible.ts` 无条件读它 —— 所以这里继承线级的 `decode()`,
 * 只把 `encode()` 留空(与 `base/` 的 `NoThinkingWire` 的区别就在这一点:
 * 那一条是「连读都不认识」的兜底)。
 *
 * P0b-A 起「留空」不再等于「静默」:调用方明确要求思考(`thinking === 'enabled'`)
 * 而这条线发不出任何思考参数时,留一条 `thinking-unsupported`
 * (「思考意图这条线协议表达不了,整段没发」——这条 kind 存在的正是这个场景;
 * 同回合里被丢掉的 temperature 仍归 `setting-dropped`,两者不是一件事)。
 * **这是旁路元数据,请求体的字节一个不变**(快照零变化)。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { OpenAIChatThinkingWire } from "./openai-chat-thinking-wire.js";

export class OpenAIChatNoThinkingWire extends OpenAIChatThinkingWire {
	readonly id = "none";

	encode(turn: TurnContext, _builder: RequestBodyBuilder): void {
		if (turn.request.thinking !== "enabled") return;
		turn.warn(
			"thinking-unsupported",
			"thinking is not expressible on this endpoint and was not sent",
			{
				thinking: turn.request.thinking,
				...(turn.request.reasoningEffort
					? { reasoningEffort: turn.request.reasoningEffort }
					: {}),
			},
		);
	}
}

export const openAIChatNoThinkingWire = new OpenAIChatNoThinkingWire();
