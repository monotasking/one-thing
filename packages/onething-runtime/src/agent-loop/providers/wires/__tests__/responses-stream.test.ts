import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnStreamEvent } from "@onething/core/agent-loop";
import { getLogger } from "../../../../logging/index.js";
import "../../dialects/index.js";
import { LedgerModelProfileResolver, RequestBodyBuilder, TurnContext, listDialects } from "../../base/index.js";
import { OpenAIResponsesWire, parseCodexResponsesSse, type ResponsesDialect } from "../openai-responses-wire.js";

class TestResponsesWire extends OpenAIResponsesWire {
	parse(response: Response, turn: TurnContext) {
		return this.parseStream(response, turn);
	}
}

const encoder = new TextEncoder();
function frame(event: Record<string, unknown>): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

async function harness(providerId = "grok") {
	const logger = getLogger(`test.responses-stream.${providerId}`);
	const info = vi.spyOn(logger, "info").mockImplementation(() => {});
	const trace = vi.spyOn(logger, "trace").mockImplementation(() => {});
	vi.spyOn(logger, "isLevelEnabled").mockReturnValue(true);
	const profiles = new LedgerModelProfileResolver({});
	const model = providerId === "codex" ? "gpt-5.5" : "grok-4.6";
	const dialect = listDialects().find((entry) => entry.id === providerId) as ResponsesDialect;
	const wire = new TestResponsesWire({
		providerId, logger, profiles, baseUrl: "https://example.invalid", fetchImpl: vi.fn(),
	}, dialect);
	const turn = new TurnContext({ turn: 1, model, messages: [] }, await profiles.resolve(providerId, model), new RequestBodyBuilder(), logger);
	const parse = (response: Response) => wire.parse(response, turn);
	const collect = async (raw: Record<string, unknown>[]) => {
		const events: AgentTurnStreamEvent[] = [];
		for await (const event of parse(new Response(raw.map(frame).join("")))) events.push(event);
		return events;
	};
	return { parse, collect, info, trace };
}

function reasoning(events: AgentTurnStreamEvent[]): string {
	return events.flatMap(event => event.type === "reasoning-delta" ? [event.delta] : []).join("");
}

afterEach(() => vi.restoreAllMocks());

describe("Responses incremental transport", () => {
	it("decodes split UTF-8 and CRLF frames before the connection closes", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
		const parser = parseCodexResponsesSse(body);
		const encoded = encoder.encode('event: response.reasoning_text.delta\r\ndata: {"delta":"思考中"}\r\n\r\n');
		const split = encoded.indexOf(0xe6) + 1;
		controller.enqueue(encoded.slice(0, split));
		const first = parser.next();
		controller.enqueue(encoded.slice(split));
		expect(await first).toEqual({ done: false, value: { type: "response.reasoning_text.delta", delta: "思考中" } });
		controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"正文"}'));
		controller.close();
		expect((await parser.next()).value).toEqual({ type: "response.output_text.delta", delta: "正文" });
		expect((await parser.next()).done).toBe(true);
	});

	it("forwards xAI reasoning_text deltas while later server events are still pending", async () => {
		const { parse } = await harness();
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
		const stream = parse(new Response(body));
		controller.enqueue(encoder.encode(frame({ type: "response.reasoning_text.delta", item_id: "r1", delta: "先检查" })));
		expect((await stream.next()).value).toEqual({ type: "reasoning-delta", turn: 1, delta: "先检查" });
		controller.enqueue(encoder.encode(frame({ type: "response.output_text.delta", delta: "完成" })));
		expect((await stream.next()).value).toEqual({ type: "text-delta", turn: 1, delta: "完成" });
		controller.close();
		expect((await stream.next()).done).toBe(true);
	});
});

describe.each(["grok", "grok-oauth", "codex"])("%s reasoning completion", (providerId) => {
	it("recovers a missing done suffix without duplicating the output-item snapshot", async () => {
		const { collect } = await harness(providerId);
		const events = await collect([
			{ type: "response.reasoning_summary_text.delta", item_id: "r1", summary_index: 0, delta: "先" },
			{ type: "response.reasoning_summary_text.done", item_id: "r1", summary_index: 0, text: "先检查" },
			{ type: "response.output_item.done", item: { id: "r1", type: "reasoning", summary: [{ type: "summary_text", text: "先检查" }] } },
		]);
		expect(reasoning(events)).toBe("先检查");
		expect(events.map(event => event.type === "reasoning-delta" && event.delta)).toEqual(["先", "检查"]);
	});

	it("recovers a done-only second summary part after a streamed first part", async () => {
		const { collect } = await harness(providerId);
		const events = await collect([
			{ type: "response.reasoning_summary_part.added", item_id: "r1", summary_index: 0 },
			{ type: "response.reasoning_summary_text.delta", item_id: "r1", summary_index: 0, delta: "第一步" },
			{ type: "response.reasoning_summary_part.added", item_id: "r1", summary_index: 1 },
			{ type: "response.reasoning_summary_part.done", item_id: "r1", summary_index: 1, part: { type: "summary_text", text: "第二步" } },
			{ type: "response.output_item.done", item: { id: "r1", type: "reasoning", summary: [{ text: "第一步" }, { text: "第二步" }] } },
		]);
		expect(reasoning(events)).toBe("第一步\n\n第二步");
	});

	it("keeps identical reasoning in distinct items and does not fabricate deltas for a batch", async () => {
		const { collect } = await harness(providerId);
		const events = await collect([
			{ type: "response.reasoning_text.done", item_id: "r1", text: "完整摘要" },
			{ type: "response.output_item.done", item: { id: "r2", type: "reasoning", summary: [{ text: "完整摘要" }] } },
		]);
		expect(events).toEqual([
			{ type: "reasoning-delta", turn: 1, delta: "完整摘要" },
			{ type: "reasoning-delta", turn: 1, delta: "完整摘要" },
		]);
	});
});

describe("Responses diagnostics", () => {
	it("counts unsupported server tool events and upstream batch sizes without logging content", async () => {
		const { collect, info, trace } = await harness();
		const secret = "private prompt and tool arguments";
		const events = await collect([
			{ type: "response.reasoning_text.delta", item_id: "r1", delta: secret },
			{ type: "response.reasoning_text.done", item_id: "r1", text: "revised private text" },
			{ type: "response.web_search_call.searching", arguments: secret },
			{ type: "response.output_item.done", item: { type: "web_search_call", arguments: secret } },
			{ type: "response.completed", response: {} },
		]);
		expect(events.some(event => event.type === "tool-call-done")).toBe(false);
		expect(info).toHaveBeenCalledWith("responses stream summary", expect.objectContaining({
			events: 5, reasoningDeltaEvents: 1, reasoningDeltaChars: secret.length,
			maxReasoningDeltaChars: secret.length, reasoningSnapshotMismatches: 1,
			completedToolCalls: 0, finishReason: "stop",
			unhandledEvents: { "response.web_search_call.searching": 1 },
			unhandledOutputItems: { web_search_call: 1 },
		}));
		expect(JSON.stringify([info.mock.calls, trace.mock.calls])).not.toContain(secret);
		expect(JSON.stringify([info.mock.calls, trace.mock.calls])).not.toContain("revised private text");
	});

	it("preserves two interleaved tool inputs for scheduler execution", async () => {
		const { collect } = await harness();
		const events = await collect([
			{ type: "response.output_item.added", item: { type: "function_call", id: "f1", call_id: "c1", name: "read" } },
			{ type: "response.output_item.added", item: { type: "function_call", id: "f2", call_id: "c2", name: "read" } },
			{ type: "response.function_call_arguments.delta", item_id: "f1", delta: '{"path":"a"}' },
			{ type: "response.function_call_arguments.delta", item_id: "f2", delta: '{"path":"b"}' },
			{ type: "response.output_item.done", item: { type: "function_call", id: "f1", call_id: "c1", name: "read", arguments: '{"path":"a"}' } },
			{ type: "response.output_item.done", item: { type: "function_call", id: "f2", call_id: "c2", name: "read", arguments: '{"path":"b"}' } },
		]);
		expect(events.flatMap(event => event.type === "tool-call-done" ? [event.toolCall] : [])).toEqual([
			{ id: "c1", name: "read", arguments: '{"path":"a"}' },
			{ id: "c2", name: "read", arguments: '{"path":"b"}' },
		]);
	});
});
