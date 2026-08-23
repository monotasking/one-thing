/**
 * anthropic-messages 线上的错误形状 —— **P1-d1 起是 `ProviderHttpError`**。
 *
 * 边界与 openai-chat 那份逐条同款(设计稿 §2.5 / §9 P1-d1):
 *
 *  1. **`message` 一字不变**:`Claude agent loop API error: ${status} ${body}`。
 *     `sourceName` 仍是**写死的 `Claude agent loop`**,与 providerId 无关 ——
 *     claude-code 与 `custom-*` 的错误消息今天也都以这五个字打头
 *     (`provider-error-classification.ts` 的锚定前缀抠取读的正是它)。改成
 *     per-id 是行为变更,仍然待拍板。
 *  2. **今天有的照旧**:顶层 `retryAfterAt`(`withProviderRetryAfter` 在
 *     `ProviderHttpError` 构造里做)。
 *  3. **只增**:`providerId` / `status` / `responseBody` / `data` / `inStream`
 *     ——`responseBody` 与 `data` 这两个从前只有 openai-chat 一家有的兼容字段,
 *     换装后四条线一致(超集,不是替换)。
 *
 * `providerId` **在构造时给**(wire 的 `errors` getter 用 `this.id` 建),不是从
 * 方言配方里拿:一份 anthropic 配方服务 `custom-*` 任意多个 provider id,
 * 拿配方 id 就会给自建端点贴上 `custom-anthropic` 这个假身份。
 *
 * 一处这条线独有的现状:Anthropic 429 必带 `retry-after`(秒),另有
 * `anthropic-ratelimit-*-reset`(RFC 3339)。挂成绝对时间戳,冷却按它走(批 B8-2)。
 */
import { ProviderHttpError, type ErrorMapper } from "../base/index.js";

/** 这条线抛出来的对象的形状 —— 换装后就是 `ProviderHttpError` 本身。 */
export type AnthropicApiError = ProviderHttpError;

/** 流事件里能带错误的两个位置。 */
interface AnthropicStreamErrorEvent {
	type?: string;
	error?: { message?: string; type?: string };
}

export const ANTHROPIC_SOURCE_NAME = "Claude agent loop";

export class AnthropicErrorMapper implements ErrorMapper {
	constructor(
		private readonly providerId: string,
		readonly sourceName: string = ANTHROPIC_SOURCE_NAME,
	) {}

	fromResponse(response: Response, bodyText: string): ProviderHttpError {
		return new ProviderHttpError({
			providerId: this.providerId,
			status: response.status,
			message: `${this.sourceName} API error: ${response.status} ${bodyText}`,
			responseBody: bodyText,
			headers: response.headers,
			requestId: response.headers.get("request-id") ?? undefined,
		});
	}

	/**
	 * `event.type === 'error'` 或者任意事件上挂了 `error` 那一块。
	 *
	 * `status: 0` = 没有 HTTP 状态(§2.5)—— 分类器与 retry 都把 0 当作读不到,
	 * 于是这一支照旧走文本判据(`overloaded` → transient),结论逐字不变。
	 */
	fromStreamEvent(event: unknown): ProviderHttpError | undefined {
		if (typeof event !== "object" || event === null) return undefined;
		const candidate = event as AnthropicStreamErrorEvent;
		if (candidate.type !== "error" && !candidate.error) return undefined;
		return new ProviderHttpError({
			providerId: this.providerId,
			status: 0,
			inStream: true,
			...(candidate.error?.type ? { type: candidate.error.type } : {}),
			message: `${this.sourceName} error: ${candidate.error?.message ?? "unknown error"}`,
		});
	}
}
