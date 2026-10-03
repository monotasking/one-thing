import {
  appendSessionLogEvent,
  drainSessionLogEventTail,
  getSessionEventsLogPath,
  isSessionEventLogEnabled,
  readSessionLogEventsSync,
  readSessionLogEventsSyncFrom,
  registerSessionLogEventAppendObserver,
  type SessionLogEventAppendObserver,
} from './event-log.js'
import { createSessionEventWriter } from './event-writer.js'
import { createSessionSurface } from './event-surface.js'
import { createSessionPrepare } from './prepare.js'
import { createSessionProjectionCache } from './projection-cache.js'
import { sessionProjectionOptions } from './projection-blobs.js'
import { createSessionCommandEvents } from './command-events.js'
import { createSessionEventReads } from './events-reads.js'
import { loadSessionProjectionCheckpoint } from './checkpoint-file.js'

/** Runtime state and every ledger subscription have one owner. */
export function createSessionEventLayer(options: { assertWritable?(sessionId: string): void } = {}) {
  let disposed = false
  const subscriptions = new Set<() => void>()
  const assertActive = (): void => {
    if (disposed) throw new Error('Session event layer has been disposed')
  }
  const observe = (observer: SessionLogEventAppendObserver): (() => void) => {
    assertActive()
    const unsubscribe = registerSessionLogEventAppendObserver(observer)
    const release = (): void => {
      subscriptions.delete(release)
      unsubscribe()
    }
    subscriptions.add(release)
    return release
  }
  // Install observers before recovery or the first production write can run.
  const surface = createSessionSurface({
    readEvents: readSessionLogEventsSync,
    isEnabled: isSessionEventLogEnabled,
    observe,
  })
  const writer = createSessionEventWriter({
    prepareOnce(sessionId) {
      assertActive()
      options.assertWritable?.(sessionId)
      prepare.once(sessionId)
    },
    ensureSurface: surface.ensure,
    append: appendSessionLogEvent,
    observe,
  })
  const prepare = createSessionPrepare({
    getLogPath: getSessionEventsLogPath,
    isEnabled: isSessionEventLogEnabled,
    writeRecovery: writer.write,
  })
  const prepareOnce = (sessionId: string): void => {
    assertActive()
    prepare.once(sessionId)
  }
  const projections = createSessionProjectionCache({
    readEvents: (sessionId, fromByte) => (fromByte === undefined
      ? readSessionLogEventsSync(sessionId)
      : readSessionLogEventsSyncFrom(sessionId, fromByte)),
    drainTail: drainSessionLogEventTail,
    prepareOnce,
    materializeOptions: sessionProjectionOptions,
    observe,
    // 工单 4 B:冷载先问一句检查点。四道判据在 `checkpoint-file.ts` 里,
    // 这一行只负责把那扇门接上 —— 拿不到就是从头折,与本单之前逐字相同。
    restore: loadSessionProjectionCheckpoint,
  })
  const commandEvents = createSessionCommandEvents({ surface, write: writer.write })
  const reads = createSessionEventReads({
    getLogPath: getSessionEventsLogPath,
    projections,
    materializeOptions: sessionProjectionOptions,
  })
  return {
    assertActive,
    writer,
    surface,
    prepare,
    projections,
    commandEvents,
    reads,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const release of subscriptions) release()
      projections.dispose()
      surface.dispose()
      prepare.dispose()
      reads.dispose()
    },
  }
}

export type SessionEventLayer = ReturnType<typeof createSessionEventLayer>
