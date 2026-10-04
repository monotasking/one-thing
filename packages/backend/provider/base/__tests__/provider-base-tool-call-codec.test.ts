/**
 * 工具调用 codec 与收尾那一格(§7.5,`docs/design/provider-settings-rework-2026-09.md`)。
 *
 * 默认 codec 与累积器是从 openai-chat 线原样搬出来的 —— 那一半由 wire-snapshots 与 golden
 * `no-spec` 钉着;这里钉的是**新长出来的**:老格式 codec、按路径读的通用 codec、
 * 收尾映射表只加词不改词、SSE 结束标记可注入。
 */
import { describe, expect, it } from "vitest";
import type { AgentTurnRequest, AgentTurnStreamEvent } from "@onething/backend/agent-loop";
import { getLogger } from "../../../logging/logging.js";
import { readJsonSseData } from "../../provider-sse.js";
import {
	finishReasonMapperFor,
	LedgerModelProfileResolver,
	LEGACY_FUNCTION_CALL_CODEC,
	OPENAI_TOOL_CALLS_CODEC,
	openAIFinishReasonMapper,
	pathToolCallsCodec,
	RequestBodyBuilder,
	ToolCallAccumulator,
	TurnContext,
	type ToolCallCodec,
} from "../provider-base.js";

const REQUEST: AgentTurnRequest = { turn: 3, model: "gpt-4o", messages: [] };

function turn(): TurnContext {
	const profile = new LedgerModelProfileResolver().resolveSync("openai", REQUEST.model);
	return new TurnContext(REQUEST, profile, new RequestBodyBuilder(), getLogger("providers.test"));
}

function run(codec: ToolCallCodec, chunks: unknown[]): AgentTurnStreamEvent[] {
	const ctx = turn();
	const acc = new ToolCallAccumulator(ctx);
	const out: AgentTurnStreamEvent[] = [];
	for (const chunk of chunks) {
		const fragments = codec.decode(chunk, ctx);
		if (fragments) out.push(...acc.accept(fragments));
	}
	out.push(...acc.finishDeclared());
	return out;
}

function doneCalls(events: AgentTurnStreamEvent[]) {
	return events.flatMap((e) => (e.type === "tool-call-done" ? [e.toolCall] : []));
}

describe("ToolCallCodec", () => {
	it("默认 codec:`delta.tool_calls[]` 按 index 累积,index 切换判前一个 done", () => {
		const events = run(OPENAI_TOOL_CALLS_CODEC, [
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "x", arguments: "{" } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "y", arguments: "{}" } }] } }] },
		]);
		expect(events.map((e) => e.type)).toEqual([
			"tool-call-start",
			"tool-call-delta",
			"tool-call-delta",
			"tool-call-done",
			"tool-call-start",
			"tool-call-delta",
			"tool-call-done",
		]);
		expect(doneCalls(events)).toEqual([
			{ id: "a", name: "x", arguments: "{}" },
			{ id: "b", name: "y", arguments: "{}" },
		]);
	});

	it("老格式:`delta.function_call` 单调用、无 index 无 id → `tool-<turn>-0`", () => {
		const events = run(LEGACY_FUNCTION_CALL_CODEC, [
			{ choices: [{ delta: { content: "hi" } }] },
			{ choices: [{ delta: { function_call: { name: "read_file", arguments: "" } } }] },
			{ choices: [{ delta: { function_call: { arguments: '{"path":"a"}' } } }] },
		]);
		expect(doneCalls(events)).toEqual([{ id: "tool-3-0", name: "read_file", arguments: '{"path":"a"}' }]);
		// 默认 codec 对同一份流一个调用都读不出 —— 这就是那格要换的原因。
		expect(
			run(OPENAI_TOOL_CALLS_CODEC, [
				{ choices: [{ delta: { function_call: { name: "read_file", arguments: "{}" } } }] },
			]),
		).toEqual([]);
	});

	it("按路径读:数组无 index 按位置;arguments 是对象时转成 JSON 文本", () => {
		const codec = pathToolCallsCodec("output.calls");
		const events = run(codec, [
			{ output: { calls: [{ name: "a", arguments: { k: 1 } }, { id: "c2", function: { name: "b", arguments: "{}" } }] } },
		]);
		expect(doneCalls(events)).toEqual([
			{ id: "tool-3-0", name: "a", arguments: '{"k":1}' },
			{ id: "c2", name: "b", arguments: "{}" },
		]);
		expect(codec.decode({ output: {} }, turn())).toBeUndefined();
	});
});

describe("收尾那一格", () => {
	it("映射表只加词:表里有的先查表,没有的走线的默认映射", () => {
		const mapper = finishReasonMapperFor(
			{ reasonMap: { end_turn: "stop", stop: "length" } },
			openAIFinishReasonMapper,
		);
		expect(mapper.map("end_turn")).toBe("stop");
		expect(mapper.map("stop")).toBe("length");
		expect(mapper.map("tool_calls")).toBe("tool_calls");
		expect(mapper.map(undefined)).toBe("unknown");
		// 没给表 = 线的默认映射本身。
		expect(finishReasonMapperFor(undefined, openAIFinishReasonMapper)).toBe(openAIFinishReasonMapper);
		expect(finishReasonMapperFor({ reasonMap: {} }, openAIFinishReasonMapper)).toBe(openAIFinishReasonMapper);
	});

	async function readAll(body: string, doneMarker?: string | null): Promise<unknown[]> {
		const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
		const out: unknown[] = [];
		for await (const item of readJsonSseData(response, {
			sourceName: "test",
			...(doneMarker !== undefined ? { doneMarker } : {}),
		})) {
			out.push(item);
		}
		return out;
	}

	it("SSE 结束标记可注入:缺 = `[DONE]`;自定义串被跳过;`null` = 不跳", async () => {
		expect(await readAll('data: {"a":1}\n\ndata: [DONE]\n\n')).toEqual([{ a: 1 }]);
		expect(await readAll('data: {"a":1}\n\ndata: [END]\n\n', "[END]")).toEqual([{ a: 1 }]);
		expect(await readAll('data: {"a":1}\n\ndata: 0\n\n', null)).toEqual([{ a: 1 }, 0]);
		await expect(readAll('data: {"a":1}\n\ndata: [DONE]\n\n', null)).rejects.toThrow(/invalid JSON SSE payload/);
	});
});
