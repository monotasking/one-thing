/**
 * openai-responses 线上的错误形状 —— **P1-d1 起是 `ProviderHttpError`**。
 *
 * 边界与另外三条线同款(设计稿 §2.5 / §9 P1-d1),两处这条线独有的现状原样保留:
 *
 *  - 消息不是 `<source> API error: <status> <body>` 而是
 *    `Codex request failed (<status>): <detail> [request-id: …]`,`detail` 走
 *    `summarizeCodexErrorBody` 的三级兜底(JSON 字段 → `<title>`/`<p>` →
 *    压平原文,各截 300 字);
 *  - request-id 读的是 **`x-oai-request-id`**(不是 `x-request-id`)。
 *
 * 今天的兼容字段是**顶层** `statusCode` / `responseBody` / `isRetryable`
 * (+ `retryAfterAt`)。`responseBody` / `retryAfterAt` 由 `ProviderHttpError`
 * 自带,另外两个由 `CodexHttpError` 这个薄子类补上 —— `isRetryable` 是
 * `core/agent-loop/retry.ts` 里**优先级最高**的判据(`typeof isRetryable ===
 * 'boolean'` 直接返回),丢了它这一家的重试口径当场就变。
 *
 * 所以 `isRetryable` 只挂在 **`fromResponse`** 造的那种错误上:流中的错误事件
 * 与 `response.failed` 今天压根没有这个字段,给它们补一个 `false` 会把
 * 「Codex stream error: overloaded」从可重试变成不可重试。
 */
import { ProviderHttpError, type ErrorMapper, type ProviderHttpErrorInit } from "../base/index.js";

/** `codex.ts` 退役前那个对象的形状 —— 换装后是 `ProviderHttpError` 的子类。 */
export type CodexApiError = CodexHttpError;

/** 顶层 `statusCode` / `isRetryable` 两个兼容字段的持有者。 */
export class CodexHttpError extends ProviderHttpError {
	/** = `status`。今天的调用方(含 `retry.ts`)读的是这个名字。 */
	readonly statusCode: number;
	/** provider 侧的预判:5xx 与 429 可重试。`retry.ts` 优先读它。 */
	readonly isRetryable: boolean;

	constructor(init: ProviderHttpErrorInit) {
		super(init);
		this.statusCode = init.status;
		this.isRetryable = init.status >= 500 || init.status === 429;
	}
}

/** JSON 字段 → HTML 标题/段落 → 压平原文,各截 300 字。逐字。 */
export function summarizeCodexErrorBody(body: string): string {
	if (!body) return "";
	try {
		const parsed = JSON.parse(body);
		const message =
			parsed?.detail ||
			parsed?.error?.message ||
			parsed?.message ||
			parsed?.error;
		if (typeof message === "string") return message.slice(0, 300);
	} catch {
		// Fall back to HTML/text cleanup below.
	}
	const compact = body.replace(/\s+/g, " ").trim();
	const title = compact.match(/<title>(.*?)<\/title>/i)?.[1]?.trim();
	const paragraph = compact
		.match(/<p>(?:<b>\d+\.<\/b>\s*)?(.*?)(?:<p>|$)/i)?.[1]
		?.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return (
		[title, paragraph].filter(Boolean).join(": ").slice(0, 300) ||
		compact.slice(0, 300)
	);
}

/**
 * `createCodexAgentApiError` —— 消息逐字,形状换成 `CodexHttpError`。
 *
 * `providerId` 有默认值 `'codex'`:这条线今天只有 codex 一家在跑,而方言的
 * 认证策略(`CodexOAuthAuth.onUnauthorized`)手上没有 provider 实例,拿不到
 * `this.id`。wire 走 `errors` getter 时会把真实的 id 传进来。
 */
export function createCodexAgentApiError(
	status: number,
	responseBody: string,
	headers: Headers,
	providerId = "codex",
): CodexHttpError {
	const detail = summarizeCodexErrorBody(responseBody);
	const requestId = headers.get("x-oai-request-id");
	return new CodexHttpError({
		providerId,
		status,
		message: `Codex request failed (${status})${detail ? `: ${detail}` : ""}${requestId ? ` [request-id: ${requestId}]` : ""}`,
		responseBody,
		headers,
		...(requestId ? { requestId } : {}),
	});
}

export class CodexResponsesErrorMapper implements ErrorMapper {
	constructor(private readonly providerId = "codex") {}

	fromResponse(response: Response, bodyText: string): CodexHttpError {
		return createCodexAgentApiError(
			response.status,
			bodyText,
			response.headers,
			this.providerId,
		);
	}

	/**
	 * 流中的错误 —— 这条线有**两个**出口,形状与措辞都不同:
	 *  - 任意事件上的顶层 `error`(`Codex stream error: <message>`);
	 *  - `response.failed`(`Codex stream error: <response.error.message>`,
	 *    兜底文案是 `Codex stream failed`)。
	 * 两处都没有 HTTP 状态(`status: 0`)也没有 `isRetryable` —— 逐字复刻。
	 */
	fromStreamEvent(event: unknown): ProviderHttpError | undefined {
		if (typeof event !== "object" || event === null) return undefined;
		const chunk = event as { error?: { message?: string } };
		if (!chunk.error) return undefined;
		return new ProviderHttpError({
			providerId: this.providerId,
			status: 0,
			inStream: true,
			message: `Codex stream error: ${chunk.error.message ?? "unknown error"}`,
		});
	}

	/** `response.failed` 那一条。 */
	fromFailedResponse(message: string | undefined): ProviderHttpError {
		return new ProviderHttpError({
			providerId: this.providerId,
			status: 0,
			inStream: true,
			message: `Codex stream error: ${message || "Codex stream failed"}`,
		});
	}
}
