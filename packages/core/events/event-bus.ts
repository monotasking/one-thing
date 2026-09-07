/**
 * Event Bus
 *
 * The central event backbone for session events. Provides:
 *
 * 1. **Intercept phase** — registered interceptors can modify or suppress
 *    an event before it's committed. Phase 1 has no interceptors.
 *
 * 2. **Commit phase** — event gets a sequence number and timestamp,
 *    is wrapped in an envelope, and pushed to the session's ring buffer.
 *
 * 3. **Fan-out phase** — the envelope is delivered to:
 *    - Per-session typed handlers (on)
 *    - Per-session wildcard handlers (onAny — currently unused in Phase 1)
 *    - Global session-wildcard handlers (onAnySession)
 *
 * Also supports global (non-session) events via emitGlobal/onGlobal.
 *
 * All operations are synchronous except interceptors (which may be async).
 * The emit() method returns a Promise<EmitResult>.
 */

import type {
  EventBase,
  Unsubscribe,
  ObserveHandler,
  TypedObserveHandler,
  GlobalObserveHandler,
  InterceptHandler,
  EmitResult,
  SessionEventEnvelope,
  GlobalEventEnvelope,
  EventDeliveryOptions,
} from './types.js'
import { RingBuffer } from './ring-buffer.js'
import { getCoreLogger, toLogger, type CompatLogger, type Logger } from '../logging/index.js'

export class EventBus<
  TSessionEvent extends EventBase = EventBase,
  TGlobalEvent extends EventBase = EventBase,
> {
  /** Per-session ring buffers */
  private buffers = new Map<string, RingBuffer<TSessionEvent>>()

  /** Per-session sequence counters */
  private sequences = new Map<string, number>()

  /** Per-session, per-type handlers: Map<sessionId, Map<eventType, Set<handler>>> */
  private typedHandlers = new Map<string, Map<string, Set<ObserveHandler<TSessionEvent>>>>()

  /** Per-session wildcard handlers: Map<sessionId, Set<handler>> */
  private wildcardHandlers = new Map<string, Set<ObserveHandler<TSessionEvent>>>()

  /** Global session-wildcard handlers (all sessions, specific type): Map<eventType, Set<handler>> */
  private anySessionTypedHandlers = new Map<string, Set<ObserveHandler<TSessionEvent>>>()

  /** Global session-wildcard handlers (all sessions, all types) */
  private anySessionWildcardHandlers = new Set<ObserveHandler<TSessionEvent>>()

  /** Interceptors (Phase 1: empty) */
  private interceptors: InterceptHandler<TSessionEvent>[] = []

  /** Global event handlers */
  private globalHandlers = new Map<string, Set<GlobalObserveHandler<TGlobalEvent>>>()
  private globalSequence = 0

  /** Default ring buffer capacity per session */
  private readonly bufferCapacity: number

  /** Handler → label mapping for logging */
  private handlerLabels = new WeakMap<(...args: any[]) => any, string>()

  /**
   * core 不持有全局 root:logger 由装配层注入,缺省 noop
   * (docs/design/logging-system-2026-08.md §8.3 区 ①)。
   */
  private log: Logger = getCoreLogger('core.events')

  constructor(bufferCapacity = 1000, logger?: CompatLogger) {
    this.bufferCapacity = bufferCapacity
    if (logger) this.log = toLogger(logger, 'core.events')
  }

  /** 装配层可以在构造之后再接线(单例路径)。 */
  setLogger(logger: CompatLogger | undefined): void {
    this.log = toLogger(logger, 'core.events')
  }

  // ── Emit (session events) ──────────────────────

  /**
   * Emit a session event through the intercept → commit → fan-out pipeline.
   */
  async emit(sessionId: string, event: TSessionEvent, options?: EventDeliveryOptions): Promise<EmitResult<TSessionEvent>> {
    // Phase 1: Intercept (pass-through if no interceptors)
    let finalEvent = event
    for (const interceptor of this.interceptors) {
      try {
        const result = await interceptor(finalEvent, sessionId)
        if (result.suppress) {
          return { envelope: null }
        }
        if (result.replacement) {
          finalEvent = result.replacement
        }
      } catch (err) {
        this.log.error('interceptor failed', { sessionId, eventType: finalEvent.type }, err)
        // On interceptor error, continue with original event
      }
    }

    // Phase 2: Commit
    const seq = (this.sequences.get(sessionId) ?? 0) + 1
    this.sequences.set(sessionId, seq)

    const envelope: SessionEventEnvelope<TSessionEvent> = {
      sessionId,
      sequence: seq,
      timestamp: Date.now(),
      event: finalEvent,
    }
    if (options?.executionContext !== undefined) {
      Object.defineProperty(envelope, 'executionContext', { value: options.executionContext })
    }

    let buffer = this.buffers.get(sessionId)
    if (!buffer) {
      buffer = new RingBuffer<TSessionEvent>(this.bufferCapacity)
      this.buffers.set(sessionId, buffer)
    }
    buffer.push(envelope)

    this.log.trace('event emitted', { sessionId, seq, eventType: finalEvent.type })

    // Phase 3: Fan-out
    this.fanOut(sessionId, envelope)

    return { envelope }
  }

  // ── Subscribe (per-session, typed) ─────────────

  /**
   * Subscribe to a specific event type for a specific session.
   * @param label Optional human-readable name for logging (e.g. 'StreamEngine')
   */
  on<T extends TSessionEvent['type']>(
    sessionId: string,
    eventType: T,
    handler: TypedObserveHandler<TSessionEvent, T>,
    label?: string
  ): Unsubscribe {
    if (label) this.handlerLabels.set(handler, label)

    let sessionMap = this.typedHandlers.get(sessionId)
    if (!sessionMap) {
      sessionMap = new Map()
      this.typedHandlers.set(sessionId, sessionMap)
    }
    let handlers = sessionMap.get(eventType)
    if (!handlers) {
      handlers = new Set()
      sessionMap.set(eventType, handlers)
    }
    handlers.add(handler as ObserveHandler<TSessionEvent>)

    this.log.debug('handler subscribed', { label: label || 'anonymous', eventType, sessionId, scope: 'session' })

    return () => {
      this.log.debug('handler unsubscribed', { label: label || 'anonymous', eventType, sessionId, scope: 'session' })
      handlers!.delete(handler as ObserveHandler<TSessionEvent>)
      if (handlers!.size === 0) sessionMap!.delete(eventType)
      if (sessionMap!.size === 0) this.typedHandlers.delete(sessionId)
    }
  }

  // ── Subscribe (per-session, wildcard) ──────────

  /**
   * Subscribe to all event types for a specific session.
   * @param label Optional human-readable name for logging
   */
  onAny(sessionId: string, handler: ObserveHandler<TSessionEvent>, label?: string): Unsubscribe {
    if (label) this.handlerLabels.set(handler, label)

    let handlers = this.wildcardHandlers.get(sessionId)
    if (!handlers) {
      handlers = new Set()
      this.wildcardHandlers.set(sessionId, handlers)
    }
    handlers.add(handler)

    this.log.debug('handler subscribed', { label: label || 'anonymous', sessionId, scope: 'sessionAny' })

    return () => {
      this.log.debug('handler unsubscribed', { label: label || 'anonymous', sessionId, scope: 'sessionAny' })
      handlers!.delete(handler)
      if (handlers!.size === 0) this.wildcardHandlers.delete(sessionId)
    }
  }

  // ── Subscribe (all sessions, typed) ────────────

  /**
   * Subscribe to a specific event type across ALL sessions.
   * Used by SessionManager to auto-vivify sessions on stream:start.
   * @param label Optional human-readable name for logging
   */
  onAnySession<T extends TSessionEvent['type']>(
    eventType: T,
    handler: TypedObserveHandler<TSessionEvent, T>,
    label?: string
  ): Unsubscribe {
    if (label) this.handlerLabels.set(handler, label)

    let handlers = this.anySessionTypedHandlers.get(eventType)
    if (!handlers) {
      handlers = new Set()
      this.anySessionTypedHandlers.set(eventType, handlers)
    }
    handlers.add(handler as ObserveHandler<TSessionEvent>)

    this.log.debug('handler subscribed', { label: label || 'anonymous', eventType, scope: 'anySession' })

    return () => {
      this.log.debug('handler unsubscribed', { label: label || 'anonymous', eventType, scope: 'anySession' })
      handlers!.delete(handler as ObserveHandler<TSessionEvent>)
      if (handlers!.size === 0) this.anySessionTypedHandlers.delete(eventType)
    }
  }

  // ── Subscribe (all sessions, all types) ────────

  /**
   * Subscribe to ALL events across ALL sessions. Use sparingly.
   * @param label Optional human-readable name for logging
   */
  onAnySessionAny(handler: ObserveHandler<TSessionEvent>, label?: string): Unsubscribe {
    if (label) this.handlerLabels.set(handler, label)

    this.anySessionWildcardHandlers.add(handler)

    this.log.debug('handler subscribed', { label: label || 'anonymous', scope: 'anySessionAny' })

    return () => {
      this.log.debug('handler unsubscribed', { label: label || 'anonymous', scope: 'anySessionAny' })
      this.anySessionWildcardHandlers.delete(handler)
    }
  }

  // ── Intercept ──────────────────────────────────

  /**
   * Register an interceptor. Phase 1: not used.
   */
  intercept(handler: InterceptHandler<TSessionEvent>): Unsubscribe {
    this.interceptors.push(handler)
    return () => {
      const idx = this.interceptors.indexOf(handler)
      if (idx >= 0) this.interceptors.splice(idx, 1)
    }
  }

  // ── Replay ─────────────────────────────────────

  /**
   * Replay committed events for a session starting from a sequence number.
   */
  replay(sessionId: string, fromSequence: number): SessionEventEnvelope<TSessionEvent>[] {
    const buffer = this.buffers.get(sessionId)
    if (!buffer) return []
    return buffer.replay(fromSequence)
  }

  // ── Destroy session ────────────────────────────

  /**
   * Clean up all state for a session: buffer, handlers, sequence.
   */
  destroySession(sessionId: string): void {
    this.buffers.get(sessionId)?.clear()
    this.buffers.delete(sessionId)
    this.sequences.delete(sessionId)
    this.typedHandlers.delete(sessionId)
    this.wildcardHandlers.delete(sessionId)
  }

  // ── Global events ─────────────────────────────

  /**
   * Emit a global (non-session) event.
   */
  emitGlobal(event: TGlobalEvent): GlobalEventEnvelope<TGlobalEvent> {
    this.globalSequence++
    const envelope: GlobalEventEnvelope<TGlobalEvent> = {
      sequence: this.globalSequence,
      timestamp: Date.now(),
      event,
    }

    this.log.trace('global event emitted', { seq: this.globalSequence, eventType: event.type })

    const handlers = this.globalHandlers.get(event.type)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(envelope)
        } catch (err) {
          this.log.error('global handler failed', { eventType: event.type }, err)
        }
      }
    }

    return envelope
  }

  /**
   * Subscribe to a specific global event type.
   */
  onGlobal<T extends TGlobalEvent['type']>(
    eventType: T,
    handler: (envelope: GlobalEventEnvelope<TGlobalEvent> & { event: Extract<TGlobalEvent, { type: T }> }) => void
  ): Unsubscribe {
    let handlers = this.globalHandlers.get(eventType)
    if (!handlers) {
      handlers = new Set()
      this.globalHandlers.set(eventType, handlers)
    }
    handlers.add(handler as GlobalObserveHandler<TGlobalEvent>)

    return () => {
      handlers!.delete(handler as GlobalObserveHandler<TGlobalEvent>)
      if (handlers!.size === 0) this.globalHandlers.delete(eventType)
    }
  }

  // ── Shutdown ──────────────────────────────────

  /**
   * Clear all state. Called on app quit.
   */
  shutdown(): void {
    this.buffers.clear()
    this.sequences.clear()
    this.typedHandlers.clear()
    this.wildcardHandlers.clear()
    this.anySessionTypedHandlers.clear()
    this.anySessionWildcardHandlers.clear()
    this.interceptors.length = 0
    this.globalHandlers.clear()
  }

  // ── Internal ──────────────────────────────────

  private fanOut(sessionId: string, envelope: SessionEventEnvelope<TSessionEvent>): void {
    const eventType = envelope.event.type
    const traceFanOut = this.log.isLevelEnabled('trace')

    // 1. Per-session typed handlers
    const sessionMap = this.typedHandlers.get(sessionId)
    if (sessionMap) {
      const handlers = sessionMap.get(eventType)
      if (handlers) {
        for (const handler of handlers) {
          if (traceFanOut) {
            this.log.trace('fan-out', { label: this.handlerLabels.get(handler) || 'anonymous', eventType, scope: 'on' })
          }
          try { handler(envelope) } catch (err) {
            this.log.error('handler failed', { sessionId, eventType, scope: 'on' }, err)
          }
        }
      }
    }

    // 2. Per-session wildcard handlers
    const wildcards = this.wildcardHandlers.get(sessionId)
    if (wildcards) {
      for (const handler of wildcards) {
        if (traceFanOut) {
          this.log.trace('fan-out', { label: this.handlerLabels.get(handler) || 'anonymous', eventType, scope: 'onAny' })
        }
        try { handler(envelope) } catch (err) {
          this.log.error('handler failed', { sessionId, eventType, scope: 'onAny' }, err)
        }
      }
    }

    // 3. Global session-typed handlers (onAnySession)
    const anyTyped = this.anySessionTypedHandlers.get(eventType)
    if (anyTyped) {
      for (const handler of anyTyped) {
        if (traceFanOut) {
          this.log.trace('fan-out', { label: this.handlerLabels.get(handler) || 'anonymous', eventType, scope: 'onAnySession' })
        }
        try { handler(envelope) } catch (err) {
          this.log.error('handler failed', { sessionId, eventType, scope: 'onAnySession' }, err)
        }
      }
    }

    // 4. Global session-wildcard handlers (onAnySessionAny)
    for (const handler of this.anySessionWildcardHandlers) {
      if (traceFanOut) {
        this.log.trace('fan-out', { label: this.handlerLabels.get(handler) || 'anonymous', eventType, scope: 'onAnySessionAny' })
      }
      try { handler(envelope) } catch (err) {
        this.log.error('handler failed', { sessionId, eventType, scope: 'onAnySessionAny' }, err)
      }
    }
  }
}
