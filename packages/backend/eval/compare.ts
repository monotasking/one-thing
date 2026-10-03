/**
 * Run comparison — the mechanical "can this prompt change ship?" answer.
 *
 * results.jsonl is an append log of run entries tagged with promptVersion.
 * This module turns two entries into a regression report instead of leaving
 * the reader to eyeball two means: per-case stable-flip detection (the only
 * level of change that means anything at small k — design warns "±1 in k=5
 * is noise"), sentinel gate violations, and a shippable verdict.
 */

import fs from "node:fs";
import type { EvalRunResultEntry } from "./runner.js";

/** Score at or above which a case counts as stably passing (4/5 with k=5). */
export const STABLE_PASS = 0.8;
/** Score at or below which a case counts as stably failing (1/5 with k=5). */
export const STABLE_FAIL = 0.2;

export interface CaseFlip {
	caseId: string;
	from: number;
	to: number;
}

export interface RunComparison {
	baselineTs: string;
	currentTs: string;
	baselinePromptVersion: string;
	currentPromptVersion: string;
	/** Cases that went stable-pass → stable-fail. Any entry here blocks. */
	regressions: CaseFlip[];
	/** Cases that went stable-fail → stable-pass. */
	improvements: CaseFlip[];
	/** Cases only in the current run (no baseline signal). */
	newCases: string[];
	/** Cases only in the baseline (retired or renamed). */
	removedCases: string[];
	/** Sentinel cases whose strict pass^k gate is false in the current run. */
	sentinelViolations: string[];
	meanDelta: number;
	verdict: "pass" | "regressions" | "sentinel-violation";
}

/**
 * Compare two run entries case-by-case. Only stable flips are reported as
 * regressions/improvements — small score movements are sampling noise at
 * the k this harness runs.
 */
export function compareRunEntries(
	current: EvalRunResultEntry,
	baseline: EvalRunResultEntry,
): RunComparison {
	const regressions: CaseFlip[] = [];
	const improvements: CaseFlip[] = [];
	const newCases: string[] = [];
	const removedCases: string[] = [];

	for (const [caseId, to] of Object.entries(current.scores)) {
		const from = baseline.scores[caseId];
		if (from === undefined) {
			newCases.push(caseId);
			continue;
		}
		if (from >= STABLE_PASS && to <= STABLE_FAIL) {
			regressions.push({ caseId, from, to });
		} else if (from <= STABLE_FAIL && to >= STABLE_PASS) {
			improvements.push({ caseId, from, to });
		}
	}
	for (const caseId of Object.keys(baseline.scores)) {
		if (!(caseId in current.scores)) removedCases.push(caseId);
	}

	// Sentinel gate: strict pass^k when recorded; fall back to score < 1
	// for entries written before sentinelStrict existed.
	const sentinelViolations: string[] = [];
	if (current.sentinelStrict) {
		for (const [caseId, strict] of Object.entries(current.sentinelStrict)) {
			if (!strict) sentinelViolations.push(caseId);
		}
	} else if (current.sentinelScores) {
		for (const [caseId, score] of Object.entries(current.sentinelScores)) {
			if (score < 1) sentinelViolations.push(caseId);
		}
	}

	const verdict: RunComparison["verdict"] =
		sentinelViolations.length > 0
			? "sentinel-violation"
			: regressions.length > 0
				? "regressions"
				: "pass";

	return {
		baselineTs: baseline.ts,
		currentTs: current.ts,
		baselinePromptVersion: baseline.promptVersion,
		currentPromptVersion: current.promptVersion,
		regressions,
		improvements,
		newCases,
		removedCases,
		sentinelViolations,
		meanDelta: Math.round((current.mean - baseline.mean) * 1000) / 1000,
		verdict,
	};
}

/**
 * True when an entry can serve as a comparison endpoint: complete, not
 * infra-noise, and a whole-prompt run (ablation runs measure a mutilated
 * prompt on purpose — they must never become baselines).
 */
export function isComparableEntry(entry: EvalRunResultEntry): boolean {
	return !entry.aborted && !entry.invalid && !entry.disabled?.length;
}

/**
 * Pick the baseline for `current` from the results log: the most recent
 * comparable entry before it, preferring same provider+model (a cross-model
 * comparison confounds prompt change with model change).
 */
export function findBaselineEntry(
	entries: EvalRunResultEntry[],
	current: EvalRunResultEntry,
): EvalRunResultEntry | null {
	const prior = entries.filter(
		(e) => isComparableEntry(e) && e.ts < current.ts,
	);
	if (prior.length === 0) return null;
	prior.sort((a, b) => (a.ts < b.ts ? 1 : -1));
	const sameBinding = prior.find(
		(e) => e.provider === current.provider && e.model === current.model,
	);
	return sameBinding ?? prior[0];
}

/** Load all entries from a results.jsonl file (bad lines skipped). */
export function loadResultEntries(resultsPath: string): EvalRunResultEntry[] {
	if (!fs.existsSync(resultsPath)) return [];
	const entries: EvalRunResultEntry[] = [];
	for (const line of fs.readFileSync(resultsPath, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Skip bad lines
		}
	}
	return entries;
}

/** Render a comparison as a compact markdown block (triage/experiments). */
export function renderComparisonMarkdown(c: RunComparison): string {
	const lines = [
		`## Run comparison: ${c.baselinePromptVersion} → ${c.currentPromptVersion}`,
		`- verdict: **${c.verdict}** (mean ${c.meanDelta >= 0 ? "+" : ""}${c.meanDelta})`,
	];
	if (c.sentinelViolations.length) {
		lines.push(`- sentinel violations: ${c.sentinelViolations.join(", ")}`);
	}
	if (c.regressions.length) {
		lines.push(
			`- regressions: ${c.regressions.map((r) => `${r.caseId} (${r.from}→${r.to})`).join(", ")}`,
		);
	}
	if (c.improvements.length) {
		lines.push(
			`- improvements: ${c.improvements.map((r) => `${r.caseId} (${r.from}→${r.to})`).join(", ")}`,
		);
	}
	if (c.newCases.length) lines.push(`- new cases: ${c.newCases.join(", ")}`);
	if (c.removedCases.length) {
		lines.push(`- removed cases: ${c.removedCases.join(", ")}`);
	}
	return lines.join("\n");
}
