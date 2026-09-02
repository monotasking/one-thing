/**
 * Session Layer — 纯工厂 + 当前实例的访问器
 *
 * A2(`docs/design/backend-composition-root-2026-09.md` §2.2)之后这里没有任何
 * 模块级 `let`:`createSessionLayer(eventBus, streamChannel)` 造一只
 * `SessionManager` 并把校验订阅一起收进它的 `dispose`,`getSessionManager()` 读
 * 进程当前实例。
 *
 * **不再经 core 的 `initializeCoreSessionLayer`**:那个函数除了
 * `new SessionManager(eventBus, streamChannel)` 与"存进 core 自己那个模块级槽"
 * 之外什么也不做,而 core 内部没有任何一处靠 `getCoreSessionManager()` 找 manager
 * (全仓调用方只有本文件与 core 自己的那份单测)。装配层因此直接构造,不再往
 * core 的槽里塞第二份真相;`packages/core/session/lifecycle.ts` 原样留给它自己的
 * 测试。
 */

import { setupValidation } from './validation.js'
import type { Unsubscribe } from '../events/types.js'
import type { EventBus } from '../events/event-bus.js'
import type { StreamChannel } from '../events/stream-channel.js'
import {
  Session,
  SessionManager,
  createEmptySessionState,
  type SessionState,
} from '@onething/core/session'
import { getCurrentBackend } from '../current.js'

/**
 * Get the singleton SessionManager instance.
 * Throws if no backend is assembled in this process.
 */
export function getSessionManager(): SessionManager {
  return getCurrentBackend('sessionManager').sessionManager
}

/**
 * 造会话层。纯工厂:入参就是它要的两件依赖(而不是自己去 `getEventBus()`),
 * 返回值里的 `dispose` 是它留下的**全部**尾巴 —— 校验订阅 + manager 自身。
 */
export function createSessionLayer(
  eventBus: EventBus,
  streamChannel: StreamChannel,
): { sessionManager: SessionManager; dispose: () => void } {
  const sessionManager = new SessionManager(eventBus, streamChannel)
  let validationUnsub: Unsubscribe | null = setupValidation(eventBus, sessionManager)

  return {
    sessionManager,
    dispose: () => {
      validationUnsub?.()
      validationUnsub = null
      sessionManager.shutdown()
    },
  }
}

// Re-export for direct use
export {
  Session,
  SessionManager,
  createEmptySessionState,
}
export type { SessionState }
