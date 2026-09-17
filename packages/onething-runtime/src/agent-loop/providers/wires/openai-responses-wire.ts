/**
 * `OpenAIResponsesWire` —— OpenAI Responses(`/responses`,SSE 档)这条线协议的
 * **唯一**实现(设计稿 §3:一条 wire 一个类,管线写死在 `HttpAgentProvider`
 * 的模板方法里)。
 *
 * P4-4 起它上面挂三个 id(`codex` / `grok` / `grok-oauth`)—— 一条订阅制后台
 * (ChatGPT backend-api)与一家 API-key 端点(`https://api.x.ai/v1`)跑同一条
 * 管线,这就是「Responses wire 脱得开 codex 的怪癖」那道门。
 *
 * codex 专属的每一样东西都是**配方上的字段**,不是这个类里的分支:认证
 * (OAuth token 三级解析 + 六个 codex 头 + 401 强制刷新重试)、端点
 * (`…/codex/responses` 的三态归一化)、`instructions` 兜底、`store`、
 * 原生工具(`image_generation`)、思考线型(`reasoning` + `include` 的同生共死)、
 * 错误措辞(`Codex request failed (…)`)、provider-data 标签、usage 里的
 * 厂商报价。这个类里没有一处 `if (providerId === …)`。
 *
 * P1-c 是**纯搬运**:`codex.ts` 的 `buildCodexRequestBody`、
 * `parseCodexResponsesSse` 的整个流状态机、`mapCodexFinishReason` 的映射,
 * 逐字保留(`__tests__/wire-snapshots/responses` 的 9 份快照就是这句话的门,
 * **禁 `-u`**)。
 *
 * 三处复刻的现状,后面几期再动(设计稿 §9 P1 门 ①;第四处「相邻同角色不合并」
 * 已在 P0b-B 与别家统一成合并):
 *  - **不发 temperature / maxTokens**:Responses 有这两个旋钮,但今天的 codex
 *    一个都不拼(`noSamplingPolicy`,`maxTokensField` 无读者);
 *  - **`isError` 对模型不可见**:工具结果的失败标记在这条线上没有出口
 *    (anthropic 有,设计稿把它排成 P3 功能项);
 *  - **dump 时序**:今天在 token 解析之前落盘,统一之后变成 auth 之后 ——
 *    落盘的字节一模一样(`dumpMetadata` 覆盖成 `{url, method, requestSource}`),
 *    差别只在「落盘了但 token 没拿到」这条边界上,fixture 看不见。
 */
import type {
	AgentFinishReason,
	AgentJsonValue,
	AgentModelCapabilities,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import { getLogger } from "../../../logging/index.js";
import { mergeAdjacentSameRoleMessages } from "../message-merge.js";
import {
	HttpAgentProvider,
	UsageBuckets,
	noSamplingPolicy,
	type Dialect,
	type FinishReasonMapper,
	type PartCodec,
	type ProviderContext,
	type RawTurnFinish,
	type RequestBodyBuilder,
	type SamplingPolicy,
	type ToolChoicePolicy,
	type TurnContext,
	type UsageNormalizer,
} from "../base/index.js";
import type { AgentProviderRequestDumpValue } from "../request-dump.js";
import { CodexResponsesErrorMapper } from "./openai-responses-errors.js";
import {
	responsesParts,
	stringifyCodexToolInput,
	toCodexToolChoice,
	toCodexTools,
	type CodexTool,
	type ResponsesCodec,
	type ResponsesWireValue,
} from "./openai-responses-messages.js";

// ---------------------------------------------------------------------------
// 方言:这条线上多出来的两个字段
// ---------------------------------------------------------------------------

export interface ResponsesDialect extends Dialect<ResponsesWireValue> {
	/** provider 的**传输**声明(模态 / 结构化工具结果)。per-model 的布尔归账本。 */
	transport: AgentModelCapabilities;
	/** 一条 system 都没有时顶上去的 `instructions`(Responses 这个字段必填)。 */
	fallbackInstructions: string;
	/**
	 * 这一家的 provider-data 标签 —— 流里产出的 `encrypted-reasoning` /
	 * `image-generation-*` 事件挂它,历史回放时 codec 也按它认
	 * (`codexEncryptedReasoning`)。codex → `'codex'`,xAI 两条通路 → `'grok'`。
	 */
	providerDataTag: string;
	/**
	 * 顶层 `store`。`undefined` = 不发这个键(服务端默认 `true`,30 天留存)。
	 * 我们两家都发 `false`:会话历史由本地这份账本负责,端点侧无状态。
	 */
	store?: boolean;
	/**
	 * 这一回合要挂的**原生工具**(服务端自己执行的那种)。codex 的
	 * `image_generation` 由 `requestedOutputModalities` 含 `'image'` 决定;
	 * xAI 有 `web_search` / `x_search` / `code_interpreter`,但本期一个都不挂。
	 */
	nativeTools?(turn: TurnContext): CodexTool[];
	/**
	 * 完成的一条 output item → 额外事件。方言缝,与 openai-chat 的
	 * `PartCodec.decodeExtras` 同一个位置:xAI 的 `url_citation` annotations
	 * 长在 `message` 项的 `content[].annotations` 上,只有到 item 完成才拿得全。
	 */
	decodeOutputItem?(
		item: Record<string, unknown>,
		turn: TurnContext,
	): AgentTurnStreamEvent[];
}

// ---------------------------------------------------------------------------
// 流上的形状
// ---------------------------------------------------------------------------

type CodexRawRecord = Record<string, AgentJsonValue | undefined>;

export interface CodexResponsesUsage {
	/** xAI 独有的厂商报价(1e10 ticks = $1)。codex 不报这个字段。 */
	cost_in_usd_ticks?: number;
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	output_tokens_details?: { reasoning_tokens?: number };
	input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

export interface CodexSseEvent {
	type?: string;
	delta?: string;
	text?: string;
	input?: string;
	arguments_delta?: string;
	argumentsDelta?: string;
	item_id?: string;
	itemId?: string;
	call_id?: string;
	callId?: string;
	summary_index?: number;
	content_index?: number;
	part?: AgentJsonValue;
	summary?: AgentJsonValue;
	summary_text?: AgentJsonValue;
	summaryText?: AgentJsonValue;
	item?: CodexRawRecord;
	response?: {
		id?: string;
		model?: string;
		usage?: CodexResponsesUsage;
		incomplete_details?: { reason?: string };
		error?: { message?: string };
	};
	error?: { message?: string };
}

function codexRecord(value: AgentJsonValue | undefined): CodexRawRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as CodexRawRecord)
		: {};
}

function optionalString(value: AgentJsonValue | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collectReasoningSummaryText(
	value: AgentJsonValue | undefined,
): string[] {
	if (typeof value === "string") return value ? [value] : [];
	if (!value || typeof value !== "object") return [];
	if (Array.isArray(value)) return value.flatMap(collectReasoningSummaryText);
	const record = codexRecord(value);
	return [
		record.text,
		record.summary_text,
		record.summaryText,
		record.value,
		record.summary,
		record.parts,
		record.items,
	].flatMap(collectReasoningSummaryText);
}

function collectManyReasoningSummaryText(
	values: Array<AgentJsonValue | undefined>,
): string[] {
	return values.flatMap((value) => collectReasoningSummaryText(value));
}

function extractOutputText(item: AgentJsonValue | undefined): string {
	const itemRecord = codexRecord(item);
	if (!Array.isArray(itemRecord.content)) return "";
	return itemRecord.content
		.map((content) => {
			const record = codexRecord(content);
			return optionalString(record.text) ?? optionalString(record.content) ?? "";
		})
		.join("");
}

function extractReasoningSummaryText(item: AgentJsonValue | undefined): string {
	const record = codexRecord(item);
	return collectManyReasoningSummaryText([
		record.summary,
		record.text,
		record.summary_text,
		record.summaryText,
		record.reasoning_summary,
		record.reasoningSummary,
	]).join("");
}

function isCodexFunctionCallItem(item: AgentJsonValue | undefined): boolean {
	const record = codexRecord(item);
	return record.type === "function_call" || record.type === "custom_tool_call";
}

/**
 * SSE 拆包 —— 这条线的事件类型写在 **`event:` 行**上,`data` 里不一定有
 * `type`,所以不能用共用的 `readJsonSseData`(那条只读 `data:`)。逐字复刻
 * `parseCodexResponsesSse`:`[DONE]` 跳过,缓冲区尾巴在流末补发一次。
 */
export async function* parseCodexResponsesSse(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<CodexSseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName: string | null = null;
	let dataLines: string[] = [];

	function decode(): CodexSseEvent | undefined {
		const data = dataLines.join("\n").trim();
		const name = eventName;
		eventName = null;
		dataLines = [];
		if (!data || data === "[DONE]") return undefined;
		const parsed = JSON.parse(data) as CodexSseEvent;
		if (name && !parsed.type) parsed.type = name;
		return parsed;
	}

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line === "") {
					const event = decode();
					if (event) yield event;
					continue;
				}
				if (line.startsWith("event:")) {
					eventName = line.slice(6).trim();
				} else if (line.startsWith("data:")) {
					dataLines.push(line.slice(5).trimStart());
				}
			}
		}
		if (buffer.trim()) {
			dataLines.push(
				buffer.startsWith("data:") ? buffer.slice(5).trimStart() : buffer.trim(),
			);
		}
		const event = decode();
		if (event) yield event;
	} finally {
		reader.releaseLock();
	}
}

// ---------------------------------------------------------------------------
// usage —— §7 的三桶直译
// ---------------------------------------------------------------------------

/**
 * 「这块响应里到底有没有 usage」的判据 —— `usageFromResponse` 逐字:
 * `input_tokens` / `output_tokens` / `total_tokens` 三个里有一个是数就算有。
 */
export function hasCodexResponsesUsage(usage: CodexResponsesUsage | undefined): boolean {
	if (!usage) return false;
	return (
		usage.input_tokens !== undefined ||
		usage.output_tokens !== undefined ||
		usage.total_tokens !== undefined
	);
}

/**
 * 三桶直译(设计稿 §7 的 Responses 行):`input_tokens` **含** cached **与**
 * cache_write,所以 uncachedInput = `input − cached − cache_write`(投影
 * `input = uncached + read`;`cacheWrite` 在 input 之外单独计费)。
 * `total_tokens` 是厂商自己报的口径,原样进 `reportedTotal`。
 *
 * `cache_write_tokens` 只有 GPT-5.6+ 会报(读 0.1× / 写 1.25× / 未缓存 1×);
 * 老模型没这个字段,那一桶就是 0,投影里连键都不出现。
 */
export class CodexResponsesUsageNormalizer implements UsageNormalizer {
	/**
	 * `providerCost` 是方言的一行:xAI 在 `/v1/responses` 的 usage 上多报一个
	 * `cost_in_usd_ticks`(官方 `POST /v1/responses` → Response Body → usage:
	 * 「Accurate cost of this request in USD ticks… there is 10'000'000'000
	 * ticks in one *dollar*」)。codex 不报,不传这个参数就是今天逐字的行为。
	 */
	constructor(
		private readonly providerCost?: (
			usage: CodexResponsesUsage,
		) => number | undefined,
	) {}

	toBuckets(raw: unknown): UsageBuckets | undefined {
		if (typeof raw !== "object" || raw === null) return undefined;
		const usage = raw as CodexResponsesUsage;
		if (!hasCodexResponsesUsage(usage)) return undefined;
		const inputTokens = usage.input_tokens ?? 0;
		const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
		const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
		return new UsageBuckets(
			Math.max(inputTokens - cacheRead - cacheWrite, 0),
			cacheRead,
			cacheWrite,
			usage.output_tokens ?? 0,
			usage.output_tokens_details?.reasoning_tokens,
			undefined,
			this.providerCost?.(usage),
			// 厂商没报 total 时派生 `input + output` —— `usageFromResponse` 的
			// `?? (in ?? 0) + (out ?? 0)` 与 `UsageBuckets.total` 同一句话。
			usage.total_tokens,
		);
	}
}

export const codexResponsesUsage: UsageNormalizer =
	new CodexResponsesUsageNormalizer();

// ---------------------------------------------------------------------------
// finish reason
// ---------------------------------------------------------------------------

/**
 * `mapCodexFinishReason` 逐字。
 *
 * 它对**自己的输出是幂等的**(`stop`/`length`/`error`/`tool_calls`/
 * `content_filter`/`unknown` 原样回),所以 `parseStream` 里那台状态机可以
 * 继续按今天的样子直接算出契约值,再由这里过一道 —— 两边不会打架。
 */
export class CodexFinishReasonMapper implements FinishReasonMapper {
	map(reason: string | null | undefined): AgentFinishReason {
		switch (reason) {
			case "stop":
			case "length":
			case "error":
				return reason;
			case "max_output_tokens":
			case "max_tokens":
				return "length";
			case "tool-calls":
			case "tool_calls":
				return "tool_calls";
			case "content-filter":
			case "content_filter":
				return "content_filter";
			default:
				return "unknown";
		}
	}
}

export const codexFinishReasonMapper: FinishReasonMapper =
	new CodexFinishReasonMapper();

// ---------------------------------------------------------------------------
// 横切策略
// ---------------------------------------------------------------------------

/**
 * `tool_choice` **恒发**(没有工具时也发 `'auto'`,`baseline.request.json`
 * 钉着这一条),指名工具是**扁平**的 `{type:'function', name}`。
 * —— 与 openai-chat 那条「有工具才发、指名嵌套」正好两处都不同。
 */
export class ResponsesToolChoicePolicy implements ToolChoicePolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void {
		builder.set("tool_choice", toCodexToolChoice(turn.request.toolChoice));
	}
}

export const responsesToolChoicePolicy: ToolChoicePolicy =
	new ResponsesToolChoicePolicy();

// ---------------------------------------------------------------------------
// wire
// ---------------------------------------------------------------------------

interface ActiveFunctionCallInput {
	itemId: string;
	callId: string;
	toolName: string;
	streamedArgs: string;
	started: boolean;
}

export class OpenAIResponsesWire extends HttpAgentProvider<
	Record<string, unknown>,
	CodexSseEvent
> {
	constructor(ctx: ProviderContext, dialect: ResponsesDialect) {
		super(ctx, dialect);
	}

	protected get transportCapabilities(): AgentModelCapabilities {
		return this.responsesDialect.transport;
	}

	protected get defaultParts(): PartCodec {
		return responsesParts;
	}

	protected get defaultUsage(): UsageNormalizer {
		return codexResponsesUsage;
	}

	protected get finish(): FinishReasonMapper {
		return codexFinishReasonMapper;
	}

	protected override get defaultToolChoice(): ToolChoicePolicy {
		return responsesToolChoicePolicy;
	}

	/** Responses 有 temperature / max_output_tokens,今天的 codex 一个都不拼。 */
	protected override get defaultSampling(): SamplingPolicy {
		return noSamplingPolicy;
	}

	/** P1-d1 起抛 `ProviderHttpError`(见 `openai-responses-errors.ts` 的抬头)。 */
	protected override get errors(): CodexResponsesErrorMapper {
		return (
			(this.dialect.errors as CodexResponsesErrorMapper | undefined) ??
			new CodexResponsesErrorMapper(this.id)
		);
	}

	protected get responsesDialect(): ResponsesDialect {
		return this.dialect as ResponsesDialect;
	}

	protected get responsesParts(): ResponsesCodec {
		return this.parts as ResponsesCodec;
	}

	/** 这条线是全仓唯一 `mode: 'codex-http'` 的。 */
	protected override get dumpMode(): "stream" | "codex-http" {
		return "codex-http";
	}

	/**
	 * 落盘元信息 —— 今天的形状是 `{url, method, requestSource}`,**没有 `turn`**
	 * (设计稿 §9 P1 门 ①,`baseline.request.json` 钉着)。
	 */
	protected override dumpMetadata(
		_turn: TurnContext,
		url: string,
	): Record<string, AgentProviderRequestDumpValue> {
		return { url, method: "POST", requestSource: "agent-loop" };
	}

	// -----------------------------------------------------------------------
	// 请求体 —— `buildCodexRequestBody` 逐字(`reasoning` / `include` 由
	// `ResponsesReasoningWire` 在下一步写,顺序不影响字节)
	// -----------------------------------------------------------------------

	protected buildBody(turn: TurnContext): void {
		const { builder, request } = turn;
		// P0b-B 起这条线上 `mergeAdjacent` 也是 **true**:Responses 的 `input`
		// 是项数组、不要求严格交替,合并对它是无害的等价改写 —— 四条线同规,
		// 同一段对话在哪条线上都长成一个样子。
		const messages = this.responsesDialect.request.mergeAdjacent
			? mergeAdjacentSameRoleMessages(request.messages)
			: request.messages;
		const { input, instructions } = this.responsesParts.toRequestPrompt(
			messages,
			turn,
		);
		const dialect = this.responsesDialect;

		builder.set("model", request.model);
		builder.set("instructions", instructions || dialect.fallbackInstructions);
		builder.set("input", input);
		// 原生工具不是一个开关,而是**工具表里多几项** —— 挂哪些由方言说了算
		// (codex 的生图路由:`requestedOutputModalities` 含 'image')。
		builder.set("tools", toCodexTools(request.tools, dialect.nativeTools?.(turn)));
		builder.set("parallel_tool_calls", false);
		if (dialect.store !== undefined) builder.set("store", dialect.store);
		builder.set("stream", true);
	}

	// -----------------------------------------------------------------------
	// 流解析 —— `codex.ts` 那台状态机逐字
	// -----------------------------------------------------------------------

	protected async *parseStream(
		response: Response,
		turn: TurnContext,
	): AsyncGenerator<AgentTurnStreamEvent, RawTurnFinish, void> {
		if (!response.body) {
			throw new Error(this.errors.emptyBodyMessage());
		}

		const log = turn.logger;
		const turnIndex = turn.turn;
		const providerTag = this.responsesDialect.providerDataTag;
		const decodeOutputItem = this.responsesDialect.decodeOutputItem?.bind(
			this.responsesDialect,
		);
		const errors = this.errors;
		const debugStream = log.isLevelEnabled("trace");

		let finishReason: AgentFinishReason = "unknown";
		let usage: CodexResponsesUsage | undefined;
		let completedToolCallCount = 0;
		let emittedTextFromDelta = false;
		let activeReasoningItemId: string | undefined;
		const reasoningSummaryByItem = new Map<string, string>();
		const reasoningPartsByItem = new Map<string, Map<number, string>>();
		const activeReasoningPartByItem = new Map<string, number>();
		const streamStartedAt = Date.now();
		const streamStats = {
			events: 0,
			reasoningDeltaEvents: 0,
			reasoningDeltaChars: 0,
			maxReasoningDeltaChars: 0,
			toolArgumentDeltaEvents: 0,
			reasoningDeltas: 0,
			reasoningChars: 0,
			textDeltas: 0,
			textChars: 0,
			firstReasoningMs: undefined as number | undefined,
			firstTextMs: undefined as number | undefined,
			reasoningSnapshotMismatches: 0,
		};
		const unhandledEvents = new Map<string, number>();
		const unhandledOutputItems = new Map<string, number>();
		const countUnhandled = (counts: Map<string, number>, value: unknown): void => {
			// Types only: no arguments, response text, IDs, or encrypted reasoning.
			const type = typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value)
				? value : "unknown";
			const key = counts.has(type) || counts.size < 32 ? type : "other";
			counts.set(key, (counts.get(key) ?? 0) + 1);
		};

		const toolInputByItemId = new Map<string, ActiveFunctionCallInput>();
		const toolInputByCallId = new Map<string, ActiveFunctionCallInput>();
		const pendingToolInputDeltas = new Map<string, string>();

		const emitReasoning = function* (
			delta: string,
			itemId = "reasoning-0",
		): Generator<AgentTurnStreamEvent> {
			if (!delta) return;
			streamStats.reasoningDeltas += 1;
			streamStats.reasoningChars += delta.length;
			streamStats.firstReasoningMs ??= Date.now() - streamStartedAt;
			reasoningSummaryByItem.set(
				itemId,
				`${reasoningSummaryByItem.get(itemId) ?? ""}${delta}`,
			);
			if (debugStream) {
				log.trace("reasoning delta", {
					turn: turnIndex,
					chars: delta.length,
				});
			}
			yield { type: "reasoning-delta", turn: turnIndex, delta };
		};

		const reasoningPartIndex = (event: CodexSseEvent, itemId: string): number =>
			event.summary_index ?? event.content_index ?? activeReasoningPartByItem.get(itemId) ?? 0;

		const emitReasoningPart = function* (
			delta: string,
			itemId: string,
			partIndex: number,
		): Generator<AgentTurnStreamEvent> {
			if (!delta) return;
			let parts = reasoningPartsByItem.get(itemId);
			if (!parts) reasoningPartsByItem.set(itemId, parts = new Map());
			if (!parts.has(partIndex) && reasoningSummaryByItem.get(itemId)?.trim()) {
				yield* emitReasoning("\n\n", itemId);
			}
			parts.set(partIndex, `${parts.get(partIndex) ?? ""}${delta}`);
			activeReasoningPartByItem.set(itemId, partIndex);
			yield* emitReasoning(delta, itemId);
		};

		const emitReasoningSnapshot = function* (
			summary: string,
			itemId: string,
			partIndex: number,
		): Generator<AgentTurnStreamEvent> {
			if (!summary) return;
			const streamed = reasoningPartsByItem.get(itemId)?.get(partIndex) ?? "";
			if (summary.startsWith(streamed)) {
				yield* emitReasoningPart(summary.slice(streamed.length), itemId, partIndex);
			} else if (!streamed.startsWith(summary)) {
				// A completed snapshot may revise already emitted text. The stream
				// contract is append-only; record the mismatch without duplicating it.
				streamStats.reasoningSnapshotMismatches += 1;
			}
		};

		const emitReasoningItem = function* (
			item: CodexRawRecord,
			itemId: string,
		): Generator<AgentTurnStreamEvent> {
			if (Array.isArray(item.summary) && item.summary.length > 0) {
				for (const [index, part] of item.summary.entries()) {
					yield* emitReasoningSnapshot(collectReasoningSummaryText(part).join(""), itemId, index);
				}
			} else {
				yield* emitReasoningSnapshot(extractReasoningSummaryText(item), itemId, 0);
			}
		};

		const emitText = function* (delta: string): Generator<AgentTurnStreamEvent> {
			if (!delta) return;
			streamStats.textDeltas += 1;
			streamStats.textChars += delta.length;
			streamStats.firstTextMs ??= Date.now() - streamStartedAt;
			emittedTextFromDelta = true;
			if (debugStream) {
				log.trace("text delta", {
					turn: turnIndex,
					chars: delta.length,
				});
			}
			yield { type: "text-delta", turn: turnIndex, delta };
		};

		const getFunctionCallItemId = (
			item: CodexRawRecord,
			event?: CodexSseEvent,
			fallback?: string,
		): string | undefined => {
			const id =
				item.id ?? item.item_id ?? item.itemId ?? event?.item_id ?? fallback;
			return optionalString(id);
		};
		const getFunctionCallCallId = (
			item: CodexRawRecord,
			event?: CodexSseEvent,
		): string | undefined => {
			return (
				optionalString(item.call_id) ??
				optionalString(item.callId) ??
				optionalString(event?.call_id) ??
				optionalString(item.id)
			);
		};
		const getFunctionCallToolName = (
			item: CodexRawRecord,
		): string | undefined => {
			return (
				optionalString(item.name) ??
				optionalString(item.tool_name) ??
				optionalString(item.toolName)
			);
		};
		const getFunctionCallArgs = (item: CodexRawRecord): string => {
			if (typeof item.arguments === "string") return item.arguments;
			if (typeof item.input === "string") return item.input;
			return stringifyCodexToolInput(item.arguments ?? item.input);
		};
		const getReasoningItemId = (
			item: CodexRawRecord | undefined,
			event: CodexSseEvent,
			fallback: string,
		): string => {
			return (
				optionalString(item?.id) ??
				optionalString(item?.item_id) ??
				optionalString(item?.itemId) ??
				optionalString(event.item_id) ??
				optionalString(event.itemId) ??
				fallback
			);
		};
		const getImageGenerationCallId = (
			item: CodexRawRecord,
			event?: CodexSseEvent,
		): string | undefined => {
			return (
				optionalString(item.id) ??
				optionalString(item.call_id) ??
				optionalString(item.callId) ??
				optionalString(event?.item_id) ??
				optionalString(event?.itemId)
			);
		};

		const registerFunctionCallInput = (
			item: CodexRawRecord,
			event?: CodexSseEvent,
		): ActiveFunctionCallInput | undefined => {
			const callId = getFunctionCallCallId(item, event);
			const toolName = getFunctionCallToolName(item);
			if (!callId || !toolName) return undefined;
			const itemId = getFunctionCallItemId(item, event, callId) ?? callId;
			const existing =
				toolInputByItemId.get(itemId) ?? toolInputByCallId.get(callId);
			if (existing) {
				existing.callId = callId;
				existing.toolName = toolName;
				toolInputByItemId.set(itemId, existing);
				toolInputByCallId.set(callId, existing);
				return existing;
			}
			const state = {
				itemId,
				callId,
				toolName,
				streamedArgs: "",
				started: false,
			};
			toolInputByItemId.set(itemId, state);
			toolInputByCallId.set(callId, state);
			return state;
		};

		const startFunctionCallInput = function* (
			state: ActiveFunctionCallInput,
		): Generator<AgentTurnStreamEvent> {
			if (state.started) return;
			state.started = true;
			yield {
				type: "tool-call-start",
				turn: turnIndex,
				toolCallId: state.callId,
				toolName: state.toolName,
			};
		};

		const flushPendingFunctionCallDeltas = function* (
			state: ActiveFunctionCallInput,
		): Generator<AgentTurnStreamEvent> {
			for (const key of Array.from(new Set([state.itemId, state.callId]))) {
				const delta = pendingToolInputDeltas.get(key);
				if (!delta) continue;
				pendingToolInputDeltas.delete(key);
				yield* startFunctionCallInput(state);
				state.streamedArgs += delta;
				yield {
					type: "tool-call-delta",
					turn: turnIndex,
					toolCallId: state.callId,
					toolName: state.toolName,
					argumentsDelta: delta,
				};
			}
		};

		const registerAndStartFunctionCallInput = function* (
			item: CodexRawRecord,
			event?: CodexSseEvent,
		): Generator<AgentTurnStreamEvent> {
			const state = registerFunctionCallInput(item, event);
			if (!state) return;
			yield* startFunctionCallInput(state);
			yield* flushPendingFunctionCallDeltas(state);
		};

		const emitFunctionCallInputDelta = function* (
			event: CodexSseEvent,
		): Generator<AgentTurnStreamEvent> {
			const delta =
				event.delta ??
				event.input ??
				event.arguments_delta ??
				event.argumentsDelta ??
				"";
			if (!delta) return;
			const itemId =
				optionalString(event.item_id) ?? optionalString(event.itemId);
			const callId =
				optionalString(event.call_id) ?? optionalString(event.callId);
			const state =
				(itemId ? toolInputByItemId.get(itemId) : undefined) ??
				(callId ? toolInputByCallId.get(callId) : undefined);
			if (!state) {
				const key = itemId ?? callId;
				if (key)
					pendingToolInputDeltas.set(
						key,
						`${pendingToolInputDeltas.get(key) ?? ""}${delta}`,
					);
				return;
			}
			yield* startFunctionCallInput(state);
			state.streamedArgs += delta;
			yield {
				type: "tool-call-delta",
				turn: turnIndex,
				toolCallId: state.callId,
				toolName: state.toolName,
				argumentsDelta: delta,
			};
		};

		const emitFunctionCall = function* (
			item: CodexRawRecord,
			event?: CodexSseEvent,
		): Generator<AgentTurnStreamEvent> {
			const callId = getFunctionCallCallId(item, event);
			const toolName = getFunctionCallToolName(item);
			if (!callId || !toolName) return;
			const state = registerFunctionCallInput(item, event);
			const args = getFunctionCallArgs(item);
			if (state) {
				yield* startFunctionCallInput(state);
				yield* flushPendingFunctionCallDeltas(state);
				if (args && !state.streamedArgs) {
					state.streamedArgs = args;
					yield {
						type: "tool-call-delta",
						turn: turnIndex,
						toolCallId: callId,
						toolName,
						argumentsDelta: args,
					};
				} else if (
					args &&
					args.startsWith(state.streamedArgs) &&
					args.length > state.streamedArgs.length
				) {
					const suffix = args.slice(state.streamedArgs.length);
					state.streamedArgs = args;
					yield {
						type: "tool-call-delta",
						turn: turnIndex,
						toolCallId: callId,
						toolName,
						argumentsDelta: suffix,
					};
				}
				toolInputByItemId.delete(state.itemId);
				toolInputByCallId.delete(state.callId);
			} else {
				yield {
					type: "tool-call-start",
					turn: turnIndex,
					toolCallId: callId,
					toolName,
				};
				if (args)
					yield {
						type: "tool-call-delta",
						turn: turnIndex,
						toolCallId: callId,
						toolName,
						argumentsDelta: args,
					};
			}
			completedToolCallCount += 1;
			yield {
				type: "tool-call-done",
				turn: turnIndex,
				toolCall: { id: callId, name: toolName, arguments: args },
			};
		};

		for await (const event of parseCodexResponsesSse(response.body)) {
			streamStats.events += 1;
			if (debugStream) {
				log.trace("sse event", {
					type: event.type,
					deltaChars: typeof event.delta === "string" ? event.delta.length : 0,
					itemType: event.item?.type,
					hasUsage: Boolean(event.response?.usage),
				});
			}
			const streamError = errors.fromStreamEvent(event);
			if (streamError) throw streamError;

			switch (event.type) {
				case "response.output_text.delta":
					yield* emitText(event.delta ?? "");
					break;
				case "response.reasoning_text.delta":
				case "response.reasoning_summary_text.delta": {
					const delta = event.delta ?? event.text ?? "";
					streamStats.reasoningDeltaEvents += 1;
					streamStats.reasoningDeltaChars += delta.length;
					streamStats.maxReasoningDeltaChars = Math.max(streamStats.maxReasoningDeltaChars, delta.length);
					const itemId = getReasoningItemId(
						undefined,
						event,
						activeReasoningItemId ?? "reasoning-0",
					);
					yield* emitReasoningPart(delta, itemId, reasoningPartIndex(event, itemId));
					break;
				}
				case "response.reasoning_summary_part.added": {
					const itemId = getReasoningItemId(
						undefined,
						event,
						activeReasoningItemId ?? "reasoning-0",
					);
					activeReasoningPartByItem.set(itemId, event.summary_index ?? (
						reasoningPartsByItem.has(itemId) ? (activeReasoningPartByItem.get(itemId) ?? 0) + 1 : 0
					));
					yield* emitReasoningSnapshot(collectReasoningSummaryText(event.part).join(""), itemId, reasoningPartIndex(event, itemId));
					break;
				}
				case "response.reasoning_text.done":
				case "response.reasoning_summary_part.done":
				case "response.reasoning_summary_text.done": {
					const itemId = getReasoningItemId(
						undefined,
						event,
						activeReasoningItemId ?? "reasoning-0",
					);
					const summary = collectManyReasoningSummaryText([
						event.text,
						event.summary,
						event.summary_text,
						event.summaryText,
						event.part,
					]).join("");
					yield* emitReasoningSnapshot(summary, itemId, reasoningPartIndex(event, itemId));
					break;
				}
				case "response.function_call_arguments.delta":
				case "response.custom_tool_call_input.delta":
					streamStats.toolArgumentDeltaEvents += 1;
					yield* emitFunctionCallInputDelta(event);
					break;
				case "response.output_item.added": {
					const item = event.item ?? {};
					if (item.type === "reasoning") {
						activeReasoningItemId = getReasoningItemId(item, event, "reasoning-0");
						yield* emitReasoningItem(item, activeReasoningItemId);
						break;
					}
					if (isCodexFunctionCallItem(item)) {
						yield* registerAndStartFunctionCallInput(item, event);
						break;
					}
					if (
						item.type === "image_generation" ||
						item.type === "image_generation_call"
					) {
						const callId = getImageGenerationCallId(item, event);
						if (callId) {
							yield {
								type: "provider-data",
								turn: turnIndex,
								providerData: {
									provider: providerTag,
									type: "image-generation-start",
									callId,
									status: optionalString(item.status),
								},
							};
						}
					} else if (item.type !== "message") {
						countUnhandled(unhandledOutputItems, item.type);
					}
					break;
				}
				case "response.output_item.done": {
					const item = event.item ?? {};
					// 方言缝:这条 item 上还有别的东西可解吗(xAI 的引文
					// annotations)。codex 不挂这一支,一个事件都不多。
					if (decodeOutputItem) yield* decodeOutputItem(item, turn);
					if (isCodexFunctionCallItem(item)) {
						yield* emitFunctionCall(item, event);
						finishReason = "tool_calls";
						break;
					}
					if (
						item.type === "image_generation" ||
						item.type === "image_generation_call"
					) {
						const callId = getImageGenerationCallId(item, event);
						const result = optionalString(item.result);
						if (callId && result) {
							yield {
								type: "provider-data",
								turn: turnIndex,
								providerData: {
									provider: providerTag,
									type: "image-generation-result",
									callId,
									status: optionalString(item.status) ?? "completed",
									revisedPrompt:
										optionalString(item.revised_prompt) ??
										optionalString(item.revisedPrompt),
									result,
								},
							};
						}
						break;
					}
					if (item.type === "reasoning") {
						const itemId = getReasoningItemId(
							item,
							event,
							activeReasoningItemId ?? "reasoning-0",
						);
						yield* emitReasoningItem(item, itemId);
						const encryptedContent = optionalString(item.encrypted_content);
						if (encryptedContent) {
							yield {
								type: "provider-data",
								turn: turnIndex,
								providerData: {
									provider: providerTag,
									type: "encrypted-reasoning",
									encryptedContent,
								},
							};
						}
						if (activeReasoningItemId === itemId)
							activeReasoningItemId = undefined;
						break;
					}
					if (item.type === "message" && !emittedTextFromDelta) {
						yield* emitText(extractOutputText(item));
					} else if (item.type !== "message") {
						countUnhandled(unhandledOutputItems, item.type);
					}
					break;
				}
				case "response.completed":
					usage = keepCodexUsage(event, usage);
					if (finishReason !== "tool_calls") finishReason = "stop";
					break;
				case "response.incomplete":
					usage = keepCodexUsage(event, usage);
					finishReason = codexFinishReasonMapper.map(
						event.response?.incomplete_details?.reason,
					);
					break;
				case "response.failed":
					throw errors.fromFailedResponse(event.response?.error?.message);
				case "response.created":
				case "response.in_progress":
				case "response.content_part.added":
				case "response.content_part.done":
				case "response.output_text.done":
				case "response.function_call_arguments.done":
				case "response.custom_tool_call_input.done":
					usage = keepCodexUsage(event, usage);
					break;
				default:
					countUnhandled(unhandledEvents, event.type);
					usage = keepCodexUsage(event, usage);
					break;
			}
		}

		// Flush tool calls whose accumulator never saw output_item.done (stream
		// interrupted / server closed early) so the loop can still execute them
		// instead of silently ending the turn.
		const flushedStates = new Set<ActiveFunctionCallInput>();
		for (const state of [
			...toolInputByItemId.values(),
			...toolInputByCallId.values(),
		]) {
			if (flushedStates.has(state)) continue;
			flushedStates.add(state);
			yield* flushPendingFunctionCallDeltas(state);
			if (!state.started) continue;
			completedToolCallCount += 1;
			yield {
				type: "tool-call-done",
				turn: turnIndex,
				toolCall: {
					id: state.callId,
					name: state.toolName,
					arguments: state.streamedArgs,
				},
			};
		}
		if (completedToolCallCount === 0 && finishReason === "tool_calls") {
			finishReason = "stop";
		}
		log.info("responses stream summary", {
			turn: turnIndex,
			...streamStats,
			durationMs: Date.now() - streamStartedAt,
			completedToolCalls: completedToolCallCount,
			finishReason: completedToolCallCount > 0 ? "tool_calls" : finishReason,
			unhandledEvents: Object.fromEntries(unhandledEvents),
			unhandledOutputItems: Object.fromEntries(unhandledOutputItems),
		});
		return {
			finishReason:
				completedToolCallCount > 0 ? "tool_calls" : finishReason,
			...(usage ? { usage } : {}),
		};
	}
}

/** `usage = usageFromResponse(event.response) ?? usage` 逐字:认得出才换。 */
function keepCodexUsage(
	event: CodexSseEvent,
	previous: CodexResponsesUsage | undefined,
): CodexResponsesUsage | undefined {
	const next = event.response?.usage;
	return hasCodexResponsesUsage(next) ? next : previous;
}

/** 方言文件与门面共用的 logger 命名规则。 */
export function responsesLogger(providerId: string): ReturnType<typeof getLogger> {
	return getLogger(`providers.${providerId}`);
}
