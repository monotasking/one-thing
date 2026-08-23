/**
 * Session storage dehydration/rehydration.
 *
 * A finished session used to persist the same tool payload three times:
 * `toolCall.result`, a full `step.toolCall` copy, and a final
 * `step.partialResult` — plus inline base64 for image attachments. Dehydrate
 * strips the duplicates and binaries before the JSON hits disk; rehydrate
 * restores the exact in-memory shape on load, so nothing outside the storage
 * layer ever sees the difference (image binaries are the one lossy part:
 * their `path` survives, the inline base64 does not).
 */

import { toJsonValue, toolResultToStructured } from '@onething/core'

const INLINE_BINARY_MAX_CHARS = 2_000

interface StoredAttachmentLike {
  type?: string
  path?: string
  content?: unknown
  data?: unknown
  mimeType?: string
  mediaType?: string
  [key: string]: unknown
}

interface StoredToolCallLike {
  id?: string
  status?: string
  result?: unknown
  changes?: { originalContent?: string; [key: string]: unknown }
  [key: string]: unknown
}

interface StoredStepLike {
  toolCallId?: string
  toolCall?: StoredToolCallLike
  status?: string
  partialResult?: unknown
  partialResultIsPartial?: boolean
  [key: string]: unknown
}

interface StoredMessageLike {
  toolCalls?: StoredToolCallLike[]
  steps?: StoredStepLike[]
  [key: string]: unknown
}

export interface StoredSessionLike {
  messages?: StoredMessageLike[]
  [key: string]: unknown
}

function attachmentPlaceholder(attachment: StoredAttachmentLike, dataChars: number): string {
  const kind = attachment.type === 'image' ? 'Image' : 'File'
  const mediaType = typeof attachment.mimeType === 'string'
    ? attachment.mimeType
    : typeof attachment.mediaType === 'string' ? attachment.mediaType : 'binary'
  return `[${kind}: ${mediaType} data omitted: ${dataChars} chars]`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Strip inline binaries (attachment content, media part data) from any
 * nested value. Returns the original reference when nothing changed. */
function stripInlineBinaries(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map(entry => {
      const stripped = stripInlineBinaries(entry)
      if (stripped !== entry) changed = true
      return stripped
    })
    return changed ? next : value
  }
  if (!isPlainObject(value)) return value

  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if ((key === 'content' || key === 'data') && typeof entry === 'string' && entry.length > INLINE_BINARY_MAX_CHARS) {
      next[key] = attachmentPlaceholder(value as StoredAttachmentLike, entry.length)
      changed = true
      continue
    }
    const stripped = stripInlineBinaries(entry)
    if (stripped !== entry) changed = true
    next[key] = stripped
  }
  return changed ? next : value
}

function dehydrateToolCall(toolCall: StoredToolCallLike): StoredToolCallLike {
  let next = toolCall

  const strippedResult = stripInlineBinaries(toolCall.result)
  if (strippedResult !== toolCall.result) {
    next = { ...next, result: strippedResult }
  }

  // Legacy sessions still inline the whole pre-edit file for rollback;
  // rollback goes through auditPath, so drop it from new writes.
  if (next.changes && typeof next.changes.originalContent === 'string') {
    const { originalContent: _omitted, ...changes } = next.changes
    next = next === toolCall ? { ...toolCall, changes } : { ...next, changes }
  }

  return next
}

function dehydrateStep(step: StoredStepLike, toolCallIds: Set<string>): StoredStepLike {
  let next = step

  // The full toolCall copy is redundant with message.toolCalls; keep only
  // the id link. Steps without a resolvable link keep a stripped copy.
  if (step.toolCall) {
    if (step.toolCallId && toolCallIds.has(step.toolCallId)) {
      next = { ...next, toolCall: undefined }
    } else {
      next = { ...next, toolCall: dehydrateToolCall(step.toolCall) }
    }
  }

  // A settled partialResult duplicates toolCall.result; it is rebuilt from
  // it on load. Mid-stream partials survive (stripped of binaries).
  if (step.partialResult !== undefined) {
    if (step.partialResultIsPartial === false) {
      next = { ...next, partialResult: undefined }
    } else {
      const stripped = stripInlineBinaries(step.partialResult)
      if (stripped !== step.partialResult) next = { ...next, partialResult: stripped }
    }
  }

  return next
}

export function dehydrateSessionForStorage<TSession>(input: TSession): TSession {
  const session = input as unknown as StoredSessionLike
  if (!Array.isArray(session.messages)) return input

  let messagesChanged = false
  const messages = session.messages.map(message => {
    if (!isPlainObject(message)) return message
    let next: StoredMessageLike = message

    if (Array.isArray(message.toolCalls)) {
      let changed = false
      const toolCalls = message.toolCalls.map(toolCall => {
        const dehydrated = dehydrateToolCall(toolCall)
        if (dehydrated !== toolCall) changed = true
        return dehydrated
      })
      if (changed) next = { ...next, toolCalls }
    }

    if (Array.isArray(message.steps)) {
      const toolCallIds = new Set(
        (next.toolCalls ?? []).map(toolCall => toolCall.id).filter((id): id is string => typeof id === 'string'),
      )
      let changed = false
      const steps = message.steps.map(step => {
        const dehydrated = dehydrateStep(step, toolCallIds)
        if (dehydrated !== step) changed = true
        return dehydrated
      })
      if (changed) next = { ...next, steps }
    }

    if (next !== message) messagesChanged = true
    return next
  })

  return (messagesChanged ? { ...session, messages } : session) as unknown as TSession
}

const TERMINAL_STEP_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/**
 * #4(§13.13):把投影出的消息过一遍**磁盘同款**的脱水 + 补水,好和
 * `messages.jsonl` 逐字节对齐。
 *
 * 病根:一张 `read` 工具读回来的图片,落盘时 `dehydrateSessionForStorage` 把
 * `toolCall.result` / `step.partialResult` 里那段图片正文(`content` / `data` 键、
 * 超 2000 字符)换成 `[Image: … data omitted: N chars]` 占位,补水又不还原它;
 * 而投影(A8)把 blob 换回**全文** —— 两侧于是分叉(裁定:选项 1,投影也省略,
 * 与脱水口径一致;图片本体仍在 blob 里一份,轨迹 / UI 按需取)。
 *
 * 复用的是**同一把**函数(`dehydrate` + `rehydrate`),所以两侧产出的占位符逐字
 * 相同。作用域只在 `toolCall.result` / `step.partialResult`(dehydrate 的作用域)——
 * 消息级的 `content` / `contentParts` / `attachments.base64Data` 是别的字段,dehydrate
 * 一律不碰,所以 #3(附件 base64 往返)与 R-b(生图正文)不受影响。
 *
 * `rehydrate` 就地改对象,所以先 `structuredClone` 一份,绝不动调用方(投影缓存 /
 * 活投影节点)里的那份。
 */
export function dehydrateProjectedMessages<TMessage>(messages: readonly TMessage[]): TMessage[] {
  const cloned = structuredClone(messages as unknown as TMessage[])
  const round = rehydrateSessionFromStorage(
    dehydrateSessionForStorage({ messages: cloned as unknown[] }),
  ) as { messages: TMessage[] }
  return round.messages
}

export function rehydrateSessionFromStorage<TSession>(input: TSession): TSession {
  const session = input as unknown as StoredSessionLike
  if (!Array.isArray(session.messages)) return input

  for (const message of session.messages) {
    if (!isPlainObject(message) || !Array.isArray(message.steps)) continue
    const toolCallsById = new Map(
      (message.toolCalls ?? [])
        .filter((toolCall): toolCall is StoredToolCallLike & { id: string } => typeof toolCall?.id === 'string')
        .map(toolCall => [toolCall.id, toolCall]),
    )

    for (const step of message.steps) {
      if (!isPlainObject(step)) continue
      const linked = step.toolCallId ? toolCallsById.get(step.toolCallId) : undefined

      if (!step.toolCall && linked) {
        step.toolCall = linked
      }

      if (
        step.partialResult === undefined &&
        TERMINAL_STEP_STATUSES.has(String(step.status)) &&
        linked?.result !== undefined
      ) {
        step.partialResult = toolResultToStructured(toJsonValue(linked.result) as never)
        step.partialResultIsPartial = false
      }
    }
  }

  return input
}
