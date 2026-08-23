/**
 * anthropic-messages 线上的错误形状 —— **P1-a 保持今天的对象,一个字节不动**。
 *
 * 设计稿 §9 把「`ProviderHttpError` 全线 + 分类器改读对象」排在 P1 的后半段;
 * P1-a 是纯搬运,所以这里造的仍然是 `claude.ts` 退役前那个对象:裸 `Error`
 * (`name` 仍是 `'Error'`)+ `withProviderRetryAfter` 挂上去的顶层
 * `retryAfterAt`,**没有** `responseBody` / `data`(openai-chat 那两个兼容字段
 * 是那一家的老习惯,anthropic 这条线今天压根没有)。三份 `error.json` 快照
 * 就是这句话的门。
 *
 * `sourceName` 是**写死的 `Claude agent loop`**,与 providerId 无关:
 * claude-code 与 `custom-*` 的错误消息今天也都以这五个字打头
 * (`provider-error-classification.ts` 的锚定前缀抠取读的正是它)。统一成
 * per-id 的名字是行为变更,排 P1-d。
 */
import { withProviderRetryAfter } from "../../provider-error-classification.js";
import type { ErrorMapper } from "../base/index.js";

/** `claude.ts` 抛出来的那个对象的形状。 */
export type AnthropicApiError = Error & { retryAfterAt?: number };

/** 流事件里能带错误的两个位置。 */
interface AnthropicStreamErrorEvent {
	type?: string;
	error?: { message?: string; type?: string };
}

export const ANTHROPIC_SOURCE_NAME = "Claude agent loop";

export class AnthropicErrorMapper implements ErrorMapper {
	constructor(readonly sourceName: string = ANTHROPIC_SOURCE_NAME) {}

	fromResponse(response: Response, bodyText: string): AnthropicApiError {
		// 批 B8-2:Anthropic 429 必带 `retry-after`(秒),另有
		// `anthropic-ratelimit-*-reset`(RFC 3339)。挂成绝对时间戳,冷却按它走。
		return withProviderRetryAfter(
			new Error(
				`${this.sourceName} API error: ${response.status} ${bodyText}`,
			),
			{ headers: response.headers, body: bodyText },
		);
	}

	/** `event.type === 'error'` 或者任意事件上挂了 `error` 那一块。 */
	fromStreamEvent(event: unknown): Error | undefined {
		if (typeof event !== "object" || event === null) return undefined;
		const candidate = event as AnthropicStreamErrorEvent;
		if (candidate.type !== "error" && !candidate.error) return undefined;
		return new Error(
			`${this.sourceName} error: ${candidate.error?.message ?? "unknown error"}`,
		);
	}
}

export const anthropicErrorMapper = new AnthropicErrorMapper();
