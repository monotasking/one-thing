/**
 * Folding a per-turn decision into the segment list.
 *
 * Segments are revised in place, not accumulated: `update` overwrites the
 * title and detail so the entry always reads as the work's current state.
 * That is the point of the feature — coming back to a session, you want the
 * conclusion, not the first impression (docs/design/session-toc.md §4).
 */
import type { TocDecision } from './decide.js'
import type { SessionSegment, SessionSegmentFile } from './types.js'

export interface ApplyTurnInput {
  decision: TocDecision
  messageId: string
  timestamp: number
  files: SessionSegmentFile[]
  /** Stable id for a newly opened segment; callers pass a uuid. */
  newSegmentId: string
}

function mergeFiles(
  existing: readonly SessionSegmentFile[],
  incoming: readonly SessionSegmentFile[],
): SessionSegmentFile[] {
  const byPath = new Map<string, SessionSegmentFile>()
  for (const file of [...existing, ...incoming]) {
    const current = byPath.get(file.path)
    if (current) {
      current.added += file.added
      current.removed += file.removed
    } else {
      byPath.set(file.path, { ...file })
    }
  }
  return Array.from(byPath.values())
}

/** The segment a turn should attach to: the newest inferred, still-open one. */
export function openSegmentOf(segments: readonly SessionSegment[]): SessionSegment | undefined {
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]
    // Goal segments are projections of a finished goal — never extended by a
    // later turn, or the projection and the goal record would disagree.
    if (segment && segment.origin === 'inferred') return segment
  }
  return undefined
}

/**
 * Returns a new segment list. `skip` still records the turn against the open
 * segment (files and end anchor move) — the turn happened, it just did not
 * change what the segment is about.
 */
export function applyTurnDecision(
  segments: readonly SessionSegment[],
  input: ApplyTurnInput,
): SessionSegment[] {
  const open = openSegmentOf(segments)
  const { decision } = input

  if (decision.action === 'skip' || (decision.action === 'update' && !open)) {
    if (!open) return [...segments]
    return segments.map(segment =>
      segment.id === open.id
        ? {
            ...segment,
            files: mergeFiles(segment.files, input.files),
            endMessageId: input.messageId,
            endedAt: input.timestamp,
            turnCount: segment.turnCount + 1,
          }
        : segment,
    )
  }

  if (decision.action === 'update' && open) {
    return segments.map(segment =>
      segment.id === open.id
        ? {
            ...segment,
            kind: decision.kind,
            title: decision.title,
            detail: decision.detail,
            files: mergeFiles(segment.files, input.files),
            endMessageId: input.messageId,
            endedAt: input.timestamp,
            turnCount: segment.turnCount + 1,
            revision: segment.revision + 1,
          }
        : segment,
    )
  }

  const opened: SessionSegment = {
    id: input.newSegmentId,
    origin: 'inferred',
    kind: decision.kind,
    title: decision.title,
    detail: decision.detail,
    files: [...input.files],
    startMessageId: input.messageId,
    endMessageId: input.messageId,
    startedAt: input.timestamp,
    endedAt: input.timestamp,
    turnCount: 1,
    revision: 0,
  }
  return [...segments, opened]
}
