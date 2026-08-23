/**
 * `OpenAIChatWire` —— chat/completions 这条线协议的**唯一**实现
 * (设计稿 §3:一条 wire 一个类,管线写死在 `HttpAgentProvider` 的模板方法里)。
 *
 * 它上面挂着 11 个方言(openai / deepseek / kimi / kimi-code / zhipu / qwen /
 * grok / grok-oauth / openrouter / github-copilot / custom-openai),差异全部由
 * 组合进 `Dialect` 的策略对象表达:思考线型、消息 codec、usage 字段表、认证、
 * `max_tokens` 字段名、采样策略。这个类里没有一处 `if (providerId === …)`。
 *
 * P0a 是**纯搬运**:`streamOpenAICompatibleResponse` 的工具调用 index 累积与
 * done 时机、text/reasoning 增量顺序、`usageFromChunk` 的读法、
 * `mapFinishReason` 的映射,逐字保留(`__tests__/wire-snapshots` 的 79 份快照
 * 就是这句话的门)。
 */
import type {
	AgentMessage,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import { getLogger } from "../../../logging/index.js";
import { mergeAdjacentSameRoleMessages } from "../message-merge.js";
import { readJsonSseData } from "../sse.js";
import {
	HttpAgentProvider,
	PathUsageNormalizer,
	openAIFinishReasonMapper,
	type Dialect,
	type FinishReasonMapper,
	type PartCodec,
	type ProviderContext,
	type RawTurnFinish,
	type ThinkingWire,
	type TurnContext,
	type UsageNormalizer,
	type UsagePathTable,
} from "../base/index.js";
import type { AgentModelCapabilities } from "@onething/core/agent-loop";
import { OpenAIChatErrorMapper } from "./openai-chat-errors.js";
import {
	OpenAIChatPartCodec,
	toOpenAIChatTools,
	type OpenAIChatCodec,
	type OpenAIChatMessage,
	type OpenAIChatWireValue,
} from "./openai-chat-messages.js";

// ---------------------------------------------------------------------------
// 方言:这条线上多出来的两个字段
// ---------------------------------------------------------------------------

export interface OpenAIChatDialect extends Dialect<OpenAIChatWireValue> {
	/** provider 的**传输**声明(模态 / 结构化工具结果)。per-model 的布尔归账本。 */
	transport: AgentModelCapabilities;
}

// ---------------------------------------------------------------------------
// 流上的形状
// ---------------------------------------------------------------------------

export interface OpenAIChatStreamChunk {
	choices?: Array<{
		index: number;
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: "function";
				function?: { name?: string; arguments?: string };
			}>;
			/**
			 * OpenRouter 的图像输出(P3-2)。**流式这一支在 OpenRouter 的
			 * OpenAPI 里没有声明**,形状按非流式 `message.images[]` 的项假定
			 * (待真机核);解析在 `dialects/openrouter.ts`,这里只是把字段留出来。
			 */
			images?: unknown;
		};
		/** 非流式形状被折进流里的那一支(同上,`message.images[]`)。 */
		message?: { images?: unknown };
		finish_reason?: string | null;
	}>;
	usage?: unknown;
	error?: { message?: string; type?: string; code?: string };
}

interface ToolCallAccumulator {
	id: string;
	name: string;
	arguments: string;
	started: boolean;
	done: boolean;
	/** 已经为这个 index 记过一条 `tool-call-interleaved` —— 一次交错记一条,不刷屏。 */
	interleavedReported: boolean;
}

/**
 * openai-chat 的 usage 直译表(设计稿 §2.6 三桶 / §7 表的第一行)。
 *
 * 三个桶互不交叠:`cacheRead` 与 `cacheWrite` 都是 `prompt_tokens` 里的子集
 * (OpenAI 官方口径:读 0.1× / 写 1.25× / 未缓存 1×,没有「未命中」字段),
 * 所以 `uncachedInput = prompt − cached − cache_write`。
 * `cache_write_tokens` 是 GPT-5.6+ 才有的字段,老模型读不到就是 0。
 *
 * 两个字段读成函数而不是路径,是为了保住今天的一个边界行为:usage 那一块只要
 * 在(truthy),即使字段全缺也要产出一份零值 usage,而不是 `undefined`。
 *
 * 各家的偏差(kimi 顶层 `cached_tokens`、deepseek 的 hit/miss、openrouter `cost`、
 * grok `cost_in_usd_ticks`、qwen `cache_creation_input_tokens`)是**方言的一行**
 * —— 见各自的配方文件,不进这里的 if。
 */
export const OPENAI_CHAT_USAGE_TABLE: UsagePathTable = {
	uncachedInput: (_raw, read) =>
		(read("prompt_tokens") ?? 0) -
		(read(["prompt_tokens_details", "cached_tokens"]) ?? 0) -
		(read(["prompt_tokens_details", "cache_write_tokens"]) ?? 0),
	cacheRead: ["prompt_tokens_details", "cached_tokens"],
	cacheWrite: ["prompt_tokens_details", "cache_write_tokens"],
	output: (_raw, read) => read("completion_tokens") ?? 0,
	reasoning: ["completion_tokens_details", "reasoning_tokens"],
	reportedTotal: "total_tokens",
};

/** 配方改一行用的:默认表 + 这家的偏差。 */
export function openAIChatUsageTable(
	overrides: Partial<UsagePathTable>,
): UsagePathTable {
	return { ...OPENAI_CHAT_USAGE_TABLE, ...overrides };
}

/** `openAIChatUsageTable(...)` 的常用形式 —— 配方里就是一句 `usage:`。 */
export function openAIChatUsage(
	overrides: Partial<UsagePathTable> = {},
): UsageNormalizer {
	return new PathUsageNormalizer(openAIChatUsageTable(overrides));
}

const openAIChatDefaultUsage = new PathUsageNormalizer(OPENAI_CHAT_USAGE_TABLE);
const openAIChatParts = new OpenAIChatPartCodec();

function previewText(value: string | null | undefined, maxLength = 240): string {
	return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function elapsedSince(previous: number | undefined, now: number): number | undefined {
	return previous === undefined ? undefined : now - previous;
}

function toolCallDoneEvent(
	turn: number,
	entry: ToolCallAccumulator,
): Extract<AgentTurnStreamEvent, { type: "tool-call-done" }> {
	return {
		type: "tool-call-done",
		turn,
		toolCall: { id: entry.id, name: entry.name, arguments: entry.arguments },
	};
}

// ---------------------------------------------------------------------------
// wire
// ---------------------------------------------------------------------------

export class OpenAIChatWire extends HttpAgentProvider<
	Record<string, unknown>,
	OpenAIChatStreamChunk
> {
	constructor(ctx: ProviderContext, dialect: OpenAIChatDialect) {
		super(ctx, dialect);
	}

	protected get transportCapabilities(): AgentModelCapabilities {
		return this.chatDialect.transport;
	}

	protected get defaultParts(): PartCodec {
		return openAIChatParts;
	}

	protected get defaultUsage(): UsageNormalizer {
		return openAIChatDefaultUsage;
	}

	protected get finish(): FinishReasonMapper {
		return openAIFinishReasonMapper;
	}

	/**
	 * P1-d1 起抛 `ProviderHttpError`(见 `openai-chat-errors.ts` 的抬头)。
	 * 覆盖 getter 而不是在基类里加分支 —— 那是方言的事,不是模板的事。
	 */
	protected override get errors(): OpenAIChatErrorMapper {
		return (
			(this.dialect.errors as OpenAIChatErrorMapper | undefined) ??
			new OpenAIChatErrorMapper(this.id)
		);
	}

	protected get chatDialect(): OpenAIChatDialect {
		return this.dialect as OpenAIChatDialect;
	}

	protected get chatParts(): OpenAIChatCodec {
		return this.parts as OpenAIChatCodec;
	}

	// -----------------------------------------------------------------------
	// 请求体
	// -----------------------------------------------------------------------

	protected buildBody(turn: TurnContext): void {
		const { builder, request } = turn;
		const { request: shape } = this.chatDialect;

		// 这条适配层同时服务一批 OpenAI 方言端点,其中包含要求 user/assistant
		// 严格交替的(DeepSeek 走的就是这里)。相邻同角色先合成一条 —— 对宽松的
		// 端点是无害的等价改写,对严格的端点是能不能发出去的分界。
		const messages = shape.mergeAdjacent
			? mergeAdjacentSameRoleMessages(request.messages)
			: request.messages;

		builder.set("model", request.model);
		builder.set("messages", this.serializeMessages(messages, turn));
		builder.set("stream", true);
		if (shape.streamUsage === "include_usage") {
			builder.set("stream_options", { include_usage: true });
		}

		const tools = toOpenAIChatTools(request.tools);
		if (tools?.length) builder.set("tools", tools);
		if (request.maxTokens !== undefined) {
			builder.set(shape.maxTokensField, request.maxTokens);
		}
	}

	private serializeMessages(
		messages: AgentMessage[],
		turn: TurnContext,
	): OpenAIChatMessage[] {
		const codec = this.chatParts;
		return messages.map((message) => codec.toWireMessage(message, turn));
	}

	// -----------------------------------------------------------------------
	// 流解析 —— `streamOpenAICompatibleResponse` 逐字
	// -----------------------------------------------------------------------

	protected async *parseStream(
		response: Response,
		turn: TurnContext,
	): AsyncGenerator<AgentTurnStreamEvent, RawTurnFinish, void> {
		const turnIndex = turn.turn;
		const thinking: ThinkingWire = this.thinkingFor(turn);
		const errors = this.errors;
		const toolCalls = new Map<number, ToolCallAccumulator>();
		let usage: unknown;
		let finishReason: string | null | undefined;
		const debugStream = turn.logger.isLevelEnabled("trace");
		let lastDeltaAt: number | undefined;

		for await (const chunk of readJsonSseData<OpenAIChatStreamChunk>(response, {
			sourceName: errors.sourceName,
			invalidMessage: "invalid stream chunk",
		})) {
			const streamError = errors.fromStreamEvent?.(chunk);
			if (streamError) throw streamError;

			if (chunk.usage) usage = chunk.usage;
			const choice = chunk.choices?.[0];
			const delta = choice?.delta;

			const reasoning = thinking.decode?.(chunk)?.reasoningDelta;
			if (reasoning) {
				if (debugStream) {
					const now = Date.now();
					turn.logger.trace("reasoning delta", {
						gapMs: elapsedSince(lastDeltaAt, now),
						turn: turnIndex,
						chars: reasoning.length,
						text: previewText(reasoning),
					});
					lastDeltaAt = now;
				}
				yield { type: "reasoning-delta", turn: turnIndex, delta: reasoning };
			}

			if (delta?.content) {
				if (debugStream) {
					const now = Date.now();
					turn.logger.trace("text delta", {
						gapMs: elapsedSince(lastDeltaAt, now),
						turn: turnIndex,
						chars: delta.content.length,
						text: previewText(delta.content),
					});
					lastDeltaAt = now;
				}
				yield { type: "text-delta", turn: turnIndex, delta: delta.content };
			}

			// 方言缝(基类 `decodeExtras`):这条线上多出来的块。今天唯一的用户是
			// OpenRouter 的 `images[]`。位置在正文之后、工具调用之前 —— 图与它
			// 前面那段正文同序,且不插进 tool-call 的 start/delta/done 之间。
			for (const event of this.decodeExtras(chunk, turn)) yield event;

			if (delta?.tool_calls) {
				for (const toolCallDelta of delta.tool_calls) {
					const index = toolCallDelta.index;
					let entry = toolCalls.get(index);
					if (!entry) {
						// Index switch = the previous tool call's arguments are complete.
						// OpenAI-style streams emit tool calls strictly by index, so a
						// delta for a NEW index proves every earlier index is done —
						// emit their tool-call-done now so execution can start while
						// later tool calls are still rendering. (The `{}`-prefix gateway
						// hazard only applies to "first parseable prefix" heuristics;
						// an index switch is not a heuristic.)
						for (const [priorIndex, prior] of [...toolCalls.entries()].sort(
							([a], [b]) => a - b,
						)) {
							if (priorIndex < index && !prior.done) {
								prior.done = true;
								yield toolCallDoneEvent(turnIndex, prior);
							}
						}
						entry = {
							id: toolCallDelta.id ?? `tool-${turnIndex}-${index}`,
							name: "",
							arguments: "",
							started: false,
							done: false,
							interleavedReported: false,
						};
						toolCalls.set(index, entry);
					}

					if (toolCallDelta.id) entry.id = toolCallDelta.id;
					if (toolCallDelta.function?.name) entry.name += toolCallDelta.function.name;
					const argumentsDelta = toolCallDelta.function?.arguments ?? "";

					// 交错:index 切换已经把这个 index 判 done 了(done 事件带着当时
					// 的完整 arguments 发了出去,下游可能已经在执行),后面又来了
					// 这个 index 的 arguments —— 那些字符对模型**已经无效**。
					//
					// 行为一个字不改(**不补第二条 done**,增量照旧累加与外发):
					// 补 done 会让同一个 toolCallId 出现两次终态,比丢几个字符坏得多。
					// 能做的是留痕 —— 一个 index 记一条,不刷屏。
					if (entry.done && argumentsDelta && !entry.interleavedReported) {
						entry.interleavedReported = true;
						const fields = {
							toolCallId: entry.id,
							index,
							droppedChars: argumentsDelta.length,
						};
						turn.warn(
							"tool-call-interleaved",
							"tool call arguments arrived after this index was already done",
							fields,
						);
						turn.logger.warn("tool call arguments arrived after done", {
							turn: turnIndex,
							...fields,
						});
					}

					if (argumentsDelta) entry.arguments += argumentsDelta;

					if (!entry.started && entry.name) {
						entry.started = true;
						yield {
							type: "tool-call-start",
							turn: turnIndex,
							toolCallId: entry.id,
							toolName: entry.name,
						};
					}

					if (argumentsDelta && entry.name) {
						yield {
							type: "tool-call-delta",
							turn: turnIndex,
							toolCallId: entry.id,
							toolName: entry.name,
							argumentsDelta,
						};
					}

					// No early-done on first parseable prefix: gateways may send `{}`
					// before the real arguments. Done is emitted on index switch /
					// finish_reason (above) or, as a last resort, at stream end.
				}
			}

			if (choice?.finish_reason) {
				finishReason = choice.finish_reason;
				// The provider has declared the turn over: every accumulated tool
				// call is complete. Emit done here (not after the SSE loop) so the
				// last tool call starts executing without waiting for stream teardown.
				for (const [, entry] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
					if (!entry.done) {
						entry.done = true;
						yield toolCallDoneEvent(turnIndex, entry);
					}
				}
			}
		}

		for (const [, entry] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
			if (!entry.done) yield toolCallDoneEvent(turnIndex, entry);
		}

		return { finishReason, usage };
	}
}

/** 方言文件与门面共用的 logger 命名规则。 */
export function openAIChatLogger(providerId: string): ReturnType<typeof getLogger> {
	return getLogger(`providers.${providerId}`);
}
