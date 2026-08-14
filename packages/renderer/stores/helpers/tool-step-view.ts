import type { DiffHunk, Step, ToolCall } from '@/types'
import { diffHunksFromUnknown } from '@/utils/diff-hunks'
// Deliberately the leaf module, NOT the engine barrel: the barrel pulls
// node-only modules (node:crypto ids, permission) that must never enter the
// renderer bundle.
import {
  createStreamingArgsParser,
  type StreamingArgsField,
  type StreamingArgsParser,
} from '@onething/core/engine/streaming-args'
import { basename, formatToolCallPreview } from './tool-preview'
import { getToolRenderStatus, type ToolRenderStatus } from './tool-status'
import { getFileToolCategory } from './tool-ui-registry'

export interface ToolDiffData {
  diff: string
  /** Structured hunks; DiffView renders these instead of re-parsing `diff`. */
  hunks?: DiffHunk[]
  additions: number
  deletions: number
  filePath: string
  auditId?: string
  auditPath?: string
  originalContentHash?: string
  afterContentHash?: string
}

/**
 * A line of the pre-execution preview.
 *
 * This is NOT a diff: before the tool runs, the only thing known is what the
 * model streamed as arguments. A write has never read the old file, and an
 * edit's `old_string` may not even match. So the preview shows the arguments
 * as-is — no +/- markers, no file line numbers, nothing that would pass for
 * ground truth.
 */
export interface ToolPreviewLine {
  /**
   * `content` — a line the write tool is about to put in the file.
   * `old` / `new` — the two halves of an edit's replacement pair.
   * `label` — a caption introducing the block that follows.
   */
  kind: 'content' | 'old' | 'new' | 'label'
  text: string
}

export interface StreamingToolContent {
  filePath: string
  content: string
  isTruncated?: boolean
  totalLines?: number
  omittedLines?: number
  kind?: 'write' | 'edit'
  replacements?: StreamingEditReplacement[]
}

/** A settled or still-streaming piece of draft text. */
export interface ToolDraftText {
  text: string
  /** True while this value is still receiving — the cursor mounts here. */
  open: boolean
}

export interface ToolDraftReplacement {
  index: number
  find: ToolDraftText | null
  replace: ToolDraftText | null
  replaceAll?: boolean
}

/**
 * Honest view of the argument stream while it is being received. Every entry
 * is derived from the incremental parser: 'closed' fields render as settled,
 * the single open field carries the cursor, and nothing is predicted.
 */
export interface ToolStreamingDraft {
  kind: 'edit' | 'write' | 'generic'
  fields: StreamingArgsField[]
  openPath: string | null
  /** True once the top-level JSON closed (the stream may still lag the done event). */
  complete: boolean
  charsReceived: number
  parseError?: string
  /** Closed path value; empty until the path field's closing quote arrived. */
  filePath: string
  /** File tools only: the path field has not closed yet. */
  pathPending: boolean
  replacements: ToolDraftReplacement[]
  content: ToolDraftText | null
}

export interface ToolStepView {
  id: string
  step: Step
  toolCall: ToolCall
  toolName: string
  displayName: string
  status: ToolRenderStatus
  preview: string
  filePath: string
  fileName: string
  inlineResult: string | null
  errorPreview: string | null
  streamingContent: StreamingToolContent | null
  streamingPreviewLines: ToolPreviewLine[]
  /** Present only while the argument stream is receiving (status streaming-input). */
  streamingDraft: ToolStreamingDraft | null
  diff: ToolDiffData | null
  argsJson: string | null
  resultText: string | null
  liveOutput: string | null
  hasDetails: boolean
  defaultExpanded: boolean
  isAwaitingConfirmation: boolean
}

export interface BuildToolStepViewOptions {
  includeDetails?: boolean
}

const STREAMING_CONTENT_CACHE_LIMIT = 80

const streamingContentCache = new Map<string, StreamingToolContent | null>()

interface ToolContentSource {
  filePath: string
  content: string
  cacheKey: string
  kind: 'write' | 'edit'
  replacements?: StreamingEditReplacement[]
}

interface StreamingEditReplacement {
  oldText: string
  newText: string
  replaceAll?: boolean
}

export function clearStreamingContentCache(): void {
  streamingContentCache.clear()
  draftParserCache.clear()
}

// ── Streaming draft (incremental, honest) ──────────────────────────────────

const DRAFT_PARSER_CACHE_LIMIT = 40

interface DraftParserEntry {
  parser: StreamingArgsParser
  consumed: number
}

const draftParserCache = new Map<string, DraftParserEntry>()

const PATH_FIELD_KEYS = [
  'path', 'filePath', 'filepath', 'file_path',
  'AbsolutePath', 'TargetFile', 'SearchPath', 'FilePath',
]

const EDIT_MEMBER_RE = /^edits\[(\d+)\]\.(oldText|newText|old_string|new_string|replaceAll|replace_all)$/

/** The parser reports booleans as the literal text it saw. */
function draftFlag(field: StreamingArgsField): boolean {
  return field.state === 'closed' && field.value === 'true'
}

/**
 * Feed the incremental parser with whatever bytes arrived since the last
 * render. streamingArgs is append-only, so the suffix is all that's new; a
 * shrunken buffer means a new life for the id and restarts the parser.
 */
function getDraftParserView(toolCallId: string, streamingArgs: string) {
  let entry = draftParserCache.get(toolCallId)
  if (!entry || entry.consumed > streamingArgs.length) {
    entry = { parser: createStreamingArgsParser(), consumed: 0 }
    draftParserCache.set(toolCallId, entry)
    if (draftParserCache.size > DRAFT_PARSER_CACHE_LIMIT) {
      const firstKey = draftParserCache.keys().next().value
      if (firstKey) draftParserCache.delete(firstKey)
    }
  }
  if (streamingArgs.length > entry.consumed) {
    entry.parser.push(streamingArgs.slice(entry.consumed))
    entry.consumed = streamingArgs.length
  }
  return entry.parser.view()
}

function draftText(field: StreamingArgsField): ToolDraftText {
  return { text: field.value, open: field.state === 'open' }
}

export function buildStreamingDraft(toolCall: ToolCall | undefined): ToolStreamingDraft | null {
  if (!toolCall || toolCall.status !== 'input-streaming') {
    if (toolCall) draftParserCache.delete(toolCall.id)
    return null
  }
  const streamingArgs = toolCall.streamingArgs ?? ''
  const view = getDraftParserView(toolCall.id, streamingArgs)

  const toolName = toolCall.toolName?.toLowerCase() || ''
  const category = getFileToolCategory(toolName)
  const kind: ToolStreamingDraft['kind'] =
    category === 'edit' ? 'edit' : category === 'write' ? 'write' : 'generic'

  let filePath = ''
  const replacementsByIndex = new Map<number, ToolDraftReplacement>()
  let content: ToolDraftText | null = null

  for (const field of view.fields) {
    if (PATH_FIELD_KEYS.includes(field.path)) {
      if (field.state === 'closed') filePath = field.value
      continue
    }
    if (kind === 'edit') {
      const memberMatch = field.path.match(EDIT_MEMBER_RE)
      if (memberMatch) {
        const index = Number(memberMatch[1])
        const slot = replacementsByIndex.get(index) ?? { index, find: null, replace: null }
        const member = memberMatch[2]
        if (member === 'oldText' || member === 'old_string') slot.find = draftText(field)
        else if (member === 'replaceAll' || member === 'replace_all') slot.replaceAll = draftFlag(field)
        else slot.replace = draftText(field)
        replacementsByIndex.set(index, slot)
        continue
      }
      if (field.path === 'oldText' || field.path === 'old_string') {
        const slot = replacementsByIndex.get(0) ?? { index: 0, find: null, replace: null }
        slot.find = draftText(field)
        replacementsByIndex.set(0, slot)
        continue
      }
      if (field.path === 'newText' || field.path === 'new_string') {
        const slot = replacementsByIndex.get(0) ?? { index: 0, find: null, replace: null }
        slot.replace = draftText(field)
        replacementsByIndex.set(0, slot)
        continue
      }
      if (field.path === 'replaceAll' || field.path === 'replace_all') {
        const slot = replacementsByIndex.get(0) ?? { index: 0, find: null, replace: null }
        slot.replaceAll = draftFlag(field)
        replacementsByIndex.set(0, slot)
        continue
      }
    }
    if (kind === 'write' && field.path === 'content') {
      content = draftText(field)
    }
  }

  return {
    kind,
    fields: view.fields,
    openPath: view.openPath,
    complete: view.complete,
    charsReceived: view.charsReceived,
    ...(view.error ? { parseError: view.error } : {}),
    filePath,
    // A file tool's path is required by contract; until its closing quote
    // arrives the title must not show a half-received name — an open value
    // still counts as pending.
    pathPending: kind !== 'generic' && !filePath,
    replacements: [...replacementsByIndex.values()].sort((a, b) => a.index - b.index),
    content,
  }
}

/** Wrap a bare ToolCall as a Step so the unified timeline can render it. */
export function stepFromToolCall(toolCall: ToolCall): Step {
  return {
    id: toolCall.id,
    type: toolCall.toolName?.toLowerCase() === 'bash' ? 'command' : 'tool-call',
    title: toolCall.toolName || 'tool',
    status: toolCall.status === 'completed'
      ? 'completed'
      : toolCall.status === 'failed'
        ? 'failed'
        : toolCall.status === 'cancelled'
          ? 'cancelled'
          : 'running',
    timestamp: toolCall.timestamp,
    toolCallId: toolCall.id,
    toolCall,
    result: typeof toolCall.result === 'string'
      ? toolCall.result
      : toolCall.result === undefined
        ? undefined
        : JSON.stringify(toolCall.result),
    error: toolCall.error,
  }
}

export function buildSyntheticToolCall(step: Step): ToolCall {
  const title = step.title || ''
  let name = 'tool'
  const args: Record<string, any> = {}

  if (title.includes(':')) {
    const parts = title.split(':')
    const first = parts[0].trim()
    if (first.toLowerCase() === 'tool' && parts.length > 1) {
      name = parts[1].trim()
      const path = parts.slice(2).join(':').trim()
      if (path) args.path = path
    } else {
      name = first
      const path = parts.slice(1).join(':').trim()
      if (path) {
        const rangeMatch = path.match(/:(\d+)-(\d+)$/)
        if (rangeMatch) {
          args.path = path.slice(0, -rangeMatch[0].length)
          args.offset = parseInt(rangeMatch[1], 10)
          args.limit = parseInt(rangeMatch[2], 10) - args.offset + 1
        } else {
          args.path = path
        }
      }
    }
  } else {
    const lowerTitle = title.toLowerCase()
    if (lowerTitle.startsWith('read ') || lowerTitle.startsWith('reading ')) {
      name = 'read'
      args.path = title.slice(lowerTitle.startsWith('read ') ? 5 : 8).trim()
    } else if (lowerTitle.startsWith('edit ') || lowerTitle.startsWith('editing ')) {
      name = 'edit'
      args.path = title.slice(lowerTitle.startsWith('edit ') ? 5 : 8).trim()
    } else if (lowerTitle.startsWith('write ') || lowerTitle.startsWith('writing ')) {
      name = 'write'
      args.path = title.slice(lowerTitle.startsWith('write ') ? 6 : 8).trim()
    } else if (lowerTitle.startsWith('run ') || lowerTitle.startsWith('running ')) {
      name = 'bash'
      args.command = title.slice(lowerTitle.startsWith('run ') ? 4 : 8).trim()
    } else {
      name = title.trim() || 'tool'
    }
  }

  name = name.toLowerCase()

  return {
    id: step.toolCallId || step.id,
    toolId: name,
    toolName: name,
    arguments: args,
    status: 'pending',
    timestamp: step.timestamp,
  }
}

export function buildToolStepView(step: Step, options: BuildToolStepViewOptions = {}): ToolStepView {
  const includeDetails = options.includeDetails ?? true
  const toolCall = step.toolCall || buildSyntheticToolCall(step)
  const toolName = toolCall.toolName?.toLowerCase() || ''
  const status = getToolRenderStatus(toolCall, step)
  const isRejected = status === 'rejected'
  const diff = getDiffFromStep(step)
  const streamingDraft = includeDetails ? buildStreamingDraft(toolCall) : null
  const streamingContent = includeDetails ? getCachedStreamingContent(step, diff, status) : null
  const filePath = getToolFilePath(toolCall, diff, streamingContent, step)
  const argsJson = includeDetails ? getArgsJson(step) : null
  const resultText = includeDetails ? getResultText(step) : null
  const liveOutput = includeDetails && step.status === 'running'
    ? getLiveOutput(step)
    : null
  const inlineResult = includeDetails ? getInlineResult(step) : null
  const errorPreview = isRejected
    ? 'Rejected'
    : step.status === 'failed' && step.error
      ? truncateError(step.error, 30)
      : null

  const hasDetails = !!(
    hasPotentialDetails(step, toolName, diff) ||
    streamingContent ||
    diff ||
    step.thinking ||
    resultText ||
    step.summary ||
    step.error ||
    // The single-line row title truncates long commands; the expanded
    // details are the guaranteed place to read the full command, so a bash
    // row with a command is always expandable.
    (toolName === 'bash' && toolCall.arguments?.command)
  )

  return {
    id: step.id,
    step,
    toolCall,
    toolName,
    displayName: toolCall.toolName || step.title?.split(':')[0] || 'tool',
    status,
    preview: formatToolCallPreview(toolCall),
    filePath,
    fileName: basename(filePath),
    inlineResult,
    errorPreview,
    streamingContent,
    streamingPreviewLines: includeDetails ? parseStreamingPreviewLines(streamingContent) : [],
    streamingDraft,
    diff,
    argsJson,
    resultText,
    liveOutput,
    hasDetails,
    defaultExpanded: shouldDefaultExpand(toolName, status),
    isAwaitingConfirmation: status === 'awaiting-confirmation',
  }
}

function shouldDefaultExpand(toolName: string, status: ToolRenderStatus): boolean {
  // A failed edit is the one failure whose detail is always worth reading
  // immediately: the engine reply carries the current file text around the
  // spot that did not match. A rejection has no such detail — stay folded.
  if (status === 'failed') return getFileToolCategory(toolName) === 'edit'
  if (status === 'rejected') return false
  // A row only opens itself when it wants a decision: an edit awaiting
  // approval must show what it is about to do. Everything else stays folded —
  // rows that merely happened are read on demand.
  if (status === 'awaiting-confirmation') {
    const cat = getFileToolCategory(toolName)
    return cat === 'write' || cat === 'edit'
  }
  return false
}

function hasPotentialStreamingDetails(step: Step, toolName: string): boolean {
  const cat = getFileToolCategory(toolName)
  if (cat !== 'write' && cat !== 'edit') return false
  return Boolean(
    step.toolCall?.changes ||
    getFinalizedContentSource(step.toolCall, toolName),
  )
}

function hasPotentialDetails(step: Step, toolName: string, diff: ToolDiffData | null): boolean {
  // While arguments stream, the draft view (counter + received fields) is
  // always available — the card must be expandable to show it.
  if (step.toolCall?.status === 'input-streaming') return true
  if (hasPotentialStreamingDetails(step, toolName)) return true
  if (diff || step.thinking || step.summary || step.error) return true
  return Boolean(step.result || step.partialResult)
}

export function getToolFilePath(
  toolCall: ToolCall | undefined,
  diff: ToolDiffData | null = null,
  streamingContent: StreamingToolContent | null = null,
  step?: Step | null,
): string {
  const args = toolCall?.arguments || {}
  if (diff?.filePath) return diff.filePath
  if (streamingContent?.filePath) return streamingContent.filePath
  if (typeof toolCall?.changes?.filePath === 'string') return toolCall.changes.filePath
  const argPath = getPathArgument(args)
  if (argPath) return argPath

  const partialPath = getPathFromDetails(step?.partialResult?.details)
  if (partialPath) return partialPath

  // Parse path from step result JSON output if available
  if (step?.result) {
    try {
      const parsed = JSON.parse(step.result)
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.path === 'string') return parsed.path
        if (typeof parsed.filePath === 'string') return parsed.filePath
        if (typeof parsed.metadata?.path === 'string') return parsed.metadata.path
      }
    } catch {
      // Non-JSON results cannot provide structured file metadata.
    }
  }

  if (toolCall?.status === 'input-streaming' && toolCall.streamingArgs) {
    // Only a CLOSED path field may name the file — a half-received path must
    // never surface in the title (honesty rule; no predicted values).
    return buildStreamingDraft(toolCall)?.filePath || ''
  }
  return ''
}

function getPathArgument(args: Record<string, any>): string {
  const value = args.path ||
    args.filePath ||
    args.filepath ||
    args.file_path ||
    args.AbsolutePath ||
    args.TargetFile ||
    args.SearchPath ||
    args.FilePath
  return typeof value === 'string' ? value : ''
}

function getPathFromDetails(details: unknown): string {
  if (!details || typeof details !== 'object') return ''
  const value = (details as Record<string, unknown>).path ||
    (details as Record<string, unknown>).filePath ||
    (details as Record<string, unknown>).file_path
  return typeof value === 'string' ? value : ''
}

function parseStreamingPreviewLines(streamingContent: StreamingToolContent | null): ToolPreviewLine[] {
  if (!streamingContent) return []
  if (streamingContent.kind === 'edit') {
    return parseStreamingEditPreviewLines(streamingContent.replacements || [])
  }
  if (!streamingContent.content) return []

  return splitDisplayLines(streamingContent.content).map(text => ({
    kind: 'content' as const,
    text,
  }))
}

function parseStreamingEditPreviewLines(replacements: StreamingEditReplacement[]): ToolPreviewLine[] {
  const result: ToolPreviewLine[] = []
  const numbered = replacements.length > 1

  replacements.forEach((replacement, index) => {
    const suffix = numbered ? ` ${index + 1}` : ''
    const scope = replacement.replaceAll ? ' (all occurrences)' : ''
    result.push({ kind: 'label', text: `Find${suffix}${scope}` })
    for (const text of splitDisplayLines(replacement.oldText)) {
      result.push({ kind: 'old', text })
    }
    result.push({ kind: 'label', text: `Replace with${suffix}` })
    for (const text of splitDisplayLines(replacement.newText)) {
      result.push({ kind: 'new', text })
    }
  })

  return result
}

export function getResultText(step: Step): string | null {
  if (!step.result || step.status === 'running' || getDiffFromStep(step)) return null
  return formatResult(step.result)
}

function getArgsJson(step: Step): string | null {
  const args = step.toolCall?.arguments
  const toolName = step.toolCall?.toolName?.toLowerCase() || ''
  if (toolName === 'read') return null
  if (args && Object.keys(args).length > 0) {
    return formatArgsJson(args, toolName)
  }
  if (step.toolCall?.streamingArgs) {
    return formatStreamingArgs(step.toolCall.streamingArgs, toolName)
  }
  return null
}

function getLiveOutput(step: Step): string | null {
  const partialText = step.partialResult?.content
    ?.map((part) => {
      if (part.type === 'text') return part.text ?? ''
      if (part.type === 'file') return part.path ? `[File: ${part.path}]` : ''
      if (part.type === 'image') return part.path ? `[Image: ${part.path}]` : '[Image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')

  const source = partialText || step.result
  return source ? truncateOutput(source) : null
}

function getInlineResult(step: Step): string | null {
  if (step.status !== 'completed' && step.status !== 'failed') return null
  const raw = step.result
  if (!raw || typeof raw !== 'string') return null

  let text = raw
  try {
    const parsed = JSON.parse(raw)
    if (parsed.output !== undefined) text = String(parsed.output)
    else if (parsed.data?.output !== undefined) text = String(parsed.data.output)
  } catch {
    // Use raw result.
  }

  const firstLine = text.split('\n')[0].trim()
  if (!firstLine || firstLine.length > 80) return null
  return firstLine
}

function truncateError(error: string, maxLen: number): string {
  const firstLine = error.split('\n')[0]
  if (firstLine.length <= maxLen) return firstLine
  return firstLine.slice(0, maxLen - 3) + '...'
}

function formatArgsJson(args: Record<string, any>, toolName: string): string {
  const displayArgs = truncateDisplayValue(args)

  if (toolName === 'bash') {
    return String((displayArgs as Record<string, any>).command || '')
  }
  return JSON.stringify(displayArgs, null, 2)
}

function formatStreamingArgs(streamingArgs: string, toolName: string): string {
  try {
    const parsed = JSON.parse(streamingArgs)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return formatArgsJson(parsed as Record<string, any>, toolName)
    }
  } catch {
    // Incomplete JSON while the model is streaming; show a bounded preview.
  }
  return truncateString(streamingArgs, 1200)
}

function truncateDisplayValue(value: any, depth = 0): any {
  if (typeof value === 'string') {
    return truncateString(value, depth === 0 ? 500 : 300)
  }
  if (Array.isArray(value)) {
    const maxItems = depth >= 2 ? 8 : 24
    const items = value.slice(0, maxItems).map(item => truncateDisplayValue(item, depth + 1))
    if (value.length > maxItems) {
      items.push(`... (${value.length - maxItems} more items)`)
    }
    return items
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    const maxEntries = depth >= 2 ? 12 : 40
    const result: Record<string, any> = {}
    for (const [key, item] of entries.slice(0, maxEntries)) {
      result[key] = truncateDisplayValue(item, depth + 1)
    }
    if (entries.length > maxEntries) {
      result.__truncated = `${entries.length - maxEntries} more keys`
    }
    return result
  }
  return value
}

function truncateString(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}... (${value.length} chars total)`
}

function formatResult(result: string): string {
  try {
    const parsed = JSON.parse(result)
    if (parsed.output !== undefined) return String(parsed.output)
    if (parsed.data?.output !== undefined) return String(parsed.data.output)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return result
  }
}

function truncateOutput(output: string, maxLines: number = 8): string {
  const lines = output.split('\n')
  if (lines.length <= maxLines) return output
  return '...\n' + lines.slice(-maxLines).join('\n')
}

function getCachedStreamingContent(
  step: Step,
  diff: ToolDiffData | null,
  status: ToolRenderStatus,
): StreamingToolContent | null {
  if (diff) return null

  const source = getToolContentSource(step)
  if (!source) return null

  const toolCallId = step.toolCall?.id || step.toolCallId || step.id
  const cacheKey = `${toolCallId}:${source.cacheKey}:${status}`
  if (streamingContentCache.has(cacheKey)) {
    return streamingContentCache.get(cacheKey) ?? null
  }

  const result = normalizeStreamingContent({
    filePath: source.filePath,
    content: source.content,
    kind: source.kind,
    replacements: source.replacements,
  })
  streamingContentCache.set(cacheKey, result)
  if (streamingContentCache.size > STREAMING_CONTENT_CACHE_LIMIT) {
    const firstKey = streamingContentCache.keys().next().value
    if (firstKey) streamingContentCache.delete(firstKey)
  }
  return result
}

function getToolContentSource(step: Step): ToolContentSource | null {
  const toolCall = step.toolCall
  const toolName = toolCall?.toolName?.toLowerCase() || ''
  const cat = getFileToolCategory(toolName)
  if (!toolCall || (cat !== 'write' && cat !== 'edit')) return null

  // While arguments stream, the honest draft view (streamingDraft) owns the
  // presentation; the settled preview only exists from finalized arguments.
  if (toolCall.status === 'input-streaming') return null

  return getFinalizedContentSource(toolCall, toolName)
}
function extractEditReplacementContent(args: Record<string, any>): string {
  return extractEditReplacements(args)
    .map(edit => edit.newText)
    .filter(Boolean)
    .join('\n')
}

function extractEditReplacements(args: Record<string, any>): StreamingEditReplacement[] {
  if (!Array.isArray(args.edits)) return []
  return args.edits
    .map((edit: any) => ({
      oldText: typeof edit?.oldText === 'string' ? edit.oldText : '',
      newText: typeof edit?.newText === 'string' ? edit.newText : '',
      replaceAll: edit?.replaceAll === true,
    }))
    .filter(edit => edit.oldText || edit.newText)
}

function getFinalizedContentSource(toolCall: ToolCall | undefined, toolName: string): ToolContentSource | null {
  const args = toolCall?.arguments
  if (!args) return null

  const cat = getFileToolCategory(toolName)
  const parsedContent = cat === 'write' ? args.content : extractEditReplacementContent(args)
  if (typeof parsedContent !== 'string') return null

  const filePath = typeof args.path === 'string' ? args.path : ''

  return {
    filePath,
    content: parsedContent,
    kind: cat === 'edit' ? 'edit' : 'write',
    replacements: cat === 'edit' ? extractEditReplacements(args) : undefined,
    cacheKey: `final:${filePath}:${parsedContent.length}:${hashString(parsedContent)}`,
  }
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return String(hash >>> 0)
}

function normalizeStreamingContent(content: StreamingToolContent): StreamingToolContent {
  return {
    ...content,
    totalLines: countAddedLines(content.content),
    isTruncated: false,
    omittedLines: 0,
  }
}

function countAddedLines(content: string): number {
  if (!content) return 0
  return content.endsWith('\n')
    ? content.split('\n').length - 1
    : content.split('\n').length
}

function splitDisplayLines(value: string): string[] {
  if (!value) return []
  const lines = value.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function getDiffFromStep(step: Step): ToolDiffData | null {
  if (step.toolCall?.changes?.diff) {
    return {
      diff: step.toolCall.changes.diff,
      hunks: step.toolCall.changes.hunks,
      additions: step.toolCall.changes.additions || 0,
      deletions: step.toolCall.changes.deletions || 0,
      filePath: step.toolCall.changes.filePath || '',
      auditId: step.toolCall.changes.auditId,
      auditPath: step.toolCall.changes.auditPath,
      originalContentHash: step.toolCall.changes.originalContentHash,
      afterContentHash: step.toolCall.changes.afterContentHash,
    }
  }

  if (!step.result) return null
  try {
    const parsed = JSON.parse(step.result)
    if (parsed.diff) {
      return {
        diff: parsed.diff,
        hunks: diffHunksFromUnknown(parsed.diffHunks),
        additions: parsed.additions || 0,
        deletions: parsed.deletions || 0,
        filePath: parsed.path || '',
        auditId: parsed.auditId,
        auditPath: parsed.auditPath,
        originalContentHash: parsed.originalContentHash,
        afterContentHash: parsed.afterContentHash,
      }
    }
    if (parsed.metadata?.diff) {
      return {
        diff: parsed.metadata.diff,
        hunks: diffHunksFromUnknown(parsed.metadata.diffHunks),
        additions: parsed.metadata.additions || 0,
        deletions: parsed.metadata.deletions || 0,
        filePath: parsed.metadata.path || '',
        auditId: parsed.metadata.auditId,
        auditPath: parsed.metadata.auditPath,
        originalContentHash: parsed.metadata.originalContentHash,
        afterContentHash: parsed.metadata.afterContentHash,
      }
    }
  } catch {
    // Not JSON, no diff.
  }
  return null
}

