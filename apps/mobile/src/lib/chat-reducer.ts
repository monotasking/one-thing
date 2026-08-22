import type { ChatMessage, ContentPart } from '@shared/ipc/chat.js'
import type { SessionEventType } from '@onething/core/events/session-event-types.js'

/**
 * Narrow mirror of packages/shared/events/session-events.ts — the M2 subset
 * the mobile reducer acts on. Defined locally on purpose: importing the full
 * SessionEvent union drags in the ipc barrel + @onething/core/interaction
 * (node:crypto) and breaks the hermetic mobile typecheck. These are the
 * oldest, most stable shapes on the wire; SSE JSON is untyped at parse time
 * anyway, and events outside this union hit `default: return state`.
 *
 * **载荷**在这里手抄,**词汇**不抄 —— 见文件末尾的 `MobileSessionEventVocabulary`。
 */
export type SessionEventPayload =
  | { type: 'message:user-created' | 'message:created'; message: ChatMessage }
  | { type: 'message:assistant-created'; message: ChatMessage }
  | { type: 'message:updated'; messageId: string; updates: Partial<ChatMessage> }
  | { type: 'message:deleted'; messageId: string }
  | { type: 'messages:replaced'; messages: ChatMessage[] }
  | { type: 'stream:start'; messageId: string; assistantMessageId: string; model?: string }
  | { type: 'stream:complete'; data: { aborted?: boolean; error?: string } }
  | { type: 'stream:aborted'; reason?: string }
  | { type: 'stream:error'; data: { error: string; errorDetails?: string } }
  | { type: 'content:part'; part: ContentPart }

/**
 * Pure chat reducer — mirrors the desktop hot-path semantics
 * (packages/renderer/stores/chat.ts handleStreamChunk) with M2 scope:
 * text streaming only; tool calls / steps land in M3.
 *
 * Wire facts (apps/server http.ts handleEvents):
 * - `session:event` frames carry { sessionId, sequence, timestamp, event }.
 * - `session:stream` frames carry { sessionId, chunk } with the messageId
 *   stamped by the server coalescer; chunks are NOT replayed on reconnect —
 *   text gaps after a resume are healed by the authoritative `content:part`
 *   finalized-text fallback (same contract as the desktop).
 */

export interface ChatState {
  messages: ChatMessage[]
  streamingMessageId: string | null
}

export const initialChatState: ChatState = { messages: [], streamingMessageId: null }

/**
 * 词汇闸(结构债 P4 E1-a)—— 上面那批 `type` 字面量必须逐条是
 * `SESSION_EVENT_TYPES`(`packages/core/events/session-event-types.ts`,会话事件
 * 词汇的唯一权威)的成员。多一个拼错的、或者哪天线上把某条事件改名,这一行当场
 * 编译不过。
 *
 * 为什么是类型约束而不是把常量 import 进来当值:那张表在 core 的一个零 import
 * 叶子文件里,`import type` 被 Babel 整行擦除、Metro 根本看不到(metro.config.js
 * 的注释就是这条约定);import 值则会真的把一个 workspace 包拖进 RN 包 —— mobile
 * 的 node_modules 里连 `@onething/core` 都没有,那是 tsconfig paths 上的一条纯
 * 类型通路。载荷形状仍然只能手抄(它们要引用 shared 的 ipc 目录),但**名字**
 * 从此不是手抄的。
 */
export type MobileSessionEventVocabulary = AssertSessionEventTypes<SessionEventPayload['type']>
type AssertSessionEventTypes<T extends SessionEventType> = T

export interface SessionEventEnvelopeWire {
  sessionId: string
  sequence?: number
  timestamp?: number
  event: SessionEventPayload
}

export interface StreamChunkWire {
  type: string
  text?: string
  /** Stamped by the server coalescer; falls back to streamingMessageId when absent. */
  messageId?: string
  turnIndex?: number
}

function upsert(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((m) => m.id === message.id)
  if (index < 0) return [...messages, message]
  const next = messages.slice()
  next[index] = { ...next[index], ...message }
  return next
}

function patchMessage(
  messages: ChatMessage[],
  id: string,
  patch: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const index = messages.findIndex((m) => m.id === id)
  if (index < 0) return messages
  const next = messages.slice()
  next[index] = patch(next[index])
  return next
}

/** Streaming hot path: append to flat content and merge the trailing text part. */
function appendText(message: ChatMessage, text: string): ChatMessage {
  const content = (message.content ?? '') + text
  const parts = [...(message.contentParts ?? [])]
  const last = parts[parts.length - 1]
  if (last && last.type === 'text') {
    parts[parts.length - 1] = { ...last, content: last.content + text }
  } else {
    parts.push({ type: 'text', content: text })
  }
  return { ...message, content, contentParts: parts }
}

/**
 * content:part(text) is a finalized block. The delta hot path usually already
 * delivered it — only append what is genuinely missing (post-resume gap heal).
 */
function applyFinalizedText(message: ChatMessage, part: { content: string }): ChatMessage {
  if (!part.content) return message
  if ((message.content ?? '').includes(part.content)) return message
  return appendText(message, part.content)
}

function lastAssistantId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].id
  }
  return null
}

export function applySessionEvent(state: ChatState, envelope: SessionEventEnvelopeWire): ChatState {
  const { event } = envelope
  switch (event.type) {
    case 'message:user-created':
    case 'message:created':
      return { ...state, messages: upsert(state.messages, event.message) }

    case 'message:assistant-created':
      return {
        ...state,
        messages: upsert(state.messages, { ...event.message, isStreaming: true }),
        streamingMessageId: event.message.id,
      }

    case 'stream:start': {
      const messageId = event.messageId || event.assistantMessageId
      if (!messageId) return state
      return {
        ...state,
        streamingMessageId: messageId,
        messages: patchMessage(state.messages, messageId, (m) => ({ ...m, isStreaming: true })),
      }
    }

    case 'stream:complete':
    case 'stream:aborted':
    case 'stream:error': {
      const targetId = state.streamingMessageId
      const messages = targetId
        ? patchMessage(state.messages, targetId, (m) => ({
            ...m,
            isStreaming: false,
            ...(event.type === 'stream:error' ? { errorDetails: event.data.error } : {}),
          }))
        : state.messages
      return { ...state, messages, streamingMessageId: null }
    }

    case 'content:part': {
      const part = event.part
      if (part.type !== 'text') return state // tool calls / steps land in M3
      const targetId = state.streamingMessageId ?? lastAssistantId(state.messages)
      if (!targetId) return state
      return {
        ...state,
        messages: patchMessage(state.messages, targetId, (m) => applyFinalizedText(m, part)),
      }
    }

    case 'message:updated':
      return {
        ...state,
        messages: patchMessage(state.messages, event.messageId, (m) => ({ ...m, ...event.updates })),
      }

    case 'message:deleted':
      return { ...state, messages: state.messages.filter((m) => m.id !== event.messageId) }

    case 'messages:replaced':
      return { ...state, messages: event.messages }

    default:
      return state
  }
}

export function applyStreamChunk(state: ChatState, chunk: StreamChunkWire): ChatState {
  if (chunk.type !== 'text-delta' || !chunk.text) return state
  const targetId = chunk.messageId ?? state.streamingMessageId
  if (!targetId) return state
  const messages = patchMessage(state.messages, targetId, (m) => ({
    ...appendText(m, chunk.text as string),
    isStreaming: true,
  }))
  // patchMessage is reference-stable when the id is unknown — preserve state
  // identity so zustand subscribers don't re-render on dropped chunks.
  if (messages === state.messages) return state
  return { ...state, messages }
}

/** Merge a history page, de-duplicating by message id (live echoes may already exist). */
export function applyHistoryPage(state: ChatState, messages: ChatMessage[], prepend: boolean): ChatState {
  if (messages.length === 0) return state
  const known = new Set(state.messages.map((m) => m.id))
  const fresh = messages.filter((m) => !known.has(m.id))
  return { ...state, messages: prepend ? [...fresh, ...state.messages] : [...state.messages, ...fresh] }
}
