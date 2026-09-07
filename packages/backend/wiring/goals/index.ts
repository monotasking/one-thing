/**
 * GoalManager — the single writer for session goals.
 *
 * Every mutation (renderer IPC, the goal tool, engine accounting, error/abort
 * breakers) funnels through here so meta.json sees one writer and the
 * renderer always hears about changes via `session:goal-updated`.
 *
 * Accounting is batched: per-turn usage accumulates in memory and is flushed
 * to disk on status changes, continuations, and run end — meta.json is a
 * whole-file write, so per-token persistence would be pure write
 * amplification.
 */
import { randomUUID } from "node:crypto";
import {
	abandonGoal,
	applyGoalSettlement,
	applyGoalUsage,
	applyModelGoalStatus,
	applyUserGoalUpdate,
	canAutoContinueGoal,
	clearGoalErrorStreak,
	createSessionGoal,
	currentGoalOf,
	GoalStateError,
	isGoalUnfinished,
	mergeGoalRecord,
	normalizeGoalRecords,
	pauseGoalAfterAbort,
	pauseGoalAtContinuationLimit,
	pruneGoalHistory,
	recordGoalContinuation,
	recordGoalRunError,
} from "@onething/runtime/goals";
import type { SessionGoal, SessionGoalLimits } from "@onething/runtime/goals";
import { getEventBus } from "../../events/index.js";
import * as store from "../../store.js";
import { sessionReads } from "../../session/reads.js";
import { getCurrentBackendInstance } from '../../current.js';

import { SESSION_EVENT_TYPES } from "@shared/events/index.js";
import { getLogger } from '../logging/index.js'

const log = getLogger('goals')


const pendingUsage = new Map<string, { tokens: number; seconds: number }>();

// Model rounds observed since the last automatic continuation. More than one
// round means the push led to real work (tool loops), not an immediate stop —
// the stall streak resets. In-memory only: after a restart the next
// continuation counts as unproductive once, which only errs toward caution.
const roundsSinceContinuation = new Map<string, number>();

export function goalLimits(): SessionGoalLimits {
	const chat = store.getSettings().chat;
	return {
		continuationLimit: chat?.goalContinuationLimit,
		defaultTokenBudget: chat?.goalDefaultTokenBudget,
		errorRetryLimit: chat?.goalErrorRetryLimit,
	};
}

/** Last message in the session — the timeline anchor for goal transitions. */
function lastMessageId(sessionId: string): string | undefined {
	const messages = sessionReads.listMessages(sessionId).messages;
	if (messages.length === 0) return undefined;
	return messages[messages.length - 1]?.id;
}

/**
 * The session's goal history, reconciled across the v2 scalar and the v3
 * array. Read through this rather than touching the session fields directly.
 */
function storedGoals(sessionId: string): SessionGoal[] {
	const session = store.getSession(sessionId) as
		| { goal?: SessionGoal; goals?: SessionGoal[] }
		| undefined;
	if (!session) return [];
	return normalizeGoalRecords(session.goals, session.goal);
}

/**
 * Folds a mutated goal back into the history and writes the whole list.
 *
 * Keeping the `SessionGoal | null` signature is what lets every caller above
 * stay untouched: they still think in terms of "the current goal", and the
 * array lives entirely below this line. The settlement anchor is stamped here
 * too, so every transition path gets it without seven separate edits.
 */
function persistGoal(sessionId: string, goal: SessionGoal | null): void {
	const previous = currentGoalOf(storedGoals(sessionId));
	const settled =
		goal === null
			? null
			: applyGoalSettlement(previous, goal, Date.now(), {
					messageId: lastMessageId(sessionId),
				});

	const goals = pruneGoalHistory(mergeGoalRecord(storedGoals(sessionId), settled));
	const current = currentGoalOf(goals) ?? null;
	store.updateSessionGoals(sessionId, goals, current);
	try {
		getEventBus().emit(sessionId, { type: SESSION_EVENT_TYPES.SESSION_GOAL_UPDATED, goal: settled, goals });
	} catch (error) {
		log.error("emit goal updated failed", { sessionId }, error);
	}
}

/**
 * Amends a record in place without touching the settlement anchor.
 *
 * Used for after-the-fact enrichment of an already-finished goal (the
 * fileChanges backfill). Going through persistGoal would compare it against
 * whatever goal is *current* now and could stamp a bogus endedAt on it.
 */
function persistGoalRecord(sessionId: string, goal: SessionGoal): void {
	const goals = pruneGoalHistory(mergeGoalRecord(storedGoals(sessionId), goal));
	store.updateSessionGoals(sessionId, goals, currentGoalOf(goals) ?? null);
	try {
		getEventBus().emit(sessionId, { type: SESSION_EVENT_TYPES.SESSION_GOAL_UPDATED, goal, goals });
	} catch (error) {
		log.error("emit goal updated failed", { sessionId }, error);
	}
}

function storedGoal(sessionId: string): SessionGoal | undefined {
	return currentGoalOf(storedGoals(sessionId));
}

/** The session's full goal history, oldest first. */
export function getGoals(sessionId: string): SessionGoal[] {
	return storedGoals(sessionId);
}

/** Stored goal plus any unflushed accounting — what prompts should render. */
export function getGoal(sessionId: string): SessionGoal | undefined {
	const goal = storedGoal(sessionId);
	if (!goal) return undefined;
	const pending = pendingUsage.get(sessionId);
	if (!pending || goal.status !== "active") return goal;
	return applyGoalUsage(goal, pending, goal.updatedAt, goalLimits());
}

export function createGoal(
	sessionId: string,
	input: { objective: string; tokenBudget?: number },
): SessionGoal {
	if (!store.getSession(sessionId)) {
		throw new GoalStateError("Session not found");
	}
	const existing = storedGoal(sessionId);
	if (isGoalUnfinished(existing)) {
		throw new GoalStateError(
			"This session already has an unfinished goal; complete or clear it first",
		);
	}
	pendingUsage.delete(sessionId);
	roundsSinceContinuation.delete(sessionId);
	const goal = createSessionGoal({
		id: randomUUID(),
		objective: input.objective,
		tokenBudget: input.tokenBudget,
		now: Date.now(),
	});
	const anchored: SessionGoal = { ...goal, startMessageId: lastMessageId(sessionId) };
	persistGoal(sessionId, anchored);
	return anchored;
}

export function updateGoalFromUser(
	sessionId: string,
	update: { status?: "active" | "paused"; objective?: string; tokenBudget?: number | null },
): SessionGoal {
	flushUsage(sessionId);
	const goal = storedGoal(sessionId);
	if (!goal) throw new GoalStateError("No goal is set for this session");
	const next = applyUserGoalUpdate(goal, update, Date.now());
	persistGoal(sessionId, next);
	return next;
}

/**
 * The user giving up on the current goal. Archives rather than deletes: the
 * record — objective, reason it stalled, files it touched — is exactly the
 * "unfinished business" worth keeping, and it is the only trace that this
 * stretch of the session happened at all.
 */
export function clearGoal(sessionId: string, reason?: string): void {
	pendingUsage.delete(sessionId);
	roundsSinceContinuation.delete(sessionId);
	const goal = storedGoal(sessionId);
	if (!goal) return;
	persistGoal(sessionId, abandonGoal(goal, Date.now(), reason));
}

/** The goal tool's path: only 'complete' | 'paused' pass validation. */
export function updateGoalFromModel(
	sessionId: string,
	status: string,
	reason?: string,
): SessionGoal {
	flushUsage(sessionId);
	const goal = storedGoal(sessionId);
	if (!goal) throw new GoalStateError("No goal is set for this session");
	const next = applyModelGoalStatus(goal, status, Date.now(), reason);
	persistGoal(sessionId, next);
	if (next.status === "complete") {
		const owner = getCurrentBackendInstance();
		try {
			if (owner) void owner.runTask('goalFileChangeSummary', () => enrichCompletedGoalWithFileChanges(sessionId, next))
				.catch(error => log.error('goal file-change summary failed', { sessionId }, error));
		} catch (error) {
			log.error('goal file-change summary admission closed', { sessionId }, error);
		}
	}
	return next;
}

/**
 * Fills in the numstat summary after completion. Async and best-effort: the
 * completion itself is already persisted; the enriched goal lands as a
 * second goal-updated event when the audit scan finishes. Skipped if the
 * goal changed in the meantime.
 */
async function enrichCompletedGoalWithFileChanges(
	sessionId: string,
	completed: SessionGoal,
): Promise<void> {
	try {
		const { collectGoalFileChanges } = await import("./file-changes.js");
		const fileChanges = await collectGoalFileChanges(
			sessionId,
			completed.createdAt,
		);
		if (fileChanges.length === 0) return;
		// Look the goal up by id, not through storedGoal(): a completed goal is
		// terminal, so it is no longer the *current* one — and by now the user
		// may already have started the next goal.
		const record = storedGoals(sessionId).find(goal => goal.id === completed.id);
		if (!record || record.status !== "complete") return;
		persistGoalRecord(sessionId, { ...record, fileChanges });
	} catch (error) {
		log.error("goal file-change summary failed", { sessionId }, error);
	}
}

/**
 * Accumulate per-turn usage. Persists only when the budget flip fires;
 * returns the flip so the engine can inject the wrap-up notice exactly once.
 */
export function recordGoalUsage(
	sessionId: string,
	delta: { tokens?: number; seconds?: number },
): { goal: SessionGoal; becameBudgetLimited: boolean } | undefined {
	const goal = storedGoal(sessionId);
	if (!goal || goal.status !== "active") return undefined;
	roundsSinceContinuation.set(
		sessionId,
		(roundsSinceContinuation.get(sessionId) ?? 0) + 1,
	);
	const pending = pendingUsage.get(sessionId) ?? { tokens: 0, seconds: 0 };
	pending.tokens += Math.max(delta.tokens ?? 0, 0);
	pending.seconds += Math.max(delta.seconds ?? 0, 0);
	pendingUsage.set(sessionId, pending);

	const projected = applyGoalUsage(goal, pending, Date.now(), goalLimits());
	if (projected.status === "budget_limited") {
		const flagged: SessionGoal = { ...projected, budgetLimitReported: true };
		pendingUsage.delete(sessionId);
		persistGoal(sessionId, flagged);
		return { goal: flagged, becameBudgetLimited: !goal.budgetLimitReported };
	}
	return { goal: projected, becameBudgetLimited: false };
}

export function flushUsage(sessionId: string): void {
	const pending = pendingUsage.get(sessionId);
	if (!pending) return;
	pendingUsage.delete(sessionId);
	const goal = storedGoal(sessionId);
	if (!goal || goal.status !== "active") return;
	persistGoal(sessionId, applyGoalUsage(goal, pending, Date.now(), goalLimits()));
}

/** Final accounting runs before the shared metadata and journal flush. */
export function flushGoalRuntimeUsage(): void {
	for (const sessionId of pendingUsage.keys()) flushUsage(sessionId);
}

/** Invoked after accepted work and final accounting, never to hide in-flight work. */
export function disposeGoalRuntimeState(): void {
	pendingUsage.clear();
	roundsSinceContinuation.clear();
}

/**
 * Called when the agent produced a final reply and the run would end.
 * Returns the goal to continue toward, with the continuation recorded, or
 * undefined when no continuation may happen (also parks the goal at the cap).
 */
export function tryBeginContinuation(sessionId: string): SessionGoal | undefined {
	flushUsage(sessionId);
	const goal = storedGoal(sessionId);
	if (!goal) return undefined;
	if (!canAutoContinueGoal(goal, goalLimits())) {
		if (goal.status === "active") {
			const parked = pauseGoalAtContinuationLimit(goal, Date.now(), goalLimits());
			if (parked !== goal) persistGoal(sessionId, parked);
		}
		return undefined;
	}
	// More rounds than the single stop-reply itself = the previous push led
	// to real work; the stall streak restarts instead of accumulating.
	const madeProgress = (roundsSinceContinuation.get(sessionId) ?? 0) > 1;
	roundsSinceContinuation.set(sessionId, 0);
	const next = recordGoalContinuation(goal, Date.now(), { madeProgress });
	persistGoal(sessionId, next);
	return next;
}

/**
 * Breaker with a bounded retry streak: transient failures (network errors,
 * provider hiccups) keep the goal active and report whether the caller may
 * schedule a retry; past the limit the goal blocks (burn guard).
 */
export function handleGoalRunError(
	sessionId: string,
	error: string,
): { willRetry: boolean; attempt: number } | undefined {
	flushUsage(sessionId);
	const goal = storedGoal(sessionId);
	if (!goal) return undefined;
	const { goal: next, willRetry } = recordGoalRunError(
		goal,
		error,
		Date.now(),
		goalLimits(),
	);
	if (next !== goal) persistGoal(sessionId, next);
	return { willRetry, attempt: next.errorRetryCount ?? 0 };
}

/** A run finished cleanly — close out any transient-error retry streak. */
export function handleGoalRunSuccess(sessionId: string): void {
	flushUsage(sessionId);
	const goal = storedGoal(sessionId);
	if (!goal) return;
	const next = clearGoalErrorStreak(goal, Date.now());
	if (next !== goal) persistGoal(sessionId, next);
}

/** The user hit stop — park the goal; never auto-resume after an abort. */
export function handleGoalAbort(sessionId: string): void {
	flushUsage(sessionId);
	const goal = storedGoal(sessionId);
	if (!goal) return;
	const next = pauseGoalAfterAbort(goal, Date.now());
	if (next !== goal) persistGoal(sessionId, next);
}
