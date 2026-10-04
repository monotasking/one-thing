// 一次上下文压缩分四步,各住一只文件(2026-10-04 拆分):本文件管「选哪段去压」(压缩计划、触发判据、
// 摘要用的转录格式)与压缩状态消息;按窗口定块大小在 `agent-loop-context-compact-sizing.ts`,分块摘要
// (map-reduce、单块超时与总预算)在 `agent-loop-context-compact-summary.ts`,摘要尾部的文件清单标签在
// `agent-loop-context-compact-file-tags.ts`。按顺序吃这四步的驱动是 `engine/engine-compact-session.ts`。
import type { JsonObject } from "@shared/json.js";
import {
	buildContextCompactContent,
	type CoreContextCompactMessage,
	type CoreContextCompactStatus,
} from "@shared/engine/context-compact-content.js";
import { getCoreLogger } from "@onething/backend/logging";

const log = getCoreLogger("core.engine");

import {
	COMPACTED_HISTORY_RETAINED_PAYLOAD_BUDGET_CHARS,
	sanitizeHistoryToolResultForAI,
	sanitizeToolResultForAI,
	type CoreHistoryChatMessage,
} from "./agent-loop-history.js";
import {
	estimateTextTokens,
	getContextUsageTriggerReason,
} from "./agent-loop-context-usage.js";

export const DEFAULT_KEEP_RECENT_TURNS = 6;
export const SUMMARY_TOOL_RESULT_MAX_CHARS = 6000;

export interface CoreCompactAttachment {
	fileName: string;
	mimeType: string;
	size: number;
}

export interface CoreCompactToolCall {
	toolId?: string;
	toolName: string;
	arguments?: JsonObject;
	status?: string;
	result?: any;
	error?: string;
	rejectionReason?: string;
}

export interface CoreCompactMessage {
	id: string;
	role: string;
	content?: string;
	reasoning?: string;
	isStreaming?: boolean;
	attachments?: CoreCompactAttachment[];
	toolCalls?: CoreCompactToolCall[];
}

export interface CoreCompactSession<
	TMessage extends CoreCompactMessage = CoreCompactMessage,
> {
	id?: string;
	messages: TMessage[];
	summary?: string;
	summaryUpToMessageId?: string;
	contextSize?: number;
	lastInputTokens?: number;
}

export interface CompactPlan<
	TMessage extends CoreCompactMessage = CoreCompactMessage,
> {
	cutoffIndex: number;
	cutoffMessage: TMessage;
	messagesToSummarize: TMessage[];
	previousSummary?: string;
}

export function createContextCompactMessage(input: {
	id: string;
	timestamp: number;
	compactedMessageCount: number;
	compactedThroughMessageId?: string;
}): CoreContextCompactMessage {
	return {
		id: input.id,
		role: "system",
		content: buildContextCompactContent({
			status: "compacting",
			compactedMessageCount: input.compactedMessageCount,
			compactedThroughMessageId: input.compactedThroughMessageId,
		}),
		timestamp: input.timestamp,
	};
}

export function buildContextCompactCompletedContent(
	summary: string,
	compactedMessageCount: number,
	compactedThroughMessageId?: string,
	/** 压缩**开始那一刻**的 provider 输入读数;写者在开始处取一次存住(见内容类型的注)。 */
	contextSizeBefore?: number,
	/** 压完之后还看得见的读数;写者算出来之后再拼这条内容(见内容类型的注)。 */
	retainedContextSize?: number,
): string {
	return buildContextCompactContent({
		status: "completed",
		summary,
		compactedMessageCount,
		compactedThroughMessageId,
		contextSizeBefore,
		retainedContextSize,
	});
}

export function buildContextCompactFailedContent(
	error: string,
	compactedMessageCount: number,
	compactedThroughMessageId?: string,
): string {
	return buildContextCompactContent({
		status: "failed",
		summary: "",
		error,
		compactedMessageCount,
		compactedThroughMessageId,
	});
}

export function normalizeContextCompactError(
	error: unknown,
	fallback = "Failed to compact context",
): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * 消息数组是**显式入参**(P0.2 area ①):core 不再从 session 上取 `messages`,
 * 拿到的永远是调用方递进来的那份快照。
 */
export function selectCompactPlan<TMessage extends CoreCompactMessage>(
	session: Pick<
		CoreCompactSession<TMessage>,
		"id" | "summary" | "summaryUpToMessageId"
	>,
	sessionMessages: readonly TMessage[],
	keepRecentTurns = DEFAULT_KEEP_RECENT_TURNS,
): CompactPlan<TMessage> | null {
	const messages = sessionMessages.filter(
		(message) => message.role === "user" || message.role === "assistant",
	);
	if (messages.length === 0) return null;

	let userTurnsSeen = 0;
	let recentStartMessageId: string | undefined;

	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "user") {
			userTurnsSeen++;
			if (userTurnsSeen >= keepRecentTurns) {
				recentStartMessageId = messages[index].id;
				break;
			}
		}
	}

	if (!recentStartMessageId) return null;

	const recentStartIndex = sessionMessages.findIndex(
		(message) => message.id === recentStartMessageId,
	);
	const cutoffIndex = recentStartIndex - 1;
	if (cutoffIndex < 0) return null;

	const cutoffMessage = sessionMessages[cutoffIndex];
	let previousSummaryIndex = -1;
	let previousSummary: string | undefined;
	if (session.summary && session.summaryUpToMessageId) {
		previousSummaryIndex = sessionMessages.findIndex(
			(message) => message.id === session.summaryUpToMessageId,
		);
		if (previousSummaryIndex === -1) {
			log.warn("ignoring summary with missing anchor", {
				sessionId: session.id,
				summaryUpToMessageId: session.summaryUpToMessageId,
			});
		} else {
			previousSummary = session.summary;
		}
	}

	if (previousSummaryIndex >= cutoffIndex) return null;

	const messagesToSummarize = sessionMessages
		.slice(previousSummaryIndex + 1, cutoffIndex + 1)
		.filter(
			(message) => message.role === "user" || message.role === "assistant",
		);

	if (messagesToSummarize.length === 0) return null;

	return {
		cutoffIndex,
		cutoffMessage,
		messagesToSummarize,
		previousSummary,
	};
}

export type CoreContextCompactReason = "threshold";

export async function shouldAutoCompactBeforeSend(options: {
	session: Omit<CoreCompactSession, "messages">;
	/** 会话消息快照:只有在没给 `inputTokens` 时才用得上(要靠它估算) */
	sessionMessages?: readonly CoreCompactMessage[];
	modelContextLength: number;
	thresholdPercent: number;
	inputTokens?: number;
}): Promise<boolean> {
	return getContextCompactReason(options) !== null;
}

export function getContextCompactReason(options: {
	session?: Omit<CoreCompactSession, "messages">;
	/** 会话消息快照:只有在没给 `inputTokens` 时才用得上(要靠它估算) */
	sessionMessages?: readonly CoreCompactMessage[];
	modelContextLength: number;
	thresholdPercent: number;
	inputTokens?: number;
}): CoreContextCompactReason | null {
	const inputContextSize =
		options.inputTokens ??
		(options.session
			? estimateCurrentInputTokens(options.session, options.sessionMessages ?? [])
			: 0);
	const reason = getContextUsageTriggerReason({
		inputTokens: inputContextSize,
		modelContextLength: options.modelContextLength,
		thresholdPercent: options.thresholdPercent,
	});
	// Deliberately token-threshold-only. A tail-size (char count) trigger was
	// tried and removed: compaction does not shrink the tail's raw chars, so
	// it re-fired every turn — an infinite compact loop.
	return reason !== "none" ? reason : null;
}

export function estimateCurrentInputTokens(
	session: Omit<CoreCompactSession, "messages">,
	messages: readonly CoreCompactMessage[],
): number {
	const providerInputTokens = Math.max(
		0,
		session.contextSize ?? 0,
		session.lastInputTokens ?? 0,
	);
	const estimatedInputTokens = estimateSessionInputTokens(session, messages);
	return Math.max(providerInputTokens, estimatedInputTokens);
}

export function estimateSessionInputTokens(
	session: Pick<CoreCompactSession, "summary" | "summaryUpToMessageId">,
	sessionMessages: readonly CoreCompactMessage[],
): number {
	const parts: string[] = [];

	if (session.summary && session.summaryUpToMessageId) {
		// 与 history.ts 的注入文案保持同形:估算的是**将要发出去的那份请求**,
		// 换了注入外壳而这里不跟,估算就开始说谎。
		parts.push(
			`The conversation history before this point was compacted into the following summary:\n\n<summary>\n${session.summary}\n</summary>`,
		);
	}

	const summaryIndex =
		session.summary && session.summaryUpToMessageId
			? sessionMessages.findIndex(
					(message) => message.id === session.summaryUpToMessageId,
				)
			: -1;
	const messages =
		summaryIndex >= 0
			? sessionMessages.slice(summaryIndex + 1)
			: sessionMessages;

	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		if (message.isStreaming) continue;

		parts.push(`${message.role}: ${message.content || ""}`);
		if (message.reasoning) {
			parts.push(`reasoning: ${message.reasoning}`);
		}
		if (message.attachments?.length) {
			parts.push(
				`attachments: ${message.attachments
					.map(
						(attachment) =>
							`${attachment.fileName} (${attachment.mimeType}, ${attachment.size} bytes)`,
					)
					.join("; ")}`,
			);
		}
		// Tool payloads are counted at the size the rebuilt request actually
		// ships (sanitized + budgeted), not the compacted summary size — a
		// summary here would blind the threshold check to the very
		// payloads that overflow the model context.
		for (const toolCall of message.toolCalls ?? []) {
			parts.push(
				`toolCall ${toolCall.toolName}: ${safeJsonForSummary(toolCall.arguments || {})}`,
			);
			if (toolCall.status === "completed") {
				parts.push(
					safeJsonForSummary(sanitizeHistoryToolResultForAI(toolCall.result)),
				);
			} else if (toolCall.error || toolCall.rejectionReason) {
				parts.push(toolCall.error || toolCall.rejectionReason || "");
			}
		}
	}

	return estimateTextTokens(parts.join("\n\n"));
}

export function shouldSkipAutoCompactForProviderUsageMismatch(options: {
	providerId: string;
	session: Pick<CoreCompactSession, "contextSize" | "lastInputTokens">;
	modelContextLength: number;
	inputTokens?: number;
}): boolean {
	if (
		!Number.isFinite(options.modelContextLength) ||
		options.modelContextLength <= 0
	)
		return false;
	const inputContextSize =
		options.inputTokens ??
		options.session.contextSize ??
		options.session.lastInputTokens ??
		0;
	return inputContextSize > options.modelContextLength;
}

export function formatMessagesForSummary<TMessage extends CoreCompactMessage>(
	messages: TMessage[],
): string {
	return messages
		.map((message, index) => {
			const label = message.role === "user" ? "User" : "Assistant";
			const parts = [
				`### ${index + 1}. ${label}`,
				message.content || "(empty)",
			];

			if (message.reasoning) {
				parts.push(`Reasoning summary source:\n${message.reasoning}`);
			}

			if (message.toolCalls?.length) {
				parts.push(
					`Tool calls:\n${formatToolCallsForSummary(message.toolCalls)}`,
				);
			}

			if (message.attachments?.length) {
				parts.push(
					`Attachments:\n${message.attachments.map((attachment) => `- ${attachment.fileName} (${attachment.mimeType}, ${attachment.size} bytes)`).join("\n")}`,
				);
			}

			return parts.join("\n\n");
		})
		.join("\n\n---\n\n");
}

function formatToolCallsForSummary(toolCalls: CoreCompactToolCall[]): string {
	return toolCalls
		.map((toolCall) => {
			const status = toolCall.status ? ` (${toolCall.status})` : "";
			const lines = [
				`- ${toolCall.toolName || toolCall.toolId}${status}: ${safeJsonForSummary(toolCall.arguments || {})}`,
			];
			const result = formatToolCallResultForSummary(toolCall);
			if (result) {
				lines.push(`  result: ${result}`);
			}
			return lines.join("\n");
		})
		.join("\n");
}

function formatToolCallResultForSummary(toolCall: CoreCompactToolCall): string {
	if (toolCall.status === "failed" || toolCall.status === "cancelled") {
		return compactSummaryText(
			toolCall.error || toolCall.rejectionReason || "Tool did not complete.",
		);
	}

	if (toolCall.status !== "completed") return "";
	const sanitized = sanitizeToolResultForAI(toolCall.result);
	return compactSummaryText(safeJsonForSummary(sanitized));
}

function safeJsonForSummary(value: unknown): string {
	try {
		return typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function compactSummaryText(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= SUMMARY_TOOL_RESULT_MAX_CHARS) return normalized;
	return `${normalized.slice(0, SUMMARY_TOOL_RESULT_MAX_CHARS).trimEnd()} [truncated ${normalized.length - SUMMARY_TOOL_RESULT_MAX_CHARS} chars]`;
}

