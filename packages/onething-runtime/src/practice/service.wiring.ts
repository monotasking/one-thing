/**
 * Practice service: single owner of the rhythm engine (kegel / pomodoro),
 * the practice ledger, and config. The engine itself is a pure state machine
 * in @onething/runtime/practice; this module drives it with a real 1 Hz timer,
 * settles finished/abandoned sessions into the ledger, and pushes
 * PRACTICE_EVENT payloads through an injected broadcaster (the Electron host
 * wires it to the IPCBridge). See docs/design/practice-system.md.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import {
	ONETHING_PRACTICE_DEFAULT_CONFIG,
	OnethingPracticeEngine,
	OnethingPracticeLedger,
	getOnethingPracticeSummary,
	normalizeOnethingPracticeConfig,
	type OnethingPracticeConfig,
	type OnethingPracticeEngineSnapshot,
	type OnethingPracticeLedgerRecord,
	type OnethingPracticePhaseEdge,
	type OnethingPracticeRecordInput,
	type OnethingPracticeSummaryResult,
} from "./index.js";
import {
	type PracticeEventPayload,
	type PracticeLogRequest,
	type PracticeSetConfigRequest,
	type PracticeStartRequest,
	type PracticeSummaryRequest,
} from "@shared/ipc.js";
import {
  getOnethingStorePath,
} from '../storage/index.js'

type PracticeEventBroadcaster = (payload: PracticeEventPayload) => void;

let practiceEventBroadcaster: PracticeEventBroadcaster | null = null;

/** Host injection point: where PRACTICE_EVENT pushes go (no-op until set). */
export function configurePracticeEventBroadcaster(
	broadcaster: PracticeEventBroadcaster | null,
): void {
	practiceEventBroadcaster = broadcaster;
}

const TICK_MS = 1000;

function practiceDir(): string {
	return path.join(getOnethingStorePath(), "practice");
}

let ledgerInstance: OnethingPracticeLedger | null = null;

export function getPracticeLedger(): OnethingPracticeLedger {
	if (!ledgerInstance) {
		ledgerInstance = new OnethingPracticeLedger({ ledgerDir: practiceDir });
	}
	return ledgerInstance;
}

// ── Config ─────────────────────────────────────────────────────

function configPath(): string {
	return path.join(practiceDir(), "config.json");
}

export async function readPracticeConfig(): Promise<OnethingPracticeConfig> {
	try {
		const raw = await fsp.readFile(configPath(), "utf-8");
		return normalizeOnethingPracticeConfig(JSON.parse(raw));
	} catch {
		return structuredClone(ONETHING_PRACTICE_DEFAULT_CONFIG);
	}
}

export async function writePracticeConfig(
	request: PracticeSetConfigRequest,
): Promise<OnethingPracticeConfig> {
	const current = await readPracticeConfig();
	const merged = normalizeOnethingPracticeConfig({
		kegel: { ...current.kegel, ...request.config.kegel },
		pomodoro: { ...current.pomodoro, ...request.config.pomodoro },
	});
	await fsp.mkdir(practiceDir(), { recursive: true });
	await fsp.writeFile(configPath(), `${JSON.stringify(merged, null, "\t")}\n`, "utf-8");
	return merged;
}

// ── Engine driving ─────────────────────────────────────────────

const engine = new OnethingPracticeEngine();
let ticker: NodeJS.Timeout | null = null;

function pushEvent(
	snapshot: OnethingPracticeEngineSnapshot,
	edges: OnethingPracticePhaseEdge[],
	settled?: OnethingPracticeLedgerRecord,
): void {
	const payload: PracticeEventPayload = { snapshot, edges, settled };
	practiceEventBroadcaster?.(payload);
}

function settle(input: OnethingPracticeRecordInput): OnethingPracticeLedgerRecord {
	return getPracticeLedger().record(input);
}

function stopTicker(): void {
	if (ticker) {
		clearInterval(ticker);
		ticker = null;
	}
}

function ensureTicker(): void {
	if (ticker) return;
	ticker = setInterval(() => {
		const result = engine.tick(Date.now());
		let settled: OnethingPracticeLedgerRecord | undefined;
		if (result.finished) {
			settled = settle(result.finished);
			stopTicker();
		}
		if (result.edges.length > 0 || result.snapshot.status !== "idle" || settled) {
			pushEvent(result.snapshot, result.edges, settled);
		}
	}, TICK_MS);
	ticker.unref?.();
}

export async function startPractice(request: PracticeStartRequest): Promise<OnethingPracticeEngineSnapshot> {
	const now = Date.now();
	// A new start supersedes any active session: settle the old one as abandoned.
	const abandoned = engine.stop(now);
	const abandonedRecord = abandoned ? settle(abandoned) : undefined;

	let result;
	if (request.kind === "kegel") {
		const config = await readPracticeConfig();
		const { holdSec, relaxSec, reps, sets, setRestSec } = config.kegel;
		result = engine.startKegel({ holdSec, relaxSec, reps, sets, setRestSec }, now);
	} else {
		const config = await readPracticeConfig();
		result = engine.startPomodoro(
			{ minutes: config.pomodoro.minutes, category: request.category, label: request.label },
			now,
		);
	}
	ensureTicker();
	pushEvent(result.snapshot, result.edges, abandonedRecord);
	return result.snapshot;
}

export function pausePractice(): OnethingPracticeEngineSnapshot {
	const snapshot = engine.pause(Date.now());
	pushEvent(snapshot, []);
	return snapshot;
}

export function resumePractice(): OnethingPracticeEngineSnapshot {
	const snapshot = engine.resume(Date.now());
	pushEvent(snapshot, []);
	return snapshot;
}

export function stopPractice(discard = false): OnethingPracticeEngineSnapshot {
	const input = engine.stop(Date.now());
	stopTicker();
	const settled = input && !discard ? settle(input) : undefined;
	const snapshot = engine.getSnapshot(Date.now());
	pushEvent(snapshot, [], settled);
	return snapshot;
}

export function getPracticeState(): OnethingPracticeEngineSnapshot {
	return engine.getSnapshot(Date.now());
}

// ── Quick log & queries ────────────────────────────────────────

export function logPractice(request: PracticeLogRequest): OnethingPracticeLedgerRecord {
	const name = request.name.trim();
	if (!name) throw new Error("practice log needs a name");
	return getPracticeLedger().record({
		ts: request.ts,
		kind: "exercise",
		source: request.source,
		name,
		note: request.note,
		exercise: request.exercise,
	});
}

export async function getPracticeSummary(
	request: PracticeSummaryRequest,
): Promise<OnethingPracticeSummaryResult> {
	return getOnethingPracticeSummary(getPracticeLedger(), {
		granularity: request.granularity,
		count: request.count,
	});
}

export async function getRecentPracticeRecords(days = 7, limit = 50): Promise<OnethingPracticeLedgerRecord[]> {
	const now = Date.now();
	const records = await getPracticeLedger().readRecordsInRange(now - days * 86_400_000, now + 60_000);
	return records.slice(-limit).reverse();
}

/** Test-only: clear module state between runs. */
export function __resetPracticeServiceForTests(): void {
	stopTicker();
	engine.stop(Date.now());
	ledgerInstance = null;
}
