/**
 * Section sensitivity audit: disabling a guarded section must flip its
 * cases; sections nothing reacts to must be reported as unguarded (the
 * uncovered prompt surface).
 */

import { describe, it, expect } from "vitest";
import { runSensitivityAudit } from "../sensitivity.js";
import type { runEvals, EvalRunOptions, EvalRunResultEntry } from "../runner.js";

function entryWith(scores: Record<string, number>): EvalRunResultEntry {
	return {
		ts: new Date().toISOString(),
		promptVersion: "test0000",
		provider: "sensitivity-audit",
		runs: 2,
		evalSetSize: Object.keys(scores).length,
		scores,
		mean:
			Object.values(scores).reduce((a, b) => a + b, 0) /
			Math.max(Object.keys(scores).length, 1),
	};
}

/** Fake runner: case "dir-case" fails when "directory" is disabled;
 * nothing reacts to "decoration". */
const fakeRunEvals: typeof runEvals = async (options: EvalRunOptions) => {
	const disabled = options.disabledSections ?? [];
	return entryWith({
		"dir-case": disabled.includes("directory") ? 0 : 1,
		"other-case": 1,
	});
};

describe("runSensitivityAudit", () => {
	it("separates guarded from unguarded sections", async () => {
		const report = await runSensitivityAudit({
			repoDir: "/unused",
			callModel: async () => {
				throw new Error("must not be called with injected runner");
			},
			sections: ["directory", "decoration"],
			runsPerSection: 2,
			runEvalsFn: fakeRunEvals,
		});

		const dir = report.sections.find((s) => s.section === "directory")!;
		expect(dir.guarded).toBe(true);
		expect(dir.flippedCases).toEqual(["dir-case"]);
		expect(dir.maxScoreDelta).toBe(1);

		const deco = report.sections.find((s) => s.section === "decoration")!;
		expect(deco.guarded).toBe(false);
		expect(deco.flippedCases).toEqual([]);

		expect(report.unguardedSections).toEqual(["decoration"]);
		expect(report.baselineMean).toBe(1);
	});

	it("streams progress per section", async () => {
		const events: string[] = [];
		await runSensitivityAudit({
			repoDir: "/unused",
			callModel: async () => {
				throw new Error("unused");
			},
			sections: ["directory"],
			runEvalsFn: fakeRunEvals,
			onProgress: (e) => events.push(e.type),
		});
		expect(events).toEqual([
			"baseline-start",
			"baseline-done",
			"section-start",
			"section-done",
		]);
	});
});
