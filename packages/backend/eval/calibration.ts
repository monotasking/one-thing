/**
 * Judge calibration (design Phase 3, hard prerequisite).
 *
 * The global judge's scores are noise until proven otherwise: this module
 * measures judge-vs-human agreement on an annotated sample set and gates
 * activation at the design threshold (>=85% agreement over >=20 samples).
 * Run it after any judge-prompt change and re-run monthly (Phase 5).
 *
 * The annotation set lives in the evals repo as JSONL — one line per
 * annotated turn: {"turnId": "...", "label": "good"|"bad", "category":
 * "optional-expected-category", "note": "optional"}.
 */

import type { JudgeInput, JudgeResult } from "./judge.js";

export const CALIBRATION_MIN_SAMPLES = 20;
export const CALIBRATION_AGREEMENT_THRESHOLD = 0.85;
/** Judge score below this counts as the judge saying "bad". */
export const CALIBRATION_SCORE_CUTOFF = 0.5;

export interface CalibrationAnnotation {
	turnId: string;
	label: "good" | "bad";
	/** Expected failure category (only meaningful for label "bad"). */
	category?: string;
	note?: string;
}

/** One judgeable sample: the annotation plus the turn's content. */
export interface CalibrationSample {
	annotation: CalibrationAnnotation;
	input: JudgeInput;
}

export interface CalibrationSampleOutcome {
	turnId: string;
	humanLabel: "good" | "bad";
	judgeScore: number | null;
	judgeCategory: string | null;
	/** Judge and human agree on good/bad. */
	agree: boolean;
	/** For agreed-bad samples with an expected category: category also matches. */
	categoryMatch?: boolean;
	error?: string;
}

export interface CalibrationOutcome {
	total: number;
	/** Samples the judge produced a parseable verdict for. */
	judged: number;
	/** good/bad agreement over judged samples. */
	agreement: number;
	/** Category agreement over agreed-bad samples that carry an expected category. */
	categoryAgreement: number | null;
	threshold: number;
	minSamples: number;
	/** True only when judged >= minSamples AND agreement >= threshold —
	 * the judge may be switched on for online sampling. */
	pass: boolean;
	/** Human-readable blocker when pass is false. */
	blocker?: string;
	samples: CalibrationSampleOutcome[];
}

/** Parse the annotation JSONL (bad lines skipped). */
export function parseAnnotationsJsonl(
	content: string,
): CalibrationAnnotation[] {
	const out: CalibrationAnnotation[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (
				typeof parsed?.turnId === "string" &&
				(parsed.label === "good" || parsed.label === "bad")
			) {
				out.push({
					turnId: parsed.turnId,
					label: parsed.label,
					category:
						typeof parsed.category === "string" ? parsed.category : undefined,
					note: typeof parsed.note === "string" ? parsed.note : undefined,
				});
			}
		} catch {
			// Skip bad lines
		}
	}
	return out;
}

/**
 * Run the judge over the annotated samples and compute agreement.
 * `callJudge` is injected (same pattern as the runner's callModel): it runs
 * buildJudgePrompt/buildJudgeUserMessage against whatever model the caller
 * configures and returns the parsed result, or null when unparseable.
 */
export async function runJudgeCalibration(options: {
	samples: CalibrationSample[];
	callJudge: (input: JudgeInput) => Promise<JudgeResult | null>;
	threshold?: number;
	minSamples?: number;
	scoreCutoff?: number;
	signal?: AbortSignal;
	onSample?: (outcome: CalibrationSampleOutcome) => void;
}): Promise<CalibrationOutcome> {
	const threshold = options.threshold ?? CALIBRATION_AGREEMENT_THRESHOLD;
	const minSamples = options.minSamples ?? CALIBRATION_MIN_SAMPLES;
	const cutoff = options.scoreCutoff ?? CALIBRATION_SCORE_CUTOFF;

	const samples: CalibrationSampleOutcome[] = [];
	for (const sample of options.samples) {
		if (options.signal?.aborted) break;
		const base = {
			turnId: sample.annotation.turnId,
			humanLabel: sample.annotation.label,
		};
		let outcome: CalibrationSampleOutcome;
		try {
			const result = await options.callJudge(sample.input);
			if (!result) {
				outcome = {
					...base,
					judgeScore: null,
					judgeCategory: null,
					agree: false,
					error: "unparseable judge output",
				};
			} else {
				const judgeSaysBad = result.score < cutoff;
				const humanSaysBad = sample.annotation.label === "bad";
				const agree = judgeSaysBad === humanSaysBad;
				outcome = {
					...base,
					judgeScore: result.score,
					judgeCategory: result.category,
					agree,
					...(agree && humanSaysBad && sample.annotation.category
						? { categoryMatch: result.category === sample.annotation.category }
						: {}),
				};
			}
		} catch (error) {
			outcome = {
				...base,
				judgeScore: null,
				judgeCategory: null,
				agree: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		samples.push(outcome);
		options.onSample?.(outcome);
	}

	const judged = samples.filter((s) => s.judgeScore !== null);
	const agreement =
		judged.length > 0
			? judged.filter((s) => s.agree).length / judged.length
			: 0;
	const withCategory = samples.filter((s) => s.categoryMatch !== undefined);
	const categoryAgreement =
		withCategory.length > 0
			? withCategory.filter((s) => s.categoryMatch).length / withCategory.length
			: null;

	const enoughSamples = judged.length >= minSamples;
	const meetsThreshold = agreement >= threshold;
	const pass = enoughSamples && meetsThreshold;

	return {
		total: samples.length,
		judged: judged.length,
		agreement: Math.round(agreement * 1000) / 1000,
		categoryAgreement:
			categoryAgreement === null
				? null
				: Math.round(categoryAgreement * 1000) / 1000,
		threshold,
		minSamples,
		pass,
		blocker: pass
			? undefined
			: !enoughSamples
				? `only ${judged.length}/${minSamples} judged samples — annotate more turns`
				: `agreement ${Math.round(agreement * 100)}% < ${Math.round(threshold * 100)}% — revise the judge prompt and re-run`,
		samples,
	};
}

/** Render a calibration outcome as markdown. */
export function renderCalibrationMarkdown(o: CalibrationOutcome): string {
	const lines = [
		`## Judge calibration — ${o.pass ? "PASS" : "BLOCKED"}`,
		`- agreement: ${Math.round(o.agreement * 100)}% (threshold ${Math.round(o.threshold * 100)}%) over ${o.judged}/${o.total} judged samples`,
	];
	if (o.categoryAgreement !== null) {
		lines.push(
			`- category agreement (agreed-bad): ${Math.round(o.categoryAgreement * 100)}%`,
		);
	}
	if (o.blocker) lines.push(`- blocker: ${o.blocker}`);
	const disagreements = o.samples.filter((s) => !s.agree);
	if (disagreements.length) {
		lines.push("", "Disagreements:");
		for (const d of disagreements) {
			lines.push(
				`- ${d.turnId}: human=${d.humanLabel}, judge=${d.judgeScore ?? "?"} ${d.judgeCategory ?? ""}${d.error ? ` (${d.error})` : ""}`,
			);
		}
	}
	return lines.join("\n");
}
