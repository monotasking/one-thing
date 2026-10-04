/**
 * event:事件总线与流通道(层次 L1)—— 会话事件与流式块怎么发、怎么订、怎么在断线后补发。
 *
 * 这里有每个会话一只环形缓冲的事件总线 `EventBus`、流通道 `StreamChannel`、16ms 一批的流式合并器、
 * delta 的消息 id 戳、给 IPC 发命令 / 事件的两只小工具、工具进度与界面事件两条流式推送,以及「当前实例」的访问器
 * (实现在 `event-current.ts`:不持有任何模块级 `let`,`getEventBus()` / `getStreamChannel()` 读进程当前实例,
 * 谁造的、谁关的由 `OnethingBackend.assemble` / `dispose()` 一处说了算)。
 *
 * 对外交出七类东西(下面按类分组):工厂与当前实例的访问器、会话总线与通道的类、泛型基类、事件的形状(类型)、
 * 流式合并与 delta 戳、发命令 / 事件的小工具与回放缓冲的内存登记、工具进度与界面事件的推送。
 *
 * 会话总线与通道的类(`EventBus` / `StreamChannel` / `RingBuffer`)是泛型基类把消息类型钉死的子类,装配造的、
 * 递给会话层的都是它们。泛型基类(`GenericEventBus` / `GenericStreamChannel` / `GenericRingBuffer`)带自己的消息类型参数,
 * 只有自带事件形状的地方才用(独立 server 的旧引擎、agent 引擎)。D191 之前两组同名,基类不经入口交出;改名之后两组都交出。
 *
 * 依赖:logging,以及包根的当前实例槽 `backend-current`。只用具名导出。
 *
 * Usage:
 *   import { getEventBus, getStreamChannel } from '@onething/backend/event'
 *   const bus = getEventBus()
 *   bus.emit(sessionId, { type: 'stream:start', assistantMessageId })
 */

// 工厂与当前实例的访问器(实现住在 `event-current.ts`,D191)
export { createEventSystem, getEventBus, getStreamChannel, isEventSystemInitialized } from './event-current.js'

// 会话总线与通道的类
export { EventBus } from './event-session-bus.js'
export { StreamChannel } from './event-session-stream-channel.js'
export { RingBuffer } from './event-session-ring-buffer.js'

// 泛型基类(自带消息类型时才用;D191 从 `EventBus` / `StreamChannel` / `RingBuffer` 改名)
export { GenericEventBus } from './event-bus.js'
export { GenericStreamChannel } from './event-stream-channel.js'
export { GenericRingBuffer } from './event-ring-buffer.js'

// 事件的形状
export type { EventBase, SessionEventEnvelope, StreamChunkHandler, Unsubscribe } from './event-types.js'

// 流式合并与 delta 的消息 id 戳
export { SessionStreamCoalescer } from './event-stream-coalescer.js'
export { claimDeltaStamp, clearDeltaStamps, offerDeltaStamp } from './event-delta-stamp.js'

// 发命令 / 事件的小工具,回放缓冲的内存登记
export { emitCoreSessionCommandForIpc, emitCoreSessionEventSafely } from './event-ipc-operations.js'
export { createReplayBufferMemoryHolder } from './event-memory.js'

// 工具进度与界面事件的流式推送(D191:访问器搬进 `event-current.ts` 之后,这两只不再引入口,可以交出)
export { isToolProgressStreamEnabled, pushSessionToolProgress } from './event-tool-progress-stream.js'
export type { SessionToolProgress } from './event-tool-progress-stream.js'
export { isUiEventStreamEnabled, onethingUiStreamMode, pushSessionUiStreamEvent } from './event-ui-stream.js'
export type { OnethingUiStreamMode, SessionUiStreamSourceEvent } from './event-ui-stream.js'
