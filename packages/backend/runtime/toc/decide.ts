/**
 * The per-turn decision: does this turn extend the current segment, open a new
 * one, or not deserve a model call at all.
 *
 * The free gate (`isTrivialTurn`) runs before any spend — a turn with no tool
 * work and a short message is folded into the current segment for nothing.
 * The known hole is "short message, big pivot" ("change of plan"), which is
 * exactly what the reasoning rule in ./input.ts covers: those turns are the
 * ones that DO get the assistant's thinking sent along. The two thresholds are
 * a matched pair — moving one without the other reopens the gap.
 */
import type { SessionSegmentKind } from './types.js'

export const DEFAULT_TRIVIAL_USER_CHARS = 24

export interface TurnSignals {
  userMessage: string
  /** Tool iterations the turn ran; 0 means the agent just replied. */
  toolIterations: number
  /** Files the turn mutated, from the audit trail. */
  fileCount: number
}

/**
 * Cheap enough to be beneath notice: no tools, no file changes, and barely
 * any text. "ok", "continue", "thanks".
 */
export function isTrivialTurn(
  signals: TurnSignals,
  trivialChars: number = DEFAULT_TRIVIAL_USER_CHARS,
): boolean {
  if (signals.toolIterations > 0) return false
  if (signals.fileCount > 0) return false
  return signals.userMessage.trim().length <= trivialChars
}

export type TocAction = 'update' | 'new' | 'skip'

export interface TocDecision {
  action: TocAction
  kind: SessionSegmentKind
  title: string
  detail: string
}

const MAX_TITLE_CHARS = 72
// Roomier than a one-liner because `update` folds multiple turns into one
// description; the card clamps and scrolls rather than relying on this.
const MAX_DETAIL_CHARS = 400

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Pulls the first complete JSON object out of a reply, by matching braces
 * rather than taking everything between the first `{` and the last `}`.
 *
 * Small models routinely wrap the answer in prose or a code fence, and some
 * emit a second object (an example, a correction). A greedy span swallows all
 * of it and fails to parse — losing an answer that was actually there.
 * Strings are tracked so a brace inside a title does not end the scan.
 */
function extractFirstJsonObject(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf('{')
  if (start === -1) return undefined

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < raw.length; i++) {
    const char = raw[i]!

    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) {
        try {
          const value = JSON.parse(raw.slice(start, i + 1)) as unknown
          return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

function normalizeAction(value: unknown, hasCurrentSegment: boolean): TocAction {
  const action = asString(value).toLowerCase()
  if (action === 'skip') return 'skip'
  if (action === 'new') return 'new'
  if (action === 'update') {
    // Nothing to update against — treat it as opening the first segment
    // rather than dropping the turn on the floor.
    return hasCurrentSegment ? 'update' : 'new'
  }
  return hasCurrentSegment ? 'update' : 'new'
}

/**
 * Parses the model's reply defensively: this runs unattended on every turn, so
 * a malformed answer must degrade to "keep the current segment" rather than
 * throw and lose the turn.
 */
export function parseTocDecision(
  raw: string,
  options: { hasCurrentSegment: boolean },
): TocDecision | undefined {
  const parsed = extractFirstJsonObject(raw)
  if (!parsed) return undefined

  const action = normalizeAction(parsed.action, options.hasCurrentSegment)
  if (action === 'skip') {
    return { action, kind: 'task', title: '', detail: '' }
  }

  const title = asString(parsed.title).slice(0, MAX_TITLE_CHARS)
  // A segment with no title is worse than no segment: it renders as a blank
  // row the user cannot act on.
  if (!title) return undefined

  return {
    action,
    kind: asString(parsed.kind) === 'question' ? 'question' : 'task',
    title,
    detail: asString(parsed.detail).slice(0, MAX_DETAIL_CHARS),
  }
}
