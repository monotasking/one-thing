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

import { SESSION_EVENT_TYPES } from '../events/session-event-types.js'
import type { EventBus } from '../events/event-bus.js'
import type { StreamChannel } from '../events/stream-channel.js'
import type { SessionEventEnvelope, StreamChunkBase, Unsubscribe } from '../events/types.js'
import { type SessionState, createEmptySessionState } from './session-state.js'

export class Session {
  private _state: SessionState
  private unsubscribers: Unsubscribe[] = []

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
        }
        break

      case 'reasoning-delta':
        if (typeof streamChunk.reasoning === 'string') {
          this._state.accumulatedReasoning += streamChunk.reasoning
        }
        break

      case 'tool-input-delta':
        // Phase 1: tool input deltas don't contribute to accumulated content
        break
    }
  }
}
