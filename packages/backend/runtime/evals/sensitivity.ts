/**
 * Section sensitivity audit — mutation testing for the prompt.
 *
 * Case count says nothing about coverage. The honest question is: "if a
 * builder section broke tomorrow, would any case notice?" This audit
 * answers it by deliberately disabling each section (reusing the runner's
 * ablation input) and checking whether the eval set reacts. Sections whose
 * removal flips nothing are UNGUARDED — a regression there ships silently —
 * and are exactly where new cases should be added first.
 *
 * Audit runs never persist to results.jsonl (they measure a deliberately
 * mutilated prompt).
 */

import { runEvals, type EvalRunResultEntry } from "./runner.js";
import type { EvalModelCaller } from "./model-call.js";
import { STABLE_PASS, STABLE_FAIL } from "./compare.js";

export interface SectionSensitivity {
	section: string;
	/** Cases that were stably passing at baseline and stably fail with the
	 * section removed — proof the section is guarded. */
	flippedCases: string[];
	/** Largest per-case score drop vs baseline (0 = no case moved). */
	maxScoreDelta: number;
	guarded: boolean;
}

export interface SensitivityReport {
	ts: string;
	runsPerSection: number;
	baselineMean: number;
	sections: SectionSensitivity[];
	/** Sections no case reacts to — the uncovered prompt surface. */
	unguardedSections: string[];
}

export interface SensitivityProgressEvent {
	type: "baseline-start" | "baseline-done" | "section-start" | "section-done";
	section?: string;
	flippedCases?: string[];
	completed?: number;
	total?: number;
}

/**
 * Enumerate the current builder's section names (ablation keys), excluding
 * "system" — the directory skeleton is not a disableable section.
 */
export async function listPromptSectionNames(): Promise<string[]> {
	const { buildOnethingPrompt } = await import("../prompts/builder.js");
	const built = await buildOnethingPrompt({
		providerId: "eval",
		model: "audit",
		hasTools: true,
		skills: [],
		toolNames: [],
		platform: process.platform,
		historyMessages: [],
	});
	return (built.sections ?? [])
		.map((s: { name: string }) => s.name)
		.filter((name: string) => name !== "system");
}

function combinedScores(entry: EvalRunResultEntry): Record<string, number> {
	return { ...entry.scores, ...(entry.sentinelScores ?? {}) };
}

/**
 * Run the audit: one baseline pass, then one ablated pass per section.
 * Cost: (sections + 1) × cases × runsPerSection model calls — use a small
 * runsPerSection (default 2) and/or a caseIds subset.
 */
export async function runSensitivityAudit(options: {
	repoDir: string;
	callModel: EvalModelCaller;
	/** Sections to audit (default: all current builder sections). */
	sections?: string[];
	/** Attempts per case per run (default 2 — flips, not means). */
	runsPerSection?: number;
	caseIds?: string[];
	onProgress?: (event: SensitivityProgressEvent) => void;
	signal?: AbortSignal;
	/** Injectable runner (tests). */
	runEvalsFn?: typeof runEvals;
}): Promise<SensitivityReport> {
	const runsPerSection = options.runsPerSection ?? 2;
	const sections = options.sections ?? (await listPromptSectionNames());
	const run = options.runEvalsFn ?? runEvals;

	const runOnce = (disabledSections?: string[]) =>
		run({
			repoDir: options.repoDir,
			caseIds: options.caseIds,
			runs: runsPerSection,
			disabledSections,
			includeSentinel: true,
			callModel: options.callModel,
			providerLabel: "sensitivity-audit",
			persistResults: false,
			signal: options.signal,
		});

	options.onProgress?.({ type: "baseline-start", total: sections.length });
	const baseline = await runOnce();
	const baselineScores = combinedScores(baseline);
	options.onProgress?.({ type: "baseline-done", total: sections.length });

	const results: SectionSensitivity[] = [];
	for (let i = 0; i < sections.length; i++) {
		if (options.signal?.aborted) break;
		const section = sections[i];
		options.onProgress?.({
			type: "section-start",
			section,
			completed: i,
			total: sections.length,
		});

		const ablated = await runOnce([section]);
		const ablatedScores = combinedScores(ablated);

		const flippedCases: string[] = [];
		let maxScoreDelta = 0;
		for (const [caseId, base] of Object.entries(baselineScores)) {
			const abl = ablatedScores[caseId];
			if (abl === undefined) continue;
			maxScoreDelta = Math.max(maxScoreDelta, base - abl);
			if (base >= STABLE_PASS && abl <= STABLE_FAIL) {
				flippedCases.push(caseId);
			}
		}

		const sensitivity: SectionSensitivity = {
			section,
			flippedCases,
			maxScoreDelta: Math.round(maxScoreDelta * 100) / 100,
			guarded: flippedCases.length > 0,
		};
		results.push(sensitivity);
		options.onProgress?.({
			type: "section-done",
			section,
			flippedCases,
			completed: i + 1,
			total: sections.length,
		});
	}

	return {
		ts: new Date().toISOString(),
		runsPerSection,
		baselineMean: baseline.mean,
		sections: results,
		unguardedSections: results
			.filter((s) => !s.guarded)
			.map((s) => s.section),
	};
}

/** Render the audit as markdown (for triage.md or the workbench). */
export function renderSensitivityMarkdown(report: SensitivityReport): string {
	const lines = [
		`## Section sensitivity audit — ${report.ts.slice(0, 16).replace("T", " ")}`,
		`baseline mean ${report.baselineMean}, ${report.runsPerSection} runs/section`,
		"",
		"| section | guarded | flipped cases | max Δ |",
		"| --- | --- | --- | --- |",
	];
	for (const s of report.sections) {
		lines.push(
			`| ${s.section} | ${s.guarded ? "✓" : "✗ UNGUARDED"} | ${s.flippedCases.join(", ") || "—"} | ${s.maxScoreDelta} |`,
		);
	}
	if (report.unguardedSections.length) {
		lines.push(
			"",
			`Unguarded sections (add cases here first): ${report.unguardedSections.join(", ")}`,
		);
	}
	return lines.join("\n");
}
