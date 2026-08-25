/**
 * Headless event system lifecycle for core consumers.
 */

import { EventBus } from './event-bus.js'
import { StreamChannel } from './stream-channel.js'

let eventBus: EventBus | null = null
let streamChannel: StreamChannel | null = null

export function getEventBus(): EventBus {
  if (!eventBus) {
    throw new Error('[CoreEventSystem] EventBus not initialized. Call initializeEventSystem() first.')
  }
  return eventBus
}

export function getStreamChannel(): StreamChannel {
  if (!streamChannel) {
    throw new Error('[CoreEventSystem] StreamChannel not initialized. Call initializeEventSystem() first.')
  }
  return streamChannel
}

export function initializeEventSystem(): void {
  if (eventBus) {
    return
  }

  eventBus = new EventBus()
  streamChannel = new StreamChannel()
}

export function shutdownEventSystem(): void {
  eventBus?.shutdown()
  streamChannel?.shutdown()
  eventBus = null
  streamChannel = null
}

export { EventBus } from './event-bus.js'
export {
  emitCoreSessionEventSafely,
  emitCoreSessionCommandForIpc,
} from './ipc-operations.js'
export { RingBuffer } from './ring-buffer.js'
export { SESSION_COMMAND_TYPES } from './session-command-types.js'
export { SESSION_EVENT_TYPES } from './session-event-types.js'
export { StreamChannel } from './stream-channel.js'
export type {
  ReasoningDeltaChunk,
  ReasoningPlacement,
  StreamChunk,
  TextDeltaChunk,
  ToolInputDeltaChunk,
  UiAssistantChunksChunk,
  UiAssistantDeltaChunk,
  UiAssistantPartEndChunk,
  UiAssistantPartKind,
  UiStreamChunk,
} from './stream-chunks.js'
export type {
  CoreSessionCommandEmitterLike,
  CoreSessionCommandIpcResult,
  CoreSessionEventEmitterLike,
  EmitCoreSessionCommandForIpcOptions,
  EmitCoreSessionEventSafelyOptions,
  SessionCommandLike,
} from './ipc-operations.js'
export type { SessionCommandType } from './session-command-types.js'
export type { SessionEventType } from './session-event-types.js'
export type {
  EmitResult,
  EventBase,
  GlobalEventEnvelope,
  GlobalObserveHandler,
  InterceptHandler,
  InterceptResult,
  ObserveHandler,
  SessionEventEnvelope,
  StreamChunkBase,
  StreamChunkHandler,
  TypedObserveHandler,
  Unsubscribe,
} from './types.js'
