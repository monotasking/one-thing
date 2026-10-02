/**
 * Session TOC IPC types.
 *
 * Structural mirror of `packages/backend/runtime/toc/types.ts` (same
 * pattern as SessionGoal): the runtime package owns the canonical definition
 * and all transitions; these types only cross the IPC boundary.
 */

export type SessionSegmentKind = 'task' | 'question'
export type SessionSegmentOrigin = 'goal' | 'inferred'
export type SessionSegmentOutcome =
  | 'complete'
  | 'abandoned'
  | 'blocked'
  | 'budget_limited'
  | 'paused'

export interface SessionSegmentFile {
  path: string
  added: number
  removed: number
}

export interface SessionSegment {
  id: string
  origin: SessionSegmentOrigin
  kind: SessionSegmentKind
  title: string
  detail: string
  files: SessionSegmentFile[]
  startMessageId?: string
  endMessageId?: string
  startedAt: number
  endedAt?: number
  turnCount: number
  goalId?: string
  outcome?: SessionSegmentOutcome
  revision: number
}

export interface GetSessionSegmentsResponse {
  success: boolean
  segments: SessionSegment[]
}
