/**
 * Engine-facing goal hooks: per-round accounting + continuation prompts for
 * the agent-loop runtime, and stream-lifecycle breakers (error → blocked,
 * abort → paused, complete → flush) wired through the EventBus so the stream
 * executor needs no goal knowledge.
 */
import {
	renderGoalBudgetLimitPrompt,
	renderGoalContinuationNudge,
} from "@onething/runtime/goals";
import type { OnethingAgentLoopGoalHooks } from "@onething/runtime/agent-loop";
import { getEventBus } from "../events/index.js";
import {
	goalLimits,
	handleGoalAbort,
	handleGoalRunError,
	handleGoalRunSuccess,
	recordGoalUsage,
	tryBeginContinuation,
} from "./index.js";
import { kickGoalRunIfIdle } from "./kick.js";

import { SESSION_EVENT_TYPES } from "@shared/events/index.js";

// Wall-clock accounting: seconds between consecutive rounds of the same
// session approximate active time. Entries are dropped when a run ends.
const lastUsageTick = new Map<string, number>();
const MAX_TICK_GAP_SECONDS = 3600;

// Transient-error retries: backoff per consecutive failed run. The pending
// timer doubles as the dedupe guard — stream:error and stream:complete{error}
// both fire for one failed run and must count as a single failure.
const GOAL_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
const pendingGoalRetries = new Map<string, ReturnType<typeof setTimeout>>();

function cancelGoalRetry(sessionId: string): void {
	const timer = pendingGoalRetries.get(sessionId);
	if (timer === undefined) return;
	clearTimeout(timer);
	pendingGoalRetries.delete(sessionId);
}

function scheduleGoalRetry(sessionId: string, attempt: number): void {
	if (pendingGoalRetries.has(sessionId)) return;
	const delay =
		GOAL_RETRY_DELAYS_MS[
			Math.min(Math.max(attempt - 1, 0), GOAL_RETRY_DELAYS_MS.length - 1)
		];
	const timer = setTimeout(() => {
		pendingGoalRetries.delete(sessionId);
		// Conditions are re-checked at fire time: the kick no-ops when the
		// goal is gone / paused / cleared or a stream is already running.
		try {
			kickGoalRunIfIdle(sessionId);
		} catch (error) {
			console.error("[goals] retry kick failed:", error);
		}
	}, delay);
	timer.unref?.();
	pendingGoalRetries.set(sessionId, timer);
}

function handleGoalStreamFailure(sessionId: string, error: string): void {
	if (pendingGoalRetries.has(sessionId)) return;
	const outcome = handleGoalRunError(sessionId, error);
	if (outcome?.willRetry) scheduleGoalRetry(sessionId, outcome.attempt);
}

export const goalRuntimeHooks: OnethingAgentLoopGoalHooks = {
	recordUsage(sessionId, usage) {
		const now = Date.now();
		const last = lastUsageTick.get(sessionId);
		lastUsageTick.set(sessionId, now);
		const seconds =
			last !== undefined
				? Math.min((now - last) / 1000, MAX_TICK_GAP_SECONDS)
				: 0;
		const result = recordGoalUsage(sessionId, {
			tokens: usage.totalTokens ?? 0,
			seconds,
		});
		if (!result?.becameBudgetLimited) return undefined;
		return renderGoalBudgetLimitPrompt(result.goal, goalLimits());
	},

	beginContinuation(sessionId) {
		const goal = tryBeginContinuation(sessionId);
		if (!goal) {
			lastUsageTick.delete(sessionId);
			return undefined;
		}
		// In-run pushes use the short nudge: the full prompt (objective +
		// rules) was already seen this run, and repeating it verbatim made
		// models read the transcript as the user repeating themselves.
		return renderGoalContinuationNudge(goal, goalLimits());
	},
};

let bootstrapped = false;

/**
 * Subscribe the goal breakers to stream lifecycle events. Idempotent; called
 * once from main bootstrap alongside the other engine wiring.
 */
export function bootstrapGoalStreamBreakers(): void {
	if (bootstrapped) return;
	bootstrapped = true;
	const bus = getEventBus();

	// A new run supersedes any pending retry: whatever started it (user
	// message, retry kick, continuation) is now the goal's driver.
	bus.onAnySession(
		SESSION_EVENT_TYPES.STREAM_START,
		({ sessionId }) => {
			cancelGoalRetry(sessionId);
		},
		"goal-breaker",
	);

	bus.onAnySession(
		SESSION_EVENT_TYPES.STREAM_COMPLETE,
		({ sessionId, event }) => {
			lastUsageTick.delete(sessionId);
			try {
				if (event.data?.aborted) {
					cancelGoalRetry(sessionId);
					handleGoalAbort(sessionId);
				} else if (event.data?.error) {
					handleGoalStreamFailure(sessionId, event.data.error);
				} else {
					handleGoalRunSuccess(sessionId);
				}
			} catch (error) {
				console.error("[goals] stream:complete breaker failed:", error);
			}
		},
		"goal-breaker",
	);

	bus.onAnySession(
		SESSION_EVENT_TYPES.STREAM_ERROR,
		({ sessionId, event }) => {
			lastUsageTick.delete(sessionId);
			try {
				handleGoalStreamFailure(sessionId, event.data?.error ?? "stream error");
			} catch (error) {
				console.error("[goals] stream:error breaker failed:", error);
			}
		},
		"goal-breaker",
	);

	bus.onAnySession(
		SESSION_EVENT_TYPES.STREAM_ABORTED,
		({ sessionId }) => {
			lastUsageTick.delete(sessionId);
			try {
				cancelGoalRetry(sessionId);
				handleGoalAbort(sessionId);
			} catch (error) {
				console.error("[goals] stream:aborted breaker failed:", error);
			}
		},
		"goal-breaker",
	);

	// A permission prompt hands the clock to the user; drop the tick so the
	// approval wait is not billed as goal working time.
	bus.onAnySession(
		SESSION_EVENT_TYPES.PERMISSION_REQUEST,
		({ sessionId }) => {
			lastUsageTick.delete(sessionId);
		},
		"goal-breaker",
	);
}
