/**
 * Single-round replay tests: traced-message → eval-message mapping keeps
 * the tool protocol intact, and replayRound resends verbatim / edited.
 */

import { describe, it, expect, vi } from "vitest";
import {
	tracedMessagesToEvalMessages,
	replayRound,
} from "../round-replay.js";
import type { HydratedTraceRound } from "../trace-store.js";
import type { EvalModelCaller } from "../model-call.js";

describe("tracedMessagesToEvalMessages", () => {
	it("preserves the full tool-calling protocol", () => {
		const out = tracedMessagesToEvalMessages([
			{ role: "system", content: "You are a bot." },
			{ role: "user", content: "run ls" },
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: "tc-1", name: "bash", arguments: { cmd: "ls" } }],
			},
			{ role: "tool", toolCallId: "tc-1", content: "file.txt" },
			{ role: "assistant", content: "done" },
		]);
		expect(out.map((m) => m.role)).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
		const assistant = out[2] as { toolCalls?: Array<Record<string, string>> };
		expect(assistant.toolCalls?.[0]).toMatchObject({
			id: "tc-1",
			name: "bash",
		});
		expect(JSON.parse(assistant.toolCalls![0].argsJson)).toEqual({
			cmd: "ls",
		});
		expect(out[3]).toMatchObject({ role: "tool", toolCallId: "tc-1" });
	});

	it("maps developer role to system and flattens content parts", () => {
		const out = tracedMessagesToEvalMessages([
			{ role: "developer", content: "rules" },
			{
				role: "user",
				content: [
					{ type: "text", text: "look at this" },
					{ type: "image", data: "..." },
				],
			},
		]);
		expect(out[0]).toEqual({ role: "system", content: "rules" });
		expect(out[1].content).toContain("look at this");
		expect(out[1].content).toContain("[image content]");
	});

	it("skips role-less entries and synthesizes missing tool-call ids", () => {
		const out = tracedMessagesToEvalMessages([
			{ content: "garbage" },
			{
				role: "assistant",
				content: "",
				toolCalls: [{ name: "bash", arguments: {} }],
			},
			{ role: "tool", content: "ok" },
		]);
		expect(out).toHaveLength(2);
		const assistant = out[0] as { toolCalls?: Array<{ id: string }> };
		const tool = out[1] as { toolCallId?: string };
		expect(assistant.toolCalls?.[0].id).toBeTruthy();
		// The tool result inherits the last synthesized id (adjacent pair)
		expect(tool.toolCallId).toBe(assistant.toolCalls?.[0].id);
	});
});

function makeRound(): HydratedTraceRound {
	return {
		round: 2,
		ts: "2026-07-10T00:00:00.000Z",
		purpose: "chat",
		request: {
			model: "deepseek-v4-pro",
			messages: [
				{ role: "system", content: "You are a bot." },
				{ role: "user", content: "hi" },
			],
			tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
			temperature: 0.7,
		},
		response: {
			message: { role: "assistant", content: "hello" },
			finishReason: "stop",
		},
		toolResultMessages: [],
	};
}

describe("replayRound", () => {
	it("resends the recorded request verbatim, k times", async () => {
		const callModel = vi.fn<EvalModelCaller>().mockResolvedValue({
			content: "hello again",
			toolCalls: [],
			finishReason: "stop",
		});
		const result = await replayRound({
			roundData: makeRound(),
			callModel,
			runs: 3,
		});
		expect(result.attempts).toHaveLength(3);
		expect(result.edited).toBe(false);
		const call = callModel.mock.calls[0][0];
		expect(call.model).toBe("deepseek-v4-pro");
		expect(call.temperature).toBe(0.7);
		expect(call.messages).toHaveLength(2);
		expect(call.tools?.[0].name).toBe("bash");
	});

	it("uses edited messages when provided and flags the result", async () => {
		const callModel = vi.fn<EvalModelCaller>().mockResolvedValue({
			content: "",
			toolCalls: [{ id: "x", name: "bash", args: { cmd: "ls" } }],
			finishReason: "tool-calls",
		});
		const result = await replayRound({
			roundData: makeRound(),
			callModel,
			editedMessages: [
				{ role: "system", content: "You are a STRICT bot." },
				{ role: "user", content: "hi" },
			],
		});
		expect(result.edited).toBe(true);
		expect(result.attempts[0].toolCalls[0].name).toBe("bash");
		const call = callModel.mock.calls[0][0];
		expect(call.messages[0].content).toBe("You are a STRICT bot.");
	});
});
