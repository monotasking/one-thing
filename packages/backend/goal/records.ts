/**
 * Goal *list* operations — pure functions over a session's goal history.
 *
 * A session stores `goals: SessionGoal[]` (ascending by createdAt). The
 * "current" goal is derived, not stored: the last record that has not reached
 * a terminal status. The invariant "at most one unfinished goal per session"
 * is preserved from v1; what changed in v3 is that stepping aside no longer
 * means being deleted.
 *
 * See docs/design/goal-system-v3.md.
 */
import { TERMINAL_GOAL_STATUSES } from './types.js'
import type { SessionGoal } from './types.js'

/**
 * How many trailing records keep their full `fileChanges` table. Goal writes
 * are whole-file meta.json rewrites, and a large goal can touch dozens of
 * files, so older history keeps only the counts.
 */
export const GOAL_HISTORY_FILE_CHANGE_LIMIT = 10

export function isGoalTerminal(goal: SessionGoal | undefined): boolean {
  if (!goal) return false
  return (TERMINAL_GOAL_STATUSES as readonly string[]).includes(goal.status)
}

/**
 * The goal the session is currently working toward (or stalled on). Scans from
 * the end so a malformed list with several non-terminal records still yields
 * the newest one rather than a stale entry.
 */
export function currentGoalOf(goals: readonly SessionGoal[]): SessionGoal | undefined {
  for (let i = goals.length - 1; i >= 0; i--) {
    const goal = goals[i]
    if (goal && !isGoalTerminal(goal)) return goal
  }
  return undefined
}

/**
 * Read-time normalization across the v2 (`goal`) and v3 (`goals`) shapes.
 *
 * Both fields are written during the transition window, so a session that has
 * been through an older build can disagree with itself. The legacy scalar wins
 * on conflict: it is what an old build would have just written, and treating
 * it as authoritative is what makes a downgrade/upgrade round trip lossless.
 */
export function normalizeGoalRecords(
  goals: readonly SessionGoal[] | undefined,
  legacyGoal: SessionGoal | undefined,
): SessionGoal[] {
  const list = Array.isArray(goals) ? goals.filter(Boolean) : []
  if (list.length === 0) return legacyGoal ? [legacyGoal] : []
  if (!legacyGoal) return [...list]

  const index = list.findIndex(goal => goal.id === legacyGoal.id)
  // Unknown id: an old build created a goal the array never saw. Its position
  // is the tail — an old build can only ever have written the current goal.
  if (index === -1) return [...list, legacyGoal]

  const merged = [...list]
  merged[index] = legacyGoal
  return merged
}

/**
 * Fold a mutated goal back into the history. Replaces the record with the same
 * id, or appends when it is new. `null` drops the current goal outright — the
 * repository-level delete path; ordinary "give up on this goal" flows archive
 * it instead (see abandonGoal) so the record survives.
 */
export function mergeGoalRecord(
  goals: readonly SessionGoal[],
  next: SessionGoal | null,
): SessionGoal[] {
  if (next === null) return goals.filter(goal => isGoalTerminal(goal))
  const index = goals.findIndex(goal => goal.id === next.id)
  if (index === -1) return [...goals, next]
  const merged = [...goals]
  merged[index] = next
  return merged
}

/**
 * Trim `fileChanges` off all but the most recent records. Applied on write, so
 * meta.json does not grow without bound on a long-lived session.
 */
export function pruneGoalHistory(
  goals: readonly SessionGoal[],
  limit: number = GOAL_HISTORY_FILE_CHANGE_LIMIT,
): SessionGoal[] {
  if (goals.length <= limit) return [...goals]
  const cutoff = goals.length - limit
  return goals.map((goal, index) => {
    if (index >= cutoff || !goal.fileChanges) return goal
    const { fileChanges: _dropped, ...rest } = goal
    return rest
  })
}
