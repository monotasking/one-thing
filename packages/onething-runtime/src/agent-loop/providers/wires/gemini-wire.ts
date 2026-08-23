/**
 * `GeminiWire` —— Gemini `generateContent`(SSE 档)这条线协议的**唯一**实现
 * (设计稿 §3:一条 wire 一个类,管线写死在 `HttpAgentProvider` 的模板方法里)。
 *
 * 今天它上面只挂一个 id(`gemini`),但差异仍然全部由组合进 `Dialect` 的策略
 * 对象表达:认证(`x-goog-api-key` 头)、端点(`models/{model}:streamGenerateContent`
 * 与 `?alt=sse&key=` 的拼装与脱敏)、思考线型(level / budget)。这个类里没有
 * 一处 `if (providerId === …)`。
 *
 * P1-b 是**纯搬运**:`gemini.ts` 的请求体构造、`streamGeminiResponse` 的
 * 流状态机、`buildGeminiContents` 的块序、`mapFinishReason` 的映射,逐字保留
 * (`__tests__/wire-snapshots/gemini` 的 11 份快照就是这句话的门,**禁 `-u`**)。
 *
 * 两处复刻的现状,后面几期再动(设计稿 §9 P1 门 ① / §5.2):
 *  - **认证发两遍**:URL 上的 `?key=` 与 `x-goog-api-key` 头**同时**发,
 *    官方已经把 query 那条标为旧法(P2 去掉 query);
 *  - **孤儿工具结果**退回 `toolCallId` 当函数名,只留形状不留 warning。
 *
 * usage 已在 P1-d2 按 §7 直译:`output = candidates + thoughts`。
 */
import type {
	AgentFinishReason,
	AgentModelCapabilities,
	AgentTurnStreamEvent,
	AgentJsonObject,
} from "@onething/core/agent-loop";
import { getLogger } from "../../../logging/index.js";
import { mergeAdjacentSameRoleMessages } from "../message-merge.js";
import { readJsonSseData } from "../sse.js";
import {
	geminiBudgetThinkingWire,
	geminiLevelThinkingWire,
	isGemini25Model,
} from "../thinking/index.js";
import {
	HttpAgentProvider,
	UsageBuckets,
	noThinkingWire,
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
import { GeminiErrorMapper } from "./gemini-errors.js";
import {
	geminiParts,
	toGeminiToolConfig,
	toGeminiTools,
	type GeminiCodec,
	type GeminiWireValue,
} from "./gemini-messages.js";

// ---------------------------------------------------------------------------
// 方言:这条线上多出来的一个字段
// ---------------------------------------------------------------------------

export interface GeminiDialect extends Dialect<GeminiWireValue> {
	/** provider 的**传输**声明(模态 / 结构化工具结果)。per-model 的布尔归账本。 */
	transport: AgentModelCapabilities;
}

// ---------------------------------------------------------------------------
// 流上的形状
// ---------------------------------------------------------------------------

export interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
	cachedContentTokenCount?: number;
	thoughtsTokenCount?: number;
}

export interface GeminiStreamChunk {
	candidates?: Array<{
		content?: {
			role?: string;
			parts?: Array<{
				text?: string;
				thought?: boolean;
				functionCall?: {
					name?: string;
					args?: AgentJsonObject;
				};
			}>;
		};
		finishReason?: string;
	}>;
	usageMetadata?: GeminiUsageMetadata;
	error?: {
		message?: string;
		status?: string;
		code?: number;
	};
}

interface ToolCallAccumulator {
	id: string;
	name: string;
	arguments: string;
	started: boolean;
	done: boolean;
}

function stableToolCallId(turn: number, index: number, name: string): string {
	return `gemini-${turn}-${index}-${name || "tool"}`;
}

function stringifyArgs(args: AgentJsonObject | undefined): string {
	try {
		return JSON.stringify(args ?? {});
	} catch {
		return "{}";
	}
}

function toolCallDoneEvent(
	turn: number,
	entry: ToolCallAccumulator,
): Extract<AgentTurnStreamEvent, { type: "tool-call-done" }> {
	return {
		type: "tool-call-done",
		turn,
		toolCall: {
			id: entry.id,
			name: entry.name,
			arguments: entry.arguments,
		},
	};
}

// ---------------------------------------------------------------------------
// usage —— 设计稿 §7 的 Gemini 行(三桶直译)
// ---------------------------------------------------------------------------

/**
 * 三桶直译:`promptTokenCount` **含** cached,所以 uncachedInput 要减掉
 * `cachedContentTokenCount`(投影 `input = uncached + read` 于是还原成
 * promptTokenCount);Gemini 没有「缓存写入」这一桶,`cacheWrite` 恒 0。
 *
 * **`output = candidatesTokenCount + thoughtsTokenCount`**:官方口径是
 * `totalTokenCount = prompt + thoughts + candidates` —— 思考 token **不在**
 * `candidatesTokenCount` 里,而计费按输出算(§12 研究摘要 Gemini 一行)。
 * `reasoning` 仍报 `thoughtsTokenCount`(此处它是 output 的子集)。
 *
 * `totalTokenCount` 是厂商自己报的口径,原样进 `reportedTotal` —— 厂商报了就
 * 用厂商的,`total` 不由三桶派生。
 */
export class GeminiUsageNormalizer implements UsageNormalizer {
	toBuckets(raw: unknown): UsageBuckets | undefined {
		if (typeof raw !== "object" || raw === null) return undefined;
		const usage = raw as GeminiUsageMetadata;
		const promptTokens = usage.promptTokenCount ?? 0;
		const cacheRead = usage.cachedContentTokenCount ?? 0;
		const thoughts = usage.thoughtsTokenCount ?? 0;
		const output = (usage.candidatesTokenCount ?? 0) + thoughts;
		return new UsageBuckets(
			Math.max(promptTokens - cacheRead, 0),
			cacheRead,
			0,
			output,
			usage.thoughtsTokenCount,
			undefined,
			undefined,
			usage.totalTokenCount,
		);
	}
}

export const geminiUsage: UsageNormalizer = new GeminiUsageNormalizer();

// ---------------------------------------------------------------------------
// finish reason
// ---------------------------------------------------------------------------

/**
 * 流里真的解出过 `functionCall` 时,收尾原因由这个哨兵翻成 `tool_calls`
 * —— 复刻 `streamGeminiResponse` 末尾那句
 * `finishReason: hasToolCalls ? 'tool_calls' : finishReason`。它不是线上会出现
 * 的值,所以不会与任何 `candidates[].finishReason` 撞名。
 */
export const GEMINI_TOOL_CALLS_FINISH = "onething:tool-calls";

/** `mapFinishReason` 逐字。 */
export class GeminiFinishReasonMapper implements FinishReasonMapper {
	map(reason: string | null | undefined): AgentFinishReason {
		switch (reason) {
			case GEMINI_TOOL_CALLS_FINISH:
				return "tool_calls";
			case "STOP":
				return "stop";
			case "MAX_TOKENS":
				return "length";
			case "SAFETY":
			case "RECITATION":
			case "BLOCKLIST":
			case "PROHIBITED_CONTENT":
			case "SPII":
				return "content_filter";
			case "MALFORMED_FUNCTION_CALL":
				// The model attempted a function call that Gemini could not parse.
				// Report tool_calls (with zero valid calls) so the runner's
				// no-valid-call nudge asks the model to re-send, instead of
				// silently ending the run as error.
				return "tool_calls";
			default:
				return "unknown";
		}
	}
}

export const geminiFinishReasonMapper: FinishReasonMapper =
	new GeminiFinishReasonMapper();

// ---------------------------------------------------------------------------
// 横切策略
// ---------------------------------------------------------------------------

/**
 * `toolConfig` 的拼法 —— `toGeminiToolConfig` 逐字。只在真的带了工具时才发
 * (`toolChoice === 'none'` 时 `buildBody` 压根不写 `tools`,于是这里也不写)。
 */
export class GeminiToolChoicePolicy implements ToolChoicePolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void {
		const tools = builder.get<unknown[]>("tools");
		if (!Array.isArray(tools) || tools.length === 0) return;
		const config = toGeminiToolConfig(turn.request.toolChoice);
		if (config) builder.set("toolConfig", config);
	}
}

export const geminiToolChoicePolicy: ToolChoicePolicy =
	new GeminiToolChoicePolicy();

/**
 * temperature **无条件带**(思考开着也带)—— 与 openai-chat / anthropic 那两条
 * 线不同,今天的 gemini 从不因为思考而丢温度。官方 2026-07 起把
 * temperature/topP/topK 标为弃用,但那是 P2 的账本判据,不是这里的分支。
 */
export class GeminiSamplingPolicy implements SamplingPolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void {
		const { temperature } = turn.request;
		if (temperature === undefined) return;
		builder.set("generationConfig.temperature", temperature);
	}
}

export const geminiSamplingPolicy: SamplingPolicy = new GeminiSamplingPolicy();

// ---------------------------------------------------------------------------
// wire
// ---------------------------------------------------------------------------

export class GeminiWire extends HttpAgentProvider<
	Record<string, unknown>,
	GeminiStreamChunk
> {
	constructor(ctx: ProviderContext, dialect: GeminiDialect) {
		super(ctx, dialect);
	}

	protected get transportCapabilities(): AgentModelCapabilities {
		return this.geminiDialect.transport;
	}

	protected get defaultParts(): PartCodec {
		return geminiParts;
	}

	protected get defaultUsage(): UsageNormalizer {
		return geminiUsage;
	}

	protected get finish(): FinishReasonMapper {
		return geminiFinishReasonMapper;
	}

	protected override get defaultToolChoice(): ToolChoicePolicy {
		return geminiToolChoicePolicy;
	}

	protected override get defaultSampling(): SamplingPolicy {
		return geminiSamplingPolicy;
	}

	/**
	 * P1-d1 起抛 `ProviderHttpError`(见 `gemini-errors.ts` 的抬头)。
	 * 覆盖 getter 而不是在基类里加分支 —— 那是方言的事,不是模板的事。
	 */
	protected override get errors(): GeminiErrorMapper {
		return (
			(this.dialect.errors as GeminiErrorMapper | undefined) ??
			new GeminiErrorMapper(this.id)
		);
	}

	protected get geminiDialect(): GeminiDialect {
		return this.dialect as GeminiDialect;
	}

	protected get geminiParts(): GeminiCodec {
		return this.parts as GeminiCodec;
	}

	/**
	 * **按模型名选线型,不按账本的 `reasoningWire`**(基类默认那条)。
	 *
	 * 今天 `geminiThinkingConfig()` 问的是 `model.includes('2.5')`,而账本只对
	 * 认得出的 gemini 模型给 `reasoningProfile`(认不出就是 `'none'`,连
	 * `gemini-test` 这类测试模型都算)。判据同一句话,取处不同 —— P2 把这条
	 * 判定并进 `ModelProfile` 之后,这个覆盖才能删。
	 */
	protected override thinkingFor(turn: TurnContext): ThinkingWire {
		const wanted = isGemini25Model(turn.model)
			? geminiBudgetThinkingWire.id
			: geminiLevelThinkingWire.id;
		return this.dialect.reasoning.find((wire) => wire.id === wanted) ?? noThinkingWire;
	}

	/**
	 * 今天的行为:**能力是一张常量表,与模型无关**(`getModelCapabilities: () =>
	 * GEMINI_CAPABILITIES`)。账本的 per-model 覆盖仍由 `factory.ts` 的
	 * `withPerModelCapabilities` 在外面盖一层;P2 两份合一时这个覆盖退役。
	 */
	override async getModelCapabilities(): Promise<AgentModelCapabilities> {
		return this.transportCapabilities;
	}

	// -----------------------------------------------------------------------
	// 请求体
	// -----------------------------------------------------------------------

	protected buildBody(turn: TurnContext): void {
		const { builder, request } = turn;

		// Gemini 的 contents 期望 user/model 交替(相邻同角色它自己会合,但依赖
		// 对端的宽容不是接口契约):在这里先合成一条,与 DeepSeek/Claude 同规。
		const messages = this.geminiDialect.request.mergeAdjacent
			? mergeAdjacentSameRoleMessages(request.messages)
			: request.messages;
		const converted = this.geminiParts.toRequestContents(messages, turn);

		if (converted.systemInstruction) {
			builder.set("systemInstruction", converted.systemInstruction);
		}
		builder.set("contents", converted.contents);
		// `generationConfig` 恒在,哪怕是空对象 —— 今天的请求体就是这样
		// (`baseline.request.json` 里那个 `"generationConfig": {}`)。
		builder.set("generationConfig", {});
		if (request.maxTokens !== undefined) {
			builder.set("generationConfig.maxOutputTokens", request.maxTokens);
		}

		const tools =
			request.toolChoice === "none" ? undefined : toGeminiTools(request.tools);
		if (tools?.length) builder.set("tools", tools);
	}

	// -----------------------------------------------------------------------
	// 流解析 —— `streamGeminiResponse` 逐字
	// -----------------------------------------------------------------------

	protected async *parseStream(
		response: Response,
		turn: TurnContext,
	): AsyncGenerator<AgentTurnStreamEvent, RawTurnFinish, void> {
		const turnIndex = turn.turn;
		const errors = this.errors;
		const toolCalls = new Map<number, ToolCallAccumulator>();
		let usage: GeminiUsageMetadata | undefined;
		let finishReason: string | undefined;
		let toolIndex = 0;

		for await (const chunk of readJsonSseData<GeminiStreamChunk>(response, {
			sourceName: errors.sourceName,
			invalidMessage: "invalid stream chunk",
		})) {
			const streamError = errors.fromStreamEvent(chunk);
			if (streamError) throw streamError;

			usage = chunk.usageMetadata ?? usage;
			const candidate = chunk.candidates?.[0];
			if (candidate?.finishReason) finishReason = candidate.finishReason;

			for (const part of candidate?.content?.parts ?? []) {
				if (part.text) {
					if (part.thought) {
						yield { type: "reasoning-delta", turn: turnIndex, delta: part.text };
					} else {
						yield { type: "text-delta", turn: turnIndex, delta: part.text };
					}
				}

				if (part.functionCall?.name) {
					// Gemini 的函数调用**一块到位**(参数不是流式增量),所以
					// start / delta / done 在同一处发完。
					const index = toolIndex++;
					const args = stringifyArgs(part.functionCall.args);
					const entry: ToolCallAccumulator = {
						id: stableToolCallId(turnIndex, index, part.functionCall.name),
						name: part.functionCall.name,
						arguments: args,
						started: true,
						done: true,
					};
					toolCalls.set(index, entry);
					yield {
						type: "tool-call-start",
						turn: turnIndex,
						toolCallId: entry.id,
						toolName: entry.name,
					};
					if (args) {
						yield {
							type: "tool-call-delta",
							turn: turnIndex,
							toolCallId: entry.id,
							toolName: entry.name,
							argumentsDelta: args,
						};
					}
					yield toolCallDoneEvent(turnIndex, entry);
				}
			}
		}

		const hasToolCalls = [...toolCalls.values()].some((entry) => entry.done);
		return {
			finishReason: hasToolCalls ? GEMINI_TOOL_CALLS_FINISH : finishReason,
			...(usage ? { usage } : {}),
		};
	}
}

/** 方言文件与门面共用的 logger 命名规则。 */
export function geminiLogger(providerId: string): ReturnType<typeof getLogger> {
	return getLogger(`providers.${providerId}`);
}
