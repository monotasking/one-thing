/**
 * Run comparison: stable-flip regression detection, sentinel pass^k gate,
 * and baseline selection (invalid / aborted / ablation entries must never
 * become baselines).
 */

import { describe, it, expect } from "vitest";
import {
	compareRunEntries,
	findBaselineEntry,
	isComparableEntry,
} from "../compare.js";
import type { EvalRunResultEntry } from "../runner.js";

function entry(over: Partial<EvalRunResultEntry>): EvalRunResultEntry {
	return {
		ts: "2026-07-12T00:00:00.000Z",
		promptVersion: "aaaa0000",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		runs: 5,
		evalSetSize: 3,
		scores: {},
		mean: 0,
		...over,
	};
}

describe("compareRunEntries", () => {
	it("reports stable flips and ignores noise-level movement", () => {
		const baseline = entry({
			scores: { a: 1, b: 0.8, c: 0, d: 0.6 },
			mean: 0.6,
		});
		const current = entry({
			ts: "2026-07-12T01:00:00.000Z",
			promptVersion: "bbbb1111",
			scores: { a: 0, b: 0.6, c: 1, d: 0.4 },
			mean: 0.5,
		});
		const cmp = compareRunEntries(current, baseline);
		expect(cmp.regressions).toEqual([{ caseId: "a", from: 1, to: 0 }]);
		expect(cmp.improvements).toEqual([{ caseId: "c", from: 0, to: 1 }]);
		expect(cmp.verdict).toBe("regressions");
		expect(cmp.meanDelta).toBe(-0.1);
	});

	it("tracks new and removed cases without calling them regressions", () => {
		const baseline = entry({ scores: { a: 1, old: 1 } });
		const current = entry({ scores: { a: 1, fresh: 0 } });
		const cmp = compareRunEntries(current, baseline);
		expect(cmp.newCases).toEqual(["fresh"]);
		expect(cmp.removedCases).toEqual(["old"]);
		expect(cmp.regressions).toEqual([]);
		expect(cmp.verdict).toBe("pass");
	});

	it("gates on sentinel strict pass^k over everything else", () => {
		const baseline = entry({ scores: { a: 1 } });
		const current = entry({
			scores: { a: 1 },
			sentinelScores: { guard: 0.8 },
			sentinelStrict: { guard: false },
		});
		expect(compareRunEntries(current, baseline).verdict).toBe(
			"sentinel-violation",
		);
	});

	it("falls back to sentinel score < 1 for pre-strict entries", () => {
		const current = entry({
			scores: { a: 1 },
			sentinelScores: { guard: 0.8 },
		});
		expect(compareRunEntries(current, entry({ scores: { a: 1 } })).verdict).toBe(
			"sentinel-violation",
		);
	});
});

describe("findBaselineEntry", () => {
	const current = entry({ ts: "2026-07-12T10:00:00.000Z" });

	it("skips invalid, aborted, and ablation entries", () => {
		const candidates = [
			entry({ ts: "2026-07-12T09:00:00.000Z", invalid: true }),
			entry({ ts: "2026-07-12T08:00:00.000Z", aborted: true }),
			entry({ ts: "2026-07-12T07:00:00.000Z", disabled: ["voice"] }),
			entry({ ts: "2026-07-12T06:00:00.000Z", promptVersion: "good0001" }),
		];
		expect(findBaselineEntry(candidates, current)?.promptVersion).toBe(
			"good0001",
		);
		expect(isComparableEntry(candidates[0])).toBe(false);
		expect(isComparableEntry(candidates[3])).toBe(true);
	});

	it("prefers the same provider+model binding", () => {
		const candidates = [
			entry({
				ts: "2026-07-12T09:00:00.000Z",
				provider: "claude",
				model: "claude-sonnet-5",
				promptVersion: "other001",
			}),
			entry({ ts: "2026-07-12T08:00:00.000Z", promptVersion: "same0001" }),
		];
		expect(findBaselineEntry(candidates, current)?.promptVersion).toBe(
			"same0001",
		);
	});

	it("returns null when nothing precedes the current run", () => {
		expect(
			findBaselineEntry([entry({ ts: "2026-07-13T00:00:00.000Z" })], current),
		).toBeNull();
	});
});
