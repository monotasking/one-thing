import { structuredPatch } from 'diff'
import type { CoreDiffHunk, CoreDiffHunkLine } from '@onething/backend/tool/tool-helpers'
import { DIFF_DISPLAY_MAX_BYTES, DIFF_DISPLAY_MAX_LINES } from './tool-replacers.js'

/**
 * Structured counterpart of createTwoFilesPatch + trimDiff + truncate. The
 * display pipeline carries these hunks; the unified-diff text remains only as
 * the audit/legacy interchange format. Each line is stored with an explicit
 * op so no consumer ever re-parses prefix characters out of ambiguous text
 * (a deleted `-- AR` Lua comment serializes as `--- AR` in unified diff and
 * truncates every header-pattern parser).
 */
export function computeDiffHunks(
  filePath: string,
  oldContent: string,
  newContent: string,
): CoreDiffHunk[] {
  const patch = structuredPatch(filePath, filePath, oldContent, newContent)
  return patch.hunks.map(hunk => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines.map(structuredPatchLineToHunkLine),
  }))
}

function structuredPatchLineToHunkLine(line: string): CoreDiffHunkLine {
  const prefix = line[0]
  if (prefix === '+') return { op: 'add', text: line.slice(1) }
  if (prefix === '-') return { op: 'del', text: line.slice(1) }
  if (prefix === '\\') return { op: 'noeof', text: '' }
  // ' ' context; anything malformed degrades to context rather than dropping.
  return { op: 'ctx', text: line.slice(1) }
}

/**
 * Structured version of trimDiff: strips the common leading indent from every
 * content line so deeply nested edits stay readable. Unlike the text version,
 * line classification is by op, so `---`-looking deletions participate too.
 */
export function trimDiffHunks(hunks: CoreDiffHunk[]): CoreDiffHunk[] {
  let min = Infinity
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.op === 'noeof' || line.text.trim().length === 0) continue
      const match = line.text.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return hunks

  return hunks.map(hunk => ({
    ...hunk,
    lines: hunk.lines.map(line =>
      line.op === 'noeof' ? line : { op: line.op, text: line.text.slice(min) },
    ),
  }))
}

/**
 * Caps hunks before they ship to the renderer, mirroring
 * truncateDiffForDisplay's limits. Whole hunks are kept up to the budget; the
 * hunk that crosses it is cut at the line boundary.
 */
export function truncateDiffHunksForDisplay(
  hunks: CoreDiffHunk[],
  maxLines = DIFF_DISPLAY_MAX_LINES,
  maxBytes = DIFF_DISPLAY_MAX_BYTES,
): CoreDiffHunk[] {
  const kept: CoreDiffHunk[] = []
  let lines = 0
  let bytes = 0
  for (const hunk of hunks) {
    const keptLines: CoreDiffHunkLine[] = []
    for (const line of hunk.lines) {
      if (lines >= maxLines || bytes > maxBytes) break
      keptLines.push(line)
      lines += 1
      bytes += line.text.length + 1
    }
    if (keptLines.length === 0) break
    kept.push(keptLines.length === hunk.lines.length ? hunk : { ...hunk, lines: keptLines })
    if (lines >= maxLines || bytes > maxBytes) break
  }
  return kept
}
