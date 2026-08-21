/**
 * Collects the file-mutation audit records relevant to a goal's lifetime and
 * projects them two ways: the net numstat summary carried on the goal itself,
 * and the full review diffs fetched on demand by the workbench.
 *
 * Audit records live under <store>/file-mutations/<YYYY-MM-DD>/<id>.json —
 * only the date directories inside the goal window are scanned.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import {
	collectGoalFileSpans,
	countSpanLines,
	summarizeGoalFileChanges,
	type GoalFileChange,
	type GoalFileMutationRecordLike,
} from "@onething/runtime/goals";
import type { GoalFileDiff } from "@shared/ipc.js";
import {
  getOnethingFileMutationsDir,
} from '@onething/runtime/storage'
import * as store from "../store.js";

/**
 * Per-side cap on shipping the full before/after text. Past it the renderer
 * gets the patch alone: it can still show every changed hunk, just not expand
 * the unchanged context around them. Keeps one giant file from stalling IPC.
 */
const MAX_INLINE_CONTENT_BYTES = 256 * 1024;

function dateKeysBetween(sinceMs: number, untilMs: number): string[] {
	const keys: string[] = [];
	// Walk in UTC day steps; the audit writer keys directories by the ISO date.
	const day = 24 * 60 * 60 * 1000;
	for (let at = sinceMs - day; at <= untilMs + day; at += day) {
		const key = new Date(at).toISOString().slice(0, 10);
		if (keys[keys.length - 1] !== key) keys.push(key);
	}
	return keys;
}

async function readRecordsForWindow(
	sinceMs: number,
	untilMs: number,
): Promise<GoalFileMutationRecordLike[]> {
	const auditRoot = getOnethingFileMutationsDir();
	const records: GoalFileMutationRecordLike[] = [];
	for (const dateKey of dateKeysBetween(sinceMs, untilMs)) {
		const dir = path.join(auditRoot, dateKey);
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			try {
				const raw = await fs.readFile(path.join(dir, entry), "utf-8");
				records.push(JSON.parse(raw) as GoalFileMutationRecordLike);
			} catch {
				// A torn or foreign file must not break the summary.
			}
		}
	}
	return records;
}

/** Shorten an absolute audit path against the session's working directory. */
function relativizeToWorkspace(
	filePath: string,
	workingDirectory: string | undefined,
): string {
	if (!workingDirectory) return filePath;
	const prefix = workingDirectory.endsWith(path.sep)
		? workingDirectory
		: workingDirectory + path.sep;
	return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

export async function collectGoalFileChanges(
	sessionId: string,
	sinceMs: number,
): Promise<GoalFileChange[]> {
	const records = await readRecordsForWindow(sinceMs, Date.now());
	const changes = summarizeGoalFileChanges(records, { sessionId, sinceMs });
	const workingDirectory = store.getSession(sessionId)?.workingDirectory;
	return changes.map((change) => ({
		...change,
		path: relativizeToWorkspace(change.path, workingDirectory),
	}));
}

/**
 * The same net spans as the numstat summary, carrying unified patches for
 * review. Diffs are computed here rather than reused from the per-record
 * `diff` field: those describe single edits, while the review shows the goal's
 * net effect on each file.
 */
export async function collectGoalFileDiffs(
	sessionId: string,
	sinceMs: number,
): Promise<GoalFileDiff[]> {
	const records = await readRecordsForWindow(sinceMs, Date.now());
	const spans = collectGoalFileSpans(records, { sessionId, sinceMs });
	const workingDirectory = store.getSession(sessionId)?.workingDirectory;

	return spans.map((span) => {
		const relativePath = relativizeToWorkspace(span.path, workingDirectory);
		const before = span.beforeExists ? span.beforeContent : "";
		const after = span.afterExists ? span.afterContent : "";
		const inlineable =
			Buffer.byteLength(before) <= MAX_INLINE_CONTENT_BYTES &&
			Buffer.byteLength(after) <= MAX_INLINE_CONTENT_BYTES;
		return {
			path: relativePath,
			absolutePath: span.path,
			...countSpanLines(span),
			created: !span.beforeExists && span.afterExists,
			deleted: span.beforeExists && !span.afterExists,
			diff: createTwoFilesPatch(
				span.beforeExists ? relativePath : "/dev/null",
				span.afterExists ? relativePath : "/dev/null",
				before,
				after,
			),
			beforeContent: inlineable ? before : undefined,
			afterContent: inlineable ? after : undefined,
		};
	});
}
