import type { JsonValue } from '@shared/json.js'

/**
 * Structured diff payload carried alongside (and eventually instead of) the
 * unified-diff display text.
 *
 * Unified diff as a display protocol is ambiguous: a deleted line whose
 * content starts with `--` (Lua/SQL/Haskell comments) serializes as `--- …`,
 * which every header-pattern parser reads as a file boundary and truncates
 * the hunk. Structured hunks carry each line with an explicit op, so no
 * downstream consumer ever re-parses ambiguous text.
 */
export interface CoreDiffHunkLine {
  /** 'ctx' unchanged, 'add' addition, 'del' deletion, 'noeof' "\ No newline at end of file" marker. */
  op: 'ctx' | 'add' | 'del' | 'noeof'
  /** Line content without prefix or trailing newline; empty for 'noeof'. */
  text: string
}

export interface CoreDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: CoreDiffHunkLine[]
}

const HUNK_LINE_OPS = new Set(['ctx', 'add', 'del', 'noeof'])

function coreDiffHunkFromJson(value: JsonValue): CoreDiffHunk | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, JsonValue>
  const { oldStart, oldLines, newStart, newLines, lines } = record
  if (
    typeof oldStart !== 'number' || typeof oldLines !== 'number'
    || typeof newStart !== 'number' || typeof newLines !== 'number'
    || !Array.isArray(lines)
  ) return null

  const parsedLines: CoreDiffHunkLine[] = []
  for (const line of lines) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) return null
    const { op, text } = line as Record<string, JsonValue>
    if (typeof op !== 'string' || !HUNK_LINE_OPS.has(op) || typeof text !== 'string') return null
    parsedLines.push({ op: op as CoreDiffHunkLine['op'], text })
  }
  return { oldStart, oldLines, newStart, newLines, lines: parsedLines }
}

/**
 * Validating reader for hunks that travelled through JSON metadata. Returns
 * undefined (never a partial result) when the value does not match the shape,
 * so malformed metadata degrades to the legacy text-diff path.
 */
export function coreDiffHunksFromJson(value: JsonValue | undefined): CoreDiffHunk[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const hunks: CoreDiffHunk[] = []
  for (const entry of value) {
    const hunk = coreDiffHunkFromJson(entry)
    if (!hunk) return undefined
    hunks.push(hunk)
  }
  return hunks
}

export function coreDiffHunksToJson(hunks: CoreDiffHunk[]): JsonValue {
  return hunks.map(hunk => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines.map(line => ({ op: line.op, text: line.text })),
  }))
}
