import type { JsonObject } from "../json.js";
import {
	buildContextCompactMergePrompt,
	buildContextCompactPrompt,
} from "./compact-prompt.js";
import { getCoreLogger } from "../logging/index.js";

const log = getCoreLogger("core.engine");

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
/**
 * 窗口未知时的回退块大小。真正的块大小由 `resolveCompactChunkChars` 按模型
 * 窗口算(2026-08-21):窗口够大时多数会话退回单块,这个 80k 只在注册表查不
 * 到窗口(或算出的可用预算为负)时兜底。
 */
export const MAX_CHUNK_CHARS = 80000;
export const SUMMARY_TOOL_RESULT_MAX_CHARS = 6000;

/** 摘要请求里除转录之外的开销:指令正文 + 标签 + 余量。 */
export const COMPACT_PROMPT_OVERHEAD_TOKENS = 4_000;
/** 估算器误差的安全系数 —— 宁可块小一点,也不要一整块请求撞窗口。 */
export const COMPACT_CHUNK_FILL_RATIO = 0.8;
/** 块再小也没有意义:低于这个值不如多切几块。 */
export const MIN_CHUNK_CHARS = 20_000;
/** 多块 map 阶段的并发上限。 */
export const CONTEXT_COMPACT_MAX_CONCURRENCY = 4;

/**
 * 块大小随模型窗口走(2026-08-21)。chars/token 比**实测自转录本身**
 * (`transcript.length / estimateTextTokens(transcript)`),中英混排才准 ——
 * 写死 4 会让纯中文的块超窗口一倍。
 *
 * 不设上限:用户明确要把块做大(块越少,滚动/合并造成的信息损耗越少),
 * 单块超时设置是那一头的护栏。
 */
export function resolveCompactChunkChars(input: {
	transcript: string;
	modelContextLength?: number;
	reservedOutputTokens: number;
}): number {
	const contextLength = input.modelContextLength;
	if (
		typeof contextLength !== "number" ||
		!Number.isFinite(contextLength) ||
		contextLength <= 0
	) {
		return MAX_CHUNK_CHARS;
	}

	const usableTokens =
		contextLength -
		Math.max(0, input.reservedOutputTokens) -
		COMPACT_PROMPT_OVERHEAD_TOKENS;
	if (usableTokens <= 0) return MAX_CHUNK_CHARS;

	const estimatedTokens = estimateTextTokens(input.transcript);
	const ratio =
		input.transcript.length > 0 && estimatedTokens > 0
			? input.transcript.length / estimatedTokens
			: 4;

	const chars = Math.floor(usableTokens * ratio * COMPACT_CHUNK_FILL_RATIO);
	return Math.max(MIN_CHUNK_CHARS, chars);
}

/**
 * P3(2026-08-14):压缩的生死时限归后端。每个 chunk 的摘要请求挂这个上限,
 * 超时走既有失败路径(marker 改 failed + compact-completed(success:false))。
 *
 * 2026-08-21:默认 120s → 300s,并开放为设置项
 * `settings.chat.contextCompactChunkTimeoutSeconds`(真机上一块 80k 字符的摘要
 * 在慢 provider 上常常两分钟回不来,整次压缩因此失败)。这个常量只是**默认值**,
 * 运行时一律经 `resolveContextCompactChunkTimeoutMs` 取。
 */
export const CONTEXT_COMPACT_CHUNK_TIMEOUT_MS = 300_000;
export const CONTEXT_COMPACT_CHUNK_TIMEOUT_MIN_SECONDS = 30;
export const CONTEXT_COMPACT_CHUNK_TIMEOUT_MAX_SECONDS = 1800;

/**
 * 把设置里的秒数解析成毫秒:非数字 / 非有限值走默认,越界夹到 [30s, 30min]。
 */
export function resolveContextCompactChunkTimeoutMs(seconds: unknown): number {
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
		return CONTEXT_COMPACT_CHUNK_TIMEOUT_MS;
	}
	const clamped = Math.min(
		CONTEXT_COMPACT_CHUNK_TIMEOUT_MAX_SECONDS,
		Math.max(CONTEXT_COMPACT_CHUNK_TIMEOUT_MIN_SECONDS, Math.round(seconds)),
	);
	return clamped * 1000;
}

/**
 * 一次压缩的总预算 = 单块超时 × 一个保守的块数上限(5)。两个消费者:
 * 前端 waiter 的传输死亡兜底,和 P2 入口闸 `waitForCompactionIdle` 的放行上限
 * —— 闸是本方案唯一的新增阻塞点,必须有一个绝不会永久等下去的顶。
 * 单块超时可配,所以预算也跟着算:`resolveContextCompactTotalBudgetMs`。
 */
export const CONTEXT_COMPACT_TOTAL_BUDGET_CHUNKS = 5;
export const CONTEXT_COMPACT_TOTAL_BUDGET_MS =
	CONTEXT_COMPACT_CHUNK_TIMEOUT_MS * CONTEXT_COMPACT_TOTAL_BUDGET_CHUNKS;

export function resolveContextCompactTotalBudgetMs(
	chunkTimeoutSeconds: unknown,
): number {
	return (
		resolveContextCompactChunkTimeoutMs(chunkTimeoutSeconds) *
		CONTEXT_COMPACT_TOTAL_BUDGET_CHUNKS
	);
}

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
	kind?: "chunk";
	chunk: string;
	previousSummary?: string;
	/** 多块时标注这是第几块 —— 单块压缩不带,提示词逐字保持旧形。 */
	part?: { index: number; total: number };
}

export interface CoreContextSummaryMergeInput {
	kind: "merge";
	partials: string[];
	previousSummary?: string;
}

export type CoreContextSummaryRequest =
	| CoreContextSummaryChunkInput
	| CoreContextSummaryMergeInput;

export interface CoreContextCompactSummaryMessage {
	role: "system" | "user";
	content: string;
}

export interface CoreContextCompactChunkPlan {
	totalChunks: number;
	maxChunkChars: number;
}

export interface SummarizeContextInChunksOptions {
	messages: string;
	previousSummary?: string;
	maxChunkChars?: number;
	summarizeChunk: (
		input: CoreContextSummaryRequest,
	) => string | Promise<string>;
	/**
	 * P3 进度:每一步完成后回调一次。**只在多块时调用** —— 单块压缩没有可
	 * 报的进度,一条 message:updated 也不该多发。多块的总步数是 N + 1
	 * (N 块 map + 1 次 merge)。
	 */
	onChunkComplete?: (
		progress: CoreContextCompactProgress,
	) => void | Promise<void>;
	/**
	 * 切完块就回调一次(单块也回调),仅供调用方记日志 —— 免得调用方为了知道
	 * 切了几块再自己 `chunkText` 一遍。
	 */
	onPlanned?: (plan: CoreContextCompactChunkPlan) => void;
}

const CONTEXT_SUMMARY_SYSTEM_GUARD =
	// C5:双护栏。摘要请求喂进去的是一整段对话转录,里面有大量指令和
	// 问句 —— 没有这两句,provider 会时不时把转录当成正在进行的对话,
	// 直接去回答里面最后那个问题,而不是概括它。合并请求同样适用。
	"You are a context summarization assistant. You produce structured summaries of conversation transcripts. Do NOT continue the conversation. Do NOT respond to any questions in the conversation.";

export function buildContextCompactSummaryMessages(
	input: CoreContextSummaryRequest,
): CoreContextCompactSummaryMessage[] {
	const userContent =
		input.kind === "merge"
			? buildContextCompactMergePrompt(input.partials, input.previousSummary)
			: buildContextCompactPrompt(
					input.chunk,
					input.previousSummary,
					input.part,
				);
	return [
		{ role: "system", content: CONTEXT_SUMMARY_SYSTEM_GUARD },
		{ role: "user", content: userContent },
	];
}

/**
 * 多块 = map-reduce(2026-08-21)。从前是**串行滚动**:第 k 块带着第 k-1 块的
 * 摘要再请求 —— 一次压缩的墙钟时间是 N 块之和,而且越靠后的块越容易被前面
 * 那份越滚越长的摘要挤掉细节。现在 N 块**互不相干地并发**各出一份部分摘要,
 * 再用一次 merge 请求合成一份;`previousSummary` 只喂给 merge(部分摘要不该
 * 各自去改写同一份旧摘要)。
 *
 * 单块路径与从前**完全一致**:一次请求、不带 part、不报进度。
 */
export async function summarizeContextInChunks(
	options: SummarizeContextInChunksOptions,
): Promise<string> {
	const maxChunkChars = options.maxChunkChars ?? MAX_CHUNK_CHARS;
	const chunks = chunkText(options.messages, maxChunkChars);
	options.onPlanned?.({ totalChunks: chunks.length, maxChunkChars });

	const previousSummary = options.previousSummary || undefined;

	if (chunks.length === 1) {
		const only = await options.summarizeChunk({
			kind: "chunk",
			chunk: chunks[0],
			previousSummary,
		});
		return normalizeContextSummaryOutput(only).trim();
	}

	const totalSteps = chunks.length + 1;
	let done = 0;

	const partials = await mapWithConcurrency(
		chunks,
		CONTEXT_COMPACT_MAX_CONCURRENCY,
		async (chunk, index) => {
			const text = normalizeContextSummaryOutput(
				await options.summarizeChunk({
					kind: "chunk",
					chunk,
					part: { index: index + 1, total: chunks.length },
				}),
			);
			done += 1;
			await options.onChunkComplete?.({
				chunk: done,
				totalChunks: totalSteps,
			});
			return text;
		},
	);

	const merged = normalizeContextSummaryOutput(
		await options.summarizeChunk({ kind: "merge", partials, previousSummary }),
	);
	await options.onChunkComplete?.({
		chunk: totalSteps,
		totalChunks: totalSteps,
	});

	return merged.trim();
}

/**
 * 有上限的并发 map,结果保持入参顺序。**fail-fast**:首个失败立即抛出,不再
 * 派发新任务;在途的 promise 挂上 `.catch` 兜住,免得它们随后的失败变成
 * unhandled rejection。
 */
async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	let stopped = false;

	const runLane = async (): Promise<void> => {
		while (!stopped) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	};

	const lanes = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		() => runLane(),
	);

	try {
		await Promise.all(lanes);
	} catch (error) {
		stopped = true;
		for (const lane of lanes) lane.catch(() => {});
		throw error;
	}

	return results;
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
