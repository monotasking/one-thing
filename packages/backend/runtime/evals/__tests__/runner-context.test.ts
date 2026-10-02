/**
 * Tests for multi-turn replay context flattening.
 *
 * Captured .context.jsonl files contain request-view messages including
 * role:"tool" results and assistant toolCalls. Replay sends bare
 * role/content messages to OpenAI-compatible APIs, which reject tool
 * messages without tool_call_id — so the runner must flatten tool
 * interactions into a plain user/assistant transcript.
 */

import { describe, it, expect } from "vitest";
import {
	flattenContextMessages,
	type RawContextMessage,
} from "../runner.js";

describe("flattenContextMessages", () => {
	it("passes through plain user/assistant messages", () => {
		const input: RawContextMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		];
		expect(flattenContextMessages(input)).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		]);
	});

	it("renders assistant tool calls as transcript lines", () => {
		const input: RawContextMessage[] = [
			{
				role: "assistant",
				content: "",
				toolCalls: [
					{ toolCallId: "1", toolName: "edit", args: { path: "a.ts" } },
				],
			},
		];
		const out = flattenContextMessages(input);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("assistant");
		expect(out[0].content).toContain('[tool call] edit({"path":"a.ts"})');
	});

	it("folds tool results into the preceding assistant message", () => {
		const input: RawContextMessage[] = [
			{ role: "user", content: "change the timeout" },
			{
				role: "assistant",
				content: "I'll edit the config.",
				toolCalls: [{ toolCallId: "1", toolName: "edit", args: {} }],
			},
			{ role: "tool", content: [{ type: "tool-result", toolCallId: "1", result: "ok" }] },
			{ role: "user", content: "wrong project" },
		];
		const out = flattenContextMessages(input);

		// No tool-role message survives (would 400 on OpenAI-compatible APIs)
		expect(out.every((m) => m.role === "user" || m.role === "assistant")).toBe(
			true,
		);
		expect(out).toHaveLength(3);
		expect(out[1].content).toContain("[tool call] edit");
		expect(out[1].content).toContain("[tool result]");
		expect(out[2]).toEqual({ role: "user", content: "wrong project" });
	});

	it("converts an orphan tool result to a user-role transcript line", () => {
		const input: RawContextMessage[] = [
			{ role: "tool", content: "orphan result" },
		];
		const out = flattenContextMessages(input);
		expect(out).toEqual([
			{ role: "user", content: "[tool result] orphan result" },
		]);
	});

	it("truncates oversized tool results", () => {
		const big = "x".repeat(5000);
		const input: RawContextMessage[] = [
			{ role: "assistant", content: "reading" },
			{ role: "tool", content: big },
		];
		const out = flattenContextMessages(input);
		expect(out[0].content.length).toBeLessThan(2000);
		expect(out[0].content).toContain("[truncated]");
	});

	it("preserves unexpected roles as annotated user lines", () => {
		const input: RawContextMessage[] = [
			{ role: "developer", content: "some directive" },
		];
		expect(flattenContextMessages(input)).toEqual([
			{ role: "user", content: "[developer] some directive" },
		]);
	});
});
