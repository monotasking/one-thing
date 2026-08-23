/**
 * `none` —— 这家的线协议上没有思考参数(github-copilot),请求体一个字不多。
 *
 * 它仍然**读**得回思维链:copilot 的上游会转发 `reasoning_content`,今天
 * `openai-compatible.ts` 无条件读它 —— 所以这里继承线级的 `decode()`,
 * 只把 `encode()` 留空(与 `base/` 的 `NoThinkingWire` 的区别就在这一点:
 * 那一条是「连读都不认识」的兜底)。
 */
import { OpenAIChatThinkingWire } from "./openai-chat-thinking-wire.js";

export class OpenAIChatNoThinkingWire extends OpenAIChatThinkingWire {
	readonly id = "none";

	encode(): void {}
}

export const openAIChatNoThinkingWire = new OpenAIChatNoThinkingWire();
