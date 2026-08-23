/**
 * `AnthropicMessagesWire` —— Anthropic Messages API 这条线协议的**唯一**实现
 * (设计稿 §3:一条 wire 一个类,管线写死在 `HttpAgentProvider` 的模板方法里)。
 *
 * 它上面挂着三个 id(claude / claude-code / custom-* apiType=anthropic),差异
 * 全部由组合进 `Dialect` 的策略对象表达:认证(`x-api-key` 发不发、OAuth 的
 * beta 头)、缓存断点开不开、`systemHeader`、传输声明。这个类里没有一处
 * `if (providerId === …)`。
 *
 * P1-a 是**纯搬运**:`claude.ts` 的请求体构造、`streamClaudeResponse` 的
 * content_block 状态机、`buildClaudeMessages` 的块序、`mapClaudeStopReason` 的
 * 映射,逐字保留(`__tests__/wire-snapshots/anthropic` 的 29 份快照就是这句话
 * 的门,**禁 `-u`**)。
 *
 * 一处复刻的现状,后续再动(设计稿 §9 P1 门 ①):
 *  - **家族判定**:`onethingClaudeModelFamily` 把老式带日期 id 的日期段当版本号。
 *
 * usage 已在 P1-d2 按 §7 直译(`anthropic-usage.ts`),不再少算缓存回合的输入。
 */
import type {
	AgentModelCapabilities,
	AgentTurnStreamEvent,
	AgentFinishReason,
	AgentJsonValue,
	AgentProviderData,
} from "@onething/core/agent-loop";
import { getLogger } from "../../../logging/index.js";
import { onethingClaudeModelFamily } from "../../../providers/model-capability.js";
import { mergeAdjacentSameRoleMessages } from "../message-merge.js";
import { readJsonSseData } from "../sse.js";
import {
	anthropicAdaptiveThinkingWire,
	anthropicAlwaysThinkingWire,
	anthropicBudgetThinkingWire,
} from "../thinking/index.js";
import {
	HttpAgentProvider,
	type CachePolicy,
	type Dialect,
	type FinishReasonMapper,
	type PartCodec,
	type ProviderContext,
	type RawTurnFinish,
	type RequestBodyBuilder,
	type SamplingPolicy,
	type ThinkingWire,
	type ToolChoicePolicy,
	type TurnContext,
	type UsageNormalizer,
} from "../base/index.js";
import { anthropicUsage, type AnthropicUsage } from "./anthropic-usage.js";
import { AnthropicErrorMapper } from "./anthropic-errors.js";
import {
	anthropicParts,
	toAnthropicToolChoice,
	toAnthropicTools,
	type AnthropicCodec,
	type AnthropicContentBlock,
	type AnthropicMessage,
	type AnthropicTextBlock,
	type AnthropicTool,
	type AnthropicWireValue,
} from "./anthropic-messages.js";

/** usage 的形状搬去 `anthropic-usage.ts`(与 claude-code-connector 共用),原处再导出。 */
export type { AnthropicUsage } from "./anthropic-usage.js";

// ---------------------------------------------------------------------------
// 方言:这条线上多出来的两个字段
// ---------------------------------------------------------------------------

export interface AnthropicDialect extends Dialect<AnthropicWireValue> {
	/** provider 的**传输**声明(模态 / 结构化工具结果)。per-model 的布尔归账本。 */
	transport: AgentModelCapabilities;
	/**
	 * 固定顶在 system 最前面的那一块(claude-code 的
	 * "You are Claude Code, …")。给了它之后 system 就长成两块文本;
	 * 会话本身没有 system 时,它自己就是 system。
	 */
	systemHeader?: string;
}

/** 这条线上三条思考线型 —— 走哪条由 `thinkingFor()` 按模型家族选。 */
export const ANTHROPIC_THINKING_WIRES: ThinkingWire[] = [
	anthropicAdaptiveThinkingWire,
	anthropicBudgetThinkingWire,
	anthropicAlwaysThinkingWire,
];

// ---------------------------------------------------------------------------
// 流上的形状
// ---------------------------------------------------------------------------

export interface AnthropicStreamEvent {
	type?: string;
	index?: number;
	content_block?: {
		type?: string;
		id?: string;
		name?: string;
		input?: AgentJsonValue;
		text?: string;
		data?: string;
	};
	delta?: {
		type?: string;
		text?: string;
		thinking?: string;
		signature?: string;
		partial_json?: string;
		stop_reason?: string | null;
	};
	usage?: AnthropicUsage;
	message?: { usage?: AnthropicUsage };
	error?: { message?: string; type?: string };
}

interface ToolUseAccumulator {
	id: string;
	name: string;
	arguments: string;
	started: boolean;
}

interface ThinkingAccumulator {
	thinking: string;
	signature: string;
}

function thinkingProviderData(entry: ThinkingAccumulator): AgentProviderData {
	return {
		provider: "claude",
		type: "thinking",
		thinking: entry.thinking,
		signature: entry.signature,
	};
}

function toolCallDoneEvent(
	turn: number,
	entry: ToolUseAccumulator,
): Extract<AgentTurnStreamEvent, { type: "tool-call-done" }> {
	return {
		type: "tool-call-done",
		turn,
		toolCall: {
			id: entry.id,
			name: entry.name,
			arguments: entry.arguments || "{}",
		},
	};
}

// ---------------------------------------------------------------------------
// finish reason
// ---------------------------------------------------------------------------

/** `mapClaudeStopReason` 逐字。 */
export class AnthropicFinishReasonMapper implements FinishReasonMapper {
	map(reason: string | null | undefined): AgentFinishReason {
		switch (reason) {
			case "end_turn":
			case "stop_sequence":
				return "stop";
			case "max_tokens":
				return "length";
			case "tool_use":
				return "tool_calls";
			default:
				return "unknown";
		}
	}
}

export const anthropicFinishReasonMapper: FinishReasonMapper =
	new AnthropicFinishReasonMapper();

// ---------------------------------------------------------------------------
// 横切策略
// ---------------------------------------------------------------------------

/**
 * `tool_choice` 的拼法 —— `toClaudeToolChoice` 逐字。只在真的带了工具时才发
 * (`toolChoice === 'none'` 时 `buildBody` 压根不写 `tools`,于是这里也不写)。
 */
export class AnthropicToolChoicePolicy implements ToolChoicePolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void {
		const tools = builder.get<unknown[]>("tools");
		if (!Array.isArray(tools) || tools.length === 0) return;
		const choice = toAnthropicToolChoice(turn.request.toolChoice);
		if (choice) builder.set("tool_choice", choice);
	}
}

export const anthropicToolChoicePolicy: ToolChoicePolicy =
	new AnthropicToolChoicePolicy();

/**
 * temperature 发不发:extended thinking 要求默认采样,4.7+/Sonnet 5/Fable 干脆
 * 拒收 temperature。丢掉的设置留一条 warning —— **旁路元数据,请求体的字节
 * 一个不变**。
 */
export class AnthropicSamplingPolicy implements SamplingPolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void {
		const { temperature, thinking } = turn.request;
		if (temperature === undefined) return;
		if (thinking === "enabled") {
			turn.warn(
				"setting-dropped",
				"temperature is not sent while thinking is enabled",
				{ temperature },
			);
			return;
		}
		if (onethingClaudeModelFamily(turn.model).samplingRemoved) {
			turn.warn(
				"setting-dropped",
				"this Claude family rejects sampling parameters",
				{ temperature, model: turn.model },
			);
			return;
		}
		builder.set("temperature", temperature);
	}
}

export const anthropicSamplingPolicy: SamplingPolicy =
	new AnthropicSamplingPolicy();

/**
 * 显式缓存断点(Anthropic 不给断点就什么都不缓存),`applyPromptCacheBreakpoints`
 * 逐字:
 *  1. system 末尾 —— 缓存 tools + system 前缀,只有 system 本身变了才失效;
 *     没有 system 时改落在**工具表最后一项**上;
 *  2. 会话末尾 —— 下一回合的历史是它的延长,前缀在这个位置对上就复用。
 * Anthropic 按最近 ~20 个断点位置匹配,所以滑动的尾部断点能连着几回合命中。
 */
export class AnthropicCachePolicy implements CachePolicy {
	annotate(_turn: TurnContext, builder: RequestBodyBuilder): void {
		const system = builder.get<string | AnthropicTextBlock[]>("system");
		const tools = builder.get<AnthropicTool[]>("tools");
		if (system) {
			const blocks: AnthropicTextBlock[] =
				typeof system === "string" ? [{ type: "text", text: system }] : [...system];
			if (blocks.length > 0) {
				blocks[blocks.length - 1] = {
					...blocks[blocks.length - 1]!,
					cache_control: { type: "ephemeral" },
				};
				builder.set("system", blocks);
			}
		} else if (tools?.length) {
			tools[tools.length - 1] = {
				...tools[tools.length - 1]!,
				cache_control: { type: "ephemeral" },
			};
		}

		const messages = builder.get<AnthropicMessage[]>("messages") ?? [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i]!;
			const blocks: AnthropicContentBlock[] =
				typeof message.content === "string"
					? message.content
						? [{ type: "text", text: message.content }]
						: []
					: [...message.content];
			if (blocks.length === 0) continue;
			const last = blocks[blocks.length - 1]!;
			// cache_control is not allowed on thinking blocks.
			if (last.type === "thinking" || last.type === "redacted_thinking") continue;
			blocks[blocks.length - 1] = {
				...last,
				cache_control: { type: "ephemeral" },
			};
			messages[i] = { ...message, content: blocks };
			return;
		}
	}
}

export const anthropicCachePolicy: CachePolicy = new AnthropicCachePolicy();

/**
 * `systemBody()` 逐字:没有 `systemHeader` 就是会话自己的 system;有的话,
 * 会话没 system(或与 header 逐字相同)时 header 独占,否则两块文本。
 */
export function anthropicSystemBody(
	systemHeader: string | undefined,
	system: string | undefined,
): string | AnthropicTextBlock[] | undefined {
	if (!systemHeader) return system;
	if (!system || system === systemHeader) return systemHeader;
	return [
		{ type: "text", text: systemHeader },
		{ type: "text", text: system },
	];
}

// ---------------------------------------------------------------------------
// wire
// ---------------------------------------------------------------------------

export class AnthropicMessagesWire extends HttpAgentProvider<
	Record<string, unknown>,
	AnthropicStreamEvent
> {
	constructor(ctx: ProviderContext, dialect: AnthropicDialect) {
		super(ctx, dialect);
	}

	protected get transportCapabilities(): AgentModelCapabilities {
		return this.anthropicDialect.transport;
	}

	protected get defaultParts(): PartCodec {
		return anthropicParts;
	}

	protected get defaultUsage(): UsageNormalizer {
		return anthropicUsage;
	}

	protected get finish(): FinishReasonMapper {
		return anthropicFinishReasonMapper;
	}

	protected override get defaultToolChoice(): ToolChoicePolicy {
		return anthropicToolChoicePolicy;
	}

	protected override get defaultSampling(): SamplingPolicy {
		return anthropicSamplingPolicy;
	}

	/**
	 * P1-d1 起抛 `ProviderHttpError`(见 `anthropic-errors.ts` 的抬头)。
	 * 覆盖 getter 而不是在基类里加分支 —— 那是方言的事,不是模板的事。
	 *
	 * 映射器**现建**而不是配方里那一只单例:一份 anthropic 配方服务
	 * `custom-*` 任意多个 provider id,`this.id` 是这里唯一说得出真身份的东西。
	 */
	protected override get errors(): AnthropicErrorMapper {
		return (
			(this.dialect.errors as AnthropicErrorMapper | undefined) ??
			new AnthropicErrorMapper(this.id)
		);
	}

	protected get anthropicDialect(): AnthropicDialect {
		return this.dialect as AnthropicDialect;
	}

	protected get anthropicParts(): AnthropicCodec {
		return this.parts as AnthropicCodec;
	}

	// -----------------------------------------------------------------------
	// 请求体
	// -----------------------------------------------------------------------

	protected buildBody(turn: TurnContext): void {
		const { builder, request } = turn;
		const dialect = this.anthropicDialect;

		// Anthropic 的 Messages API 同样要求 user/assistant 交替(它自己不合并):
		// 相邻同角色先合成一条(C5 —— 摘要注入不再垫伪造的 assistant 握手)。
		const messages = dialect.request.mergeAdjacent
			? mergeAdjacentSameRoleMessages(request.messages)
			: request.messages;
		const converted = this.anthropicParts.toRequestMessages(messages, turn);

		builder.set("model", request.model);
		builder.set("messages", converted.messages);
		// Anthropic requires max_tokens, but we do not invent one (2026-08-15):
		// the app-level caller fills in the model's real max when the registry
		// knows it; when it doesn't, the field is omitted and Anthropic's own
		// "max_tokens: field required" surfaces — an honest error beats a hidden
		// 4096 nobody can find in any setting.
		if (request.maxTokens !== undefined) {
			builder.set(dialect.request.maxTokensField, request.maxTokens);
		}
		builder.set("stream", true);

		const system = anthropicSystemBody(dialect.systemHeader, converted.system);
		if (system) builder.set("system", system);

		const tools =
			request.toolChoice === "none" ? undefined : toAnthropicTools(request.tools);
		if (tools?.length) builder.set("tools", tools);
	}

	// -----------------------------------------------------------------------
	// 流解析 —— `streamClaudeResponse` 逐字
	// -----------------------------------------------------------------------

	protected async *parseStream(
		response: Response,
		turn: TurnContext,
	): AsyncGenerator<AgentTurnStreamEvent, RawTurnFinish, void> {
		const turnIndex = turn.turn;
		const errors = this.errors;
		const toolUses = new Map<number, ToolUseAccumulator>();
		const thinkingBlocks = new Map<number, ThinkingAccumulator>();
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let cacheWriteTokens = 0;
		/** 官方有则报(思考 token ⊂ output_tokens);没报就一路 undefined,不造零。 */
		let thinkingTokens: number | undefined;
		let stopReason: string | null | undefined;

		const applyUsage = (usage: AnthropicUsage | undefined): void => {
			if (!usage) return;
			inputTokens = usage.input_tokens ?? inputTokens;
			outputTokens = usage.output_tokens ?? outputTokens;
			cacheReadTokens = usage.cache_read_input_tokens ?? cacheReadTokens;
			cacheWriteTokens = usage.cache_creation_input_tokens ?? cacheWriteTokens;
			thinkingTokens = usage.output_tokens_details?.thinking_tokens ?? thinkingTokens;
		};

		for await (const event of readJsonSseData<AnthropicStreamEvent>(response, {
			sourceName: errors.sourceName,
			invalidMessage: "invalid stream event",
		})) {
			const streamError = errors.fromStreamEvent(event);
			if (streamError) throw streamError;

			applyUsage(event.message?.usage);
			applyUsage(event.usage);

			if (
				event.type === "content_block_start" &&
				event.content_block?.type === "thinking"
			) {
				thinkingBlocks.set(event.index ?? 0, { thinking: "", signature: "" });
				continue;
			}

			if (
				event.type === "content_block_start" &&
				event.content_block?.type === "redacted_thinking"
			) {
				const data = event.content_block.data;
				if (typeof data === "string" && data) {
					yield {
						type: "provider-data",
						turn: turnIndex,
						providerData: { provider: "claude", type: "redacted-thinking", data },
					};
				}
				continue;
			}

			if (
				event.type === "content_block_start" &&
				event.content_block?.type === "tool_use"
			) {
				const index = event.index ?? toolUses.size;
				const input =
					event.content_block.input && typeof event.content_block.input === "object"
						? JSON.stringify(event.content_block.input)
						: "";
				const entry: ToolUseAccumulator = {
					id: event.content_block.id ?? `tool-${turnIndex}-${index}`,
					name: event.content_block.name ?? "",
					arguments: input === "{}" ? "" : input,
					started: true,
				};
				toolUses.set(index, entry);
				yield {
					type: "tool-call-start",
					turn: turnIndex,
					toolCallId: entry.id,
					toolName: entry.name,
				};
				if (entry.arguments) {
					yield {
						type: "tool-call-delta",
						turn: turnIndex,
						toolCallId: entry.id,
						toolName: entry.name,
						argumentsDelta: entry.arguments,
					};
				}
				continue;
			}

			if (event.type === "content_block_delta") {
				if (event.delta?.type === "text_delta" && event.delta.text) {
					yield { type: "text-delta", turn: turnIndex, delta: event.delta.text };
					continue;
				}
				if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
					const entry = thinkingBlocks.get(event.index ?? 0);
					if (entry) entry.thinking += event.delta.thinking;
					yield {
						type: "reasoning-delta",
						turn: turnIndex,
						delta: event.delta.thinking,
					};
					continue;
				}
				if (event.delta?.type === "signature_delta" && event.delta.signature) {
					const entry = thinkingBlocks.get(event.index ?? 0);
					if (entry) entry.signature += event.delta.signature;
					continue;
				}
				if (event.delta?.type === "input_json_delta") {
					const index = event.index ?? 0;
					const entry = toolUses.get(index);
					const partial = event.delta.partial_json ?? "";
					if (entry && partial) {
						entry.arguments += partial;
						yield {
							type: "tool-call-delta",
							turn: turnIndex,
							toolCallId: entry.id,
							toolName: entry.name,
							argumentsDelta: partial,
						};
					}
				}
				continue;
			}

			if (event.type === "content_block_stop") {
				const index = event.index ?? -1;
				const thinkingEntry = thinkingBlocks.get(index);
				if (thinkingEntry) {
					// Signed blocks are replayed verbatim on later turns; unsigned ones
					// (third-party anthropic-compatible endpoints) have nothing the API
					// would verify, so skip them.
					if (thinkingEntry.signature) {
						yield {
							type: "provider-data",
							turn: turnIndex,
							providerData: thinkingProviderData(thinkingEntry),
						};
					}
					thinkingBlocks.delete(index);
					continue;
				}
				const entry = toolUses.get(index);
				if (entry?.started) {
					yield toolCallDoneEvent(turnIndex, entry);
					toolUses.delete(index);
				}
				continue;
			}

			if (event.type === "message_delta") {
				stopReason = event.delta?.stop_reason;
				applyUsage(event.usage);
			}
		}

		for (const [, entry] of [...toolUses.entries()].sort(([a], [b]) => a - b)) {
			yield toolCallDoneEvent(turnIndex, entry);
		}

		// **usage 恒有**:今天 `usageFromAnthropic(0,0,0,0)` 也会产出一份零值
		// usage,而不是 `undefined`。这里原样交出去,由 `UsageNormalizer` 直译。
		return {
			finishReason: stopReason,
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_input_tokens: cacheReadTokens,
				cache_creation_input_tokens: cacheWriteTokens,
				...(thinkingTokens === undefined
					? {}
					: { output_tokens_details: { thinking_tokens: thinkingTokens } }),
			} satisfies AnthropicUsage,
		};
	}
}

/** 方言文件与门面共用的 logger 命名规则。 */
export function anthropicLogger(providerId: string): ReturnType<typeof getLogger> {
	return getLogger(`providers.${providerId}`);
}
