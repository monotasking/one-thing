/**
 * gemini 线上的错误形状 —— **P1-d1 起是 `ProviderHttpError`**。
 *
 * 边界与另外三条线逐条同款(设计稿 §2.5 / §9 P1-d1):`message` 一字不变
 * (`Gemini agent loop API error: ${status} ${body}`,`sourceName` 仍与
 * providerId 无关 —— 锚定前缀抠取读的正是它)、顶层 `retryAfterAt` 照旧、
 * `providerId` / `status` / `responseBody` / `data` / `inStream` 只增。
 *
 * 一处这条线独有、别家没有的现状:**Gemini 没有 `Retry-After` 头** —— 它把
 * `RetryInfo`(`retryDelay: "27s"`)放在响应体的 `error.details[]` 里,所以
 * 解析必须**同时**喂头和体,否则整个家族拿不到任何恢复时刻(批 B8-2)。
 * `ProviderHttpError` 的构造器本来就是这么调 `withProviderRetryAfter` 的。
 */
import { ProviderHttpError, type ErrorMapper } from "../base/index.js";

/** 这条线抛出来的对象的形状 —— 换装后就是 `ProviderHttpError` 本身。 */
export type GeminiApiError = ProviderHttpError;

/** 流块里能带错误的那一块。 */
interface GeminiStreamErrorChunk {
	error?: { message?: string; status?: string; code?: number };
}

export const GEMINI_SOURCE_NAME = "Gemini agent loop";

export class GeminiErrorMapper implements ErrorMapper {
	constructor(
		private readonly providerId: string,
		readonly sourceName: string = GEMINI_SOURCE_NAME,
	) {}

	fromResponse(response: Response, bodyText: string): ProviderHttpError {
		return new ProviderHttpError({
			providerId: this.providerId,
			status: response.status,
			message: `${this.sourceName} API error: ${response.status} ${bodyText}`,
			responseBody: bodyText,
			headers: response.headers,
		});
	}

	/**
	 * 流中的 `error` 块 —— message → status → 兜底文案,逐字。
	 *
	 * `status: 0` = 没有 HTTP 状态;Gemini 在块里给的 `error.status`
	 * (`RESOURCE_EXHAUSTED` 之类)是一个**字符串枚举**,不是 HTTP 码,所以它
	 * 落在 `type` 上而不是 `status` 上。
	 */
	fromStreamEvent(event: unknown): ProviderHttpError | undefined {
		if (typeof event !== "object" || event === null) return undefined;
		const chunk = event as GeminiStreamErrorChunk;
		if (!chunk.error) return undefined;
		return new ProviderHttpError({
			providerId: this.providerId,
			status: 0,
			inStream: true,
			...(chunk.error.status ? { type: chunk.error.status } : {}),
			message: `${this.sourceName} API error: ${chunk.error.message ?? chunk.error.status ?? "unknown error"}`,
		});
	}
}
