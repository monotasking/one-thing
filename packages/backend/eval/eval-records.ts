/**
 * Evals Records Management
 *
 * Reads, merges (amend folding), and filters online eval records from
 * records.jsonl. Shared between scripts/diagnose-weekly.mjs (CLI) and
 * IPC handlers (desktop app UI), so that the amend-merging logic does
 * not drift between the two consumers.
 */

import fs from "node:fs";
import {
	getOnethingEvalsOnlineRecordsPath,
	type OnethingStorePathOptions,
} from "../storage/storage-paths.js";
import type { TurnEvalRecord } from "@shared/contracts/eval-record.js";

/** Amend record written after the fact (retry/edit/downvote). */
interface AmendEntry {
	amend: true;
	turnId: string;
	sessionId: string;
	retried?: boolean;
	editResent?: boolean;
	explicitDown?: boolean;
	// Artifacts materialized late from the prompt-capture LRU (normal turns
	// don't persist snapshots at turn end; a late retry/edit/👎 writes them).
	fixtureRef?: string | null;
	incidentRef?: string | null;
	promptSnapshotRef?: string | null;
	contextSnapshotRef?: string | null;
	requestSnapshotRef?: string | null;
	responseSnapshotRef?: string | null;
}

/** Union type for a single line in records.jsonl. */
type RawLine = TurnEvalRecord | AmendEntry;

export interface LoadMergedRecordsOptions {
	storePathOptions?: OnethingStorePathOptions;
}

/**
 * Load all records from records.jsonl and fold amend lines (written later
 * when a retry/edit/downvote happens after turn end) back into the original
 * record they amend, keyed by (sessionId, turnId).
 *
 * Amend lines carry no `ts`; on their own they're invisible to date-based
 * filters. This merges them before any filter runs.
 */
export function loadMergedRecords(
	options?: LoadMergedRecordsOptions,
): TurnEvalRecord[] {
	const recordsPath = getOnethingEvalsOnlineRecordsPath(
		options?.storePathOptions,
	);

	if (!fs.existsSync(recordsPath)) {
		return [];
	}

	const content = fs.readFileSync(recordsPath, "utf-8");
	const lines = content
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as RawLine;
			} catch {
				return null;
			}
		})
		.filter((line): line is RawLine => line !== null);

	const records: TurnEvalRecord[] = [];
	const byKey = new Map<string, TurnEvalRecord>();
	const pendingAmends: Array<{ key: string; entry: AmendEntry }> = [];

	for (const entry of lines) {
		const key = `${entry.sessionId}::${entry.turnId}`;
		if ("amend" in entry && entry.amend === true) {
			pendingAmends.push({ key, entry: entry as AmendEntry });
			continue;
		}
		records.push(entry as TurnEvalRecord);
		// Later records for the same turn (shouldn't normally happen, but be
		// defensive) win, matching append-order semantics.
		byKey.set(key, entry as TurnEvalRecord);
	}

	for (const { key, entry } of pendingAmends) {
		const target = byKey.get(key);
		if (!target) continue; // amend arrived with no matching original record
		if (entry.retried) target.signals = { ...target.signals, retried: true };
		if (entry.editResent)
			target.signals = { ...target.signals, editResent: true };
		if (entry.explicitDown) target.explicit = "down";
		// Late-materialized artifact refs win over the (null) turn-end refs.
		if (entry.fixtureRef) target.fixtureRef = entry.fixtureRef;
		if (entry.incidentRef) target.incidentRef = entry.incidentRef;
		if (entry.promptSnapshotRef)
			target.promptSnapshotRef = entry.promptSnapshotRef;
		if (entry.contextSnapshotRef)
			target.contextSnapshotRef = entry.contextSnapshotRef;
		if (entry.requestSnapshotRef)
			target.requestSnapshotRef = entry.requestSnapshotRef;
		if (entry.responseSnapshotRef)
			target.responseSnapshotRef = entry.responseSnapshotRef;
	}

	return records;
}

/**
 * Filter records to only those within the last N weeks.
 */
export function filterRecordsByWeeks(
	records: TurnEvalRecord[],
	weeks: number,
): TurnEvalRecord[] {
	const cutoff = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;
	return records.filter((r) => new Date(r.ts).getTime() >= cutoff);
}

/**
 * Check if a record has negative signals worth reviewing.
 */
export function recordHasNegative(record: TurnEvalRecord): boolean {
	if (record.explicit === "down") return true;
	if (record.judge && record.judge.score < 0.5) return true;
	if (record.signals) {
		const s = record.signals;
		if (s.retried || s.editResent || s.streamAborted) return true;
		if (s.toolErrors > 0 || s.permissionDenied) return true;
	}
	return false;
}

/**
 * Categorize a record for triage purposes.
 */
export function categorizeRecord(record: TurnEvalRecord): string {
	if (record.judge?.category) return record.judge.category;
	const s = record.signals;
	if (s?.streamAborted) return "general-poor-response";
	if (s?.toolErrors > 0) return "general-poor-response";
	if (s?.retried) return "general-poor-response";
	if (s?.editResent) return "general-poor-response";
	return "not-prompt-fault";
}

/**
 * Category to prompt section mapping for triage reports.
 * Section keys match the names returned by buildRuntimeSystemPrompt.
 */
export const CATEGORY_TO_SECTION: Record<string, string> = {
	"missed-directory-switch": "known-projects",
	"ignored-skill-instructions": "skills",
	"voice-mode-violation": "voice",
	"ignored-known-projects": "known-projects",
	"wrong-platform-behavior": "os",
	"ignored-agent-instructions": "agent",
	"general-poor-response": "system",
	"not-prompt-fault": "N/A",
	"context-confusion": "context-variables",
	"working-directory-error": "workdir",
	"agents-md-conflict": "agents-md",
};

/**
 * Generate a triage markdown report draft.
 */
export function generateTriageReport(records: TurnEvalRecord[]): string {
	const negativeRecords = records.filter(recordHasNegative);

	// Cluster by category
	const clusters: Record<string, TurnEvalRecord[]> = {};
	for (const r of negativeRecords) {
		const cat = categorizeRecord(r);
		if (!clusters[cat]) clusters[cat] = [];
		clusters[cat].push(r);
	}

	const weekLabel = new Date().toISOString().slice(0, 10);
	let report = `\n## ${weekLabel} (auto-generated draft)\n\n`;
	report += `Total turns this period: ${records.length}\n`;
	report += `Turns with negative signals: ${negativeRecords.length}\n\n`;
	report += "| 失败类别 | 本周 | 归因段落 | 段版本分布 | 状态 |\n";
	report += "|---|---|---|---|---|\n";

	const sorted = Object.entries(clusters).sort(
		([, a], [, b]) => b.length - a.length,
	);

	for (const [category, recs] of sorted) {
		const sectionKey = CATEGORY_TO_SECTION[category] || "N/A";
		// Compute section hash distribution for the attribution section
		const hashCounts = new Map<string, number>();
		for (const r of recs) {
			const hash = r.sectionHashes?.[sectionKey];
			if (hash) hashCounts.set(hash, (hashCounts.get(hash) ?? 0) + 1);
		}
		const distribution = [...hashCounts.entries()]
			.sort(([, a], [, b]) => b - a)
			.map(([hash, count]) => `${hash} ×${count}`)
			.join(", ");
		report += `| ${category} | ${recs.length} | ${sectionKey} | ${distribution || "—"} | 待修 |\n`;
	}

	if (sorted.length === 0) {
		report += "| _(no failures detected)_ | 0 | — | — | — |\n";
	}

	report += `\n<!-- Auto-generated. Review and correct before committing. -->\n`;
	return report;
}
