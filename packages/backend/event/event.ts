/**
 * event:事件总线与流通道(层次 L1)—— 会话事件与流式块怎么发、怎么订、怎么在断线后补发。
 *
 * 这里有每个会话一只环形缓冲的事件总线 `EventBus`、流通道 `StreamChannel`、16ms 一批的流式合并器、
 * delta 的消息 id 戳、给 IPC 发命令 / 事件的两只小工具,以及「当前实例」的访问器:
 * A2(`docs/design/backend-composition-root-2026-09.md` §2.2)之后这里**不再持有任何模块级 `let`**,
 * `createEventSystem()` 只造两只对象交出去,`getEventBus()` / `getStreamChannel()` 读的是进程当前实例
 * (`@onething/backend/backend-current.js`)。谁造的、谁关的,由 `OnethingBackend.assemble` / `dispose()` 一处说了算。
 *
 * 对外交出五类东西(下面按类分组):工厂与当前实例的访问器、总线与通道的类、事件的形状(类型)、
 * 流式合并与 delta 戳、发命令 / 事件的小工具与回放缓冲的内存登记。
 *
 * 依赖:logging,以及包根的当前实例槽 `backend-current`。
 * `event-tool-progress-stream.ts` / `event-ui-stream.ts` 两只兄弟要的 `getStreamChannel` 就声明在这只入口里,
 * 所以它们仍引入口(D126 的例外);也因此这两只不经入口交出(交出就成环),外面照旧直接引。
 * 另有一套与这里同名的旧内核 `EventBus` / `StreamChannel`(`event-bus.ts` / `event-stream-channel.ts`,
 * 旧 agent 引擎与会话管理器在用)—— 同名不同物,不经入口交出。只用具名导出。
 *
 * Usage:
 *   import { getEventBus, getStreamChannel } from './event.js'
 *   const bus = getEventBus()
 *   bus.emit(sessionId, { type: 'stream:start', assistantMessageId })
 */

import { EventBus } from './event-session-bus.js'
import { StreamChannel } from './event-session-stream-channel.js'
import { getCurrentBackend, getCurrentBackendSafe } from '@onething/backend/backend-current.js'

// 工厂与当前实例的访问器

/**
 * 造一套事件系统。纯工厂:不碰任何全局,谁拿到谁负责关。
 *
 * 关它的方式就是两只对象自己的 `shutdown()` —— 装配层在
 * `backend.ts` 里把这一对登记成一个 disposer。
 */
export function createEventSystem(): { eventBus: EventBus; streamChannel: StreamChannel } {
  return { eventBus: new EventBus(), streamChannel: new StreamChannel() }
}

/**
 * Get the singleton EventBus instance.
 * Throws if no backend is assembled in this process.
 */
export function getEventBus(): EventBus {
  return getCurrentBackend('eventBus').eventBus
}

/**
 * 事件系统立起来了没有 —— 给那些**"有就发,没有就算了"**的产地用。
 *
 * 第一个用户是删会话的推送(`session/session-store.ts`):删会话在没装配事件系统的
 * 进程里(轻量单测、脚本)照样得能删,而 `getEventBus()` 那一声 throw 会被
 * try/catch 吞掉、留下一行没人需要的 warn。问一句比事后吞一个异常干净。
 *
 * try/catch 不是多余的:装配**中途**槽里已经有句柄,但 `eventBus` 那一格可能
 * 还没填(方案 §5 风险 1),那种时候答案同样是"还没有"。
 */
export function isEventSystemInitialized(): boolean {
  const handle = getCurrentBackendSafe()
  if (!handle) return false
  try {
    return Boolean(handle.eventBus)
  } catch {
    return false
  }
}

/**
 * Get the singleton StreamChannel instance.
 * Throws if no backend is assembled in this process.
 */
export function getStreamChannel(): StreamChannel {
  return getCurrentBackend('streamChannel').streamChannel
}

// 总线与通道的类
export { EventBus } from './event-session-bus.js'
export { StreamChannel } from './event-session-stream-channel.js'
export { RingBuffer } from './event-session-ring-buffer.js'

// 事件的形状
export type { EventBase, SessionEventEnvelope, StreamChunkHandler, Unsubscribe } from './event-types.js'

// 流式合并与 delta 的消息 id 戳
export { SessionStreamCoalescer } from './event-stream-coalescer.js'
export { claimDeltaStamp, clearDeltaStamps, offerDeltaStamp } from './event-delta-stamp.js'

// 发命令 / 事件的小工具,回放缓冲的内存登记
export { emitCoreSessionCommandForIpc, emitCoreSessionEventSafely } from './event-ipc-operations.js'
export { createReplayBufferMemoryHolder } from './event-memory.js'
