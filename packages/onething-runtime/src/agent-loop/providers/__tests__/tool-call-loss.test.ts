import { describe, expect, it } from "vitest";
import type {
	AgentTurnRequest,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import { createCodexAgentProvider } from "../../../providers/vendors/codex/agent-provider.js";
import { createDeepSeekAgentProvider } from "../../../providers/vendors/deepseek/agent-provider.js";
import { createOpenAICompatibleAgentProvider } from "../openai-compatible.js";

function sseResponse(dataLines: string[]): Response {
	return new Response(
		[...dataLines.map((line) => `data: ${line}`), "data: [DONE]", ""].join(
			"\n\n",
		),
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

async function collect(
	events: AsyncIterable<AgentTurnStreamEvent>,
): Promise<AgentTurnStreamEvent[]> {
	const collected: AgentTurnStreamEvent[] = [];
	for await (const event of events) collected.push(event);
	return collected;
}

const baseRequest = {
	turn: 1,
	model: "test-model",
	messages: [{ role: "user" as const, content: "do something" }],
} as AgentTurnRequest;

function doneEvents(events: AgentTurnStreamEvent[]) {
	return events.filter(
		(event): event is Extract<AgentTurnStreamEvent, { type: "tool-call-done" }> =>
			event.type === "tool-call-done",
	);
}

function finishEvent(events: AgentTurnStreamEvent[]) {
	const finish = events.find(
		(event): event is Extract<AgentTurnStreamEvent, { type: "finish" }> =>
			event.type === "finish",
	);
	if (!finish) throw new Error("no finish event emitted");
	return finish;
}

describe("codex tool-call loss on interrupted streams", () => {
	function codexProvider(dataLines: string[]) {
		return createCodexAgentProvider({
			oauthToken: { accessToken: "test-token" } as never,
			fetchImpl: async () => sseResponse(dataLines),
		});
	}

	it("flushes an accumulated tool call when the stream ends without output_item.done", async () => {
		const provider = codexProvider([
			JSON.stringify({
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "item_1",
					call_id: "call_1",
					name: "bash",
				},
			}),
			JSON.stringify({
				type: "response.function_call_arguments.delta",
				item_id: "item_1",
				delta: '{"command":"ls"}',
			}),
			// Stream cut: no output_item.done, no response.completed.
		]);

		const events = await collect(provider.streamTurn!(baseRequest));
		const dones = doneEvents(events);
		expect(dones).toHaveLength(1);
		expect(dones[0].toolCall).toEqual({
			id: "call_1",
			name: "bash",
			arguments: '{"command":"ls"}',
		});
		expect(finishEvent(events).finishReason).toBe("tool_calls");
	});

	it("never reports tool_calls when zero tool calls were emitted", async () => {
		const provider = codexProvider([
			JSON.stringify({ type: "response.output_text.delta", delta: "hello" }),
			JSON.stringify({ type: "response.completed", response: {} }),
		]);

		const events = await collect(provider.streamTurn!(baseRequest));
		expect(doneEvents(events)).toHaveLength(0);
		expect(finishEvent(events).finishReason).toBe("stop");
	});

	it("maps underscore incomplete reasons (max_output_tokens) to length", async () => {
		const provider = codexProvider([
			JSON.stringify({ type: "response.output_text.delta", delta: "partial" }),
			JSON.stringify({
				type: "response.incomplete",
				response: { incomplete_details: { reason: "max_output_tokens" } },
			}),
		]);

		const events = await collect(provider.streamTurn!(baseRequest));
		expect(finishEvent(events).finishReason).toBe("length");
	});
});

describe("openai-compatible early-done removal", () => {
	function chunk(toolCallDelta: Record<string, unknown>): string {
		return JSON.stringify({
			choices: [{ delta: { tool_calls: [toolCallDelta] } }],
		});
	}

	it("emits a single done with the full accumulated arguments, not the first parseable prefix", async () => {
		const provider = createOpenAICompatibleAgentProvider({
			providerId: "test-gateway",
			apiKey: "test",
			defaultBaseUrl: "https://example.invalid/v1",
			supportsTools: true,
			fetchImpl: async () =>
				sseResponse([
					chunk({
						index: 0,
						id: "call_1",
						function: { name: "read", arguments: "{}" },
					}),
					chunk({ index: 0, function: { arguments: '{"path":"a"}' } }),
					JSON.stringify({
						choices: [{ delta: {}, finish_reason: "tool_calls" }],
					}),
				]),
		});

		const events = await collect(provider.streamTurn!(baseRequest));
		const dones = doneEvents(events);
		expect(dones).toHaveLength(1);
		// The `{}` prefix alone must not finalize the call: all later deltas
		// belong to the same accumulated argument payload.
		expect(dones[0].toolCall.arguments).toBe('{}{"path":"a"}');
	});
});

describe("deepseek early-done removal", () => {
	it("emits a single done with the full accumulated arguments, not the first parseable prefix", async () => {
		const provider = createDeepSeekAgentProvider({
			apiKey: "test",
			fetchImpl: async () =>
				sseResponse([
					JSON.stringify({
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											function: { name: "read", arguments: "{}" },
										},
									],
								},
							},
						],
					}),
					JSON.stringify({
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, function: { arguments: '{"path":"a"}' } },
									],
								},
							},
						],
					}),
					JSON.stringify({
						choices: [{ delta: {}, finish_reason: "tool_calls" }],
					}),
				]),
		});

		const events = await collect(provider.streamTurn!(baseRequest));
		const dones = doneEvents(events);
		expect(dones).toHaveLength(1);
		expect(dones[0].toolCall.arguments).toBe('{}{"path":"a"}');
	});
});
