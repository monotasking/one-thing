/**
 * Core event system types.
 *
 * The core package keeps these types generic so it does not depend on the
 * Electron main process or on any host renderer-facing event schema.
 */

export interface EventBase {
  type: string
}

export type SessionEventEnvelope<TEvent extends EventBase = EventBase> = {
  sessionId: string
  sequence: number
  timestamp: number
  event: TEvent
  /** Trusted host context, supplied separately from the event and never serialized. */
  readonly executionContext?: unknown
}

export interface EventDeliveryOptions {
  readonly executionContext?: unknown
}

export type GlobalEventEnvelope<TEvent extends EventBase = EventBase> = {
  sequence: number
  timestamp: number
  event: TEvent
}

export interface StreamChunkBase {
  type: string
}

/** Unsubscribe function returned by on/onAny/onGlobal */
export type Unsubscribe = () => void

/** Handler for observing committed events */
export type ObserveHandler<TEvent extends EventBase = EventBase> = (
  envelope: SessionEventEnvelope<TEvent>
) => void

/** Handler for observing events by type */
export type TypedObserveHandler<
  TEvent extends EventBase,
  TType extends TEvent['type'],
> = (
  envelope: SessionEventEnvelope<TEvent> & { event: Extract<TEvent, { type: TType }> }
) => void

/** Handler for observing global events */
export type GlobalObserveHandler<TEvent extends EventBase = EventBase> = (
  envelope: GlobalEventEnvelope<TEvent>
) => void

/** Handler for stream chunks */
export type StreamChunkHandler<TChunk extends StreamChunkBase = StreamChunkBase> = (
  chunk: TChunk
) => void

/**
 * Intercept handler — can modify or suppress an event before it's committed.
 */
export type InterceptHandler<TEvent extends EventBase = EventBase> = (
  event: TEvent,
  sessionId: string
) => InterceptResult<TEvent> | Promise<InterceptResult<TEvent>>

export interface InterceptResult<TEvent extends EventBase = EventBase> {
  /** If true, the event is suppressed (not committed or fanned out) */
  suppress?: boolean
  /** Optional replacement event. If provided, replaces the original. */
  replacement?: TEvent
}

export interface EmitResult<TEvent extends EventBase = EventBase> {
  /** The envelope that was committed (or null if suppressed) */
  envelope: SessionEventEnvelope<TEvent> | null
}
