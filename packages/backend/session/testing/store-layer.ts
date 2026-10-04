import { createBackendHandle, getCurrentBackendSafe, setCurrentBackend } from '@onething/backend/current.js'
import { EventBus } from '@onething/backend/event/session-event-bus'
import { StreamChannel } from '@onething/backend/event/session-stream-channel'
import { acquireSessionEventLogStore } from '../event-log.js'
import { createSessionLayer, type SessionLayer } from '../session-layer.js'
import { collectSessionCascadeDeleteIds } from '../store-helpers.js'
import { getOnethingSessionsDir } from '@onething/backend/storage'
import { createSessionDeletionRecovery } from '../deletion-recovery.js'
import { getTracesDir } from '@onething/backend/eval/trace-store'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import * as store from '../session-store.js'
import type { SessionAccessContext } from '../session-access.js'
import path from 'node:path'
import { ToolExecutionRegistry } from '@onething/backend/toolkit/executions'

/** Real store + production session assembly, with an explicit isolated execution port. */
export async function installStoreSessionLayerForTest(options: { abortAndDrain?(id: string): Promise<void> } = {}) {
  const previous = getCurrentBackendSafe()
  const sessionsDir = getOnethingSessionsDir()
  let active = true
  const sessionDeletionRecovery = createSessionDeletionRecovery({
    sessionsDir,
    assertOwned: () => { if (!active) throw new Error('Isolated store fixture is disposed') },
    associatedDirectories: { traces: getTracesDir({ storePath: path.dirname(sessionsDir) }) },
  })
  await sessionDeletionRecovery.recover()
  const journalStore = acquireSessionEventLogStore(path.dirname(sessionsDir), { sessionsDir })
  const eventBus = new EventBus()
  const streamChannel = new StreamChannel()
  const parts: Parameters<typeof createBackendHandle>[0] = { journalStore, eventBus, streamChannel, sessionDeletionRecovery }
  const handle = createBackendHandle(parts)
  setCurrentBackend(handle)
  let sessionLayer: SessionLayer
  try {
    sessionLayer = createSessionLayer(eventBus, streamChannel, {
      // These store tests have no executing engine. Concurrency tests supply a held producer.
      abortAndDrain: options.abortAndDrain ?? (async () => {}),
    })
    parts.sessionLayer = sessionLayer
    parts.toolExecutions = new ToolExecutionRegistry(sessionLayer.access)
    parts.sessionManager = sessionLayer.sessionManager
    journalStore.assertSessionWritable = sessionLayer.deletion.assertWritable
  } catch (error) {
    eventBus.shutdown()
    streamChannel.shutdown()
    await journalStore.drainAndRelease()
    active = false
    setCurrentBackend(previous)
    throw error
  }
  return {
    sessionLayer,
    eventBus,
    journalStore,
    deleteSession(id: string, context: SessionAccessContext = DESKTOP_RPC_CONTEXT) {
      const ids = sessionLayer.access.resolveAll(context, collectSessionCascadeDeleteIds(store.getSessionsList(), id), 'delete')
      return sessionLayer.deletion.delete(id, ids, targets => { sessionLayer.access.resolveAll(context, targets, 'delete') })
    },
    async dispose(): Promise<void> {
      parts.toolExecutions!.quiesce()
      await parts.toolExecutions!.drain()
      await sessionLayer.deletion.drain()
      await store.flushAllPendingSaves()
      sessionLayer.dispose()
      eventBus.shutdown()
      streamChannel.shutdown()
      try { await journalStore.drainAndRelease() }
      finally {
        active = false
        if (getCurrentBackendSafe() === handle) setCurrentBackend(previous)
      }
    },
  }
}
