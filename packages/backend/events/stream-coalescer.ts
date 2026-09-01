/**
 * Session stream coalescing shared by every streaming transport.
 *
 * A real provider emits hundreds of delta chunks per second; forwarding each
 * one is what made the desktop IPC chatty, and the server SSE path has the
 * same problem. Both hosts route their chunk streams through this module:
 * - Text/reasoning/tool-input deltas are coalesced in a 16ms ordered buffer
 *   (per session) before delivery, preserving cross-type stream ordering.
 * - Every delivered chunk carries the active stream's messageId (engine chunks
 *   don't stamp it; renderers route by it).
 * - Flush-before-event: pending buffers are flushed before any session event
 *   is forwarded, so e.g. a permission:request never overtakes the tool-input
 *   deltas that precede it.
 *
 * The coalescer owns no subscriptions — hosts feed it via handleEvent /
 * handleChunk and receive deliveries through the sink.
 */

import type {
  ReasoningPlacement,
  SessionEventEnvelope,
  StreamChunk,
  StreamDeltaStamp,
  UiAssistantChunksChunk,
} from '@shared/events/index.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('engine.stream.coalescer')

export type BufferedStreamChunk =
  | { type: 'text-delta'; text: string; turnIndex?: number; voiceSpeakText?: string; stamp?: StreamDeltaStamp }
  | { type: 'reasoning-delta'; reasoning: string; turnIndex?: number; placement?: ReasoningPlacement; stamp?: StreamDeltaStamp }
  | { type: 'tool-input-delta'; toolCallId: string; argsTextDelta: string; stamp?: StreamDeltaStamp }
  // U0:UI 事件流的小批(`docs/design/ui-event-stream-2026-08.md` §3)。它与上面
  // 三条**并排**躺在同一个 16ms 缓冲里 —— 一个缓冲一个顺序,两条流的相对次序
  // 因此天然稳定,而不是各排各的队再在管口撞车。
  | UiAssistantChunksChunk

/** Accumulates high-frequency stream chunks between flush intervals. */
export interface StreamBuffer {
  chunks: BufferedStreamChunk[]
  timer: ReturnType<typeof setTimeout> | null
}

export function createStreamBuffer(): StreamBuffer {
  return { chunks: [], timer: null }
}

/**
 * R1:**合批器只搬运,不编号**(`docs/stream-render-2026-09.md` 审查条 2)。
 *
 * 一批 delta 是连续的,所以整批只需要**批内第一条**那枚章:批长可推,后面每一条
 * 的偏移 = 批首偏移 + 已并进去的字数。搬运的规矩因此多一条:**并批之前先问两枚章
 * 接不接得上** —— 同一段(消息 / run / 请求 / partIndex / 世代)且偏移正好衔接。
 *
 * 接不上就另起一条,不是保守:两条不连续的 delta 并成一批,那枚批首章会替后半截
 * 说一句假话(「我从第 N 个字起连续这么长」),而水位表正是按这句话落格的 ——
 * 章说错比没有章危险得多。
 *
 * 两边都没有章(旧路 / 旁路发的正文)时按老规矩并,行为逐字不变。
 */
function stampsJoin(
  last: StreamDeltaStamp | undefined,
  lastLength: number,
  next: StreamDeltaStamp | undefined,
): boolean {
  if (!last && !next) return true
  if (!last || !next) return false
  return (
    last.messageId === next.messageId
    && last.runId === next.runId
    && last.requestIndex === next.requestIndex
    && last.partIndex === next.partIndex
    && last.kind === next.kind
    && last.gen === next.gen
    && last.charOffset + lastLength === next.charOffset
  )
}

export function appendStreamBufferChunk(buffer: StreamBuffer, chunk: StreamChunk): boolean {
  const last = buffer.chunks[buffer.chunks.length - 1]

  if (chunk.type === 'text-delta') {
    if (
      last?.type === 'text-delta'
      && last.turnIndex === chunk.turnIndex
      && stampsJoin(last.stamp, last.text.length, chunk.stamp)
    ) {
      last.text += chunk.text
      if (chunk.voiceSpeakText !== undefined || last.voiceSpeakText !== undefined) {
        last.voiceSpeakText = `${last.voiceSpeakText ?? ''}${chunk.voiceSpeakText ?? ''}`
      }
    } else {
      buffer.chunks.push({
        type: 'text-delta',
        text: chunk.text,
        ...(chunk.turnIndex !== undefined ? { turnIndex: chunk.turnIndex } : {}),
        ...(chunk.voiceSpeakText !== undefined ? { voiceSpeakText: chunk.voiceSpeakText } : {}),
        // 批首那枚章:批是连续的,后面每一条的偏移由批长推得出来。
        ...(chunk.stamp ? { stamp: chunk.stamp } : {}),
      })
    }
    return true
  }

  if (chunk.type === 'reasoning-delta') {
    if (
      last?.type === 'reasoning-delta'
      && last.turnIndex === chunk.turnIndex
      && last.placement === chunk.placement
      && stampsJoin(last.stamp, last.reasoning.length, chunk.stamp)
    ) {
      last.reasoning += chunk.reasoning
    } else {
      buffer.chunks.push({
        type: 'reasoning-delta',
        reasoning: chunk.reasoning,
        ...(chunk.turnIndex !== undefined ? { turnIndex: chunk.turnIndex } : {}),
        ...(chunk.placement ? { placement: chunk.placement } : {}),
        ...(chunk.stamp ? { stamp: chunk.stamp } : {}),
      })
    }
    return true
  }

  if (chunk.type === 'tool-input-delta') {
    if (
      last?.type === 'tool-input-delta'
      && last.toolCallId === chunk.toolCallId
      && stampsJoin(last.stamp, last.argsTextDelta.length, chunk.stamp)
    ) {
      last.argsTextDelta += chunk.argsTextDelta
    } else {
      buffer.chunks.push({
        type: 'tool-input-delta',
        toolCallId: chunk.toolCallId,
        argsTextDelta: chunk.argsTextDelta,
        ...(chunk.stamp ? { stamp: chunk.stamp } : {}),
      })
    }
    return true
  }

  // U0:UI 事件流的 delta 已经在**源头**盖过章(messageId / partIndex / kind ——
  // core 的 part 边界状态机判的那一次)。这里因此不再判第二遍边界,只按那枚章
  // 攒批:同一段就并进上一条,换段就另起一条。
  if (chunk.type === 'assistant/delta') {
    if (
      last?.type === 'assistant/chunks'
      && last.messageId === chunk.messageId
      && last.partIndex === chunk.partIndex
    ) {
      last.text.push(chunk.text)
    } else {
      buffer.chunks.push({
        type: 'assistant/chunks',
        runId: chunk.runId,
        requestIndex: chunk.requestIndex,
        messageId: chunk.messageId,
        partIndex: chunk.partIndex,
        kind: chunk.kind,
        ...(chunk.toolCallId ? { toolCallId: chunk.toolCallId } : {}),
        ...(chunk.toolName ? { toolName: chunk.toolName } : {}),
        ...(chunk.turnIndex !== undefined ? { turnIndex: chunk.turnIndex } : {}),
        text: [chunk.text],
      })
    }
    return true
  }

  return false
}

export function drainStreamBuffer(buffer: StreamBuffer): BufferedStreamChunk[] {
  const chunks = buffer.chunks
  buffer.chunks = []
  return chunks
}

// ── Debug tracing ───────────────────────────────────────────────────────
// 等级过滤取代了旧的 `ONETHING_DEBUG_STREAM` 开关(它现在是 `engine.stream=trace`
// 的废弃别名,见 app/logging/legacy-debug-env.ts)。

function streamChunkText(chunk: BufferedStreamChunk): string {
  if (chunk.type === 'text-delta') return chunk.text
  if (chunk.type === 'reasoning-delta') return chunk.reasoning
  if (chunk.type === 'tool-input-delta') return chunk.argsTextDelta
  if (chunk.type === 'assistant/chunks') return chunk.text.join('')
  return ''
}

/**
 * U0:UI 事件流的那几条**自带 messageId**(源头就盖好了章,steering 换锚点时
 * 它比"当前活跃流"更早也更准),所以合帧器不许用自己那份去盖它。
 */
function isUiStreamChunkType(type: string): boolean {
  return type === 'assistant/delta'
    || type === 'assistant/chunks'
    || type === 'assistant/part-end'
}

function previewText(value: string, maxLength = 240): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

const debugLastSendAt = new Map<string, number>()

function debugGapMs(key: string, now = Date.now()): number | undefined {
  const previous = debugLastSendAt.get(key)
  debugLastSendAt.set(key, now)
  return previous === undefined ? undefined : now - previous
}

// ── Coalescer ───────────────────────────────────────────────────────────

export type OutgoingStreamChunk = (StreamChunk | BufferedStreamChunk) & { messageId?: string }

export interface SessionStreamCoalescerSink {
  sendChunk(sessionId: string, chunk: OutgoingStreamChunk): void
}

interface CoalescerSessionState {
  messageId: string
  buffer: StreamBuffer
}

export interface SessionStreamCoalescerOptions {
  flushIntervalMs?: number
  /** Label used in ONETHING_DEBUG_STREAM traces (e.g. 'IPCBridge', 'ServerSSE'). */
  debugLabel?: string
}

export class SessionStreamCoalescer {
  private sessions = new Map<string, CoalescerSessionState>()
  private readonly flushIntervalMs: number
  private readonly debugLabel: string

  constructor(
    private readonly sink: SessionStreamCoalescerSink,
    options: SessionStreamCoalescerOptions = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? 16
    this.debugLabel = options.debugLabel ?? 'StreamCoalescer'
  }

  /**
   * Observe a session event BEFORE the host forwards it: flushes pending
   * deltas so they never arrive after the event, and tracks the active
   * stream's messageId across stream:start/end.
   */
  handleEvent(envelope: SessionEventEnvelope): void {
    const { sessionId, event } = envelope
    const existing = this.sessions.get(sessionId)
    if (existing && event.type !== SESSION_EVENT_TYPES.STREAM_START) {
      this.flush(sessionId, existing)
    }
    switch (event.type) {
      case SESSION_EVENT_TYPES.STREAM_START:
        this.start(sessionId, event.assistantMessageId)
        break
      case SESSION_EVENT_TYPES.STREAM_COMPLETE:
      case SESSION_EVENT_TYPES.STREAM_ERROR:
      case SESSION_EVENT_TYPES.STREAM_ABORTED:
        this.end(sessionId)
        break
    }
  }

  /** Route a stream chunk: buffer deltas, deliver everything else at once. */
  handleChunk(sessionId: string, chunk: StreamChunk): void {
    const state = this.sessions.get(sessionId)

    // U0:一段收齐了 —— 与 flush-before-event 同一条纪律,那一段还攒着的 delta
    // 必须先走,`assistant/part-end` 不许越过自己那一段的正文。
    if (chunk.type === 'assistant/part-end') {
      if (state) this.flush(sessionId, state)
      this.sink.sendChunk(sessionId, chunk)
      return
    }

    const bufferable = chunk.type === 'text-delta'
      || chunk.type === 'reasoning-delta'
      || chunk.type === 'tool-input-delta'
      || chunk.type === 'assistant/delta'

    if (!state || !bufferable) {
      this.sink.sendChunk(
        sessionId,
        state && !isUiStreamChunkType(chunk.type)
          ? { ...chunk, messageId: (chunk as { messageId?: string }).messageId || state.messageId }
          : chunk,
      )
      return
    }

    appendStreamBufferChunk(state.buffer, chunk)
    if (state.buffer.timer === null) {
      state.buffer.timer = setTimeout(() => this.flush(sessionId, state), this.flushIntervalMs)
    }
  }

  /** Begin tracking a stream (flushes any previous stream's tail first). */
  start(sessionId: string, messageId: string): void {
    const existing = this.sessions.get(sessionId)
    if (existing) this.flush(sessionId, existing)
    this.sessions.set(sessionId, { messageId, buffer: createStreamBuffer() })
  }

  /** Stop tracking a session (flushes remaining deltas). */
  end(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state) this.flush(sessionId, state)
    this.sessions.delete(sessionId)
  }

  /** Drop all state and timers without delivering (transport is gone). */
  dispose(): void {
    for (const [, state] of this.sessions) {
      if (state.buffer.timer !== null) {
        clearTimeout(state.buffer.timer)
        state.buffer.timer = null
      }
    }
    this.sessions.clear()
  }

  private flush(sessionId: string, state: CoalescerSessionState): void {
    const buf = state.buffer
    if (buf.timer !== null) {
      clearTimeout(buf.timer)
      buf.timer = null
    }

    for (const chunk of drainStreamBuffer(buf)) {
      if (log.isLevelEnabled('trace')) {
        const text = streamChunkText(chunk)
        const key = `${sessionId}:${state.messageId}:${chunk.type}`
        log.trace('session stream chunk sent', {
          label: this.debugLabel,
          gapMs: debugGapMs(key),
          sessionId,
          messageId: state.messageId,
          type: chunk.type,
          chars: text.length,
          text: previewText(text),
        })
      }
      // UI 小批自带 messageId(源头盖的章);旧 delta 仍由这里补。
      this.sink.sendChunk(
        sessionId,
        isUiStreamChunkType(chunk.type) ? chunk : { ...chunk, messageId: state.messageId },
      )
    }
  }
}
