/**
 * Per-round request/response trace store (L1 tracing).
 *
 * Ground truth for "why did the model do this": every agent-loop round's
 * exact (request, response) pair, recorded at the loop boundary and stored
 * per turn:
 *
 *   ~/.onething/evals/traces/<sessionId>/<turnId>/round-<n>.json
 *
 * Design constraints (from the blind-spot review):
 * - PREFIX DELTA STORAGE: round N's request messages extend round N-1's
 *   (the loop appends outputs). Storing every round in full would be
 *   O(rounds × history); instead round 1 stores the full message list and
 *   later rounds store only the appended tail, with a prefix check that
 *   falls back to full storage when a mid-loop compaction rewrote history.
 * - ASYNC WRITES: serialization happens synchronously at observation time
 *   (the live array mutates right after), but disk writes are queued and
 *   never block the request path.
 * - RING PRUNING: turn directories beyond maxTurnDirs / total byte budget
 *   are removed, oldest first.
 */

import fs from "node:fs";
import path from "node:path";
import {
	getOnethingEvalsDir,
	type OnethingStorePathOptions,
} from "../storage/paths.js";

export interface TraceRoundRecord {
	v: 1;
	sessionId: string;
	turnId: string;
	round: number;
	ts: string;
	purpose: string;
	request: {
		model: string;
		/** Full messages (round 1 / prefix-mismatch fallback). */
		messages?: unknown[];
		/** Prefix-delta form: this round = prior rounds' messages + appended. */
		messagesDelta?: { baseCount: number; appended: unknown[] };
		tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
		toolChoice?: unknown;
		temperature?: number;
		maxTokens?: number;
		thinking?: string;
		reasoningEffort?: string;
	};
	response: {
		message: unknown;
		finishReason: string;
		usage?: unknown;
	};
	toolResultMessages: unknown[];
}

export function getTracesDir(options?: OnethingStorePathOptions): string {
	return path.join(getOnethingEvalsDir(options), "traces");
}

/** The one place a session/turn id becomes a directory name. */
function safeTraceSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function getSessionTraceDir(
	sessionId: string,
	options?: OnethingStorePathOptions,
): string {
	return path.join(getTracesDir(options), safeTraceSegment(sessionId));
}

export function getTurnTraceDir(
	sessionId: string,
	turnId: string,
	options?: OnethingStorePathOptions,
): string {
	return path.join(
		getSessionTraceDir(sessionId, options),
		safeTraceSegment(turnId),
	);
}

/**
 * Drop every trace this session ever wrote.
 *
 * Traces are per-session state living OUTSIDE `sessions/<id>/`, so deleting a
 * session used to leave `evals/traces/<id>/` behind forever — the ring only
 * ever evicts by age/size, never by "this session is gone". Called from the
 * session delete cascade; best-effort by design (diagnostic data must never
 * turn a delete into a failure).
 */
export function deleteSessionTraces(
	sessionId: string,
	options?: OnethingStorePathOptions,
): void {
	try {
		fs.rmSync(getSessionTraceDir(sessionId, options), {
			recursive: true,
			force: true,
		});
	} catch {
		// Already gone, or the store is not writable — never surface.
	}
}

// ── Recorder (one per turn, held by the loop wiring) ───

export interface TurnTraceRecorder {
	record(event: {
		turn: number;
		request: {
			model: string;
			messages: unknown[];
			tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
			toolChoice?: unknown;
			temperature?: number;
			maxTokens?: number;
			thinking?: string;
			reasoningEffort?: string;
		};
		response: { message: unknown; finishReason: string; usage?: unknown };
		toolResultMessages: unknown[];
	}): void;
	/** Await all queued disk writes (turn end / tests). Never rejects. */
	flush(): Promise<void>;
}

/**
 * Create a per-turn recorder. `record` serializes synchronously (the live
 * message array mutates right after observation) and queues the disk write.
 */
export function createTurnTraceRecorder(options: {
	sessionId: string;
	turnId: string;
	purpose?: string;
	storeOptions?: OnethingStorePathOptions;
	maxTurnDirs?: number;
	maxTotalBytes?: number;
}): TurnTraceRecorder {
	const dir = getTurnTraceDir(
		options.sessionId,
		options.turnId,
		options.storeOptions,
	);
	// Per-message serialized prefix of the previous round, for delta checks.
	let prevSerialized: string[] = [];
	let writeChain: Promise<void> = Promise.resolve();
	let pruned = false;

	function record(event: Parameters<TurnTraceRecorder["record"]>[0]): void {
		let serialized: string[];
		try {
			serialized = event.request.messages.map((m) => JSON.stringify(m));
		} catch {
			return; // non-serializable request — skip this round
		}

		// Prefix-delta: valid only when the previous rounds' serialized
		// messages are an exact prefix (mid-loop compaction rewrites break it).
		const prefixIntact =
			prevSerialized.length > 0 &&
			prevSerialized.length <= serialized.length &&
			prevSerialized.every((line, i) => line === serialized[i]);

		const record: TraceRoundRecord = {
			v: 1,
			sessionId: options.sessionId,
			turnId: options.turnId,
			round: event.turn,
			ts: new Date().toISOString(),
			purpose: options.purpose ?? "chat",
			request: {
				model: event.request.model,
				...(prefixIntact
					? {
							messagesDelta: {
								baseCount: prevSerialized.length,
								appended: serialized
									.slice(prevSerialized.length)
									.map((line) => JSON.parse(line)),
							},
						}
					: {
							messages: serialized.map((line) => JSON.parse(line)),
						}),
				tools: event.request.tools?.map((t) => ({
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				})),
				toolChoice: safeClone(event.request.toolChoice),
				temperature: event.request.temperature,
				maxTokens: event.request.maxTokens,
				thinking: event.request.thinking,
				reasoningEffort: event.request.reasoningEffort,
			},
			response: {
				message: safeClone(event.response.message),
				finishReason: event.response.finishReason,
				usage: safeClone(event.response.usage),
			},
			toolResultMessages: (event.toolResultMessages ?? []).map(safeClone),
		};

		prevSerialized = serialized;

		// Queue the disk write off the request path.
		writeChain = writeChain
			.then(async () => {
				await fs.promises.mkdir(dir, { recursive: true });
				await fs.promises.writeFile(
					path.join(dir, `round-${event.turn}.json`),
					JSON.stringify(record),
					"utf-8",
				);
				if (!pruned) {
					pruned = true;
					pruneTraceRing(
						options.maxTurnDirs ?? 300,
						options.storeOptions,
						options.maxTotalBytes ?? 512 * 1024 * 1024,
					);
				}
			})
			.catch(() => {
				// Tracing must never surface errors into the loop
			});
	}

	return { record, flush: () => writeChain };
}

function safeClone<T>(value: T): T {
	if (value === undefined) return value;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return "[non-serializable]" as unknown as T;
	}
}

// ── Reading (rebuilds full messages from deltas) ───────

export interface HydratedTraceRound {
	round: number;
	ts: string;
	purpose: string;
	request: Omit<TraceRoundRecord["request"], "messagesDelta"> & {
		messages: unknown[];
	};
	response: TraceRoundRecord["response"];
	toolResultMessages: unknown[];
	/** True when the delta chain was broken and this round is best-effort. */
	incomplete?: boolean;
}

export function readTraceRounds(
	sessionId: string,
	turnId: string,
	options?: OnethingStorePathOptions,
): HydratedTraceRound[] {
	const dir = getTurnTraceDir(sessionId, turnId, options);
	return readTraceRoundsFromDir(dir);
}

/** Read rounds from any dir holding round-<n>.json files (trace or bundle). */
export function readTraceRoundsFromDir(dir: string): HydratedTraceRound[] {
	if (!fs.existsSync(dir)) return [];

	const files = fs
		.readdirSync(dir)
		.filter((name) => /^round-\d+\.json$/.test(name))
		.sort(
			(a, b) =>
				Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0),
		);

	const rounds: HydratedTraceRound[] = [];
	let accumulated: unknown[] = [];
	let chainIntact = true;

	for (const file of files) {
		let record: TraceRoundRecord;
		try {
			record = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
		} catch {
			chainIntact = false;
			continue;
		}

		let messages: unknown[];
		let incomplete = false;
		if (record.request.messages) {
			messages = record.request.messages;
			accumulated = messages;
			chainIntact = true;
		} else if (record.request.messagesDelta) {
			if (
				chainIntact &&
				accumulated.length === record.request.messagesDelta.baseCount
			) {
				messages = [...accumulated, ...record.request.messagesDelta.appended];
				accumulated = messages;
			} else {
				// Broken chain (missing/corrupt earlier round): best effort
				messages = record.request.messagesDelta.appended;
				incomplete = true;
				chainIntact = false;
			}
		} else {
			messages = [];
			incomplete = true;
		}

		const { messagesDelta: _drop, ...requestRest } = record.request;
		rounds.push({
			round: record.round,
			ts: record.ts,
			purpose: record.purpose,
			request: { ...requestRest, messages },
			response: record.response,
			toolResultMessages: record.toolResultMessages ?? [],
			...(incomplete ? { incomplete: true } : {}),
		});
	}
	return rounds;
}

// ── Ring pruning ───────────────────────────────────────

export function pruneTraceRing(
	maxTurnDirs: number,
	options?: OnethingStorePathOptions,
	maxTotalBytes: number = 512 * 1024 * 1024,
): void {
	const root = getTracesDir(options);
	let turnDirs: Array<{ dir: string; mtime: number; size: number }>;
	try {
		turnDirs = [];
		for (const sessionEntry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!sessionEntry.isDirectory()) continue;
			const sessionDir = path.join(root, sessionEntry.name);
			for (const turnEntry of fs.readdirSync(sessionDir, {
				withFileTypes: true,
			})) {
				if (!turnEntry.isDirectory()) continue;
				const dir = path.join(sessionDir, turnEntry.name);
				let size = 0;
				let mtime = 0;
				for (const file of fs.readdirSync(dir)) {
					const stat = fs.statSync(path.join(dir, file));
					size += stat.size;
					mtime = Math.max(mtime, stat.mtimeMs);
				}
				turnDirs.push({ dir, mtime, size });
			}
		}
	} catch {
		return;
	}

	turnDirs.sort((a, b) => b.mtime - a.mtime);
	let totalBytes = 0;
	for (let i = 0; i < turnDirs.length; i++) {
		totalBytes += turnDirs[i].size;
		if (i < maxTurnDirs && totalBytes <= maxTotalBytes) continue;
		try {
			fs.rmSync(turnDirs[i].dir, { recursive: true, force: true });
		} catch {
			// Already gone
		}
	}
}
