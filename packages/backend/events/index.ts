/**
 * Event System — 纯工厂 + 当前实例的访问器
 *
 * A2(`docs/design/backend-composition-root-2026-09.md` §2.2)之后这里**不再持有
 * 任何模块级 `let`**:`createEventSystem()` 只造两只对象交出去,`getEventBus()` /
 * `getStreamChannel()` 读的是进程当前实例(`../current.js`)。谁造的、谁关的,
 * 由 `OnethingBackend.assemble` / `dispose()` 一处说了算。
 *
 * Usage:
 *   import { getEventBus, getStreamChannel } from './index.js'
 *   const bus = getEventBus()
 *   bus.emit(sessionId, { type: 'stream:start', assistantMessageId })
 */

import { EventBus } from './event-bus.js'
import { StreamChannel } from './stream-channel.js'
import { getCurrentBackend, getCurrentBackendSafe } from '../current.js'

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
 * 第一个用户是删会话的推送(`stores/sessions.ts`):删会话在没装配事件系统的
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

// Re-export classes for direct use in tests
export { EventBus } from './event-bus.js'
export { StreamChannel } from './stream-channel.js'
export { RingBuffer } from './ring-buffer.js'
