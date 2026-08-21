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
} from '@shared/events/index.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('engine.stream.coalescer')

export type BufferedStreamChunk =
  | { type: 'text-delta'; text: string; turnIndex?: number; voiceSpeakText?: string }
  | { type: 'reasoning-delta'; reasoning: string; turnIndex?: number; placement?: ReasoningPlacement }
  | { type: 'tool-input-delta'; toolCallId: string; argsTextDelta: string }

/** Accumulates high-frequency stream chunks between flush intervals. */
export interface StreamBuffer {
  chunks: BufferedStreamChunk[]
  timer: ReturnType<typeof setTimeout> | null
}

export function createStreamBuffer(): StreamBuffer {
  return { chunks: [], timer: null }
}

export function appendStreamBufferChunk(buffer: StreamBuffer, chunk: StreamChunk): boolean {
  const last = buffer.chunks[buffer.chunks.length - 1]

  if (chunk.type === 'text-delta') {
    if (last?.type === 'text-delta' && last.turnIndex === chunk.turnIndex) {
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
      })
    }
    return true
  }

  if (chunk.type === 'reasoning-delta') {
    if (last?.type === 'reasoning-delta' && last.turnIndex === chunk.turnIndex && last.placement === chunk.placement) {
      last.reasoning += chunk.reasoning
    } else {
      buffer.chunks.push({
        type: 'reasoning-delta',
        reasoning: chunk.reasoning,
        ...(chunk.turnIndex !== undefined ? { turnIndex: chunk.turnIndex } : {}),
        ...(chunk.placement ? { placement: chunk.placement } : {}),
      })
    }
    return true
  }

  if (chunk.type === 'tool-input-delta') {
    if (last?.type === 'tool-input-delta' && last.toolCallId === chunk.toolCallId) {
      last.argsTextDelta += chunk.argsTextDelta
    } else {
      buffer.chunks.push({
        type: 'tool-input-delta',
        toolCallId: chunk.toolCallId,
        argsTextDelta: chunk.argsTextDelta,
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
  return ''
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

    if (!state || (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta' && chunk.type !== 'tool-input-delta')) {
      this.sink.sendChunk(
        sessionId,
        state
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
      this.sink.sendChunk(sessionId, { ...chunk, messageId: state.messageId })
    }
  }
}
