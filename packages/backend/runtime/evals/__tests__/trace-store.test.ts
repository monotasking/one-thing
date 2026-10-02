/**
 * L1 per-round trace store tests: prefix-delta storage & hydration,
 * fallback to full storage on history rewrite, broken-chain best effort,
 * and ring pruning.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	createTurnTraceRecorder,
	readTraceRounds,
	readTraceRoundsFromDir,
	getTurnTraceDir,
	pruneTraceRing,
	type TraceRoundRecord,
} from "../trace-store.js";

let tmpDir: string;
let storeOptions: { storePath: string };

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-trace-"));
	storeOptions = { storePath: tmpDir };
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEvent(turn: number, messages: unknown[], toolCall = true) {
	return {
		turn,
		request: {
			model: "deepseek-v4-pro",
			messages,
			tools: [{ name: "bash", description: "run", parameters: {} }],
			temperature: 0.7,
		},
		response: {
			message: toolCall
				? { role: "assistant", content: "", toolCalls: [{ name: "bash" }] }
				: { role: "assistant", content: "done" },
			finishReason: toolCall ? "tool-calls" : "stop",
		},
		toolResultMessages: toolCall
			? [{ role: "tool", content: "ok", toolCallId: "tc-1" }]
			: [],
	};
}

describe("turn trace recorder (delta storage)", () => {
	it("stores round 1 full, later rounds as prefix deltas", async () => {
		const recorder = createTurnTraceRecorder({
			sessionId: "s1",
			turnId: "t1",
			storeOptions,
		});
		const base = [
			{ role: "system", content: "You are a bot." },
			{ role: "user", content: "hi" },
		];
		recorder.record(makeEvent(1, base));
		const round2Messages = [
			...base,
			{ role: "assistant", content: "", toolCalls: [{ name: "bash" }] },
			{ role: "tool", content: "ok", toolCallId: "tc-1" },
		];
		recorder.record(makeEvent(2, round2Messages, false));
		await recorder.flush();

		const dir = getTurnTraceDir("s1", "t1", storeOptions);
		const raw1: TraceRoundRecord = JSON.parse(
			fs.readFileSync(path.join(dir, "round-1.json"), "utf-8"),
		);
		const raw2: TraceRoundRecord = JSON.parse(
			fs.readFileSync(path.join(dir, "round-2.json"), "utf-8"),
		);
		expect(raw1.request.messages).toHaveLength(2);
		expect(raw1.request.messagesDelta).toBeUndefined();
		expect(raw2.request.messages).toBeUndefined();
		expect(raw2.request.messagesDelta?.baseCount).toBe(2);
		expect(raw2.request.messagesDelta?.appended).toHaveLength(2);
	});

	it("hydrates deltas back to the full per-round request", async () => {
		const recorder = createTurnTraceRecorder({
			sessionId: "s1",
			turnId: "t1",
			storeOptions,
		});
		const base = [{ role: "user", content: "hi" }];
		recorder.record(makeEvent(1, base));
		recorder.record(
			makeEvent(2, [...base, { role: "tool", content: "ok" }], false),
		);
		await recorder.flush();

		const rounds = readTraceRounds("s1", "t1", storeOptions);
		expect(rounds).toHaveLength(2);
		expect(rounds[0].request.messages).toHaveLength(1);
		expect(rounds[1].request.messages).toHaveLength(2);
		expect(rounds[1].incomplete).toBeUndefined();
		expect(rounds[0].response.finishReason).toBe("tool-calls");
		expect(rounds[1].response.finishReason).toBe("stop");
	});

	it("snapshots at observation time — later mutation of the live array is invisible", async () => {
		const recorder = createTurnTraceRecorder({
			sessionId: "s1",
			turnId: "t1",
			storeOptions,
		});
		const live: Array<{ role: string; content: string }> = [
			{ role: "user", content: "hi" },
		];
		recorder.record(makeEvent(1, live));
		live.push({ role: "assistant", content: "mutated after record" });
		live[0].content = "rewritten";
		await recorder.flush();

		const rounds = readTraceRounds("s1", "t1", storeOptions);
		expect(rounds[0].request.messages).toEqual([
			{ role: "user", content: "hi" },
		]);
	});

	it("falls back to full storage when history is rewritten mid-loop", async () => {
		const recorder = createTurnTraceRecorder({
			sessionId: "s1",
			turnId: "t1",
			storeOptions,
		});
		recorder.record(
			makeEvent(1, [
				{ role: "user", content: "hi" },
				{ role: "user", content: "again" },
			]),
		);
		// Compaction-style rewrite: shorter, different messages
		recorder.record(makeEvent(2, [{ role: "user", content: "summary" }], false));
		await recorder.flush();

		const dir = getTurnTraceDir("s1", "t1", storeOptions);
		const raw2: TraceRoundRecord = JSON.parse(
			fs.readFileSync(path.join(dir, "round-2.json"), "utf-8"),
		);
		expect(raw2.request.messages).toHaveLength(1);
		expect(raw2.request.messagesDelta).toBeUndefined();

		const rounds = readTraceRounds("s1", "t1", storeOptions);
		expect(rounds[1].request.messages).toEqual([
			{ role: "user", content: "summary" },
		]);
		expect(rounds[1].incomplete).toBeUndefined();
	});

	it("marks rounds incomplete when the delta chain is broken", async () => {
		const recorder = createTurnTraceRecorder({
			sessionId: "s1",
			turnId: "t1",
			storeOptions,
		});
		const base = [{ role: "user", content: "hi" }];
		recorder.record(makeEvent(1, base));
		recorder.record(
			makeEvent(2, [...base, { role: "tool", content: "ok" }], false),
		);
		await recorder.flush();

		// Simulate ring/corruption loss of round 1
		const dir = getTurnTraceDir("s1", "t1", storeOptions);
		fs.rmSync(path.join(dir, "round-1.json"));

		const rounds = readTraceRoundsFromDir(dir);
		expect(rounds).toHaveLength(1);
		expect(rounds[0].round).toBe(2);
		expect(rounds[0].incomplete).toBe(true);
		// Best effort: only the appended tail is recoverable
		expect(rounds[0].request.messages).toEqual([
			{ role: "tool", content: "ok" },
		]);
	});

	it("records request params and tools alongside messages", async () => {
		const recorder = createTurnTraceRecorder({
			sessionId: "s1",
			turnId: "t1",
			storeOptions,
		});
		recorder.record(makeEvent(1, [{ role: "user", content: "hi" }]));
		await recorder.flush();

		const rounds = readTraceRounds("s1", "t1", storeOptions);
		expect(rounds[0].request.model).toBe("deepseek-v4-pro");
		expect(rounds[0].request.temperature).toBe(0.7);
		expect(rounds[0].request.tools?.map((t) => t.name)).toEqual(["bash"]);
		expect(rounds[0].toolResultMessages).toHaveLength(1);
	});
});

describe("trace ring pruning", () => {
	it("removes oldest turn dirs beyond maxTurnDirs", async () => {
		for (let i = 0; i < 5; i++) {
			const recorder = createTurnTraceRecorder({
				sessionId: "s1",
				turnId: `t${i}`,
				storeOptions,
			});
			recorder.record(makeEvent(1, [{ role: "user", content: `msg ${i}` }]));
			await recorder.flush();
			// Distinct mtimes for deterministic recency ordering
			const dir = getTurnTraceDir("s1", `t${i}`, storeOptions);
			const when = new Date(Date.now() - (5 - i) * 60_000);
			fs.utimesSync(path.join(dir, "round-1.json"), when, when);
		}

		pruneTraceRing(2, storeOptions);

		const kept = [0, 1, 2, 3, 4].filter((i) =>
			fs.existsSync(getTurnTraceDir("s1", `t${i}`, storeOptions)),
		);
		expect(kept).toEqual([3, 4]);
	});
});
