#!/usr/bin/env bun

/**
 * Weekly Diagnosis Script (Phase 4)
 *
 * Reads ~/.onething/evals/online/records.jsonl via the shared
 * packages/backend/eval/eval-records.ts module, clusters
 * low-score turns, and outputs an evals/triage.md draft section.
 *
 * The amend-merging logic lives in records.ts and is shared with
 * the desktop app's IPC handler — no duplicate implementations.
 *
 * Usage: bun scripts/diagnose-weekly.mjs [--weeks 1]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const TRIAGE_PATH = join(REPO_ROOT, "evals", "triage.md");

function parseArgs() {
	const args = process.argv.slice(2);
	const opts = { weeks: 1 };
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--weeks" && args[i + 1]) {
			opts.weeks = parseInt(args[i + 1], 10) || 1;
			i++;
		}
	}
	return opts;
}

async function main() {
	const { weeks } = parseArgs();

	// Use the shared records module (same code as the desktop app IPC handler)
	const {
		loadMergedRecords,
		filterRecordsByWeeks,
		recordHasNegative,
		generateTriageReport,
		listIncidents,
	} = await import("@onething/backend/eval");

	const allRecords = loadMergedRecords();
	const records = filterRecordsByWeeks(allRecords, weeks);

	console.log(
		`Records loaded: ${allRecords.length} total, ${records.length} in last ${weeks} week(s)`,
	);

	const negativeRecords = records.filter(recordHasNegative);

	console.log(`Negative records: ${negativeRecords.length}`);

	let report = generateTriageReport(records);

	// Incident clustering: incidents carry AI-assigned categories and
	// diagnosis conclusions — far richer than raw signal records.
	const cutoff = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;
	const incidents = listIncidents().filter(
		(i) => new Date(i.createdAt).getTime() >= cutoff,
	);
	if (incidents.length > 0) {
		const byCategory = new Map();
		for (const incident of incidents) {
			const key = incident.category ?? "(未分析)";
			if (!byCategory.has(key)) byCategory.set(key, []);
			byCategory.get(key).push(incident);
		}
		report += "\n### 事故聚类(incident workbench)\n\n";
		report += "| 类别 | 数量 | 诊断结论 | 事故 |\n|---|---|---|---|\n";
		for (const [category, items] of [...byCategory.entries()].sort(
			(a, b) => b[1].length - a[1].length,
		)) {
			const conclusions = [
				...new Set(
					items.map((i) => i.diagnosis?.conclusion).filter(Boolean),
				),
			].join(", ");
			const ids = items
				.slice(0, 3)
				.map((i) => `\`${i.id}\``)
				.join(" ");
			report += `| ${category} | ${items.length} | ${conclusions || "—"} | ${ids}${items.length > 3 ? " …" : ""} |\n`;
		}
	}

	if (existsSync(TRIAGE_PATH)) {
		const existing = readFileSync(TRIAGE_PATH, "utf-8");
		// Insert after the "Current Week" heading
		const updated = existing.replace(
			/## Current Week:.*/,
			`## Current Week: ${new Date().toISOString().slice(0, 10)}`,
		);
		writeFileSync(TRIAGE_PATH, updated + "\n" + report, "utf-8");
	} else {
		writeFileSync(TRIAGE_PATH, `# Evals Triage Ledger\n\n${report}`, "utf-8");
	}

	console.log(`\nDiagnosis draft appended to ${TRIAGE_PATH}`);
	console.log(report);
}

main().catch(console.error);
