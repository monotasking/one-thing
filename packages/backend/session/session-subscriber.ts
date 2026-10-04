/**
 * Session
 *
 * A Session subscribes to EventBus and StreamChannel, reducing events
 * and chunks into a SessionState.
 *
 * Phase 1: The Session is passive — it only accumulates state for
 * validation purposes. It does NOT persist anything or drive the UI.
 * The existing store + IPC pipeline handles all that.
 *
 * Phase 2+: Session becomes the authoritative state owner. Events
 * drive persistence (checkpoints) and renderer sync.
 */

import { SESSION_EVENT_TYPES } from '@shared/events/session-event-types.js'
import type { EventBus } from '@onething/backend/event/event-bus'
import type { StreamChannel } from '@onething/backend/event/event-stream-channel'
import type { SessionEventEnvelope, Unsubscribe } from '@onething/backend/event'
import type { StreamChunkBase } from '@shared/events/stream-chunks.js'
import { type SessionState, createEmptySessionState } from './session-state.js'

/**
 * 累计文本里的一截,带着它的账本身份章(若有):哪条执行(`runId`)的哪一段(`partIndex`)。
 * 相邻、同章的 delta 并进同一截。没章的 delta(旁路 / 老路)也进来,只是作废认不到它。
 */
interface AccumulatedSegment {
  kind: 'text' | 'reasoning'
  runId?: string
  partIndex?: number
  text: string
}

export class Session {
  private _state: SessionState
  private unsubscribers: Unsubscribe[] = []
  /**
   * 与 `accumulatedContent` / `accumulatedReasoning` 同一份字,按账本段切开(批 6 留账)。
   *
   * 流到一半失败、换凭证重试时,失败那一次已经从旧文字流通道(`session:stream`)出去的
   * 半句不能收回 —— 流帧词汇里没有「作废」这一种,也不为它加。但账本在 `request/error`
   * 上点名作废了那几段(`discardParts`),而这条账本事件原样随总线下发
   * (`SESSION_LEDGER_EVENT`)。这里据它把同号的几截摘掉,累计值于是与折叠出来的
   * 那条消息重新对得上 —— 否则 dev 下的 `sessions.validation` 会报一条「内容不一致」。
   */
  private segments: AccumulatedSegment[] = []

  constructor(sessionId: string) {
    this._state = createEmptySessionState(sessionId)
  }

  /** Read-only access to current state */
  get state(): Readonly<SessionState> {
    return this._state
  }

  /**
   * Attach this session to EventBus and StreamChannel.
   * Starts receiving events and chunks.
   */
  attach(eventBus: EventBus<any, any>, streamChannel: StreamChannel<any>): void {
    const sessionId = this._state.id

    // Subscribe to all events for this session
    const unsubEvents = eventBus.onAny(sessionId, (envelope) => {
      this.applyEvent(envelope)
    }, 'Session')
    this.unsubscribers.push(unsubEvents)

    // Subscribe to stream chunks for this session
    const unsubChunks = streamChannel.subscribe(sessionId, (chunk) => {
      this.applyChunk(chunk)
    })
    this.unsubscribers.push(unsubChunks)
  }

  /**
   * Detach from EventBus and StreamChannel.
   * Stops receiving events and chunks.
   */
  detach(): void {
    for (const unsub of this.unsubscribers) {
      unsub()
    }
    this.unsubscribers = []
  }

  /**
   * Apply a committed event to the session state.
   */
  applyEvent(envelope: SessionEventEnvelope): void {
    this._state.eventCount++
    const event = envelope.event as {
      type: string
      assistantMessageId?: string
      message?: { id?: string }
      data?: { sessionName?: string }
      name?: string
    }

    switch (event.type) {
      case SESSION_EVENT_TYPES.STREAM_START:
        this._state.activeMessageId = event.assistantMessageId ?? null
        this._state.isStreaming = true
        // Reset accumulators for new stream
        this._state.accumulatedContent = ''
        this._state.accumulatedReasoning = ''
        this.segments = []
        break

      case SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT:
        this.applyLedgerDiscard((envelope.event as { record?: unknown }).record)
        break

      case SESSION_EVENT_TYPES.STREAM_COMPLETE:
        this._state.isStreaming = false
        if (event.data?.sessionName) {
          this._state.name = event.data.sessionName
        }
        break

      case SESSION_EVENT_TYPES.STREAM_ERROR:
        this._state.isStreaming = false
        break

      case SESSION_EVENT_TYPES.STREAM_ABORTED:
        this._state.isStreaming = false
        break

      case SESSION_EVENT_TYPES.MESSAGE_USER_CREATED:
        // Phase 1: just track event count, no state mutation needed
        break

      case SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED:
        this._state.activeMessageId = event.message?.id ?? null
        break

      case SESSION_EVENT_TYPES.SESSION_RENAMED:
        if (event.name) {
          this._state.name = event.name
        }
        break

      case SESSION_EVENT_TYPES.TOOL_CALL:
      case SESSION_EVENT_TYPES.TOOL_RESULT:
      case SESSION_EVENT_TYPES.TOOL_INPUT_START:
      case SESSION_EVENT_TYPES.TOOL_INPUT_END:
      case SESSION_EVENT_TYPES.TOOL_EXECUTION_START:
      case SESSION_EVENT_TYPES.TOOL_EXECUTION_UPDATE:
      case SESSION_EVENT_TYPES.TOOL_EXECUTION_END:
      case SESSION_EVENT_TYPES.STEP_ADDED:
      case SESSION_EVENT_TYPES.STEP_UPDATED:
      case SESSION_EVENT_TYPES.CONTENT_PART:
      case SESSION_EVENT_TYPES.CONTENT_CONTINUATION:
      case SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED:
      case SESSION_EVENT_TYPES.STREAM_PARAMS_RESOLVING:
      case SESSION_EVENT_TYPES.SKILL_ACTIVATED:
      case SESSION_EVENT_TYPES.PERMISSION_REQUEST:
      case SESSION_EVENT_TYPES.PERMISSION_TIMEOUT:
      case SESSION_EVENT_TYPES.TOOL_EXECUTING:
      case SESSION_EVENT_TYPES.TOOL_METADATA:
      case SESSION_EVENT_TYPES.MESSAGE_UPDATED:
        // These events are tracked for replay but don't
        // update the validation-relevant state fields yet
        break
    }
  }

  /**
   * Apply a stream chunk to the session state.
   */
  applyChunk(chunk: StreamChunkBase): void {
    this._state.chunkCount++
    const streamChunk = chunk as StreamChunkBase & {
      text?: string
      reasoning?: string
    }

    switch (chunk.type) {
      case 'text-delta':
        if (typeof streamChunk.text === 'string') {
          this._state.accumulatedContent += streamChunk.text
          this.pushSegment('text', streamChunk.text, (chunk as { stamp?: unknown }).stamp)
        }
        break

      case 'reasoning-delta':
        if (typeof streamChunk.reasoning === 'string') {
          this._state.accumulatedReasoning += streamChunk.reasoning
          this.pushSegment('reasoning', streamChunk.reasoning, (chunk as { stamp?: unknown }).stamp)
        }
        break

      case 'tool-input-delta':
        // Phase 1: tool input deltas don't contribute to accumulated content
        break

      /*
       * C2-b 工具进度活流:**故意什么都不做**,这一条不是漏了。
       *
       * 进度是一次调用执行中的**过程读数**(输出尾行 / 比例 / 一句话),不是会话
       * 的事实 —— 它不进 `events.jsonl`,也不该累进这里的任何一格。重开会话看到
       * 的是结局,不是「当时跑到第 7 行」。三定律因此一格不动。
       *
       * 写成显式空 `case` 而不是让它落进 switch 外面:下一位读这段代码的人要能
       * 一眼看出「这条 chunk 被想过、结论是不累加」,而不是怀疑少写了一支。
       */
      case 'tool-progress':
        break
    }
  }
  private pushSegment(kind: 'text' | 'reasoning', text: string, stamp: unknown): void {
    const mark = stamp as { runId?: unknown; partIndex?: unknown } | undefined
    const runId = typeof mark?.runId === 'string' ? mark.runId : undefined
    const partIndex = typeof mark?.partIndex === 'number' ? mark.partIndex : undefined
    const last = this.segments[this.segments.length - 1]
    if (last && last.kind === kind && last.runId === runId && last.partIndex === partIndex) {
      last.text += text
      return
    }
    this.segments.push({ kind, ...(runId !== undefined ? { runId } : {}), ...(partIndex !== undefined ? { partIndex } : {}), text })
  }

  /**
   * 账本的 `request/error`(`willRetry` + `discardParts`)到了:把那条执行上被点名的几段
   * 从累计值里摘掉。只认得出盖过章的那几截 —— 没章的认不到,宁可不摘也不摘错。
   */
  private applyLedgerDiscard(record: unknown): void {
    const event = record as { type?: unknown; data?: { runId?: unknown; willRetry?: unknown; discardParts?: unknown } } | undefined
    if (event?.type !== 'request/error' || event.data?.willRetry !== true) return
    const runId = event.data.runId
    const parts = event.data.discardParts
    if (typeof runId !== 'string' || !Array.isArray(parts) || parts.length === 0) return
    const dropped = new Set(parts.filter((part): part is number => typeof part === 'number'))
    const kept = this.segments.filter(segment =>
      !(segment.runId === runId && segment.partIndex !== undefined && dropped.has(segment.partIndex)))
    if (kept.length === this.segments.length) return
    this.segments = kept
    this._state.accumulatedContent = kept.filter(segment => segment.kind === 'text').map(segment => segment.text).join('')
    this._state.accumulatedReasoning = kept.filter(segment => segment.kind === 'reasoning').map(segment => segment.text).join('')
  }
}
