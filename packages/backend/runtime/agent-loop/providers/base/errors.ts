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
		// `name` 定义成**不可枚举**,与 `Error.prototype.name` 同待遇:直接赋值会
		// 让它变成一个自有可枚举属性,于是每一条错误的"字段"里都多出一份与
		// `error.name` 重复的噪音(快照里看得最清楚)。
		Object.defineProperty(this, "name", {
			value: "ProviderHttpError",
			enumerable: false,
			configurable: true,
			writable: true,
		});
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
 * 返回类型 **P1-d1 起收窄回 `ProviderHttpError`**:四条线的映射器全部换装完毕,
 * 「哪一期换形状」从此是类型问题,新写一份映射器再也退不回裸 `Error`。
 *
 * 用户可见的 `message` 一字未改(前缀 `DeepSeek` / `Claude` / `Gemini` /
 * `Codex request failed` 各家原样;前缀统一是设计稿 §10 的待拍板项),今天的
 * 兼容字段全部保留为超集 —— 变的只有 `name` 与**只增**的统一字段。
 */
export interface ErrorMapper {
	fromResponse(
		response: Response,
		bodyText: string,
		turn: TurnContext,
	): ProviderHttpError;
	/** 流中的错误事件(OpenRouter 带内错误、Anthropic `error` 事件、Zhipu sensitive)。 */
	fromStreamEvent?(
		event: unknown,
		turn: TurnContext,
	): ProviderHttpError | undefined;
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
