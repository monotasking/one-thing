import type {
  AgentContentPart,
  AgentInputModality,
  AgentJsonObject,
  AgentJsonValue,
  AgentMessageContent,
  AgentModelCapabilities,
  AgentToolResult,
} from './types.js'
import {
  agentSupportsStructuredToolResults,
  agentSupportsToolResultModality,
} from './capabilities.js'

function isRecord(value: AgentJsonValue | undefined): value is AgentJsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseDataUrl(value: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(value)
  if (!match) return undefined
  return { mediaType: match[1], data: match[2] }
}

function mediaPartFromData(
  type: AgentJsonValue | undefined,
  data: AgentJsonValue | undefined,
  mediaType: AgentJsonValue | undefined,
  filename?: AgentJsonValue | undefined,
): AgentContentPart | undefined {
  if (typeof data !== 'string' || data.length === 0) return undefined

  const parsed = parseDataUrl(data)
  const resolvedMediaType = typeof mediaType === 'string' && mediaType
    ? mediaType
    : parsed?.mediaType

  if (type === 'image' || resolvedMediaType?.startsWith('image/')) {
    return {
      type: 'image',
      image: data,
      ...(resolvedMediaType ? { mediaType: resolvedMediaType } : {}),
    }
  }

  if (type === 'audio' || resolvedMediaType?.startsWith('audio/')) {
    return {
      type: 'audio',
      audio: data,
      ...(resolvedMediaType ? { mediaType: resolvedMediaType } : {}),
    }
  }

  if (type === 'video' || resolvedMediaType?.startsWith('video/')) {
    return {
      type: 'video',
      video: data,
      ...(resolvedMediaType ? { mediaType: resolvedMediaType } : {}),
    }
  }

  if (!resolvedMediaType) return undefined
  return {
    type: 'file',
    data,
    mediaType: resolvedMediaType,
    ...(typeof filename === 'string' && filename ? { filename } : {}),
  }
}

function addStructuredResultParts(payload: AgentJsonValue | undefined, parts: AgentContentPart[]): boolean {
  if (!isRecord(payload)) return false

  let hasMedia = false
  const addText = (text: AgentJsonValue | undefined) => {
    if (typeof text === 'string' && text.length > 0) {
      parts.push({ type: 'text', text })
    }
  }

  if (Array.isArray(payload.content)) {
    for (const part of payload.content) {
      if (!isRecord(part)) continue
      if (part.type === 'text') {
        addText(part.text)
        continue
      }

      const media = mediaPartFromData(
        part.type,
        part.data ?? part.image ?? part.audio ?? part.video ?? part.url,
        part.mimeType ?? part.mediaType,
        part.filename ?? part.name,
      )
      if (media) {
        parts.push(media)
        if (media.type !== 'text') hasMedia = true
      } else if (typeof part.path === 'string' && part.path) {
        addText(`[${String(part.type || 'File')}: ${part.path}]`)
      }
    }
  }

  if (Array.isArray(payload.attachments)) {
    for (const attachment of payload.attachments) {
      if (!isRecord(attachment)) continue
      const media = mediaPartFromData(
        attachment.type,
        attachment.content ?? attachment.data ?? attachment.url,
        attachment.mimeType ?? attachment.mediaType,
        attachment.filename ?? attachment.name,
      )
      if (media) {
        parts.push(media)
        if (media.type !== 'text') hasMedia = true
      } else if (typeof attachment.path === 'string' && attachment.path) {
        addText(`[${String(attachment.type || 'File')}: ${attachment.path}]`)
      }
    }
  }

  return hasMedia
}

function stringifyErrorResult(result: AgentToolResult): string {
  return JSON.stringify({ success: false, error: result.error })
}

function summarizeMediaData(data: string, fallbackMediaType: string | undefined): string {
  if (data.startsWith('http://') || data.startsWith('https://')) return data

  const parsed = parseDataUrl(data)
  const mediaType = parsed?.mediaType ?? fallbackMediaType ?? 'unknown media'
  return `${mediaType} data omitted: ${data.length} chars`
}

export function agentToolMessageContentToText(content: AgentMessageContent): string {
  if (content == null) return ''
  if (typeof content === 'string') return content

  return content
    .map(part => {
      if (part.type === 'text') return part.text
      if (part.type === 'image') {
        return `[Image: ${summarizeMediaData(part.image, part.mediaType)}]`
      }
      if (part.type === 'file') {
        const name = part.filename ? `${part.filename}; ` : ''
        return `[File: ${name}${summarizeMediaData(part.data, part.mediaType)}]`
      }
      if (part.type === 'audio') {
        return `[Audio: ${summarizeMediaData(part.audio, part.mediaType)}]`
      }
      if (part.type === 'video') {
        return `[Video: ${summarizeMediaData(part.video, part.mediaType)}]`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function agentToolMessageContentToStructuredPayload(content: AgentMessageContent): AgentJsonValue {
  if (content == null || typeof content === 'string') return content ?? ''
  if (!Array.isArray(content)) return ''

  let hasStructuredMedia = false
  const parts = content
    .map((part): AgentJsonObject | undefined => {
      if (part.type === 'text') {
        return part.text ? { type: 'text', text: part.text } : undefined
      }
      if (part.type === 'image') {
        hasStructuredMedia = true
        return {
          type: 'image',
          data: part.image,
          mediaType: part.mediaType,
        }
      }
      if (part.type === 'file') {
        if (part.mediaType.startsWith('image/')) {
          hasStructuredMedia = true
          return {
            type: 'file',
            data: part.data,
            mediaType: part.mediaType,
            filename: part.filename,
          }
        }
        return {
          type: 'text',
          text: agentToolMessageContentToText([part]),
        }
      }
      return {
        type: 'text',
        text: agentToolMessageContentToText([part]),
      }
    })
    .filter((part): part is AgentJsonObject => Boolean(part))

  return hasStructuredMedia ? { content: parts } : agentToolMessageContentToText(content)
}

function modalityFromToolMessagePart(part: AgentContentPart): AgentInputModality {
  return part.type
}

export function agentToolMessageContentForCapabilities(
  content: AgentMessageContent,
  capabilities: AgentModelCapabilities,
): AgentMessageContent {
  if (content == null || typeof content === 'string') return content ?? ''
  if (!Array.isArray(content)) return ''
  if (!agentSupportsStructuredToolResults(capabilities)) {
    return agentToolMessageContentToText(content)
  }

  let keptStructuredMedia = false
  const parts: AgentContentPart[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) parts.push(part)
      continue
    }

    if (agentSupportsToolResultModality(capabilities, modalityFromToolMessagePart(part))) {
      parts.push(part)
      keptStructuredMedia = true
      continue
    }

    const text = agentToolMessageContentToText([part])
    if (text) parts.push({ type: 'text', text })
  }

  return keptStructuredMedia ? parts : agentToolMessageContentToText(content)
}

export function agentToolResultToMessageContent(result: AgentToolResult): AgentMessageContent {
  if (result.error) return stringifyErrorResult(result)

  const parts: AgentContentPart[] = []
  if (result.content) {
    parts.push({ type: 'text', text: result.content })
  }

  const hasStructuredMedia = addStructuredResultParts(result.data, parts)
  return hasStructuredMedia ? parts : result.content
}

/**
 * Whether a tool message carries a failure. Providers that have an explicit
 * error flag on their tool-result block (Anthropic's `is_error`) need this;
 * without it a failure reads to the model as a successful result whose text
 * happens to describe a problem.
 */
export function agentToolResultIsError(result: AgentToolResult): boolean {
  return Boolean(result.error) || result.rejected === true
}

/**
 * Same question for a rebuilt-history tool result, where the failure survives
 * as the persisted `{ error, status }` shape rather than an AgentToolResult.
 */
export function agentToolResultIsErrorFromHistoryResult(result: AgentJsonValue | undefined): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false
  const record = result as Record<string, AgentJsonValue | undefined>
  if (record.status === 'failed' || record.status === 'rejected') return true
  if (record.rejected === true) return true
  return typeof record.error === 'string' && record.error.trim().length > 0
}

export function agentToolResultToMessageContentForCapabilities(
  result: AgentToolResult,
  capabilities: AgentModelCapabilities,
): AgentMessageContent {
  return agentToolMessageContentForCapabilities(
    agentToolResultToMessageContent(result),
    capabilities,
  )
}

function safeStringifyHistoryResult(result: AgentJsonValue): string {
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

/**
 * Plausible inline media payload: data/http URLs, or a long unbroken blob
 * (raw base64). Sanitized placeholders like "[Image: … omitted]" and other
 * human-readable strings fail this check and are treated as text — otherwise
 * a vision model would receive an invalid image part.
 */
function looksLikeMediaData(value: AgentJsonValue | undefined): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.startsWith('data:') || value.startsWith('http://') || value.startsWith('https://')) return true
  return value.length > 1_000 && !/[\s[\]{}]/.test(value.slice(0, 200))
}

/**
 * Convert a PERSISTED tool result (the `{title, output, metadata,
 * attachments}` object stored on the session) into the exact message content
 * the live loop produced for it — same text, same capability gating, same
 * media handling. This is the single convergence point that keeps rebuilt
 * histories identical to what the model saw during the original turn.
 */
export function agentToolMessageContentFromHistoryResult(
  result: AgentJsonValue | undefined,
  capabilities: AgentModelCapabilities,
): AgentMessageContent {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (typeof result !== 'object' || Array.isArray(result)) return safeStringifyHistoryResult(result)

  const record = result as AgentJsonObject
  const looksLikeToolResult =
    typeof record.output === 'string' ||
    Array.isArray(record.attachments) ||
    Array.isArray(record.content)
  if (!looksLikeToolResult) return safeStringifyHistoryResult(record)

  // Attachments whose payload was already replaced by a sanitizer
  // placeholder (or never had inline data) degrade to text lines; only
  // plausible media survives as structured parts for capable models.
  const textExtras: string[] = []
  const mediaAttachments: AgentJsonValue[] = []
  for (const attachment of Array.isArray(record.attachments) ? record.attachments : []) {
    if (!isRecord(attachment)) continue
    const data = attachment.content ?? attachment.data ?? attachment.url
    if (looksLikeMediaData(data)) {
      mediaAttachments.push(attachment)
    } else if (typeof data === 'string' && data) {
      textExtras.push(data)
    } else if (typeof attachment.path === 'string' && attachment.path) {
      textExtras.push(`[${String(attachment.type || 'File')}: ${attachment.path}]`)
    }
  }

  const output = typeof record.output === 'string' ? record.output : ''
  const content = [output, ...textExtras].filter(Boolean).join('\n')
  return agentToolResultToMessageContentForCapabilities(
    { content, data: { ...record, attachments: mediaAttachments } },
    capabilities,
  )
}
