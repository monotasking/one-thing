/**
 * ACP 状态的**总线广播器**(A0-2,方案 `docs/design/acp-integration-2026-09.md` §3.3)。
 *
 * 产品层的 `ACPManager` 只认识两条监听口(会话状态、agent 状态),不认识事件总线 —— 总线住
 * 装配层。这里把两条监听接成两种全局事件 `acp:session-state` / `acp:agent-state`,它们在
 * `GLOBAL_EVENT_LEAVES_PROCESS` 登记为可出网,于是经 `GET /api/events` 自动到壳,壳零通道代码。
 *
 * 写法照 `wiring/terminal/bus-broadcaster.ts`:**发送时才取总线**。子系统构造在装配中途,
 * 那时事件系统也许还没造出来;构造时抓总线会当场抛。装配没完成就有状态变化 → warn 一行丢掉,
 * 不抛 —— 状态是整张快照,下一次变化或一次 `acp.sessionState` 就补齐了。
 */
import type { ACPAgentState, AcpSessionState } from '@shared/contracts/acp'
import { getEventBus, isEventSystemInitialized } from '../../events/index.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('app.acp.events')

/** 广播器看得见的 manager 面:两条监听口,各自返回退订函数。 */
export interface AcpStateSource {
  onSessionStateChanged(listener: (state: AcpSessionState) => void): () => void
  onAgentStateChanged(listener: (state: ACPAgentState) => void): () => void
}

/** 订上两条监听口;返回的函数把两条一起退掉(由 `AcpSubsystem.dispose()` 调)。 */
export function installAcpStateBroadcaster(source: AcpStateSource): () => void {
  const offSession = source.onSessionStateChanged((state) => {
    if (!isEventSystemInitialized()) {
      log.warn('acp session state dropped before assembly', { agentId: state.agentId, localSessionId: state.localSessionId })
      return
    }
    getEventBus().emitGlobal({ type: 'acp:session-state', state })
  })
  const offAgent = source.onAgentStateChanged((state) => {
    if (!isEventSystemInitialized()) {
      log.warn('acp agent state dropped before assembly', { agentId: state.config.id, status: state.status })
      return
    }
    getEventBus().emitGlobal({ type: 'acp:agent-state', state })
  })
  return () => {
    offSession()
    offAgent()
  }
}

/** `onSessionsDeleted` 看得见的总线面:一条全局订阅口(`EventBus.onGlobal` 的子集)。 */
export interface SessionDeletionBus {
  onGlobal(
    type: 'resource:event',
    handler: (envelope: { event: { ref: string; event: string; payload: unknown } }) => void,
  ): () => void
}

const SESSION_REF_PREFIX = 'session:'

/**
 * 「这几条会话删了」(A4-b:删会话 → 作废那条会话名下的 ACP 桥凭据)。
 *
 * 删除今天只有一个出口:`session:` 资源的 `delete` 操作,它在收完尾之后发 `deleted` 资源事件
 * (`wiring/resource/session-provider.ts`),经 `forwardResourceEventsToBus` 成为全局
 * `resource:event`。载荷里的 `cascadedSessionIds` 是连带删掉的整串(子会话在内),都算。
 * 订总线而不是往删除路径里再塞一个端口:删除那一段不该认识 ACP。
 */
export function onSessionsDeletedFromBus(bus: SessionDeletionBus): (listener: (sessionIds: string[]) => void) => () => void {
  return listener => bus.onGlobal('resource:event', ({ event }) => {
    if (event.event !== 'deleted' || !event.ref.startsWith(SESSION_REF_PREFIX)) return
    const ids = new Set<string>([event.ref.slice(SESSION_REF_PREFIX.length)])
    const cascaded = (event.payload as { cascadedSessionIds?: unknown } | null)?.cascadedSessionIds
    if (Array.isArray(cascaded)) for (const id of cascaded) if (typeof id === 'string') ids.add(id)
    ids.delete('')
    if (ids.size > 0) listener([...ids])
  })
}
