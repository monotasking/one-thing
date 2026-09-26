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
 *
 * 09-26(§7.5):工具调用的「在哪读」、收尾原因的「在哪读 / 怎么译」、SSE 结束标记三处
 * 不再读死 —— 分别是方言的 `toolCalls`(`ToolCallCodec`)与 `finish` 两格,缺省 = 今天的
 * 读法;index 累积与 done 时机原样搬进 `base/tool-call-codec.ts` 的 `ToolCallAccumulator`。
 */
import type {
	AgentMessage,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import { getLogger } from "../../../logging/index.js";
import { mergeAdjacentSameRoleMessages } from "../message-merge.js";
import { readJsonSseData } from "../sse.js";
import {
	finishReasonMapperFor,
	getPath,
	HttpAgentProvider,
	OPENAI_TOOL_CALLS_CODEC,
	PathUsageNormalizer,
	openAIFinishReasonMapper,
	ToolCallAccumulator,
	type Dialect,
	type FinishReasonMapper,
	type PartCodec,
	type ProviderContext,
	type RawTurnFinish,
	type ThinkingWire,
	type ToolCallCodec,
	type TransportFileDelivery,
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
	/**
	 * 这家的文件靠**抽取通道**收(P4-6)。见
	 * `OpenAIChatDialectSpec.fileViaExtraction` —— 判据在
	 * `ModelProfile.toAgentModelCapabilities`,这里只是配方那一行的落点。
	 */
	fileViaExtraction?: boolean;
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

	/** 这家靠抽取通道收文件吗(P4-6)—— 配方的一行,基类只是把它递给账本投影。 */
	protected override get transportFileDelivery(): TransportFileDelivery {
		return this.chatDialect.fileViaExtraction ? { viaExtraction: true } : {};
	}

	protected get defaultParts(): PartCodec {
		return openAIChatParts;
	}

	protected get defaultUsage(): UsageNormalizer {
		return openAIChatDefaultUsage;
	}

	/** 方言给了 `finish.reasonMap` 就先查它,查不到(或没给)= 线的默认映射。 */
	protected get finish(): FinishReasonMapper {
		return finishReasonMapperFor(this.dialect.finish, openAIFinishReasonMapper);
	}

	/** 工具调用在哪 —— 方言的一格,缺 = `choices[0].delta.tool_calls[]`。 */
	protected get toolCallCodec(): ToolCallCodec {
		return this.dialect.toolCalls ?? OPENAI_TOOL_CALLS_CODEC;
	}

	/** 收尾原因在哪 —— 方言的一格,缺 = `choices[0].finish_reason`(今天的读法逐字)。 */
	protected get finishReasonReader(): (chunk: OpenAIChatStreamChunk) => string | null | undefined {
		const path = this.dialect.finish?.reasonPath;
		if (path === undefined) return (chunk) => chunk.choices?.[0]?.finish_reason;
		return (chunk) => {
			const value = getPath(chunk, path);
			if (value === undefined || value === null) return undefined;
			return typeof value === "string" ? value : String(value);
		};
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

	protected async buildBody(turn: TurnContext): Promise<void> {
		const { builder, request } = turn;
		const { request: shape } = this.chatDialect;

		// 序列化**之前**先让附件通道换一次(P4-6):Kimi 的文件走
		// `/v1/files` 旁路,抽出来的文本以一条 `role:'system'` 进 messages,
		// 原来那一块从 user 消息里消失。没配通道 = 零副请求、零改写,这一句
		// 就是一个 `await undefined`。读的是 `turn.messages` 而不是
		// `request.messages` —— 上游的历史本体一个字都不动。
		await this.chatDialect.attachments?.prepare(turn);

		// 这条适配层同时服务一批 OpenAI 方言端点,其中包含要求 user/assistant
		// 严格交替的(DeepSeek 走的就是这里)。相邻同角色先合成一条 —— 对宽松的
		// 端点是无害的等价改写,对严格的端点是能不能发出去的分界。
		const messages = shape.mergeAdjacent
			? mergeAdjacentSameRoleMessages(turn.messages)
			: turn.messages;

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
		const toolCallCodec = this.toolCallCodec;
		const toolCalls = new ToolCallAccumulator(turn);
		const readFinishReason = this.finishReasonReader;
		let usage: unknown;
		let finishReason: string | null | undefined;
		const debugStream = turn.logger.isLevelEnabled("trace");
		let lastDeltaAt: number | undefined;
		const doneMarker = this.dialect.finish?.doneMarker;

		for await (const chunk of readJsonSseData<OpenAIChatStreamChunk>(response, {
			sourceName: errors.sourceName,
			invalidMessage: "invalid stream chunk",
			...(doneMarker !== undefined ? { doneMarker } : {}),
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

			// 方言缝(§7.5):工具调用**在哪**由 codec 读,按 index 累积与 done 时机是
			// 累积器的(从这里原样搬出去的,见 `base/tool-call-codec.ts`)。
			const fragments = toolCallCodec.decode(chunk, turn);
			if (fragments) yield* toolCalls.accept(fragments);

			const rawFinishReason = readFinishReason(chunk);
			if (rawFinishReason) {
				finishReason = rawFinishReason;
				// The provider has declared the turn over: every accumulated tool
				// call is complete. Emit done here (not after the SSE loop) so the
				// last tool call starts executing without waiting for stream teardown.
				yield* toolCalls.finishDeclared();
			}
		}

		yield* toolCalls.streamEnded();

		return { finishReason, usage };
	}
}

/** 方言文件与门面共用的 logger 命名规则。 */
export function openAIChatLogger(providerId: string): ReturnType<typeof getLogger> {
	return getLogger(`providers.${providerId}`);
}
