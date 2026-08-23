/**
 * openai-responses 线上的错误形状 —— **P1-c 保持今天的对象,一个字节不动**。
 *
 * 设计稿 §9 把「`ProviderHttpError` 全线 + 分类器改读对象」排在 P1 的后半段;
 * P1-c 是纯搬运,所以这里造的仍然是 `codex.ts` 退役前那个对象:裸 `Error`
 * (`name` 仍是 `'Error'`)+ 顶层 `statusCode` / `responseBody` / `isRetryable`
 * + `withProviderRetryAfter` 挂上去的顶层 `retryAfterAt`,**没有** `data`
 * (那个兼容字段是 openai-chat 那一家的老习惯)。`error.json` 快照就是这句话
 * 的门。
 *
 * 两处这条线独有的现状:
 *  - 消息不是 `<source> API error: <status> <body>` 而是
 *    `Codex request failed (<status>): <detail> [request-id: …]`,`detail` 走
 *    `summarizeCodexErrorBody` 的三级兜底(JSON 字段 → `<title>`/`<p>` →
 *    压平原文,各截 300 字);
 *  - request-id 读的是 **`x-oai-request-id`**(不是 `x-request-id`)。
 */
import { withProviderRetryAfter } from "../../provider-error-classification.js";
import type { ErrorMapper } from "../base/index.js";

/** `codex.ts` 抛出来的那个对象的形状。 */
export type CodexApiError = Error & {
	statusCode: number;
	responseBody: string;
	isRetryable: boolean;
	retryAfterAt?: number;
};

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
 * `createCodexAgentApiError` 逐字。
 *
 * 批 B8-2:headers 本来就传进来了(只用来取 request-id),顺手把
 * `retry-after` / `x-ratelimit-reset-*` 解析成绝对时间戳挂上去。
 */
export function createCodexAgentApiError(
	status: number,
	responseBody: string,
	headers: Headers,
): CodexApiError {
	const detail = summarizeCodexErrorBody(responseBody);
	const requestId = headers.get("x-oai-request-id");
	return withProviderRetryAfter(
		Object.assign(
			new Error(
				`Codex request failed (${status})${detail ? `: ${detail}` : ""}${requestId ? ` [request-id: ${requestId}]` : ""}`,
			),
			{
				statusCode: status,
				responseBody,
				isRetryable: status >= 500 || status === 429,
			},
		),
		{ headers, body: responseBody },
	);
}

export class CodexResponsesErrorMapper implements ErrorMapper {
	fromResponse(response: Response, bodyText: string): CodexApiError {
		return createCodexAgentApiError(
			response.status,
			bodyText,
			response.headers,
		);
	}

	/**
	 * 流中的错误 —— 这条线有**两个**出口,形状与措辞都不同:
	 *  - 任意事件上的顶层 `error`(`Codex stream error: <message>`);
	 *  - `response.failed`(`Codex stream error: <response.error.message>`,
	 *    兜底文案是 `Codex stream failed`)。
	 * 两处都抛裸 `Error`,没有状态码 —— 逐字复刻。
	 */
	fromStreamEvent(event: unknown): Error | undefined {
		if (typeof event !== "object" || event === null) return undefined;
		const chunk = event as { error?: { message?: string } };
		if (!chunk.error) return undefined;
		return new Error(
			`Codex stream error: ${chunk.error.message ?? "unknown error"}`,
		);
	}

	/** `response.failed` 那一条。 */
	fromFailedResponse(message: string | undefined): Error {
		return new Error(`Codex stream error: ${message || "Codex stream failed"}`);
	}
}

export const codexResponsesErrorMapper = new CodexResponsesErrorMapper();
