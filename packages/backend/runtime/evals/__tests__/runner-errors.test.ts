/**
 * Runner statistical semantics:
 * - infra errors (thrown model calls) are excluded from the pass-rate
 *   denominator instead of reading as behavioral failures
 * - error-heavy runs are flagged invalid (never a baseline)
 * - sentinel cases get a strict pass^k gate alongside the score
 * - meta-runs can opt out of results.jsonl persistence
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runEvals, type EvalRunProgressEvent } from "../runner.js";
import type { EvalModelCaller } from "../model-call.js";

let repoDir: string;

beforeEach(() => {
	repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-runner-"));
	const casesDir = path.join(repoDir, "evals", "cases");
	const sentinelDir = path.join(casesDir, "sentinel");
	const fixturesDir = path.join(repoDir, "evals", "fixtures");
	fs.mkdirSync(sentinelDir, { recursive: true });
	fs.mkdirSync(fixturesDir, { recursive: true });

	fs.writeFileSync(
		path.join(fixturesDir, "f.json"),
		JSON.stringify({
			userMessage: "say ok",
			provider: "eval",
			model: "test-model",
			context: { hasTools: false, skills: [], toolNames: [] },
		}),
		"utf-8",
	);
	const caseYaml = (id: string) =>
		[
			`id: ${id}`,
			"description: test case",
			"fixture: f.json",
			'userMessage: "say ok"',
			"expect:",
			"  contains: OK",
			"",
		].join("\n");
	fs.writeFileSync(path.join(casesDir, "basic.yaml"), caseYaml("basic"), "utf-8");
	fs.writeFileSync(
		path.join(sentinelDir, "guard.yaml"),
		caseYaml("guard"),
		"utf-8",
	);
});

afterEach(() => {
	fs.rmSync(repoDir, { recursive: true, force: true });
});

const okCaller: EvalModelCaller = async () => ({
	content: "OK",
	toolCalls: [],
	finishReason: "stop",
	usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
});

describe("runEvals error semantics", () => {
	it("excludes infra errors from the pass-rate denominator and flags invalid", async () => {
		let n = 0;
		const flaky: EvalModelCaller = async () => {
			n++;
			if (n % 2 === 1) throw new Error("ECONNRESET");
			return { content: "OK", toolCalls: [], finishReason: "stop" };
		};

		const attempts: EvalRunProgressEvent[] = [];
		const entry = await runEvals({
			repoDir,
			caseIds: ["basic"],
			runs: 4,
			callModel: flaky,
			onProgress: (e) => {
				if (e.type === "attempt-done") attempts.push(e);
			},
		});

		// 2 errors + 2 passes: behavioral score is 1, not 0.5
		expect(entry.scores.basic).toBe(1);
		expect(entry.errorRate).toBe(0.5);
		expect(entry.invalid).toBe(true);
		expect(attempts).toHaveLength(4);

		// Invalid entries are still persisted (with the flag) for history
		const line = fs
			.readFileSync(path.join(repoDir, "evals", "results.jsonl"), "utf-8")
			.trim();
		expect(JSON.parse(line).invalid).toBe(true);
	});

	it("keeps a fully-judgeable clean run valid with metrics", async () => {
		const entry = await runEvals({
			repoDir,
			caseIds: ["basic"],
			runs: 2,
			callModel: okCaller,
		});
		expect(entry.scores.basic).toBe(1);
		expect(entry.errorRate).toBeUndefined();
		expect(entry.invalid).toBeUndefined();
		expect(entry.metrics?.avgOutputChars).toBe(2);
		expect(entry.metrics?.avgToolCalls).toBe(0);
		expect(entry.metrics?.avgTotalTokens).toBe(110);
	});

	it("computes sentinel strict pass^k separately from the score", async () => {
		let n = 0;
		const flakyBehavior: EvalModelCaller = async () => {
			n++;
			return {
				content: n === 1 ? "NOT WHAT YOU WANT" : "OK",
				toolCalls: [],
				finishReason: "stop",
			};
		};

		const entry = await runEvals({
			repoDir,
			caseIds: ["guard"],
			runs: 2,
			callModel: flakyBehavior,
		});
		expect(entry.sentinelScores?.guard).toBe(0.5);
		expect(entry.sentinelStrict?.guard).toBe(false);

		const clean = await runEvals({
			repoDir,
			caseIds: ["guard"],
			runs: 2,
			callModel: okCaller,
		});
		expect(clean.sentinelStrict?.guard).toBe(true);
	});

	it("skips results.jsonl when persistResults is false", async () => {
		await runEvals({
			repoDir,
			caseIds: ["basic"],
			runs: 1,
			callModel: okCaller,
			persistResults: false,
		});
		expect(fs.existsSync(path.join(repoDir, "evals", "results.jsonl"))).toBe(
			false,
		);
	});
});
