/**
 * `SamplingPolicy` —— temperature / top_p / penalty 发不发(设计稿 §3)。
 *
 * P0a 只落「今天的行为」:思考开着就不发 temperature(与
 * `openai-compatible.ts` 逐字一致 —— Kimi 的思考模型会拒绝自定义温度)。
 * 丢掉的设置留一条 warning:那是**旁路元数据**,不进请求体,所以请求体的
 * 字节与今天完全相同。
 *
 * 「Kimi 固定值不发」「Anthropic 新模型不发」按 `profile.allows()` 判是 P0b。
 */
import type { RequestBodyBuilder } from "./request-body-builder.js";
import type { TurnContext } from "./turn-context.js";

export interface SamplingPolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void;
}

export class OpenAISamplingPolicy implements SamplingPolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void {
		const { temperature, thinking } = turn.request;
		if (temperature === undefined) return;
		if (thinking === "enabled") {
			turn.warn(
				"setting-dropped",
				"temperature is not sent while thinking is enabled",
				{ temperature },
			);
			return;
		}
		builder.set("temperature", temperature);
	}
}

export const openAISamplingPolicy: SamplingPolicy = new OpenAISamplingPolicy();

/**
 * 这条线协议压根没有采样旋钮的出口(openai-responses 今天既不发 temperature
 * 也不发 max_output_tokens)。**不发不等于静默**:请求里带了就留一条 warning,
 * 请求体的字节与「什么都不做」完全相同(§2.4)。
 */
export class NoSamplingPolicy implements SamplingPolicy {
	apply(turn: TurnContext): void {
		const { temperature } = turn.request;
		if (temperature === undefined) return;
		turn.warn("setting-dropped", "this wire sends no sampling parameters", {
			temperature,
		});
	}
}

export const noSamplingPolicy: SamplingPolicy = new NoSamplingPolicy();
