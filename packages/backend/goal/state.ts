/**
 * Pure state transitions for session goals. Every mutation of a SessionGoal
 * goes through these functions so the ownership rules (model vs user vs
 * system) and the budget flip live in one testable place.
 */
import { isGoalTerminal } from './records.js'
import {
  DEFAULT_GOAL_CONTINUATION_LIMIT,
  DEFAULT_GOAL_ERROR_RETRY_LIMIT,
  GOAL_MODEL_SETTABLE_STATUSES,
} from './types.js'
import type {
  GoalModelSettableStatus,
  SessionGoal,
  SessionGoalLimits,
  SessionGoalStatus,
} from './types.js'

export class GoalStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoalStateError'
  }
}

const MAX_OBJECTIVE_LENGTH = 4000

export function validateGoalObjective(objective: string): string {
  const trimmed = objective.trim()
  if (!trimmed) {
    throw new GoalStateError('Goal objective cannot be empty')
  }
  if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
    throw new GoalStateError(`Goal objective exceeds ${MAX_OBJECTIVE_LENGTH} characters`)
  }
  return trimmed
}

export function validateGoalTokenBudget(budget: number | undefined): number | undefined {
  if (budget === undefined) return undefined
  if (!Number.isFinite(budget) || !Number.isInteger(budget) || budget <= 0) {
    throw new GoalStateError('Goal token budget must be a positive integer')
  }
  return budget
}

export function createSessionGoal(input: {
  id: string
  objective: string
  tokenBudget?: number
  now: number
}): SessionGoal {
  return {
    id: input.id,
    objective: validateGoalObjective(input.objective),
    status: 'active',
    tokenBudget: validateGoalTokenBudget(input.tokenBudget),
    tokensUsed: 0,
    timeUsedSeconds: 0,
    continuationCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
  }
}

/**
 * A goal blocks creating a new one until it reaches a terminal status.
 * paused / blocked / budget_limited deliberately count as unfinished: all
 * three are resumable and must not be silently displaced. Terminal goals step
 * aside but are kept as history (see ./records.ts).
 */
export function isGoalUnfinished(goal: SessionGoal | undefined): boolean {
  return goal !== undefined && !isGoalTerminal(goal)
}

/**
 * The user giving up on a goal. This is the second exit besides 'complete' —
 * the pressure valve for a goal stalled at blocked / budget_limited that the
 * user neither wants to resume nor can honestly call done. Unlike the v2
 * `clearGoal`, it preserves the record: an abandoned goal is exactly the
 * "unfinished business" signal worth keeping.
 */
export function abandonGoal(
  goal: SessionGoal,
  now: number,
  reason?: string,
): SessionGoal {
  if (isGoalTerminal(goal)) return goal
  return {
    ...goal,
    status: 'abandoned',
    statusReason: reason ?? goal.statusReason,
    updatedAt: now,
  }
}

/**
 * Stamps the settlement anchor (`endedAt` / `endMessageId`) on a transition.
 *
 * Called once from the single writer rather than from each transition, so
 * every path — model, user, budget flip, error breaker, abort — is covered
 * without seven separate edits that could drift apart.
 *
 * Only the active⇄non-active edge moves the anchor. A goal that goes
 * paused → abandoned keeps the pause timestamp: that is when the work
 * stopped, not when the user got around to writing it off.
 */
export function applyGoalSettlement(
  previous: SessionGoal | undefined,
  next: SessionGoal,
  now: number,
  anchor?: { messageId?: string },
): SessionGoal {
  const wasActive = previous?.status === 'active'
  const isActive = next.status === 'active'

  if (wasActive && !isActive) {
    return { ...next, endedAt: now, endMessageId: anchor?.messageId ?? next.endMessageId }
  }
  if (!wasActive && isActive) {
    const resumed = { ...next }
    delete resumed.endedAt
    delete resumed.endMessageId
    return resumed
  }
  return next
}

/**
 * The budget that actually applies: per-goal value, else the optional
 * settings-level default cap, else none — an uncapped goal never flips to
 * budget_limited.
 */
export function effectiveGoalTokenBudget(
  goal: SessionGoal,
  limits?: SessionGoalLimits,
): number | undefined {
  return goal.tokenBudget ?? limits?.defaultTokenBudget
}

/** Remaining tokens against the effective budget; undefined when uncapped. */
export function remainingGoalTokens(
  goal: SessionGoal,
  limits?: SessionGoalLimits,
): number | undefined {
  const budget = effectiveGoalTokenBudget(goal, limits)
  if (budget === undefined) return undefined
  return Math.max(budget - goal.tokensUsed, 0)
}

/** codex status_after_budget_limit: only an active goal flips on overrun. */
function statusAfterBudgetLimit(
  status: SessionGoalStatus,
  tokensUsed: number,
  budget: number | undefined,
): SessionGoalStatus {
  return status === 'active' && budget !== undefined && tokensUsed >= budget
    ? 'budget_limited'
    : status
}

/** Accumulate usage; flips active → budget_limited when the cap is reached. */
export function applyGoalUsage(
  goal: SessionGoal,
  delta: { tokens?: number; seconds?: number },
  now: number,
  limits?: SessionGoalLimits,
): SessionGoal {
  const tokensUsed = goal.tokensUsed + Math.max(delta.tokens ?? 0, 0)
  const timeUsedSeconds = goal.timeUsedSeconds + Math.max(delta.seconds ?? 0, 0)
  return {
    ...goal,
    tokensUsed,
    timeUsedSeconds,
    status: statusAfterBudgetLimit(goal.status, tokensUsed, effectiveGoalTokenBudget(goal, limits)),
    updatedAt: now,
  }
}

/**
 * Model-side transition: the declaration protocol allows complete (with the
 * delivery summary as reason) and paused (with what it needs as reason).
 * Resume and budgets stay user-controlled; 'blocked' stays system-only.
 */
export function applyModelGoalStatus(
  goal: SessionGoal,
  status: string,
  now: number,
  reason?: string,
): SessionGoal {
  if (!(GOAL_MODEL_SETTABLE_STATUSES as readonly string[]).includes(status)) {
    throw new GoalStateError(
      'The goal tool can only mark the goal complete or paused; resume and budgets are controlled by the user',
    )
  }
  if (isGoalTerminal(goal)) {
    throw new GoalStateError(
      goal.status === 'complete'
        ? 'Goal is already complete'
        : 'Goal was abandoned; set a new goal instead',
    )
  }
  return {
    ...goal,
    status: status as GoalModelSettableStatus,
    statusReason: reason?.trim() || undefined,
    updatedAt: now,
  }
}

/**
 * User-side transitions (/goal command, IPC): pause/resume, edit objective,
 * change budget. Resume re-arms a blocked/limited goal and resets the
 * continuation counter so the fresh run gets a full allowance.
 */
export function applyUserGoalUpdate(
  goal: SessionGoal,
  update: {
    status?: 'active' | 'paused'
    objective?: string
    tokenBudget?: number | null
  },
  now: number,
): SessionGoal {
  const next: SessionGoal = { ...goal, updatedAt: now }
  if (update.objective !== undefined) {
    next.objective = validateGoalObjective(update.objective)
  }
  if (update.tokenBudget !== undefined) {
    next.tokenBudget =
      update.tokenBudget === null ? undefined : validateGoalTokenBudget(update.tokenBudget)
    // A raised budget un-flips a budget-limited goal only through resume below.
  }
  if (update.status !== undefined) {
    if (isGoalTerminal(goal)) {
      throw new GoalStateError(
        goal.status === 'complete'
          ? 'Goal is already complete; set a new goal instead'
          : 'Goal was abandoned; set a new goal instead',
      )
    }
    next.status = update.status
    if (update.status === 'active') {
      next.continuationCount = 0
      next.statusReason = undefined
      next.budgetLimitReported = undefined
      next.errorRetryCount = undefined
    }
  }
  return next
}

/** System-side transition: a run that ended in an error trips the breaker. */
export function blockGoalAfterError(goal: SessionGoal, error: string, now: number): SessionGoal {
  if (goal.status !== 'active') return goal
  return { ...goal, status: 'blocked', statusReason: error, updatedAt: now }
}

export function goalErrorRetryLimit(limits?: SessionGoalLimits): number {
  return limits?.errorRetryLimit ?? DEFAULT_GOAL_ERROR_RETRY_LIMIT
}

/**
 * A run ended in an error (network failure, provider error, ...). Transient
 * failures get a bounded retry streak before the breaker trips: while the
 * streak is under the limit the goal stays active with a visible retry
 * marker; past the limit it blocks with the error as the reason.
 */
export function recordGoalRunError(
  goal: SessionGoal,
  error: string,
  now: number,
  limits?: SessionGoalLimits,
): { goal: SessionGoal; willRetry: boolean } {
  if (goal.status !== 'active') return { goal, willRetry: false }
  const limit = goalErrorRetryLimit(limits)
  const attempt = (goal.errorRetryCount ?? 0) + 1
  if (attempt > limit) {
    return { goal: blockGoalAfterError(goal, error, now), willRetry: false }
  }
  return {
    goal: {
      ...goal,
      errorRetryCount: attempt,
      statusReason: `Retrying after error (${attempt}/${limit}): ${error}`,
      updatedAt: now,
    },
    willRetry: true,
  }
}

/** A run finished cleanly — the transient-error streak is over. */
export function clearGoalErrorStreak(goal: SessionGoal, now: number): SessionGoal {
  if (goal.errorRetryCount === undefined) return goal
  const next: SessionGoal = { ...goal, updatedAt: now }
  delete next.errorRetryCount
  if (goal.status === 'active') next.statusReason = undefined
  return next
}

/** System-side transition: the user stopped the stream — never auto-resume. */
export function pauseGoalAfterAbort(goal: SessionGoal, now: number): SessionGoal {
  if (goal.status !== 'active') return goal
  return { ...goal, status: 'paused', statusReason: 'Stopped by user', updatedAt: now }
}

export function goalContinuationLimit(limits?: SessionGoalLimits): number {
  return limits?.continuationLimit ?? DEFAULT_GOAL_CONTINUATION_LIMIT
}

/** Whether the engine may push the agent again after it stopped. */
export function canAutoContinueGoal(
  goal: SessionGoal | undefined,
  limits?: SessionGoalLimits,
): boolean {
  return (
    goal !== undefined &&
    goal.status === 'active' &&
    goal.continuationCount < goalContinuationLimit(limits)
  )
}

/**
 * Register one automatic continuation. `madeProgress` means real work
 * happened since the previous push (more model rounds than just the stop
 * itself) — the stall streak restarts at 1 instead of accumulating, so the
 * limit only parks goals that keep stopping the moment they are pushed.
 */
export function recordGoalContinuation(
  goal: SessionGoal,
  now: number,
  options: { madeProgress?: boolean } = {},
): SessionGoal {
  const continuationCount = options.madeProgress ? 1 : goal.continuationCount + 1
  return { ...goal, continuationCount, updatedAt: now }
}

/** Continuation allowance exhausted → park the goal instead of looping. */
export function pauseGoalAtContinuationLimit(
  goal: SessionGoal,
  now: number,
  limits?: SessionGoalLimits,
): SessionGoal {
  if (goal.status !== 'active' || goal.continuationCount < goalContinuationLimit(limits)) {
    return goal
  }
  return {
    ...goal,
    status: 'paused',
    statusReason: 'Automatic continuation limit reached',
    updatedAt: now,
  }
}
