import type {
  GlobalEvent,
  GlobalEventEnvelope,
  SessionBusMessage,
  SessionEvent,
  SessionEventEnvelope,
  StreamChunk,
} from '@shared/events/index.js'
import type {
  EmitResult as CoreEmitResult,
  GlobalObserveHandler as CoreGlobalObserveHandler,
  InterceptHandler as CoreInterceptHandler,
  InterceptResult,
  ObserveHandler as CoreObserveHandler,
  StreamChunkHandler as CoreStreamChunkHandler,
  TypedObserveHandler as CoreTypedObserveHandler,
  Unsubscribe,
} from '@onething/core/events'

export type { Unsubscribe, InterceptResult }

// 这几个都是**总线**的形状,载荷因此是 `SessionBusMessage`:订阅方
// (IPCBridge / SSE / 引擎的 `command:*` 订阅)看到的就是事件与命令的并集。
export type ObserveHandler = CoreObserveHandler<SessionBusMessage>
export type TypedObserveHandler<T extends SessionBusMessage['type']> = CoreTypedObserveHandler<SessionBusMessage, T>
export type GlobalObserveHandler = CoreGlobalObserveHandler<GlobalEvent>
export type StreamChunkHandler = CoreStreamChunkHandler<StreamChunk>
export type InterceptHandler = CoreInterceptHandler<SessionBusMessage>
export type EmitResult = CoreEmitResult<SessionBusMessage>
export type {
  GlobalEventEnvelope,
  SessionEventEnvelope,
  SessionBusMessage,
  SessionEvent,
  StreamChunk,
}
