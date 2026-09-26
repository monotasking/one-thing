/**
 * `ToolCallCodec` —— 流上的工具调用**长在哪、长什么样**,是方言可替换的一格
 * (`docs/design/provider-settings-rework-2026-09.md` §7.5 / §11 留账「线把工具调用读死了」)。
 *
 * 分两半,各管一件事:
 *
 *  - **codec**(方言可换):从一个 chunk 里读出这一片工具调用 —— `{ index, id?, name?, arguments? }`
 *    的列表。只做「在哪、叫什么」,不做累积,不发事件。默认实现 `OPENAI_TOOL_CALLS_CODEC` 读
 *    `choices[0].delta.tool_calls`;`LEGACY_FUNCTION_CALL_CODEC` 读老格式 `delta.function_call`
 *    (单调用、无 index);`pathToolCallsCodec(path)` 按任意路径读。
 *  - **累积器** `ToolCallAccumulator`(线共用,不可换):按 index 拼 id / name / arguments,
 *    决定 start / delta / done 的时机与「交错」留痕。这段是从 openai-chat 线里**原样搬出来的**,
 *    一个字的行为都没改 —— done 的三个时机(index 切换 / 收尾原因 / 流结束)是这条线对下游的
 *    承诺,与字段长在哪无关,所以不让方言碰。
 *
 * 片段里的原值**不做清洗**:`id` 用 `??` 兜底、`name` 按真值拼、`arguments` 缺席当空串 ——
 * 全是搬之前的读法,golden 与 wire-snapshots 钉着。
 */
import type { AgentTurnStreamEvent } from "@onething/core/agent-loop";
import { getPath } from "./path.js";
import type { TurnContext } from "./turn-context.js";

/** 一个 chunk 里某一个工具调用的一片。 */
export interface ToolCallFragment {
	index: number;
	id?: string;
	name?: string;
	arguments?: string;
}

export interface ToolCallCodec {
	/** 人认得的名字(日志 / 测试);线不解释它。 */
	id: string;
	/** 这个 chunk 里没有工具调用 → `undefined`(或空数组)。 */
	decode(chunk: unknown, turn: TurnContext): ToolCallFragment[] | undefined;
}

interface OpenAIToolCallDelta {
	index: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

interface ChunkWithChoices {
	choices?: Array<{ delta?: { tool_calls?: OpenAIToolCallDelta[] } }>;
}

/** 今天的读法:`choices[0].delta.tool_calls[]`,每项带 `index`。 */
export const OPENAI_TOOL_CALLS_CODEC: ToolCallCodec = {
	id: "openai-tool-calls",
	decode(chunk) {
		const calls = (chunk as ChunkWithChoices).choices?.[0]?.delta?.tool_calls;
		if (!calls) return undefined;
		return calls.map((call) => ({
			index: call.index,
			id: call.id,
			name: call.function?.name,
			arguments: call.function?.arguments,
		}));
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOr(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return undefined;
	// 有的转发站把 arguments 发成已解析的对象 —— 下游要的是 JSON 文本。
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** 一项(OpenAI 的 `{ index, id, function: { name, arguments } }`,或扁平的 `{ name, arguments }`)。 */
function fragmentOf(item: unknown, position: number): ToolCallFragment | undefined {
	if (!isRecord(item)) return undefined;
	const fn = isRecord(item.function) ? item.function : item;
	const fragment: ToolCallFragment = {
		index: typeof item.index === "number" ? item.index : position,
	};
	const id = stringOr(item.id);
	const name = stringOr(fn.name);
	const args = stringOr(fn.arguments);
	if (id !== undefined) fragment.id = id;
	if (name !== undefined) fragment.name = name;
	if (args !== undefined) fragment.arguments = args;
	return fragment;
}

/**
 * 按路径读:值是数组 = 多调用(项里有 `index` 就用,没有按位置);值是对象 = 单调用、index 0。
 * 适配表 `toolCallsPath` 非默认、又不是老格式那一条时,编译器产出它。
 */
export function pathToolCallsCodec(path: string): ToolCallCodec {
	return {
		id: `path:${path}`,
		decode(chunk) {
			const value = getPath(chunk, path);
			if (Array.isArray(value)) {
				const out: ToolCallFragment[] = [];
				value.forEach((item, position) => {
					const fragment = fragmentOf(item, position);
					if (fragment) out.push(fragment);
				});
				return out;
			}
			const single = fragmentOf(value, 0);
			return single ? [single] : undefined;
		},
	};
}

/**
 * 老格式:`choices[0].delta.function_call { name, arguments }` —— 一轮最多一个调用、没有
 * index、没有 id(id 由累积器按 `tool-<turn>-0` 兜底)。
 */
export const LEGACY_FUNCTION_CALL_CODEC: ToolCallCodec = {
	id: "legacy-function-call",
	decode: pathToolCallsCodec("choices[0].delta.function_call").decode,
};

// ---------------------------------------------------------------------------
// 累积器 —— openai-chat 线原样搬出
// ---------------------------------------------------------------------------

interface AccumulatedToolCall {
	id: string;
	name: string;
	arguments: string;
	started: boolean;
	done: boolean;
	/** 已经为这个 index 记过一条 `tool-call-interleaved` —— 一次交错记一条,不刷屏。 */
	interleavedReported: boolean;
}

function toolCallDoneEvent(
	turn: number,
	entry: AccumulatedToolCall,
): Extract<AgentTurnStreamEvent, { type: "tool-call-done" }> {
	return {
		type: "tool-call-done",
		turn,
		toolCall: { id: entry.id, name: entry.name, arguments: entry.arguments },
	};
}

/** 一回合一个。状态只活在这一次 `parseStream` 里。 */
export class ToolCallAccumulator {
	private readonly toolCalls = new Map<number, AccumulatedToolCall>();

	constructor(private readonly turn: TurnContext) {}

	/** 吃一片,吐这一片带出来的 start / delta / (前序 index 的)done。 */
	*accept(fragments: readonly ToolCallFragment[]): Generator<AgentTurnStreamEvent, void, void> {
		const turn = this.turn;
		const turnIndex = turn.turn;
		const toolCalls = this.toolCalls;
		for (const toolCallDelta of fragments) {
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
			if (toolCallDelta.name) entry.name += toolCallDelta.name;
			const argumentsDelta = toolCallDelta.arguments ?? "";

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

	/**
	 * The provider has declared the turn over: every accumulated tool
	 * call is complete. Emit done here (not after the SSE loop) so the
	 * last tool call starts executing without waiting for stream teardown.
	 */
	*finishDeclared(): Generator<AgentTurnStreamEvent, void, void> {
		for (const [, entry] of [...this.toolCalls.entries()].sort(([a], [b]) => a - b)) {
			if (!entry.done) {
				entry.done = true;
				yield toolCallDoneEvent(this.turn.turn, entry);
			}
		}
	}

	/** 流结束兜底:还没 done 的一律补一条(不改 done 位 —— 搬之前就是这样)。 */
	*streamEnded(): Generator<AgentTurnStreamEvent, void, void> {
		for (const [, entry] of [...this.toolCalls.entries()].sort(([a], [b]) => a - b)) {
			if (!entry.done) yield toolCallDoneEvent(this.turn.turn, entry);
		}
	}
}
