/**
 * core 的事件系统桶。
 *
 * A2(`docs/design/backend-composition-root-2026-09.md`)删掉了这里从前那一对
 * `eventBus` / `streamChannel` 模块级 `let` 与同名的
 * `getEventBus` / `getStreamChannel` / `initializeEventSystem` /
 * `shutdownEventSystem`:全仓**没有任何一个宿主初始化过它们**,也没有任何一个
 * 文件 import 过(只有 `packages/core/index.ts` 把它们再导出了一次)。留着的
 * 唯一作用是与 `packages/backend/events/index.ts` 的同名函数撞名 —— 排障时
 * "getEventBus 抛了"要先分辨是哪一份。
 */

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
  StreamDeltaStamp,
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
