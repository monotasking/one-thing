/**
 * Building session segments without asking a model anything.
 *
 * Two sources, and the difference in trust matters (docs/design/session-toc.md §3):
 *
 * - **Goal segments** are projected straight from the goal history. The
 *   objective is what the user themselves declared, the outcome is what the
 *   engine observed. Zero inference, zero cost.
 * - **Coarse segments** cover everything else, cut on free signals only
 *   (user absence, disjoint file sets). Titles come from the first user
 *   message rather than a model.
 *
 * The coarse pass exists to answer "is segmenting even the right idea" before
 * any money is spent on naming. Deciding *where* segments break and deciding
 * *what to call them* are separate problems; mixing them makes a bad result
 * impossible to attribute.
 */
import type { SessionGoal } from '../goals/types.js'
import type {
  SessionSegment,
  SessionSegmentFile,
  SessionSegmentOutcome,
} from './types.js'

/**
 * A user is "away" if this much wall-clock passed between the agent finishing
 * and them speaking again. Measured from the last assistant message, NOT from
 * the previous user message: an agent can work for hours on one instruction,
 * and user-to-user spacing would read that as a new intent.
 */
export const DEFAULT_ABSENCE_GAP_MS = 30 * 60 * 1000

export interface SegmentSourceMessage {
  id: string
  role: string
  content: string
  timestamp: number
  /** Marks engine-injected drives (goal continuation, radio) — never a boundary. */
  source?: string
}

export interface SegmentSourceTurn {
  /** The user message that opened the turn. */
  userMessage: SegmentSourceMessage
  /** Last message produced while answering it, if any. */
  lastAssistantMessage?: SegmentSourceMessage
  files: SessionSegmentFile[]
}

/**
 * Synthetic user messages the engine injects to re-drive itself. They look
 * exactly like user turns in the transcript, so without filtering them a goal
 * that continued ten times would shatter into ten segments.
 */
export function isEngineDrivenMessage(message: SegmentSourceMessage): boolean {
  return message.source === 'goal' || message.source === 'radio'
}

function titleFromMessage(content: string, maxLength = 48): string {
  const cleaned = content.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength).trim()}…`
}

function outcomeFromGoalStatus(status: string): SessionSegmentOutcome | undefined {
  switch (status) {
    case 'complete':
    case 'abandoned':
    case 'blocked':
    case 'budget_limited':
    case 'paused':
      return status
    default:
      return undefined
  }
}

/**
 * Projects the goal history into segments. A goal that is still active is
 * skipped: its stretch of the session has not finished yet, and showing it
 * as a settled entry would be a lie.
 */
export function segmentsFromGoals(goals: readonly SessionGoal[]): SessionSegment[] {
  const segments: SessionSegment[] = []
  for (const goal of goals) {
    if (goal.status === 'active') continue
    segments.push({
      id: `goal:${goal.id}`,
      origin: 'goal',
      kind: 'task',
      title: titleFromMessage(goal.objective, 72),
      detail: goal.statusReason?.trim() || '',
      files: (goal.fileChanges ?? []).map(change => ({
        path: change.path,
        added: change.added,
        removed: change.removed,
      })),
      startMessageId: goal.startMessageId,
      endMessageId: goal.endMessageId,
      startedAt: goal.createdAt,
      endedAt: goal.endedAt ?? goal.updatedAt,
      turnCount: 0,
      goalId: goal.id,
      outcome: outcomeFromGoalStatus(goal.status),
      revision: 0,
    })
  }
  return segments
}

/** Did the user step away between the agent finishing and speaking again? */
export function userWasAway(
  previousTurn: SegmentSourceTurn,
  nextTurn: SegmentSourceTurn,
  gapMs: number = DEFAULT_ABSENCE_GAP_MS,
): boolean {
  const agentDoneAt =
    previousTurn.lastAssistantMessage?.timestamp ?? previousTurn.userMessage.timestamp
  return nextTurn.userMessage.timestamp - agentDoneAt >= gapMs
}

/** Two turns that touched no file in common are probably two different jobs. */
export function touchesDisjointFiles(
  previousTurn: SegmentSourceTurn,
  nextTurn: SegmentSourceTurn,
): boolean {
  if (previousTurn.files.length === 0 || nextTurn.files.length === 0) return false
  const seen = new Set(previousTurn.files.map(file => file.path))
  return !nextTurn.files.some(file => seen.has(file.path))
}

/**
 * Should a new segment start at `nextTurn`?
 *
 * Both signals are free. Neither is conclusive on its own, which is exactly
 * why this pass is labelled coarse — it is a probe for whether the segment
 * boundaries look right at all, not the final answer.
 */
export function startsNewSegment(
  previousTurn: SegmentSourceTurn,
  nextTurn: SegmentSourceTurn,
  gapMs: number = DEFAULT_ABSENCE_GAP_MS,
): boolean {
  return userWasAway(previousTurn, nextTurn, gapMs) || touchesDisjointFiles(previousTurn, nextTurn)
}

function mergeFiles(turns: readonly SegmentSourceTurn[]): SessionSegmentFile[] {
  const byPath = new Map<string, SessionSegmentFile>()
  for (const turn of turns) {
    for (const file of turn.files) {
      const existing = byPath.get(file.path)
      if (existing) {
        existing.added += file.added
        existing.removed += file.removed
      } else {
        byPath.set(file.path, { ...file })
      }
    }
  }
  return Array.from(byPath.values())
}

function segmentFromTurns(turns: SegmentSourceTurn[], index: number): SessionSegment {
  const first = turns[0]!
  const last = turns[turns.length - 1]!
  const files = mergeFiles(turns)
  return {
    id: `coarse:${first.userMessage.id}:${index}`,
    origin: 'inferred',
    // No files touched anywhere in the stretch reads as discussion rather than
    // work. Crude, but it keeps "I only asked a question" from looking like a
    // task that produced nothing.
    kind: files.length > 0 ? 'task' : 'question',
    title: titleFromMessage(first.userMessage.content),
    detail: '',
    files,
    startMessageId: first.userMessage.id,
    endMessageId: last.lastAssistantMessage?.id ?? last.userMessage.id,
    startedAt: first.userMessage.timestamp,
    endedAt: last.lastAssistantMessage?.timestamp ?? last.userMessage.timestamp,
    turnCount: turns.length,
    revision: 0,
  }
}

/**
 * The zero-model pass: group turns into segments on free signals alone.
 * Engine-driven turns are folded into whatever segment precedes them.
 */
export function coarseSegments(
  turns: readonly SegmentSourceTurn[],
  gapMs: number = DEFAULT_ABSENCE_GAP_MS,
): SessionSegment[] {
  const real = turns.filter(turn => !isEngineDrivenMessage(turn.userMessage))
  if (real.length === 0) return []

  const segments: SessionSegment[] = []
  let current: SegmentSourceTurn[] = [real[0]!]

  for (let i = 1; i < real.length; i++) {
    const turn = real[i]!
    if (startsNewSegment(current[current.length - 1]!, turn, gapMs)) {
      segments.push(segmentFromTurns(current, segments.length))
      current = [turn]
    } else {
      current.push(turn)
    }
  }
  segments.push(segmentFromTurns(current, segments.length))
  return segments
}

/**
 * Merge goal-backed and coarse segments into one timeline.
 *
 * Goal segments win where they overlap: they are recorded fact, the coarse
 * pass is guesswork. A coarse segment is dropped when it starts inside a
 * goal's span rather than being trimmed — a partial segment would claim a
 * boundary the free signals never actually established.
 */
export function mergeSegments(
  goalSegments: readonly SessionSegment[],
  coarse: readonly SessionSegment[],
): SessionSegment[] {
  const spans = goalSegments
    .map(segment => ({ start: segment.startedAt, end: segment.endedAt ?? segment.startedAt }))
    .filter(span => span.end >= span.start)

  const kept = coarse.filter(
    segment => !spans.some(span => segment.startedAt >= span.start && segment.startedAt <= span.end),
  )

  return [...goalSegments, ...kept].sort((a, b) => a.startedAt - b.startedAt)
}
