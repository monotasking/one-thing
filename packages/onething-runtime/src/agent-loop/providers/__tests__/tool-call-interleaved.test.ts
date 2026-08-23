/**
 * 工具调用 index 交错的**留痕**(P0b-B 泳道甲第 3 项,设计稿 §10 第 7 条)。
 *
 * openai-chat 这条线判 done 的依据是 **index 切换**:OpenAI 形状的流按 index
 * 顺序发工具调用,于是一条新 index 的增量就证明所有更小的 index 都发完了 ——
 * 提前发 done 让下游能一边执行一边渲染后面的调用。
 *
 * 不按这个顺序发的网关会把这条判据撞穿:index 0 被判 done 之后又来了 index 0
 * 的 `arguments`,那些字符对模型**已经无效**(done 事件带着当时的完整
 * arguments 已经出去了,下游可能已经在执行)。
 *
 * 这份门守的是两件事,合起来才是这一项的全部:
 *
 *  1. **事件序列一个字不变** —— 不补第二条 done(同一个 toolCallId 出现两次
 *     终态比丢几个字符坏得多),增量照旧累加与外发。`__fixtures__` 里那批
 *     `events.json` 因此零变化。
 *  2. **warnings 里多一条 `tool-call-interleaved`** —— 一个 index 记一条,
 *     带 `toolCallId` / `index` / `droppedChars`。
 *
 * 取样用的 SSE 与 各家的 `__fixtures__/openai-chat/<id>/sse.txt` 同形(那批 fixture 本身
 * 就是交错的:index 0 → index 1 → index 0)。warnings 今天没有流上的出口
 * (`AgentTurnStreamEvent.finish` 的 `warnings?` 是 §8 的契约增量,待拍板),
 * 所以这里覆盖 `finishEvent` 把那一回合的 `TurnContext` 捞出来 —— 与
 * `base/__tests__/warnings-channel.test.ts` 对**回合**断言是同一个做法。
 */
import { describe, expect, it } from "vitest";
import type {
	AgentTurnRequest,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import { OPENROUTER_DIALECT } from "../dialects/index.js";
import { LedgerModelProfileResolver, type TurnContext } from "../base/index.js";
import { OpenAIChatWire, openAIChatLogger } from "../wires/index.js";
import { drain, sseResponse } from "./wire-snapshots/snapshot-harness.js";

// 取样用 openrouter —— 这条门守的是 **openai-chat wire** 的 index 判据,与哪家
// 无关;P4-5 起 `openai` 自己走 Responses(那条线按 output item id 判 done,
// 没有 index 这个概念),所以这里换成同线上另一家最普通的配方。
const PROVIDER_ID = "openrouter";
const MODEL = "openai/gpt-5.5";

const REQUEST: AgentTurnRequest = {
	turn: 1,
	model: MODEL,
	messages: [{ role: "user", content: "read a.txt then write b.txt" }],
};

function chunk(toolCallDelta: Record<string, unknown>): string {
	return JSON.stringify({
		choices: [{ index: 0, delta: { tool_calls: [toolCallDelta] } }],
	});
}

/** 手写的 SSE 帧:每条一块 data,末尾 `[DONE]`。 */
function sse(dataLines: string[]): string {
	return [...dataLines.map((line) => `data: ${line}`), "data: [DONE]", ""].join("\n\n");
}

/** index 0 → index 1(0 在这里被判 done)→ index 0 又来一段。 */
const INTERLEAVED_SSE = sse([
	chunk({
		index: 0,
		id: "call_read",
		type: "function",
		function: { name: "read_file", arguments: '{"path":' },
	}),
	chunk({
		index: 1,
		id: "call_write",
		type: "function",
		function: { name: "write_file", arguments: '{"path":' },
	}),
	chunk({ index: 0, function: { arguments: '"a.txt"}' } }),
	chunk({ index: 1, function: { arguments: '"b.txt","content":"hi"}' } }),
	JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
]);

/** 覆盖 `finishEvent` 把这一回合的 TurnContext 捞出来 —— warnings 今天只活在那儿。 */
class ObservableOpenAIChatWire extends OpenAIChatWire {
	lastTurn: TurnContext | undefined;

	protected override finishEvent(
		raw: Parameters<OpenAIChatWire["finishEvent"]>[0],
		turn: TurnContext,
	): Extract<AgentTurnStreamEvent, { type: "finish" }> {
		this.lastTurn = turn;
		return super.finishEvent(raw, turn);
	}
}

function wireOver(body: string): ObservableOpenAIChatWire {
	return new ObservableOpenAIChatWire(
		{
			providerId: PROVIDER_ID,
			baseUrl: OPENROUTER_DIALECT.endpoint.defaultBaseUrl,
			fetchImpl: (async () => sseResponse(body)) as typeof globalThis.fetch,
			logger: openAIChatLogger(PROVIDER_ID),
			profiles: new LedgerModelProfileResolver(),
		},
		OPENROUTER_DIALECT,
	);
}

function toolCallEvents(events: AgentTurnStreamEvent[]) {
	return events
		.filter((event) => event.type.startsWith("tool-call"))
		.map((event) => {
			if (event.type === "tool-call-done") {
				return ["done", event.toolCall.id, event.toolCall.arguments];
			}
			if (event.type === "tool-call-start") {
				return ["start", event.toolCallId, event.toolName];
			}
			if (event.type === "tool-call-delta") {
				return ["delta", event.toolCallId, event.argumentsDelta];
			}
			return [event.type];
		});
}

describe("openai-chat:工具调用 index 交错", () => {
	it("事件序列与今天逐条相同 —— 不补第二条 done,增量照旧外发", async () => {
		const wire = wireOver(INTERLEAVED_SSE);
		const events = await drain(wire.streamTurn!(REQUEST));

		expect(toolCallEvents(events)).toEqual([
			["start", "call_read", "read_file"],
			["delta", "call_read", '{"path":'],
			// index 切换 = index 0 判 done,带着当时的 arguments 出去。
			["done", "call_read", '{"path":'],
			["start", "call_write", "write_file"],
			["delta", "call_write", '{"path":'],
			// 交错的那一段:仍然作为 delta 外发,**没有**第二条 done。
			["delta", "call_read", '"a.txt"}'],
			["delta", "call_write", '"b.txt","content":"hi"}'],
			["done", "call_write", '{"path":"b.txt","content":"hi"}'],
		]);
		// call_read 全程只有一条 done。
		expect(
			events.filter(
				(event) => event.type === "tool-call-done" && event.toolCall.id === "call_read",
			),
		).toHaveLength(1);
	});

	it("warnings 里多一条 tool-call-interleaved,带 toolCallId / index / droppedChars", async () => {
		const wire = wireOver(INTERLEAVED_SSE);
		await drain(wire.streamTurn!(REQUEST));

		const warnings = wire.lastTurn?.warnings ?? [];
		expect(warnings.map((warning) => warning.kind)).toContain("tool-call-interleaved");
		const interleaved = warnings.filter(
			(warning) => warning.kind === "tool-call-interleaved",
		);
		// 一个 index 一条,不刷屏。
		expect(interleaved).toHaveLength(1);
		expect(interleaved[0]!.fields).toEqual({
			toolCallId: "call_read",
			index: 0,
			droppedChars: '"a.txt"}'.length,
		});
	});

	it("按 index 顺序发的流一条 warning 都没有", async () => {
		const orderly = sse([
			chunk({
				index: 0,
				id: "call_read",
				type: "function",
				function: { name: "read_file", arguments: '{"path":"a.txt"}' },
			}),
			chunk({
				index: 1,
				id: "call_write",
				type: "function",
				function: { name: "write_file", arguments: '{"path":"b.txt"}' },
			}),
			JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
		]);

		const wire = wireOver(orderly);
		await drain(wire.streamTurn!(REQUEST));
		expect(wire.lastTurn?.warnings ?? []).toEqual([]);
	});
});
