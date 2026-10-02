/**
 * Net file-change summary for a completed goal, computed from the file
 * mutation audit trail (tools/file-mutation-audit.ts). Per file the summary
 * spans the EARLIEST before-state to the LATEST after-state inside the goal
 * window, so ten edits to one file report one net +/- pair, and a file that
 * ends up byte-identical drops out entirely.
 *
 * Line counts are a multiset diff (occurrences added/removed), matching git
 * numstat for ordinary changes; pure moves of identical lines count as 0/0
 * rather than +1/-1 (the file still appears — the review diff shows the move).
 * Bash-driven mutations bypass the audit trail and are not counted — this
 * summarizes what the edit/write tools did.
 */

export interface GoalFileChange {
  /** Path as recorded (workspace-relative when the caller shortens it). */
  path: string
  added: number
  removed: number
}

/**
 * A file's net before/after state across the goal window — the numstat table
 * and the review diffs are both projections of this, so they can never
 * disagree about which files the goal touched.
 */
export interface GoalFileSpan {
  path: string
  beforeExists: boolean
  beforeContent: string
  afterExists: boolean
  afterContent: string
}

export interface GoalFileMutationRecordLike {
  sessionId: string
  /** ISO timestamp of the mutation. */
  timestamp: string
  filePath: string
  beforeExists: boolean
  afterExists: boolean
  beforeContent: string
  afterContent: string
}

function contentLines(exists: boolean, content: string): string[] {
  if (!exists || content === '') return []
  return content.split('\n')
}

function lineCounts(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return counts
}

function diffCounts(before: string[], after: string[]): { added: number; removed: number } {
  const beforeCounts = lineCounts(before)
  const afterCounts = lineCounts(after)
  let added = 0
  let removed = 0
  for (const [line, count] of afterCounts) {
    added += Math.max(count - (beforeCounts.get(line) ?? 0), 0)
  }
  for (const [line, count] of beforeCounts) {
    removed += Math.max(count - (afterCounts.get(line) ?? 0), 0)
  }
  return { added, removed }
}

/**
 * Reduces the audit records to one net span per file. Files whose content is
 * byte-identical at both ends of the window (edited then reverted) drop out —
 * the goal did not change them, whatever it did along the way.
 */
export function collectGoalFileSpans(
  records: GoalFileMutationRecordLike[],
  options: { sessionId: string; sinceMs: number },
): GoalFileSpan[] {
  interface NetSpan {
    firstTimestamp: string
    beforeExists: boolean
    beforeContent: string
    lastTimestamp: string
    afterExists: boolean
    afterContent: string
  }

  const spans = new Map<string, NetSpan>()
  for (const record of records) {
    if (record.sessionId !== options.sessionId) continue
    const at = Date.parse(record.timestamp)
    if (!Number.isFinite(at) || at < options.sinceMs) continue

    const existing = spans.get(record.filePath)
    if (!existing) {
      spans.set(record.filePath, {
        firstTimestamp: record.timestamp,
        beforeExists: record.beforeExists,
        beforeContent: record.beforeContent,
        lastTimestamp: record.timestamp,
        afterExists: record.afterExists,
        afterContent: record.afterContent,
      })
      continue
    }
    if (record.timestamp < existing.firstTimestamp) {
      existing.firstTimestamp = record.timestamp
      existing.beforeExists = record.beforeExists
      existing.beforeContent = record.beforeContent
    }
    if (record.timestamp >= existing.lastTimestamp) {
      existing.lastTimestamp = record.timestamp
      existing.afterExists = record.afterExists
      existing.afterContent = record.afterContent
    }
  }

  const result: GoalFileSpan[] = []
  for (const [filePath, span] of spans) {
    const unchanged =
      span.beforeExists === span.afterExists &&
      span.beforeContent === span.afterContent
    if (unchanged) continue
    result.push({
      path: filePath,
      beforeExists: span.beforeExists,
      beforeContent: span.beforeContent,
      afterExists: span.afterExists,
      afterContent: span.afterContent,
    })
  }

  result.sort((a, b) => a.path.localeCompare(b.path))
  return result
}

/** Line counts for one span — the numstat pair the summary card renders. */
export function countSpanLines(span: GoalFileSpan): { added: number; removed: number } {
  return diffCounts(
    contentLines(span.beforeExists, span.beforeContent),
    contentLines(span.afterExists, span.afterContent),
  )
}

export function summarizeGoalFileChanges(
  records: GoalFileMutationRecordLike[],
  options: { sessionId: string; sinceMs: number },
): GoalFileChange[] {
  return collectGoalFileSpans(records, options).map((span) => ({
    path: span.path,
    ...countSpanLines(span),
  }))
}
