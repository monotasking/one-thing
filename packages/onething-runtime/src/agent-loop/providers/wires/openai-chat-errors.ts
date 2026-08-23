/**
 * openai-chat 线上的错误形状 —— **P1-d1 起是 `ProviderHttpError`**。
 *
 * 换装的边界写死在三句话里(设计稿 §2.5 / §9 P1-d1):
 *
 *  1. **用户可见的 `message` 一字不变**:`${displayName} agent loop API error:
 *     ${status} ${body}`,DeepSeek 那个大写前缀照旧(前缀统一是 §10 的待拍板
 *     项,不在这一批);
 *  2. **今天的兼容字段全部保留**:顶层 `responseBody`、
 *     `data { providerId, statusCode, responseBody }`、顶层 `retryAfterAt` ——
 *     `ProviderHttpError` 自带这三样,分类器的三段兜底与既有测试一行不用改;
 *  3. **只增不减**:再多出统一字段 `providerId` / `status` / `inStream`
 *     (以及有值才出现的 `requestId`)。`name` 从 `'Error'` 变成
 *     `'ProviderHttpError'` —— 这是本批唯一允许的快照变化。
 *
 * `displayName` 是这家在**用户可见文案**里的名字:十家用 providerId,DeepSeek
 * 今天写作 `DeepSeek`。它也是 SSE 读取器的 `sourceName` —— 同一个名字只有一处
 * owner。
 */
import { ProviderHttpError, type ErrorMapper } from "../base/index.js";

/** 这条线抛出来的对象的形状 —— 换装后就是 `ProviderHttpError` 本身。 */
export type OpenAIChatApiError = ProviderHttpError;

export class OpenAIChatErrorMapper implements ErrorMapper {
	constructor(
		private readonly providerId: string,
		readonly displayName: string = providerId,
	) {}

	/** `readJsonSseData` 的 `sourceName`,以及流中错误那句话的前缀。 */
	get sourceName(): string {
		return `${this.displayName} agent loop`;
	}

	fromResponse(response: Response, bodyText: string): ProviderHttpError {
		// 批 B8-2:OpenAI 系用 `retry-after` + `x-ratelimit-reset-requests/-tokens`
		// (Go duration,`6m0s` / `2m59.56s`)。`retryAfterAt` 挂**顶层**,与
		// `statusCode` 藏在 data 里的老习惯不同 —— 那是既有形状,不去动它。
		return new ProviderHttpError({
			providerId: this.providerId,
			status: response.status,
			message: `${this.displayName} agent loop API error: ${response.status} ${bodyText}`,
			responseBody: bodyText,
			headers: response.headers,
			requestId:
				response.headers.get("x-request-id") ??
				response.headers.get("request-id") ??
				undefined,
		});
	}

	/**
	 * 带内错误:`{ error: { message } }` 那一块。
	 *
	 * `status: 0` = **没有 HTTP 状态**(§2.5)——它来自流里的一条事件,不是响应头。
	 * 分类器与 core 的 retry 都把 0 当作「读不到状态码」,于是这一支照旧走文本
	 * 判据(`overloaded` → transient / 可重试),与换装前逐字同一个结论。
	 */
	fromStreamEvent(event: unknown): ProviderHttpError | undefined {
		if (typeof event !== "object" || event === null) return undefined;
		const error = (event as { error?: { message?: string } }).error;
		if (!error) return undefined;
		return new ProviderHttpError({
			providerId: this.providerId,
			status: 0,
			inStream: true,
			message: `${this.sourceName} error: ${error.message ?? "unknown error"}`,
		});
	}
}
