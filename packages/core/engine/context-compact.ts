import type { JsonObject } from "../json.js";
import { buildContextCompactPrompt } from "./compact-prompt.js";
import {
	COMPACTED_HISTORY_RETAINED_PAYLOAD_BUDGET_CHARS,
	sanitizeHistoryToolResultForAI,
	sanitizeToolResultForAI,
	type CoreHistoryChatMessage,
} from "./history.js";
import {
	estimateTextTokens,
	getContextUsageTriggerReason,
} from "./context-usage.js";

export const DEFAULT_KEEP_RECENT_TURNS = 6;
export const MAX_CHUNK_CHARS = 80000;
export const SUMMARY_TOOL_RESULT_MAX_CHARS = 6000;

/**
 * P3(2026-08-14):压缩的生死时限归后端。每个 chunk 的摘要请求挂这个上限,
 * 超时走既有失败路径(marker 改 failed + compact-completed(success:false))。
 * 常量,不进设置页 —— 用户没有理由调它。
 */
export const CONTEXT_COMPACT_CHUNK_TIMEOUT_MS = 120_000;

/**
 * 一次压缩的总预算 = 单块超时 × 一个保守的块数上限(5)。两个消费者:
 * 前端 waiter 的传输死亡兜底,和 P2 入口闸 `waitForCompactionIdle` 的放行上限
 * —— 闸是本方案唯一的新增阻塞点,必须有一个绝不会永久等下去的顶。
 */
export const CONTEXT_COMPACT_TOTAL_BUDGET_MS = CONTEXT_COMPACT_CHUNK_TIMEOUT_MS * 5;

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

export type CoreContextCompactStatus = "compacting" | "completed" | "failed";

export interface CoreContextCompactProgress {
	chunk: number;
	totalChunks: number;
}

export interface CoreContextCompactContent {
	type: "context-compact";
	status: CoreContextCompactStatus;
	summary: string;
	compactedMessageCount: number;
	error?: string;
	/**
	 * P0(2026-08-14):标记消息不再插进历史中部,而是**追加到会话末尾** ——
	 * 展示位置从此是「压缩发生的时间点」。切点因而必须写进内容:这是「压到
	 * 哪一条为止」的唯一凭据。字段可选、位置任意 —— 旧会话中部的历史标记
	 * 没有它,照常渲染,无需迁移。
	 */
	compactedThroughMessageId?: string;
	/**
	 * P3:多块摘要的进度(每块完成后刷一次 marker)。单块压缩不写,不多发事件。
	 */
	progress?: CoreContextCompactProgress;
}

export interface CoreContextCompactMessage {
	id: string;
	role: "system";
	content: string;
	timestamp: number;
}

export function buildContextCompactContent(input: {
	status: CoreContextCompactStatus;
	compactedMessageCount: number;
	summary?: string;
	error?: string;
	compactedThroughMessageId?: string;
	progress?: CoreContextCompactProgress;
}): string {
	const content: CoreContextCompactContent = {
		type: "context-compact",
		status: input.status,
		summary: input.summary ?? "",
		compactedMessageCount: input.compactedMessageCount,
	};
	if (input.error) {
		content.error = input.error;
	}
	if (input.compactedThroughMessageId) {
		content.compactedThroughMessageId = input.compactedThroughMessageId;
	}
	if (input.progress) {
		content.progress = input.progress;
	}
	return JSON.stringify(content);
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
): string {
	return buildContextCompactContent({
		status: "completed",
		summary,
		compactedMessageCount,
		compactedThroughMessageId,
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

export interface CoreContextSummaryChunkInput {
	chunk: string;
	previousSummary?: string;
}

export interface CoreContextCompactSummaryMessage {
	role: "system" | "user";
	content: string;
}

export interface SummarizeContextInChunksOptions {
	messages: string;
	previousSummary?: string;
	maxChunkChars?: number;
	summarizeChunk: (
		input: CoreContextSummaryChunkInput,
	) => string | Promise<string>;
	/**
	 * P3 进度:每块摘要完成后回调一次。**只在多块时调用** —— 单块压缩没有可
	 * 报的进度,一条 message:updated 也不该多发。
	 */
	onChunkComplete?: (
		progress: CoreContextCompactProgress,
	) => void | Promise<void>;
}

export function buildContextCompactSummaryMessages(
	input: CoreContextSummaryChunkInput,
): CoreContextCompactSummaryMessage[] {
	return [
		{
			role: "system",
			// C5:双护栏。摘要请求喂进去的是一整段对话转录,里面有大量指令和
			// 问句 —— 没有这两句,provider 会时不时把转录当成正在进行的对话,
			// 直接去回答里面最后那个问题,而不是概括它。
			content:
				"You are a context summarization assistant. You produce structured summaries of conversation transcripts. Do NOT continue the conversation. Do NOT respond to any questions in the conversation.",
		},
		{
			role: "user",
			content: buildContextCompactPrompt(input.chunk, input.previousSummary),
		},
	];
}

export async function summarizeContextInChunks(
	options: SummarizeContextInChunksOptions,
): Promise<string> {
	const chunks = chunkText(
		options.messages,
		options.maxChunkChars ?? MAX_CHUNK_CHARS,
	);
	let summary = options.previousSummary || "";

	for (let index = 0; index < chunks.length; index++) {
		const nextSummary = await options.summarizeChunk({
			chunk: chunks[index],
			previousSummary: summary || undefined,
		});
		summary = normalizeContextSummaryOutput(nextSummary);
		if (chunks.length > 1) {
			await options.onChunkComplete?.({
				chunk: index + 1,
				totalChunks: chunks.length,
			});
		}
	}

	return summary.trim();
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
			console.warn("[ContextCompact] Ignoring summary with missing anchor:", {
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

export type CoreContextCompactReason = "threshold" | "hard-limit";

export async function shouldAutoCompactBeforeSend(options: {
	session: Omit<CoreCompactSession, "messages">;
	/** 会话消息快照:只有在没给 `inputTokens` 时才用得上(要靠它估算) */
	sessionMessages?: readonly CoreCompactMessage[];
	modelContextLength: number;
	thresholdPercent: number;
	reservedOutputTokens?: number;
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
	reservedOutputTokens?: number;
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
		reservedOutputTokens: options.reservedOutputTokens,
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
		// summary here would blind the threshold/hard-limit checks to the very
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

/**
 * C5:输出从 JSON 换成固定标题的 Markdown 六节式,校验也随之从「能不能
 * JSON.parse」换成「有没有 `## Goal` 标题」。**不再做 JSON 抽取** —— 从前那段
 * 找 `{`…`}` 的兜底是给 JSON 形态用的,对 Markdown 只会把一段正文腰斩。
 * 不合格就原样返回裁剪后的原文:一份没按格式写的摘要仍然比没有摘要好。
 */
export function normalizeContextSummaryOutput(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";

	const withoutFence = trimmed
		.replace(/^```(?:markdown|md|json)?[ \t]*\r?\n?/i, "")
		.replace(/\r?\n?[ \t]*```$/i, "")
		.trim();

	return CONTEXT_SUMMARY_GOAL_HEADING_RE.test(withoutFence)
		? withoutFence
		: trimmed;
}

const CONTEXT_SUMMARY_GOAL_HEADING_RE = /(^|\n)##[ \t]+Goal[ \t]*(\n|$)/;

export const COMPACT_READ_FILES_TAG = "read-files";
export const COMPACT_MODIFIED_FILES_TAG = "modified-files";

export interface CoreCompactFileOperations {
	read: string[];
	modified: string[];
}

const compactFileTagRe = (tag: string) =>
	new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "g");

/**
 * C5:确定性文件清单的**格式化**(通用字符串活,归 core);「哪个工具的哪个
 * 参数是路径」的分类表归 app 层 —— core 不识产品工具名。空清单省略对应标签。
 */
export function formatCompactFileOperations(
	operations: CoreCompactFileOperations,
): string {
	const blocks: string[] = [];
	if (operations.read.length > 0) {
		blocks.push(
			`<${COMPACT_READ_FILES_TAG}>\n${operations.read.join("\n")}\n</${COMPACT_READ_FILES_TAG}>`,
		);
	}
	if (operations.modified.length > 0) {
		blocks.push(
			`<${COMPACT_MODIFIED_FILES_TAG}>\n${operations.modified.join("\n")}\n</${COMPACT_MODIFIED_FILES_TAG}>`,
		);
	}
	return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}

/** 从一份既有摘要的尾部读回两张清单(UPDATE 模式的并集去重用)。 */
export function extractCompactFileOperations(
	summary: string,
): CoreCompactFileOperations {
	const collect = (tag: string): string[] => {
		const lines: string[] = [];
		for (const match of summary.matchAll(compactFileTagRe(tag))) {
			for (const line of match[1].split("\n")) {
				const entry = line.trim();
				if (entry) lines.push(entry);
			}
		}
		return dedupePreservingOrder(lines);
	};
	return {
		read: collect(COMPACT_READ_FILES_TAG),
		modified: collect(COMPACT_MODIFIED_FILES_TAG),
	};
}

/**
 * 剥掉尾部的两张清单。传给模型的 previousSummary 走这里:清单归代码管,
 * 让模型看见它只会把它改写掉。
 */
export function stripCompactFileOperations(summary: string): string {
	return summary
		.replace(compactFileTagRe(COMPACT_READ_FILES_TAG), "")
		.replace(compactFileTagRe(COMPACT_MODIFIED_FILES_TAG), "")
		.trim();
}

export function mergeCompactFileOperations(
	previous: CoreCompactFileOperations,
	next: CoreCompactFileOperations,
): CoreCompactFileOperations {
	return {
		read: dedupePreservingOrder([...previous.read, ...next.read]),
		modified: dedupePreservingOrder([...previous.modified, ...next.modified]),
	};
}

function dedupePreservingOrder(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
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

export function chunkText(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];

	const chunks: string[] = [];
	for (let start = 0; start < text.length; start += maxChars) {
		chunks.push(text.slice(start, start + maxChars));
	}
	return chunks;
}
