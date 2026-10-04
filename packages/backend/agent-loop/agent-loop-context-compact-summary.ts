// 上下文压缩的第三步:把选出来的那段转录分块摘要(单块直出,多块 map-reduce),连同单块超时与总预算。
// 块多大由 `agent-loop-context-compact-sizing.ts` 定,选哪段由 `agent-loop-context-compact.ts` 定。
import { isAgentExecutionCheckpointError } from './agent-loop-errors.js';
import type { CoreContextCompactProgress } from "@shared/engine/context-compact-content.js";
import {
	buildContextCompactMergePrompt,
	buildContextCompactPrompt,
} from "./agent-loop-compact-prompt.js";
import { MAX_CHUNK_CHARS } from "./agent-loop-context-compact-sizing.js";

/** 多块 map 阶段的并发上限。 */
export const CONTEXT_COMPACT_MAX_CONCURRENCY = 4;

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
		const settled = await Promise.allSettled(lanes);
		const checkpointFailure = settled.find(result => result.status === 'rejected' && isAgentExecutionCheckpointError(result.reason));
		throw checkpointFailure?.status === 'rejected' ? checkpointFailure.reason : error;
	}

	return results;
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

export function chunkText(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];

	const chunks: string[] = [];
	for (let start = 0; start < text.length; start += maxChars) {
		chunks.push(text.slice(start, start + maxChars));
	}
	return chunks;
}
