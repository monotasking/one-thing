/**
 * Prompt-capture disk ring buffer (Route B).
 *
 * The in-memory LRU dies with the process and holds only a couple dozen
 * turns; this ring persists per-turn captures to disk so a 👎 on any
 * recent turn — days and restarts later — still gets the three things the
 * session jsonl can never provide: the verbatim system prompt sections,
 * the real tool schemas, and the call params.
 *
 * Size discipline: `requestMessages` (the send-view history) is the big
 * part AND the reconstructible part (Route A rebuilds it from the session
 * jsonl through the production pipeline) — so oversized captures are
 * persisted WITHOUT it rather than truncated. The ring keeps the newest
 * `maxEntries` files and prunes the rest.
 */

import fs from "node:fs";
import path from "node:path";
import type { CorePromptCapture } from "@onething/backend/core/engine";
import {
	getOnethingEvalsDir,
	type OnethingStorePathOptions,
} from "../storage/paths.js";

const DEFAULT_MAX_ENTRIES = 200;
/**
 * Above this serialized size, drop requestMessages (Route A rebuilds them).
 * 2MB keeps byte-exact history for virtually all real turns — long sessions
 * are precisely where exact replay matters most, so this cap is generous
 * and the ring is bounded by TOTAL bytes instead.
 */
const CAPTURE_MAX_BYTES = 2 * 1024 * 1024;
/** Total ring budget; oldest captures are pruned past this. */
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export function getCapturesDir(options?: OnethingStorePathOptions): string {
	return path.join(getOnethingEvalsDir(options), "captures");
}

function captureFilePath(
	turnId: string,
	options?: OnethingStorePathOptions,
): string {
	const safe = turnId.replace(/[^a-zA-Z0-9_-]/g, "_");
	return path.join(getCapturesDir(options), `${safe}.json`);
}

export function saveCaptureToDisk(
	turnId: string,
	capture: CorePromptCapture,
	options?: { maxEntries?: number; storeOptions?: OnethingStorePathOptions },
): void {
	const dir = getCapturesDir(options?.storeOptions);
	fs.mkdirSync(dir, { recursive: true });

	let serialized: string;
	try {
		serialized = JSON.stringify(capture);
	} catch {
		return; // non-serializable capture — skip silently
	}
	if (Buffer.byteLength(serialized, "utf-8") > CAPTURE_MAX_BYTES) {
		const slim: CorePromptCapture = {
			...capture,
			requestMessages: undefined,
			rawRequest: capture.rawRequest
				? { ...capture.rawRequest, messages: [] }
				: undefined,
		};
		try {
			serialized = JSON.stringify(slim);
		} catch {
			return;
		}
	}

	fs.writeFileSync(captureFilePath(turnId, options?.storeOptions), serialized, "utf-8");
	pruneCaptureRing(options?.maxEntries ?? DEFAULT_MAX_ENTRIES, options?.storeOptions);
}

export function loadCaptureFromDisk(
	turnId: string,
	options?: OnethingStorePathOptions,
): CorePromptCapture | null {
	try {
		return JSON.parse(
			fs.readFileSync(captureFilePath(turnId, options), "utf-8"),
		);
	} catch {
		return null;
	}
}

export function pruneCaptureRing(
	maxEntries: number,
	options?: OnethingStorePathOptions,
	maxTotalBytes: number = DEFAULT_MAX_TOTAL_BYTES,
): void {
	const dir = getCapturesDir(options);
	let entries: Array<{ name: string; mtime: number; size: number }>;
	try {
		entries = fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => {
				const stat = fs.statSync(path.join(dir, name));
				return { name, mtime: stat.mtimeMs, size: stat.size };
			});
	} catch {
		return;
	}

	// Newest first; keep while within BOTH the entry count and byte budget.
	entries.sort((a, b) => b.mtime - a.mtime);
	let totalBytes = 0;
	for (let i = 0; i < entries.length; i++) {
		totalBytes += entries[i].size;
		if (i < maxEntries && totalBytes <= maxTotalBytes) continue;
		try {
			fs.unlinkSync(path.join(dir, entries[i].name));
		} catch {
			// Already gone
		}
	}
}
