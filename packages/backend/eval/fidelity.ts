/**
 * Replay fidelity — validates the measuring stick itself.
 *
 * The entire offline loop (diagnose, ablation, fix verification) rests on
 * one assumption: that mock replay reproduces the original behavior when
 * NOTHING is changed. This module measures that assumption instead of
 * trusting it: replay the scene N times with the CAPTURED prompt (byte-
 * faithful, zero changes) and compare tool-call decision sequences against
 * the recorded trace.
 *
 * A low-fidelity scene means its diagnosis conclusions are mock noise, not
 * prompt signal — attribution on such a scene should not be trusted.
 */

import type { EvalModelCaller } from "./model-call.js";
import { runReplay, type ReplayScene, type ReplayResult } from "./replay.js";

export interface FidelityReport {
	attempts: number;
	/** Decision sequence recorded at failure time (tool names, in order). */
	originalSequence: string[];
	/** Decision sequence of each replay attempt. */
	replaySequences: string[][];
	/** Fraction of replays whose sequence exactly matches the original. */
	fidelity: number;
	/** Fraction of replays agreeing with the most common replay sequence —
	 * separates harness drift from plain model nondeterminism. */
	selfConsistency: number;
	/** Which prompt the replays used; "rebuilt" means the scene had no
	 * captured prompt and the measurement is weaker (builder drift mixed in). */
	promptMode: "captured" | "rebuilt";
	verdict: "high" | "medium" | "low";
	/** Attempts that threw (excluded from the ratios). */
	errors: number;
}

/** Tool-call decision sequence of one replay (names in call order). */
export function replayDecisionSequence(result: ReplayResult): string[] {
	const seq: string[] = [];
	for (const e of result.transcript.events) {
		if (e.t === "assistant" && e.toolCalls) {
			for (const tc of e.toolCalls) seq.push(tc.name);
		}
	}
	return seq;
}

/** Decision sequence recorded in the scene's original turn trace. */
export function traceDecisionSequence(scene: ReplayScene): string[] {
	const seq: string[] = [];
	for (const entry of scene.trace) {
		for (const tc of entry.toolCalls ?? []) seq.push(tc.name);
	}
	return seq;
}

function sequencesEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function fidelityVerdict(fidelity: number): FidelityReport["verdict"] {
	if (fidelity >= 0.8) return "high";
	if (fidelity >= 0.4) return "medium";
	return "low";
}

/**
 * Measure a scene's replay fidelity with N zero-change replays.
 *
 * Uses the captured prompt when the scene has one — that is the true
 * "does the harness reproduce the original?" question. Without a captured
 * prompt the current builder output is the best available approximation
 * and the report says so via promptMode.
 */
export async function measureReplayFidelity(options: {
	scene: ReplayScene;
	callModel: EvalModelCaller;
	attempts?: number;
	onAttempt?: (index: number, sequence: string[]) => void;
	signal?: AbortSignal;
}): Promise<FidelityReport> {
	const attempts = Math.min(options.attempts ?? 5, 10);
	const promptMode: FidelityReport["promptMode"] = options.scene
		.capturedSystemPrompt
		? "captured"
		: "rebuilt";

	const originalSequence = traceDecisionSequence(options.scene);
	const replaySequences: string[][] = [];
	let errors = 0;

	for (let i = 0; i < attempts; i++) {
		if (options.signal?.aborted) break;
		try {
			const result = await runReplay({
				scene: options.scene,
				callModel: options.callModel,
				useCapturedPrompt: promptMode === "captured",
				header: {
					runId: `fidelity-${Date.now()}`,
					attempt: i + 1,
					model: options.scene.params.model ?? "unknown",
					provider: options.scene.params.provider,
				},
				signal: options.signal,
			});
			const seq = replayDecisionSequence(result);
			replaySequences.push(seq);
			options.onAttempt?.(i + 1, seq);
		} catch {
			errors++;
		}
	}

	const judged = replaySequences.length;
	const matches = replaySequences.filter((s) =>
		sequencesEqual(s, originalSequence),
	).length;
	const fidelity = judged > 0 ? matches / judged : 0;

	// Modal agreement among replays themselves.
	let selfConsistency = 0;
	if (judged > 0) {
		const counts = new Map<string, number>();
		for (const seq of replaySequences) {
			const key = seq.join("→");
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		selfConsistency = Math.max(...counts.values()) / judged;
	}

	return {
		attempts: judged,
		originalSequence,
		replaySequences,
		fidelity: Math.round(fidelity * 100) / 100,
		selfConsistency: Math.round(selfConsistency * 100) / 100,
		promptMode,
		verdict: fidelityVerdict(fidelity),
		errors,
	};
}
