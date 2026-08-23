/**
 * gemini 线上的错误形状 —— **P1-b 保持今天的对象,一个字节不动**。
 *
 * 设计稿 §9 把「`ProviderHttpError` 全线 + 分类器改读对象」排在 P1 的后半段;
 * P1-b 是纯搬运,所以这里造的仍然是 `gemini.ts` 退役前那个对象:裸 `Error`
 * (`name` 仍是 `'Error'`)+ `withProviderRetryAfter` 挂上去的顶层
 * `retryAfterAt`,**没有** `responseBody` / `data`(那两个兼容字段是
 * openai-chat 那一家的老习惯)。两份 `error*.json` 快照就是这句话的门。
 *
 * 一处这条线独有、别家没有的现状:**Gemini 没有 `Retry-After` 头** —— 它把
 * `RetryInfo`(`retryDelay: "27s"`)放在响应体的 `error.details[]` 里,所以
 * `withProviderRetryAfter` 必须**同时**喂头和体,否则整个家族拿不到任何恢复
 * 时刻(批 B8-2)。
 *
 * `sourceName` 是写死的 `Gemini agent loop`,与 providerId 无关
 * (`provider-error-classification.ts` 的锚定前缀抠取读的正是它)。
 */
import { withProviderRetryAfter } from "../../provider-error-classification.js";
import type { ErrorMapper } from "../base/index.js";

/** `gemini.ts` 抛出来的那个对象的形状。 */
export type GeminiApiError = Error & { retryAfterAt?: number };

/** 流块里能带错误的那一块。 */
interface GeminiStreamErrorChunk {
	error?: { message?: string; status?: string; code?: number };
}

export const GEMINI_SOURCE_NAME = "Gemini agent loop";

export class GeminiErrorMapper implements ErrorMapper {
	constructor(readonly sourceName: string = GEMINI_SOURCE_NAME) {}

	fromResponse(response: Response, bodyText: string): GeminiApiError {
		return withProviderRetryAfter(
			new Error(
				`${this.sourceName} API error: ${response.status} ${bodyText}`,
			),
			{ headers: response.headers, body: bodyText },
		);
	}

	/** 流中的 `error` 块 —— message → status → 兜底文案,逐字。 */
	fromStreamEvent(event: unknown): Error | undefined {
		if (typeof event !== "object" || event === null) return undefined;
		const chunk = event as GeminiStreamErrorChunk;
		if (!chunk.error) return undefined;
		return new Error(
			`${this.sourceName} API error: ${chunk.error.message ?? chunk.error.status ?? "unknown error"}`,
		);
	}
}

export const geminiErrorMapper = new GeminiErrorMapper();
