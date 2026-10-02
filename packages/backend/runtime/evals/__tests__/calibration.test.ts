/**
 * Judge calibration: agreement computation and the activation gate
 * (>=85% agreement over >=20 judged samples — design Phase 3 hard
 * prerequisite; the judge stays off until this passes).
 */

import { describe, it, expect } from "vitest";
import {
	runJudgeCalibration,
	parseAnnotationsJsonl,
	type CalibrationSample,
} from "../calibration.js";
import type { JudgeInput, JudgeResult } from "../judge.js";

function sample(
	turnId: string,
	label: "good" | "bad",
	category?: string,
): CalibrationSample {
	return {
		annotation: { turnId, label, category },
		input: { userMessage: `u-${turnId}`, assistantResponse: `a-${turnId}` },
	};
}

/** Judge that agrees with the human on every sample. */
function perfectJudge(
	samples: CalibrationSample[],
): (input: JudgeInput) => Promise<JudgeResult | null> {
	const byUser = new Map(
		samples.map((s) => [s.input.userMessage, s.annotation]),
	);
	return async (input) => {
		const ann = byUser.get(input.userMessage)!;
		return {
			score: ann.label === "bad" ? 0.1 : 0.9,
			category: (ann.category ?? "not-prompt-fault") as JudgeResult["category"],
			reason: "test",
		};
	};
}

describe("runJudgeCalibration", () => {
	it("passes at full agreement with enough samples", async () => {
		const samples = Array.from({ length: 20 }, (_, i) =>
			sample(`t${i}`, i % 2 ? "bad" : "good", i % 2 ? "voice-mode-violation" : undefined),
		);
		const outcome = await runJudgeCalibration({
			samples,
			callJudge: perfectJudge(samples),
		});
		expect(outcome.judged).toBe(20);
		expect(outcome.agreement).toBe(1);
		expect(outcome.categoryAgreement).toBe(1);
		expect(outcome.pass).toBe(true);
	});

	it("blocks below the sample minimum even at full agreement", async () => {
		const samples = Array.from({ length: 5 }, (_, i) => sample(`t${i}`, "good"));
		const outcome = await runJudgeCalibration({
			samples,
			callJudge: perfectJudge(samples),
		});
		expect(outcome.pass).toBe(false);
		expect(outcome.blocker).toContain("5/20");
	});

	it("blocks below the agreement threshold", async () => {
		const samples = Array.from({ length: 20 }, (_, i) => sample(`t${i}`, "bad"));
		// Judge calls everything good → 0% agreement.
		const outcome = await runJudgeCalibration({
			samples,
			callJudge: async () => ({
				score: 1,
				category: "not-prompt-fault",
				reason: "all fine",
			}),
		});
		expect(outcome.agreement).toBe(0);
		expect(outcome.pass).toBe(false);
		expect(outcome.blocker).toContain("revise the judge prompt");
	});

	it("counts unparseable and throwing judge calls as disagreement, not as judged", async () => {
		const samples = [
			sample("ok", "good"),
			sample("unparseable", "good"),
			sample("throws", "good"),
		];
		const outcome = await runJudgeCalibration({
			samples,
			callJudge: async (input) => {
				if (input.userMessage === "u-unparseable") return null;
				if (input.userMessage === "u-throws") throw new Error("boom");
				return { score: 0.9, category: "not-prompt-fault", reason: "ok" };
			},
		});
		expect(outcome.total).toBe(3);
		expect(outcome.judged).toBe(1);
		expect(outcome.samples.filter((s) => s.error)).toHaveLength(2);
	});
});

describe("parseAnnotationsJsonl", () => {
	it("parses valid lines and skips garbage", () => {
		const content = [
			'{"turnId": "a", "label": "bad", "category": "voice-mode-violation"}',
			'{"turnId": "b", "label": "good"}',
			'{"turnId": "c", "label": "meh"}',
			"not json",
			"",
		].join("\n");
		const anns = parseAnnotationsJsonl(content);
		expect(anns).toHaveLength(2);
		expect(anns[0]).toEqual({
			turnId: "a",
			label: "bad",
			category: "voice-mode-violation",
			note: undefined,
		});
	});
});
