import type { Step, ToolCall } from '@/types'
import {
  buildToolStepView,
  getDiffFromStep,
  getToolFilePath,
  type ToolDiffData,
  type ToolStepView,
} from './tool-step-view'
import { buildToolPrimaryArg, getFileToolCategory } from './tool-display'
import { basename, shortenPath } from './tool-preview'
import type { ToolRenderStatus } from './tool-status'
import { getStatusLabel, getToolDisplayLabel } from './tool-ui-registry'

export interface ToolActivityView {
  id: string
  step: Step
  toolCall: ToolCall
  toolName: string
  status: ToolRenderStatus
  /** Display label for the row title (`Bash`, `Read`, raw MCP name…). */
  toolLabel: string
  /** Primary argument rendered as `toolLabel(target)`. */
  target: string
  targetMeta: string
  filePath: string
  canOpenFile: boolean
  /** edit 的落点:第一个 hunk 在新文件里的起始行,打开文件时定位到改动处。 */
  fileLine?: number
  additions: number
  deletions: number
  stats: string
  duration: string
  statusLabel: string
  errorSummary: string
  isAwaitingConfirmation: boolean
  hasDetails: boolean
  defaultExpanded: boolean
  isFart: boolean
}

export function buildToolActivityViews(steps: Step[], nowMs = Date.now()): ToolActivityView[] {
  return steps.map(step => buildToolActivityView(step, nowMs))
}

function getFileTargetAndMeta(view: ToolStepView, filePath: string): { target: string; meta: string } {
  const fileName = filePath ? basename(filePath) : ''
  const preview = view.preview || ''

  if (preview.startsWith(':') && fileName) {
    return { target: `${fileName}${preview}`, meta: '' }
  }

  if (preview.startsWith(':')) {
    return { target: `Lines ${preview.slice(1)}`, meta: '' }
  }

  if (/^Lines\s+\d+/i.test(preview)) {
    return { target: preview, meta: '' }
  }

  if (fileName && preview.startsWith(fileName)) {
    const meta = preview.slice(fileName.length).trim()
    if (meta.startsWith(':')) {
      return { target: `${fileName}${meta}`, meta: '' }
    }
    return { target: fileName, meta }
  }

  if (preview) {
    const colonIndex = preview.indexOf(':')
    if (colonIndex > 0) {
      const target = preview.substring(0, colonIndex)
      const meta = preview.substring(colonIndex)
      return { target, meta }
    }
    const spaceIndex = preview.indexOf(' ')
    if (spaceIndex > 0) {
      const target = preview.substring(0, spaceIndex)
      const meta = preview.substring(spaceIndex).trim()
      return { target, meta }
    }
    return { target: preview, meta: '' }
  }

  return { target: fileName || 'file', meta: '' }
}

export function buildToolActivityView(step: Step, nowMs = Date.now()): ToolActivityView {
  const view = buildToolStepView(step, { includeDetails: false })
  const toolCall = view.toolCall
  const toolName = view.toolName
  const diff = getDiffFromStep(step)
  const filePath = getToolFilePath(toolCall, diff, null, step)
  const stats = buildStats(diff, toolCall)

  let target = ''
  let targetMeta = ''

  if (getFileToolCategory(toolName) !== null) {
    const fileInfo = getFileTargetAndMeta(view, filePath)
    target = fileInfo.target
    targetMeta = fileInfo.meta
  } else {
    target = buildTarget(view, filePath)
    targetMeta = buildTargetMeta(view)
  }

  return {
    id: view.id,
    step,
    toolCall,
    toolName,
    status: view.status,
    toolLabel: getToolDisplayLabel(toolCall.toolName || toolName),
    target,
    targetMeta,
    filePath,
    canOpenFile: !!filePath && getFileToolCategory(toolName) !== null,
    fileLine: diff?.hunks?.[0]?.newStart || undefined,
    additions: stats.additions,
    deletions: stats.deletions,
    stats: stats.text,
    duration: buildDuration(toolCall, nowMs),
    statusLabel: getStatusLabel(view.status),
    errorSummary: buildErrorSummary(step, toolCall, view.status),
    isAwaitingConfirmation: view.isAwaitingConfirmation,
    hasDetails: view.hasDetails,
    defaultExpanded: view.defaultExpanded,
    isFart: toolName === 'fart',
  }
}

export function buildDetailedToolStepView(activity: ToolActivityView): ToolStepView {
  return buildToolStepView(activity.step, { includeDetails: true })
}

function buildTarget(view: ToolStepView, filePath: string): string {
  const mappedTarget = buildToolPrimaryArg(view.toolName, view.toolCall)
  if (mappedTarget) return mappedTarget

  let preview = view.preview
  if (preview && preview.startsWith(':') && filePath) {
    preview = basename(filePath) + preview
  }

  if (preview) return preview
  if (filePath) return basename(filePath)

  // Avoid duplicate tool names (e.g. "Failed Edit edit") by returning a generic noun
  if (getFileToolCategory(view.toolName) !== null) {
    return 'file'
  }
  if (view.toolName === 'bash') {
    return 'command'
  }
  return view.displayName
}

function buildTargetMeta(view: ToolStepView): string {
  if (view.toolName !== 'variable') return ''
  const args = view.toolCall.arguments || {}
  const action = String(args.action || '').toLowerCase()
  const value = typeof args.value === 'string' ? args.value : ''
  if (!value) return ''
  if (action === 'set') return `= ${shortenPath(value, 42)}`
  if (action === 'append') return `+ ${shortenPath(value, 42)}`
  if (action === 'remove') return `− ${shortenPath(value, 42)}`
  return ''
}

interface ActivityStats {
  additions: number
  deletions: number
  text: string
}

function buildStats(diff: ToolDiffData | null, toolCall: ToolCall): ActivityStats {
  if (diff) {
    return {
      additions: diff.additions,
      deletions: diff.deletions,
      text: `+${diff.additions} -${diff.deletions}`,
    }
  }
  if (toolCall.changes) {
    const additions = toolCall.changes.additions ?? 0
    const deletions = toolCall.changes.deletions ?? 0
    return {
      additions,
      deletions,
      text: additions || deletions ? `+${additions} -${deletions}` : '',
    }
  }
  // No predicted counts while arguments stream — +N/−N is a measurement of
  // the applied change and only exists once a real diff does.
  return { additions: 0, deletions: 0, text: '' }
}

/**
 * Duration display. One format everywhere: seconds with a single decimal
 * (`0.3s`, `12.4s`), switching to `2m05.3s` past a minute. Running and final
 * values share the format so the text never jumps shape on completion.
 */
export function formatToolDuration(ms: number): string {
  // Sub-100ms runs would render "0.0s", which reads as a broken timer; every
  // real execution displays at least the 0.1s floor.
  const clamped = Math.max(ms, 100)
  if (clamped < 60_000) return `${(clamped / 1000).toFixed(1)}s`
  const minutes = Math.floor(clamped / 60_000)
  const seconds = (clamped % 60_000) / 1000
  return `${minutes}m${seconds < 10 ? '0' : ''}${seconds.toFixed(1)}s`
}

/**
 * Settled durations only speak when they have something to say: under a second
 * is "instant", and a column of `0.1s / 0.2s / 0.1s` is noise that makes the
 * one slow call harder to spot. The LIVE readout (LiveToolDuration, the args
 * draft meter) keeps ticking from zero — a running clock that shows nothing
 * for its first second reads as broken, which is the opposite problem.
 */
const SETTLED_DURATION_FLOOR_MS = 1000

function formatSettledToolDuration(ms: number): string {
  if (ms < SETTLED_DURATION_FLOOR_MS) return ''
  return formatToolDuration(ms)
}

function buildDuration(toolCall: ToolCall, nowMs = Date.now()): string {
  const running = toolCall.status === 'executing' || toolCall.status === 'input-streaming'
  if (running) {
    if (!toolCall.startTime) return ''
    return formatToolDuration(Math.max(0, (toolCall.endTime ?? nowMs) - toolCall.startTime))
  }
  // Frozen final duration stays on the row so runs can be compared.
  if (toolCall.status === 'completed' || toolCall.status === 'failed' || toolCall.status === 'cancelled') {
    if (typeof toolCall.durationMs === 'number') {
      return formatSettledToolDuration(Math.max(0, toolCall.durationMs))
    }
    if (toolCall.startTime && toolCall.endTime) {
      return formatSettledToolDuration(Math.max(0, toolCall.endTime - toolCall.startTime))
    }
  }
  return ''
}

export function buildErrorSummary(
  step: Step,
  toolCall: ToolCall,
  status: ToolRenderStatus,
): string {
  if (status !== 'failed' && status !== 'rejected') return ''

  const reason = compactFailureReason(getRawToolError(step, toolCall))
  // A rejection used to render as an empty row — the collapsed line said
  // nothing about why the tool never ran. The stored error already carries
  // the rejection reason, so show it.
  if (status === 'rejected') return reason || 'Permission was rejected.'
  return reason || 'Tool failed.'
}

function getRawToolError(step: Step, toolCall: ToolCall): string {
  if (typeof step.error === 'string' && step.error.trim()) return step.error
  if (typeof toolCall.error === 'string' && toolCall.error.trim()) return toolCall.error

  if (typeof step.result === 'string' && step.result.trim()) {
    try {
      const parsed = JSON.parse(step.result)
      const message = parsed?.error || parsed?.message || parsed?.details?.error || parsed?.details?.message
      if (message) return String(message)
    } catch {
      return step.result
    }
  }

  return ''
}

/**
 * The collapsed row shows the failure's first line verbatim. Tool errors are
 * written "short reason first, detail below" (see edit-engine's
 * editFailureError), so the first line is already the actionable sentence —
 * truncating it or stripping its prefix used to leave a generic half-sentence
 * with the real cause thrown away.
 */
function compactFailureReason(value: string): string {
  const firstLine = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) || ''

  // Legacy transcripts stored "Failed to edit <path>: <engine message>". The
  // wrapper is gone from production, but old sessions still render.
  return firstLine
    .replace(/^error:\s*/i, '')
    .replace(/^failed:\s*/i, '')
    .replace(/^failed to\s+\w+\s+[^:]+:\s*/i, '')
}
