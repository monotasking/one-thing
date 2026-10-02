/**
 * Mock tool resolution for scene replay (workbench W2, design D3).
 *
 * Replay never executes real tools. Each tool call walks a three-step
 * ladder, every result tagged with its source:
 *   ① recorded  — matched against the turn-trace tape (real result from
 *                 the original turn), by tool name + args similarity
 *   ② simulated — an injected simulator (AI-backed in W4) fabricates a
 *                 plausible result from the tool schema + tape context
 *   ③ stub      — explicit "unavailable in replay" marker (never invent
 *                 silently)
 */

import type { TurnTraceEntry, TurnTraceToolCall } from "./incident.js";

export type MockResultSource = "recorded" | "simulated" | "stub";

export interface MockToolResolution {
	result: string;
	source: MockResultSource;
}

export type ToolSimulator = (call: {
	name: string;
	args: Record<string, unknown>;
	recordedCalls: TurnTraceToolCall[];
}) => Promise<string | null>;

/** Minimum similarity for a recorded match; below this we don't guess. */
const MATCH_THRESHOLD = 0.55;

export function stringifyToolValue(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/**
 * Char-bigram Dice similarity — cheap, language-agnostic, good enough to
 * pair "edit {path: a.ts, old: x}" with its recorded twin while rejecting
 * calls against different files.
 */
export function argsSimilarity(a: unknown, b: unknown): number {
	const sa = stringifyToolValue(a);
	const sb = stringifyToolValue(b);
	if (sa === sb) return 1;
	if (!sa.length || !sb.length) return sa.length === sb.length ? 1 : 0;

	const bigrams = (s: string) => {
		const map = new Map<string, number>();
		for (let i = 0; i < s.length - 1; i++) {
			const bg = s.slice(i, i + 2);
			map.set(bg, (map.get(bg) ?? 0) + 1);
		}
		return map;
	};
	const ma = bigrams(sa);
	const mb = bigrams(sb);
	let overlap = 0;
	for (const [bg, countA] of ma) {
		const countB = mb.get(bg);
		if (countB) overlap += Math.min(countA, countB);
	}
	const total = Math.max(sa.length - 1, 0) + Math.max(sb.length - 1, 0);
	return total === 0 ? 1 : (2 * overlap) / total;
}

export interface MockToolResolver {
	resolve(name: string, args: Record<string, unknown>): Promise<MockToolResolution>;
	/** Recorded calls that were never matched (divergence indicator). */
	unusedRecordedCalls(): TurnTraceToolCall[];
}

export function createMockToolResolver(options: {
	trace: TurnTraceEntry[];
	simulate?: ToolSimulator;
}): MockToolResolver {
	const recorded = options.trace.flatMap((entry) => entry.toolCalls);
	const consumed = new Set<number>();

	async function resolve(
		name: string,
		args: Record<string, unknown>,
	): Promise<MockToolResolution> {
		// ① recorded playback: best unconsumed same-name call above threshold
		let bestIdx = -1;
		let bestScore = 0;
		for (let i = 0; i < recorded.length; i++) {
			if (recorded[i].name !== name) continue;
			const score = argsSimilarity(args, recorded[i].args) * (consumed.has(i) ? 0.9 : 1);
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}
		if (bestIdx >= 0 && bestScore >= MATCH_THRESHOLD) {
			consumed.add(bestIdx);
			return {
				result: stringifyToolValue(recorded[bestIdx].result),
				source: "recorded",
			};
		}

		// ② injected simulation (AI-backed in W4)
		if (options.simulate) {
			try {
				const simulated = await options.simulate({
					name,
					args,
					recordedCalls: recorded,
				});
				if (simulated != null) {
					return { result: simulated, source: "simulated" };
				}
			} catch {
				// Fall through to stub — never let simulation break the replay
			}
		}

		// ③ explicit stub
		return {
			result: JSON.stringify({
				error: "tool result unavailable in replay (no recorded match)",
				tool: name,
			}),
			source: "stub",
		};
	}

	return {
		resolve,
		unusedRecordedCalls: () =>
			recorded.filter((_, i) => !consumed.has(i)),
	};
}
