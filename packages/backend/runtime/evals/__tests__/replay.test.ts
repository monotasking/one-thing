/**
 * Replay engine tests (workbench W2): full agent loop with mocked tools,
 * recorded-playback matching, stub fallback, context tool-protocol mapping,
 * and rubric judging.
 */

import { describe, it, expect } from "vitest";
import { runReplay, contextToEvalMessages, type ReplayScene } from "../replay.js";
import { argsSimilarity, createMockToolResolver } from "../mock-tools.js";
import type { EvalModelCaller, EvalModelResponse } from "../model-call.js";

function scene(overrides: Partial<ReplayScene> = {}): ReplayScene {
	return {
		fixtureContext: {
			workingDirectory: "/repo",
			skills: [],
			toolNames: ["edit"],
			hasTools: true,
			platform: "darwin",
		},
		tools: [
			{
				type: "function",
				function: {
					name: "edit",
					description: "Edit a file",
					parameters: { type: "object", properties: { path: {} } },
				},
			},
		],
		params: { provider: "eval", model: "mock-model", temperature: 0 },
		contextMessages: [],
		trace: [
			{
				content: "editing",
				toolCalls: [
					{
						name: "edit",
						args: { path: "/repo/config.ts", old: "10s" },
						result: "edited: timeout set to 30s",
						status: "completed",
					},
				],
			},
		],
		userMessage: "把超时改成 30 秒",
		...overrides,
	};
}

/** Scripted caller: first turn calls the tool, second turn answers. */
function scriptedCaller(script: EvalModelResponse[]): EvalModelCaller {
	let i = 0;
	return async () => script[Math.min(i++, script.length - 1)];
}

describe("runReplay", () => {
	it("runs the agent loop with recorded tool playback", async () => {
		const result = await runReplay({
			scene: scene(),
			callModel: scriptedCaller([
				{
					content: "",
					toolCalls: [
						{
							id: "tc1",
							name: "edit",
							args: { path: "/repo/config.ts", old: "10s" },
						},
					],
					finishReason: "tool_calls",
				},
				{ content: "已把超时改成 30 秒", toolCalls: [], finishReason: "stop" },
			]),
			header: { runId: "r1", attempt: 1, model: "mock-model" },
		});

		expect(result.rounds).toBe(2);
		expect(result.finalContent).toBe("已把超时改成 30 秒");
		// The recorded REAL result was played back, not fabricated
		expect(result.mockStats).toEqual({ recorded: 1, simulated: 0, stub: 0 });
		const toolEvent = result.transcript.events.find(
			(e) => e.t === "tool-result",
		);
		expect(toolEvent).toMatchObject({
			source: "recorded",
			result: "edited: timeout set to 30s",
		});
	});

	it("falls back to stub for unmatched tool calls and marks the source", async () => {
		const result = await runReplay({
			scene: scene({ trace: [] }),
			callModel: scriptedCaller([
				{
					content: "",
					toolCalls: [{ id: "tc1", name: "edit", args: { path: "/other" } }],
					finishReason: "tool_calls",
				},
				{ content: "done", toolCalls: [], finishReason: "stop" },
			]),
			header: { runId: "r2", attempt: 1, model: "mock-model" },
		});

		expect(result.mockStats.stub).toBe(1);
		const toolEvent = result.transcript.events.find(
			(e) => e.t === "tool-result",
		);
		expect(toolEvent).toMatchObject({ source: "stub" });
	});

	it("caps rounds to prevent infinite tool loops", async () => {
		const result = await runReplay({
			scene: scene(),
			callModel: scriptedCaller([
				{
					content: "",
					toolCalls: [{ id: "x", name: "edit", args: {} }],
					finishReason: "tool_calls",
				},
			]),
			maxRounds: 3,
			header: { runId: "r3", attempt: 1, model: "mock-model" },
		});
		expect(result.rounds).toBe(3);
	});

	it("judges the outcome against the rubric", async () => {
		const result = await runReplay({
			scene: scene(),
			callModel: scriptedCaller([
				{ content: "先切换到目标目录再修改", toolCalls: [], finishReason: "stop" },
			]),
			rubric: "应该先切到目标目录",
			judgeModel: {
				model: "judge-model",
				callModel: async () => ({
					content: '{"pass": true, "reason": "行为符合期望"}',
					toolCalls: [],
					finishReason: "stop",
				}),
			},
			header: { runId: "r4", attempt: 1, model: "mock-model" },
		});

		expect(result.verdict).toEqual({ pass: true, reason: "行为符合期望" });
		expect(
			result.transcript.events.some((e) => e.t === "judge" && e.pass),
		).toBe(true);
	});
});

describe("contextToEvalMessages", () => {
	it("preserves the tool-calling protocol and trims dangling tails", () => {
		const messages = contextToEvalMessages([
			{ role: "user", content: "改超时" },
			{
				role: "assistant",
				content: "",
				toolCalls: [{ toolCallId: "a", toolName: "edit", args: { p: 1 } }],
			},
			{
				role: "tool",
				content: [{ type: "tool-result", toolCallId: "a", toolName: "edit", result: "ok" }],
			},
			{ role: "user", content: "不对,是另一个项目" },
			// Dangling tail that must be trimmed:
			{
				role: "assistant",
				content: "",
				toolCalls: [{ toolCallId: "b", toolName: "edit", args: {} }],
			},
		] as never);

		expect(messages[1].toolCalls?.[0]).toMatchObject({
			id: "a",
			name: "edit",
		});
		expect(messages[2]).toMatchObject({ role: "tool", toolCallId: "a" });
		expect(messages[messages.length - 1]).toMatchObject({
			role: "user",
			content: "不对,是另一个项目",
		});
	});
});

describe("argsSimilarity / resolver matching", () => {
	it("matches near-identical args and rejects different files", async () => {
		expect(
			argsSimilarity({ path: "/repo/a.ts", old: "x" }, { path: "/repo/a.ts", old: "x" }),
		).toBe(1);

		const resolver = createMockToolResolver({
			trace: [
				{
					content: "",
					toolCalls: [
						{ name: "read", args: { path: "/repo/src/index.ts" }, result: "file A content" },
					],
				},
			],
		});
		const hit = await resolver.resolve("read", { path: "/repo/src/index.ts" });
		expect(hit.source).toBe("recorded");
		const miss = await resolver.resolve("read", { path: "/completely/else.md" });
		expect(miss.source).toBe("stub");
	});
});
