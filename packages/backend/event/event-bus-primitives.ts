/**
 * 事件总线泛型原语的桶(`event-bus.ts` / `event-ring-buffer.ts` / `event-stream-channel.ts` / `types.ts` / `ipc-operations.ts`)。
 * 它从前是 core 的事件目录桶(`runtime/event-bus/index.ts`);收尾整理 2(2026-10-03)与包根的 `events/` 并成
 * `event/` 时,目录桶 `index.ts` 留给对外入口(`createEventSystem` / `getEventBus`),这只按内容改名。
 *
 * A2(`docs/design/backend-composition-root-2026-09.md`)删掉了这里从前那一对
 * `eventBus` / `streamChannel` 模块级 `let` 与同名的
 * `getEventBus` / `getStreamChannel` / `initializeEventSystem` /
 * `shutdownEventSystem`:全仓**没有任何一个宿主初始化过它们**,也没有任何一个
 * 文件 import 过(只有当时 core 的大桶 `index.ts` 把它们再导出了一次)。留着的
 * 唯一作用是与同目录 `index.ts` 的同名函数撞名 —— 排障时
 * "getEventBus 抛了"要先分辨是哪一份。
 */

export { EventBus } from './event-bus.js'
export {
  emitCoreSessionEventSafely,
  emitCoreSessionCommandForIpc,
} from './event-ipc-operations.js'
export { RingBuffer } from './event-ring-buffer.js'
export { StreamChannel } from './event-stream-channel.js'
export type {
  CoreSessionCommandEmitterLike,
  CoreSessionCommandIpcResult,
  CoreSessionEventEmitterLike,
  EmitCoreSessionCommandForIpcOptions,
  EmitCoreSessionEventSafelyOptions,
  SessionCommandLike,
} from './event-ipc-operations.js'
export type {
  EmitResult,
  EventDeliveryOptions,
  EventBase,
  GlobalEventEnvelope,
  GlobalObserveHandler,
  InterceptHandler,
  InterceptResult,
  ObserveHandler,
  SessionEventEnvelope,
  StreamChunkHandler,
  TypedObserveHandler,
  Unsubscribe,
} from './event-types.js'
