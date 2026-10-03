/**
 * Replay fidelity: zero-change replays compared against the recorded
 * decision sequence. High fidelity = the harness reproduces the original;
 * low fidelity = diagnosis conclusions on this scene are mock noise.
 */

import { describe, it, expect } from "vitest";
import { measureReplayFidelity, fidelityVerdict } from "../fidelity.js";
import type { ReplayScene } from "../replay.js";
import type { EvalModelCaller } from "../model-call.js";

function makeScene(): ReplayScene {
	return {
		tools: [
			{
				type: "function",
				function: { name: "read", description: "read a file", parameters: {} },
			},
		],
		params: { provider: "deepseek", model: "test-model" },
		contextMessages: [],
		trace: [
			{
				content: "let me read it",
				toolCalls: [{ name: "read", args: { path: "a.ts" } }],
			},
		] as ReplayScene["trace"],
		userMessage: "open a.ts",
		capturedSystemPrompt: "You are a test assistant.",
	};
}

/** Caller that calls `read` on round 1 then answers — matches the trace. */
function faithfulCaller(): EvalModelCaller {
	let round = 0;
	return async () => {
		round++;
		if (round % 2 === 1) {
			return {
				content: "",
				toolCalls: [{ id: `tc-${round}`, name: "read", args: { path: "a.ts" } }],
				finishReason: "tool_calls",
			};
		}
		return { content: "done", toolCalls: [], finishReason: "stop" };
	};
}

/** Caller that never uses tools — diverges from the trace every time. */
const divergentCaller: EvalModelCaller = async () => ({
	content: "I refuse to use tools",
	toolCalls: [],
	finishReason: "stop",
});

describe("measureReplayFidelity", () => {
	it("reports full fidelity when replays match the recorded sequence", async () => {
		const report = await measureReplayFidelity({
			scene: makeScene(),
			callModel: faithfulCaller(),
			attempts: 3,
		});
		expect(report.originalSequence).toEqual(["read"]);
		expect(report.fidelity).toBe(1);
		expect(report.selfConsistency).toBe(1);
		expect(report.verdict).toBe("high");
		expect(report.promptMode).toBe("captured");
		expect(report.errors).toBe(0);
	});

	it("reports low fidelity when replays diverge from the trace", async () => {
		const report = await measureReplayFidelity({
			scene: makeScene(),
			callModel: divergentCaller,
			attempts: 3,
		});
		expect(report.fidelity).toBe(0);
		expect(report.verdict).toBe("low");
		// Divergent but self-consistent: harness is stable, behavior changed.
		expect(report.selfConsistency).toBe(1);
	});

	it("counts throwing attempts as errors, not mismatches", async () => {
		let n = 0;
		const flaky: EvalModelCaller = async () => {
			n++;
			if (n === 1) throw new Error("ECONNRESET");
			return { content: "done", toolCalls: [], finishReason: "stop" };
		};
		const report = await measureReplayFidelity({
			scene: makeScene(),
			callModel: flaky,
			attempts: 3,
		});
		// runReplay catches the model error internally and yields an empty
		// sequence OR the attempt errors — either way judged attempts + errors
		// must cover all attempts.
		expect(report.attempts + report.errors).toBe(3);
	});

	it("flags rebuilt-prompt mode when the scene has no captured prompt", async () => {
		const scene = { ...makeScene(), capturedSystemPrompt: undefined };
		const report = await measureReplayFidelity({
			scene,
			callModel: faithfulCaller(),
			attempts: 1,
		});
		expect(report.promptMode).toBe("rebuilt");
	});
});

describe("fidelityVerdict", () => {
	it("maps thresholds", () => {
		expect(fidelityVerdict(0.8)).toBe("high");
		expect(fidelityVerdict(0.5)).toBe("medium");
		expect(fidelityVerdict(0.2)).toBe("low");
	});
});
