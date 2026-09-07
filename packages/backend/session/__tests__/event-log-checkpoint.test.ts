import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackendHandle, setCurrentBackend } from '../../current.js'

const location = vi.hoisted(() => ({ store: '', sessions: '' }))
vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => location.sessions,
  getOnethingLogDir: () => path.join(location.store, 'log'),
}))

const {
  acquireSessionEventLogStore,
  drainSessionLogEventTail,
  flushSessionEventLog: flush,
  flushSessionEventLedger,
  getSessionEventsLogPath,
  readSessionLogEventsSync,
  registerSessionLogEventAppendObserver,
  resetSessionEventLogCache,
  SESSION_EVENT_DIRECTORY_SYNC_SUPPORTED,
  SessionEventWriteError,
} = await import('../event-log.js')
const { createSessionEventLayer } = await import('../event-layer.js')
let journal: ReturnType<typeof acquireSessionEventLogStore>
let layer: ReturnType<typeof createSessionEventLayer>
/**
 * 写走**正门**(工单 4 D1)。这套用例验的是低层的检查点/落盘契约,但「谁来落账」
 * 这件事不能因此开一个后门:`appendSessionLogEvent` 只有写入口一个调用者。
 * 从前这里是靠给 `checkSessionEventSingleWriteDoor` 加一条测试白名单绕过去的。
 */
const append: ReturnType<typeof createSessionEventLayer>['writer']['write'] =
  (...args) => layer.writer.write(...args)
const { resetSessionEventStatsCache } = await import('../event-stats.js')

beforeEach(() => {
  location.store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'event-checkpoint-')))
  // Exercise creation of sessions as well as the individual session directory.
  location.sessions = path.join(location.store, 'sessions')
  journal = acquireSessionEventLogStore(location.store)
  setCurrentBackend(createBackendHandle({ journalStore: journal }))
  layer = createSessionEventLayer()
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
})

afterEach(async () => {
  layer.dispose()
  await flush().catch(() => undefined) // Expected failures stay sticky until shutdown.
  await journal.drainAndRelease().catch(() => undefined)
  setCurrentBackend(null)
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
  vi.restoreAllMocks()
  fs.rmSync(location.store, { recursive: true, force: true })
})

function create(sessionId = 's'): number {
  return append(sessionId, 'session/created', { sessionId })!
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('event log durable checkpoints', () => {
  it('exposes the original append failure and prevents queued or later writes across a gap', async () => {
    const cause = Object.assign(new Error('append EIO'), { code: 'EIO' })
    const appendFile = vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(cause)
    create()
    append('s', 'request/end', { requestIndex: 1 })
    await expect(flush('s', 2)).rejects.toMatchObject({
      name: 'SessionEventWriteError', sessionId: 's', seq: 1, operation: 'append', cause,
    })
    expect(appendFile).toHaveBeenCalledTimes(1)
    expect(() => append('s', 'request/end', { requestIndex: 2 })).toThrow(SessionEventWriteError)
    await expect(flushSessionEventLedger()).rejects.toMatchObject({ cause })
    expect(readSessionLogEventsSync('s')).toEqual([])
  })

  it('a reentrant observer checkpoint waits for the event it just received', async () => {
    const started = deferred()
    const release = deferred()
    const appendFile = fs.promises.appendFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (...args) => {
      started.resolve()
      await release.promise
      return appendFile(...args)
    })
    let checkpoint: Promise<void> | undefined
    let complete = false
    const unsubscribe = registerSessionLogEventAppendObserver((id, event) => {
      checkpoint = flush(id, event.seq).then(() => { complete = true })
    })
    try {
      expect(create()).toBe(1)
      await started.promise
      await Promise.resolve()
      expect(complete).toBe(false)
      release.resolve()
      await checkpoint
      expect(readSessionLogEventsSync('s').map(event => event.seq)).toEqual([1])
    } finally {
      release.resolve()
      unsubscribe()
    }
  })

  it('publishes nested synchronous appends in the same order as the log and the tail', async () => {
    const unsubscribe = registerSessionLogEventAppendObserver((id, event) => {
      if (event.seq === 1) append(id, 'request/end', { requestIndex: 1 })
    })
    try {
      create()
      expect(drainSessionLogEventTail('s').records.map(event => event.seq)).toEqual([1, 2])
      await flush('s')
      expect(readSessionLogEventsSync('s').map(event => event.seq)).toEqual([1, 2])
    } finally {
      unsubscribe()
    }
  })

  it('finishes its captured target while later accepted appends are still blocked', async () => {
    create()
    await flush('s')
    const laterStarted = deferred()
    const release = deferred()
    const appendFile = fs.promises.appendFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (...args) => {
      const record = JSON.parse(String(args[1])) as { seq: number }
      if (record.seq >= 3) {
        laterStarted.resolve()
        await release.promise
      }
      return appendFile(...args)
    })
    append('s', 'request/end', { requestIndex: 1 })
    const checkpoint = flush('s') // Captures 2, not the subsequently growing queue.
    for (let index = 2; index < 30; index++) append('s', 'request/end', { requestIndex: index })
    try {
      await laterStarted.promise
      await checkpoint
      expect(readSessionLogEventsSync('s').map(event => event.seq)).toEqual([1, 2])
    } finally {
      release.resolve()
    }
  })

  it('does not hide a later failure or invalidate an already durable prefix', async () => {
    create()
    await flush('s', 1)
    const cause = new Error('later append failed')
    vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(cause)
    append('s', 'request/end', { requestIndex: 1 })
    await expect(flush('s', 2)).rejects.toMatchObject({ seq: 2, cause })
    await expect(flush('s', 1)).resolves.toBeUndefined()
    await expect(flush('s')).rejects.toMatchObject({ seq: 2, cause })
  })

  it('an earlier checkpoint can finish while an already requested later checkpoint waits', async () => {
    const release = deferred()
    const appendFile = fs.promises.appendFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (...args) => {
      if ((JSON.parse(String(args[1])) as { seq: number }).seq === 2) await release.promise
      return appendFile(...args)
    })
    create()
    append('s', 'request/end', { requestIndex: 1 })
    const laterCheckpoint = flush('s', 2)
    try {
      await flush('s', 1)
      expect(readSessionLogEventsSync('s').map(event => event.seq)).toEqual([1])
    } finally {
      release.resolve()
      await laterCheckpoint
    }
  })

  it('can persist an unflushed earlier prefix even after a later append has failed', async () => {
    const appendFile = fs.promises.appendFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'appendFile').mockImplementationOnce(appendFile)
      .mockRejectedValueOnce(new Error('later append failed'))
    create()
    append('s', 'request/end', { requestIndex: 1 })
    await expect(flush('s', 2)).rejects.toMatchObject({ seq: 2 })
    await expect(flush('s', 1)).resolves.toBeUndefined()
    expect(readSessionLogEventsSync('s').map(event => event.seq)).toEqual([1])
  })

  it('retains an earlier sync failure even when a later append failed first', async () => {
    const laterCause = new Error('later append failed first')
    const syncCause = new Error('earlier prefix sync failed')
    const appendFile = fs.promises.appendFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'appendFile').mockImplementationOnce(appendFile).mockRejectedValueOnce(laterCause)
    const open = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      vi.spyOn(handle, 'sync').mockRejectedValue(syncCause)
      return handle
    })
    create()
    append('s', 'request/end', { requestIndex: 1 })
    await expect(flush('s', 2)).rejects.toMatchObject({ seq: 2, cause: laterCause })
    await expect(flush('s', 1)).rejects.toMatchObject({ seq: 1, cause: syncCause })
    vi.restoreAllMocks()
    await expect(flush('s', 1)).rejects.toMatchObject({ seq: 1, cause: syncCause })
  })

  it.each(['open', 'sync'] as const)('propagates %s failure and refuses subsequent appends', async operation => {
    const cause = Object.assign(new Error(`${operation} EIO`), { code: 'EIO' })
    const open = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('events.jsonl')) {
        if (operation === 'open') throw cause
        const handle = await open(...args)
        vi.spyOn(handle, 'sync').mockRejectedValue(cause)
        return handle
      }
      return open(...args)
    })
    create()
    await expect(flush('s')).rejects.toMatchObject({ seq: 1, operation, cause })
    expect(() => append('s', 'request/end', { requestIndex: 1 })).toThrow(SessionEventWriteError)
    await expect(flush('s')).rejects.toMatchObject({ cause })
  })

  it('reports ENOENT for accepted events, while a truly empty checkpoint is a no-op', async () => {
    await expect(flush('missing')).resolves.toBeUndefined()
    create()
    const appendFile = fs.promises.appendFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (...args) => {
      await appendFile(...args)
      fs.unlinkSync(String(args[0]))
    })
    await expect(flush('s')).rejects.toMatchObject({ operation: 'open', cause: { code: 'ENOENT' } })
  })

  /*
   * 工单 5 §2:目录屏障的上界改成 `sessions/`。这一条从"数前四个"换成"整张表逐字"——
   * 只有把整张表钉死,才证得出链条**到此为止**(数前 N 个的写法对"后面还跟着
   * `<store>` / 用户主目录 / 卷根"是瞎的,而那正是这次要砍掉的东西)。
   */
  it.runIf(SESSION_EVENT_DIRECTORY_SYNC_SUPPORTED)('syncs the new file entry and its parents up to sessions/, only on the first checkpoint', async () => {
    const synced: string[] = []
    const open = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        await sync()
        synced.push(String(args[0]))
      })
      return handle
    })
    create()
    await flush('s')
    expect(synced).toEqual([
      getSessionEventsLogPath('s'), path.join(location.sessions, 's'), location.sessions,
    ])
    const firstCount = synced.length
    append('s', 'request/end', { requestIndex: 1 })
    await flush('s')
    expect(synced.slice(firstCount)).toEqual([getSessionEventsLogPath('s')])
    resetSessionEventLogCache()
    expect(readSessionLogEventsSync('s').map(event => event.seq)).toEqual([1, 2])
    expect(append('s', 'request/end', { requestIndex: 2 })).toBe(3)
    await flush('s')
  })

  it.runIf(SESSION_EVENT_DIRECTORY_SYNC_SUPPORTED)('rejects the first checkpoint when a parent directory cannot be synced', async () => {
    const cause = new Error('directory fsync EIO')
    const open = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]) === location.sessions) vi.spyOn(handle, 'sync').mockRejectedValue(cause)
      return handle
    })
    create()
    await expect(flush('s')).rejects.toMatchObject({ operation: 'directory', cause })
    expect(() => append('s', 'request/end', { requestIndex: 1 })).toThrow(SessionEventWriteError)
    await expect(flush('s')).rejects.toMatchObject({ cause })
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2])('rejects invalid target %s without poisoning an accepted write', async target => {
    create()
    await expect(flush('s', target)).rejects.toThrow(RangeError)
    await expect(flush('s', 1)).resolves.toBeUndefined()
  })
})
