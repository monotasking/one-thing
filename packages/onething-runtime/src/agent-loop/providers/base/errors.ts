/**
 * `ProviderHttpError` —— **一种 provider 错误形状**(设计稿 §2.5)。
 *
 * 放在 runtime 而不是 core:core 有零依赖与 I2 断言,分类器读的是鸭子形状。
 *
 * 兼容是硬要求。今天 `provider-error-classification.ts` 的状态码三段兜底
 * (顶层 `statusCode` → `data.statusCode` → 锚定前缀抠取)和一批既有测试
 * 读的是 `openai-compatible.ts` 造的那个对象:顶层 `responseBody` +
 * `data: { providerId, statusCode, responseBody }` + 顶层 `retryAfterAt`,
 * 消息形如 `${providerId} agent loop API error: ${status} ${body}`。
 * 这些**全部保留**,新字段只是加上去 —— 迁移时分类器与测试可以一行不改。
 */
import { withProviderRetryAfter } from "../../provider-error-classification.js";
import type { TurnContext } from "./turn-context.js";

export interface ProviderHttpErrorInit {
	providerId: string;
	/** HTTP 状态码。`0` = 没有 HTTP 状态(超时、流中错误事件)。 */
	status: number;
	message?: string;
	code?: string;
	type?: string;
	responseBody?: string;
	requestId?: string;
	/** 错误来自流中的 SSE 事件,而不是响应头(§2.5)。 */
	inStream?: boolean;
	/** 拿来解析 `retry-after` / `x-ratelimit-reset-*` 的响应头。 */
	headers?: Headers;
	retryAfterAt?: number;
}

export class ProviderHttpError extends Error {
	readonly providerId: string;
	readonly status: number;
	readonly code?: string;
	readonly type?: string;
	readonly responseBody: string;
	readonly requestId?: string;
	readonly inStream: boolean;
	/** 兼容字段 —— 分类器的第二段兜底与既有测试读它。 */
	readonly data: { providerId: string; statusCode: number; responseBody: string };
	/** `withProviderRetryAfter` 挂在顶层(既有形状)。 */
	retryAfterAt?: number;

	constructor(init: ProviderHttpErrorInit) {
		const responseBody = init.responseBody ?? "";
		super(
			init.message ??
				`${init.providerId} agent loop API error: ${init.status} ${responseBody}`,
		);
		this.name = "ProviderHttpError";
		this.providerId = init.providerId;
		this.status = init.status;
		this.code = init.code;
		this.type = init.type;
		this.responseBody = responseBody;
		this.requestId = init.requestId;
		this.inStream = init.inStream ?? false;
		this.data = {
			providerId: init.providerId,
			statusCode: init.status,
			responseBody,
		};
		if (init.retryAfterAt !== undefined) {
			this.retryAfterAt = init.retryAfterAt;
		} else {
			withProviderRetryAfter(this, { headers: init.headers, body: responseBody });
		}
	}
}

export function isProviderHttpError(error: unknown): error is ProviderHttpError {
	return error instanceof ProviderHttpError;
}

/**
 * 返回类型是 `Error` 而不是 `ProviderHttpError`:设计稿 §9 把「`ProviderHttpError`
 * 全线」排在 **P1**,P0a 搬过来的 openai-chat 十一家仍然抛今天那个裸 `Error`
 * (`name === 'Error'` + `responseBody` / `data` / `retryAfterAt` 三个自有字段)。
 * 收窄成 `ProviderHttpError` 会把「哪一期换形状」变成类型问题,而不是行为问题。
 */
export interface ErrorMapper {
	fromResponse(response: Response, bodyText: string, turn: TurnContext): Error;
	/** 流中的错误事件(OpenRouter 带内错误、Anthropic `error` 事件、Zhipu sensitive)。 */
	fromStreamEvent?(event: unknown, turn: TurnContext): Error | undefined;
}

/**
 * OpenAI 形状的默认映射:消息、`data` 兼容字段、retry-after 都与今天
 * `createOpenAICompatibleApiError` 一致。
 */
export class DefaultErrorMapper implements ErrorMapper {
	constructor(private readonly providerId: string) {}

	fromResponse(response: Response, bodyText: string): ProviderHttpError {
		return new ProviderHttpError({
			providerId: this.providerId,
			status: response.status,
			responseBody: bodyText,
			headers: response.headers,
			requestId:
				response.headers.get("x-request-id") ??
				response.headers.get("request-id") ??
				undefined,
		});
	}
}
