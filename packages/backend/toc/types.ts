/**
 * Session TOC — a session's work broken into intent segments.
 *
 * A segment answers "what was I doing here": a title, one line of detail, the
 * files it touched, and anchors to jump back to. See docs/design/session-toc.md.
 */

export type SessionSegmentKind = 'task' | 'question'

/**
 * How a segment came to exist. This is a trust marker, not bookkeeping:
 * 'goal' segments are projected from facts the engine recorded, 'inferred'
 * ones are a model's reading of the conversation. The UI treats them
 * differently — only goal segments may show an outcome.
 */
export type SessionSegmentOrigin = 'goal' | 'inferred'

/**
 * Terminal states a goal-backed segment can carry. `blocked` and
 * `budget_limited` are set by the engine from observed facts; `complete` is
 * the model's own claim and `abandoned` is the user's.
 */
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
  /** One line: what this stretch of the session was about. */
  title: string
  /** One or two sentences of substance. Empty is allowed. */
  detail: string
  /** Files this segment touched, derived from the mutation audit trail. */
  files: SessionSegmentFile[]
  startMessageId?: string
  endMessageId?: string
  startedAt: number
  endedAt?: number
  turnCount: number
  /** Set only on goal-backed segments — never inferred. */
  goalId?: string
  outcome?: SessionSegmentOutcome
  /** How many times a model revised this description. */
  revision: number
}

/** A segment plus the position the UI should anchor it at. */
export interface AnchoredSessionSegment extends SessionSegment {
  anchorIndex: number
}
