/**
 * openai-chat 线上的错误形状 —— **P0a 保持今天的对象,一个字节不动**。
 *
 * 设计稿 §9 把「`ProviderHttpError` 全线 + 分类器改读对象」排在 **P1**;P0a 是
 * 纯搬运,所以这里造的仍然是 `openai-compatible.ts` 的
 * `createOpenAICompatibleApiError` 那个对象:裸 `Error`(`name` 仍是
 * `'Error'`)+ 顶层 `responseBody` + `data { providerId, statusCode, responseBody }`
 * + 顶层 `retryAfterAt`。换成 `ProviderHttpError` 会同时改掉 `name` 和可枚举
 * 自有字段集,十一份 `error.json` 快照会一起变 —— 那不是搬运。
 *
 * `displayName` 是这家在**用户可见文案**里的名字:十家用 providerId,DeepSeek
 * 今天写作 `DeepSeek`(设计稿 §10 第 1 条:统一成小写是 P1 要拍板的变更)。
 * 它也是 SSE 读取器的 `sourceName` —— 同一个名字只有一处 owner。
 */
import { withProviderRetryAfter } from "../../provider-error-classification.js";
import type { ErrorMapper } from "../base/index.js";

/** `createOpenAICompatibleApiError` 造出来的那个对象的形状。 */
export type OpenAIChatApiError = Error & {
	responseBody: string;
	data: { providerId: string; statusCode: number; responseBody: string };
	retryAfterAt?: number;
};

export class OpenAIChatErrorMapper implements ErrorMapper {
	constructor(
		private readonly providerId: string,
		readonly displayName: string = providerId,
	) {}

	/** `readJsonSseData` 的 `sourceName`,以及流中错误那句话的前缀。 */
	get sourceName(): string {
		return `${this.displayName} agent loop`;
	}

	fromResponse(response: Response, bodyText: string): OpenAIChatApiError {
		// 批 B8-2:OpenAI 系用 `retry-after` + `x-ratelimit-reset-requests/-tokens`
		// (Go duration,`6m0s` / `2m59.56s`)。`retryAfterAt` 挂**顶层**,与
		// `statusCode` 藏在 data 里的老习惯不同 —— 那是既有形状,不去动它。
		return withProviderRetryAfter(
			Object.assign(
				new Error(
					`${this.displayName} agent loop API error: ${response.status} ${bodyText}`,
				),
				{
					responseBody: bodyText,
					data: {
						providerId: this.providerId,
						statusCode: response.status,
						responseBody: bodyText,
					},
				},
			),
			{ headers: response.headers, body: bodyText },
		);
	}

	/** 带内错误:`{ error: { message } }` 那一块。 */
	fromStreamEvent(event: unknown): Error | undefined {
		if (typeof event !== "object" || event === null) return undefined;
		const error = (event as { error?: { message?: string } }).error;
		if (!error) return undefined;
		return new Error(
			`${this.sourceName} error: ${error.message ?? "unknown error"}`,
		);
	}
}
