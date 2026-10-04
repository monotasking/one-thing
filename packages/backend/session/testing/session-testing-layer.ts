import { createBackendHandle, getCurrentBackendSafe, setCurrentBackend } from '@onething/backend/backend-current.js'
import { EventBus, StreamChannel } from '@onething/backend/event'
import { SessionManager } from '../session-manager.js'
import { createSessionEventLayer } from '../session-event-layer.js'
import type { SessionLayer } from '../session-layer.js'
import path from 'node:path'
import { getOnethingSessionsDir } from '@onething/backend/storage'
import { acquireSessionEventLogStore, flushSessionEventLog, readSessionLogEventsSync } from '../session-event-log.js'
import { createSessionReads, type SessionReadPorts } from '../session-reads.js'
import { sessionProjectionOptions } from '../session-projection-blobs.js'
import { createSessionCommands, type SessionCommandsPorts } from '../session-commands.js'
import { createSessionAccess, type SessionAccess } from '../session-access.js'
import { createSessionWritable } from '../session-writable.js'
import { createSessionDeletion, type SessionDeletionPorts } from '../session-deletion.js'
import type { DeleteSessionResult } from '../session-store.js'

/** Explicit fixture for isolated session tests. No production fallback exists. */
export function installSessionLayerForTest(options: Partial<Pick<SessionLayer, 'commands' | 'listSessions'>> & {
  store?: Partial<SessionReadPorts['store']>
  eventReads?: Partial<SessionReadPorts['events']>
  commandPorts?: Omit<SessionCommandsPorts, 'reads' | 'hasMessage'>
  access?: SessionAccess
  deletionPorts?: SessionDeletionPorts<DeleteSessionResult>
} = {}) {
  const previous = getCurrentBackendSafe()
  const eventBus = new EventBus()
  const streamChannel = new StreamChannel()
  const sessionsDir = getOnethingSessionsDir()
  const journal = acquireSessionEventLogStore(path.dirname(sessionsDir), { sessionsDir })
  const deletion = createSessionDeletion(options.deletionPorts ?? {
    targets: id => [id],
    abortAndDrain: async () => { throw new Error('This isolated fixture requires an execution drain port') },
    flush: flushSessionEventLog,
    remove: async () => { throw new Error('This isolated fixture requires a deletion port') },
  })
  const events = createSessionEventLayer({ assertWritable: deletion.assertWritable })
  journal.assertSessionWritable = deletion.assertWritable
  const sessionManager = new SessionManager(eventBus, streamChannel)
  const testStore = new Proxy({} as SessionReadPorts['store'], {
    get: (_target, name) => Reflect.get(options.store ?? {}, name)
      ?? (() => { throw new Error(`This isolated fixture requires the ${String(name)} store port`) }),
  })
  const reads = createSessionReads({
    store: testStore,
    events: { ...events.reads, ...options.eventReads },
    getProjection: events.projections.getLiveSessionProjection,
    materializeOptions: sessionProjectionOptions,
    getSessionsDir: getOnethingSessionsDir,
  })
  const commands = options.commands ?? (options.commandPorts
    ? createSessionCommands({ ...options.commandPorts, reads, hasMessage: events.reads.eventsHasMessage }, {
        events: events.commandEvents,
        account: events.projections.peekSessionAccount,
        assertActive: events.assertActive,
        assertWritable: deletion.assertWritable,
      })
    : undefined)
  const sessionLayer: SessionLayer = {
    sessionManager,
    events,
    reads,
    deletion,
    access: options.access ?? createSessionAccess({ findMeta: () => undefined }),
    ensureWritable: createSessionWritable({
      assertActive: events.assertActive,
      getSession: id => testStore.getSessionRaw(id) ?? testStore.getSession(id),
      readEvents: readSessionLogEventsSync,
      write: events.writer.write,
      flush: flushSessionEventLog,
    }),
    get commands() {
      if (!commands) throw new Error('This isolated fixture requires explicit command ports')
      return commands
    },
    listSessions: options.listSessions ?? (() => { throw new Error('This isolated fixture requires an explicit list query') }),
    dispose() { events.dispose(); reads.dispose(); sessionManager.shutdown(); deletion.dispose() },
  }
  const handle = createBackendHandle({
    journalStore: journal,
    eventBus,
    streamChannel,
    sessionManager: sessionLayer.sessionManager,
    sessionLayer,
  })
  setCurrentBackend(handle)
  return {
    sessionLayer,
    async dispose(): Promise<void> {
      sessionLayer.dispose()
      eventBus.shutdown()
      streamChannel.shutdown()
      try { await journal.drainAndRelease() }
      finally { if (getCurrentBackendSafe() === handle) setCurrentBackend(previous) }
    },
  }
}
