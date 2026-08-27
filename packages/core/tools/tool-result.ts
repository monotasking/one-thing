import type { JsonObject } from '../json.js'
import { toJsonObject } from '../json.js'
// §17.8 U1-a:走**叶子路径**,不走 `permission/index.js` 那个桶 —— 桶带
// `node:crypto`(它自己)与 `node:os|path`(`permission-grants` / `capability-registry`),
// 而这个文件在 `session/projection/reducer.ts` 的浏览器闭包里。
import {
  DEFAULT_PERMISSION_REJECTED_MESSAGE,
  formatPermissionRejectedMessage,
} from '../permission/rejection-message.js'

export interface CanonicalToolResultContentPart {
  type: 'text' | 'image' | 'file'
  text?: string
  data?: string
  mimeType?: string
  path?: string
}

export interface CanonicalToolResult<TDetails = JsonObject | undefined> {
  content: CanonicalToolResultContentPart[]
  details?: TDetails
  terminate?: boolean
}

export interface ToolResultLike {
  title?: string
  output?: string
  metadata?: JsonObject
  attachments?: Array<{
    type: 'file' | 'image'
    path: string
    content?: string
    data?: string
    mimeType?: string
  }>
}

export function textFromToolResult(result: CanonicalToolResult | undefined): string {
  if (!result) return ''
  const text = result.content
    .map((part) => {
      if (part.type === 'text') return part.text ?? ''
      if (part.type === 'file') return part.path ? `[File: ${part.path}]` : ''
      if (part.type === 'image') return part.path ? `[Image: ${part.path}]` : '[Image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
  return text || JSON.stringify(result)
}

type ToolResultInput =
  | string
  | ToolResultLike
  | CanonicalToolResult<JsonObject | undefined>
  | null
  | undefined

export function toolResultToStructured(result: ToolResultInput): CanonicalToolResult<JsonObject | undefined> {
  if (result && typeof result === 'object' && isCanonicalToolResult(result)) return result

  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }], details: undefined }
  }

  const value = (result && typeof result === 'object' ? result : {}) as ToolResultLike
  const content: CanonicalToolResultContentPart[] = []

  if (typeof value.output === 'string') {
    content.push({ type: 'text', text: value.output })
  }

  for (const attachment of value.attachments ?? []) {
    if (!attachment?.path) continue
    const part: CanonicalToolResultContentPart = {
      type: attachment.type === 'image' ? 'image' : 'file',
      path: attachment.path,
      mimeType: attachment.mimeType,
    }
    const attachmentData = attachment.content ?? attachment.data
    if (attachment.type === 'image') {
      part.data = attachmentData
    } else {
      part.text = attachment.content
      part.data = attachment.data
    }
    content.push(part)
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: JSON.stringify(result ?? null) })
  }

  return {
    content,
    details: value.metadata ? toJsonObject(value.metadata) : undefined,
  }
}

export interface ToolFailureLike {
  error?: string
  rejected?: boolean
  rejectionReason?: string
  status?: string
  toolName?: string
  toolId?: string
  arguments?: JsonObject
}

export interface ToolFailureResultForAI {
  error: string
  rejected?: boolean
  rejectionReason?: string
  status?: string
  parameters?: JsonObject
  parameterSummary?: string
}

export interface ToolFailureParameterSummary {
  summary: string
  parameters: JsonObject
}

function shortPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || normalized || path
}

export function summarizeToolFailureParameters(
  toolName: string | undefined,
  args: JsonObject | undefined,
): ToolFailureParameterSummary | null {
  if (!args || Object.keys(args).length === 0) return null

  const normalizedToolName = (toolName || '').toLowerCase()
  if (normalizedToolName === 'edit') {
    const path = typeof args.path === 'string' ? args.path : undefined
    const edits = Array.isArray(args.edits) ? args.edits : []
    return {
      summary: [
        path ? `path: ${shortPath(path)}` : '',
        `edits: ${edits.length}`,
      ].filter(Boolean).join(' · '),
      parameters: {
        ...(path ? { path } : {}),
        edits,
      },
    }
  }

  if (normalizedToolName === 'bash') {
    const command = typeof args.command === 'string' ? args.command : undefined
    return command
      ? { summary: `command: ${command}`, parameters: { command } }
      : { summary: 'parameters', parameters: args }
  }

  const preferredKeys = ['path', 'pattern', 'command', 'name', 'action']
  const parts = preferredKeys
    .filter(key => args[key] !== undefined)
    .map(key => `${key}: ${String(args[key])}`)

  return {
    summary: parts.length > 0 ? parts.join(' · ') : 'parameters',
    parameters: args,
  }
}

export function toolFailureText(failure: ToolFailureLike): string {
  if (failure.rejected) {
    return formatPermissionRejectedMessage(failure.rejectionReason) || failure.error || DEFAULT_PERMISSION_REJECTED_MESSAGE
  }
  if (typeof failure.error === 'string' && failure.error.trim()) return failure.error
  if (failure.status === 'cancelled') return 'Tool execution was cancelled.'
  return 'Tool execution failed.'
}

export function toolFailureResultForAI(failure: ToolFailureLike): ToolFailureResultForAI {
  const result: ToolFailureResultForAI = {
    error: toolFailureText(failure),
  }
  const parameterSummary = summarizeToolFailureParameters(
    failure.toolName || failure.toolId,
    failure.arguments,
  )
  if (parameterSummary) {
    result.parameterSummary = parameterSummary.summary
    result.parameters = parameterSummary.parameters
  }
  if (failure.rejected) result.rejected = true
  if (failure.rejectionReason) result.rejectionReason = failure.rejectionReason
  if (failure.status) result.status = failure.status
  return result
}

export function isCanonicalToolResult(value: object | null | undefined): value is CanonicalToolResult<JsonObject | undefined> {
  return Boolean(
    value &&
    Array.isArray((value as Partial<CanonicalToolResult>).content),
  )
}
