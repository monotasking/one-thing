/**
 * 会话组合根：绑定命令、查询、账本写入、恢复与投影，统一持有并释放运行期状态。
 * 兼容入口只读取已装配实例；业务工厂通过窄端口工作，不自行寻找生产依赖。
 */

import { setupValidation } from './validation.js'
import type { Unsubscribe } from '../events/types.js'
import type { EventBus } from '../events/event-bus.js'
import type { StreamChannel } from '../events/stream-channel.js'
import {
  Session,
  SessionManager,
  createEmptySessionState,
  collectSessionCascadeDeleteIds,
  type SessionState,
} from '@onething/core/session'
import { getCurrentBackend } from '../current.js'
import { createSessionEventLayer } from './event-layer.js'
import { createSessionCommands } from './commands.js'
import { createSessionReads, type SessionHistoryBuilder, type SessionReads } from './reads.js'
import * as store from '../stores/sessions.js'
import type { SessionsListRequest } from '@shared/ipc/sessions.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import { getOnethingSessionsDir } from '@onething/runtime/storage'
import { sessionProjectionOptions } from './projection-blobs.js'
import { createSessionAccess, type SessionOwnershipRecord, type SessionAccessContext } from './access.js'
import { createSessionListQuery } from './queries.js'
import { createSessionWritable } from './writable.js'
import { flushSessionEventLog, readSessionLogEventsSync } from './event-log.js'
import { createSessionDeletion } from './deletion.js'

export { createSessionListQuery } from './queries.js'

export const listSessions = (request: SessionsListRequest = {}, context: SessionAccessContext = DESKTOP_RPC_CONTEXT) =>
  getCurrentBackend('sessionLayer').sessionLayer.listSessions(context, request)
export const ensureSessionWritable = (sessionId: string): Promise<void> =>
  getCurrentBackend('sessionLayer').sessionLayer.ensureWritable(sessionId)

/**
 * Get the singleton SessionManager instance.
 * Throws if no backend is assembled in this process.
 */
export function getSessionManager(): SessionManager {
  return getCurrentBackend('sessionManager').sessionManager
}

/**
 * 生产接线集中在此：事件系统与历史配方由宿主给出，其余端口绑定现有存储适配。
 * dispose 释放校验、真实活投影、分页索引、历史配方及所有写入口观察者。
 */
export function createSessionLayer(
  eventBus: EventBus,
  streamChannel: StreamChannel,
  options: { historyBuilder?: SessionHistoryBuilder; abortAndDrain?(sessionId: string): Promise<void> } = {},
): SessionLayer {
  const sessionManager = new SessionManager(eventBus, streamChannel)
  const deletion = createSessionDeletion<store.DeleteSessionResult>({
    targets: id => collectSessionCascadeDeleteIds(store.getSessionsList(), id),
    abortAndDrain: id => {
      if (!options.abortAndDrain) throw new Error('Session deletion requires an execution drain port')
      return options.abortAndDrain(id)
    },
    flush: async id => {
      await store.flushSessionSave(id)
      await flushSessionEventLog(id)
    },
    remove: async (id, expectedIds) => {
      const result = await store.deleteSession(id, expectedIds)
      for (const deletedId of result.deletedIds) {
        events.projections.resetSessionProjectionCache(deletedId)
        events.prepare.reset(deletedId)
        events.reads.resetSessionEventReadCache(deletedId)
        ensureWritable.forget(deletedId)
        reads.forgetSession(deletedId)
      }
      return result
    },
  })
  const events = createSessionEventLayer({ assertWritable: deletion.assertWritable })
  const reads = createSessionReads({
    store,
    events: events.reads,
    getProjection: events.projections.getLiveSessionProjection,
    materializeOptions: sessionProjectionOptions,
    getSessionsDir: getOnethingSessionsDir,
  }, options.historyBuilder)
  const commands = createSessionCommands({
    getSession: (...args) => store.getSession(...args),
    saveSession: (...args) => store.saveSessionForCommands(...args),
    updateSessionsIndexMeta: (...args) => store.updateSessionsIndexMetaForCommands(...args),
    flushSessionSave: (...args) => store.flushSessionSave(...args),
    stampCollabAgentId: (...args) => store.stampCollabAgentId(...args),
    patchSession: (...args) => store.patchSessionFields(...args),
    reads,
    hasMessage: events.reads.eventsHasMessage,
  }, {
    events: events.commandEvents,
    account: events.projections.peekSessionAccount,
    assertActive: events.assertActive,
    assertWritable: deletion.assertWritable,
  })
  let validationUnsub: Unsubscribe | null = setupValidation(eventBus, sessionManager)
  const ensureWritable = createSessionWritable({
    assertActive: events.assertActive,
    getSession: id => store.getSessionRaw(id) ?? store.getSession(id),
    readEvents: readSessionLogEventsSync,
    write: events.writer.write,
    flush: flushSessionEventLog,
  })

  const access = createSessionAccess({
    findMeta: id => store.findSessionIndexMeta(id) as SessionOwnershipRecord | undefined,
    assertAccepting: deletion.assertAccepting,
  })
  return {
    sessionManager,
    events,
    commands,
    reads,
    deletion,
    access,
    ensureWritable,
    listSessions: createSessionListQuery({ listSessions: () => store.getSessionsList(), access }),
    dispose: () => {
      validationUnsub?.()
      validationUnsub = null
      sessionManager.shutdown()
      events.dispose()
      reads.dispose()
      deletion.dispose()
    },
  }
}

export interface SessionLayer {
  sessionManager: SessionManager
  events: ReturnType<typeof createSessionEventLayer>
  commands: ReturnType<typeof createSessionCommands>
  reads: SessionReads
  deletion: ReturnType<typeof createSessionDeletion<store.DeleteSessionResult>>
  access: ReturnType<typeof createSessionAccess>
  ensureWritable: ReturnType<typeof createSessionWritable>
  listSessions: ReturnType<typeof createSessionListQuery<ReturnType<typeof store.getSessionsList>[number]>>
  dispose(): void
}

// Re-export for direct use
export {
  Session,
  SessionManager,
  createEmptySessionState,
}
export type { SessionState }
