import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackendHandle, setCurrentBackend } from '../../current.js'
import {
  acquireSessionEventLogStore,
  getSessionEventsLogPath,
  readSessionLogEventsSync,
  resetSessionEventLogCache,
} from '../event-log.js'
import { createSessionEventLayer } from '../event-layer.js'

let directory: string
let owner: ReturnType<typeof acquireSessionEventLogStore> | undefined
let layer: ReturnType<typeof createSessionEventLayer>
/**
 * 写走**正门**(工单 4 D1)。换库这件事验的是低层账本的所有权,但落账仍然只有
 * 写入口一个调用者 —— 从前这里靠给检查器加一条测试白名单绕过去。
 * 这一层**跨换库不重建**,正是这套用例「不靠重置缓存」那条判据要的。
 */
const writeEvent: ReturnType<typeof createSessionEventLayer>['writer']['write'] =
  (...args) => layer.writer.write(...args)

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-owner-')))
  layer = createSessionEventLayer()
})

afterEach(async () => {
  layer.dispose()
  await owner?.drainAndRelease().catch(() => undefined)
  setCurrentBackend(null)
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

function acquire(name: string) {
  owner = acquireSessionEventLogStore(path.join(directory, name))
  setCurrentBackend(createBackendHandle({ journalStore: owner }))
  return owner
}

describe('event journal store ownership', () => {
  it('moves from store A to store B with the same session ID through real drain, without resetting caches', async () => {
    const a = acquire('a')
    writeEvent('same', 'session/created', { sessionId: 'same', model: 'A' })
    const fileA = getSessionEventsLogPath('same')
    await a.drainAndRelease()

    const b = acquire('b')
    expect(writeEvent('same', 'session/created', { sessionId: 'same', model: 'B' })).toBe(1)
    await b.flush()
    const fileB = getSessionEventsLogPath('same')
    expect(fileA).not.toBe(fileB)
    expect(fs.readFileSync(fileA, 'utf8')).toContain('"model":"A"')
    expect(fs.readFileSync(fileA, 'utf8')).not.toContain('"model":"B"')
    expect(readSessionLogEventsSync('same')).toMatchObject([{ seq: 1, data: { model: 'B' } }])
    await expect(a.flush()).rejects.toThrow('released')
  })

  it('keeps ownership while drain waits on real IO and refuses cache reset as a substitute', async () => {
    const a = acquire('a')
    const appendFile = fs.promises.appendFile.bind(fs.promises)
    let unblock!: () => void
    const blocked = new Promise<void>(resolve => { unblock = resolve })
    vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (...args) => {
      await blocked
      await appendFile(...args)
    })
    writeEvent('same', 'session/created', { sessionId: 'same' })
    const release = a.drainAndRelease()
    try {
      expect(() => acquireSessionEventLogStore(path.join(directory, 'b'))).toThrow('already owned')
      expect(() => resetSessionEventLogCache()).toThrow('pending IO')
      expect(() => writeEvent('same', 'request/end', { requestIndex: 1 })).toThrow('not accepting')
    } finally {
      unblock()
      await release
    }
    acquire('b')
    expect(writeEvent('same', 'session/created', { sessionId: 'same' })).toBe(1)
  })

  it('reports a failed drain but permits a different owner only once all other sessions settle', async () => {
    const a = acquire('a')
    const cause = new Error('disk EIO')
    const appendFile = fs.promises.appendFile.bind(fs.promises)
    let unblock!: () => void
    const blocked = new Promise<void>(resolve => { unblock = resolve })
    vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (...args) => {
      if (String(args[0]).includes(`${path.sep}broken${path.sep}`)) throw cause
      await blocked
      await appendFile(...args)
    })
    writeEvent('broken', 'session/created', { sessionId: 'broken' })
    writeEvent('pending', 'session/created', { sessionId: 'pending' })
    const result = a.drainAndRelease().then(() => undefined, error => error)
    await Promise.resolve()
    expect(() => acquireSessionEventLogStore(path.join(directory, 'b'))).toThrow('already owned')
    unblock()
    expect(await result).toMatchObject({ cause, sessionId: 'broken' })
    vi.restoreAllMocks()
    const b = acquire('b')
    expect(writeEvent('broken', 'session/created', { sessionId: 'broken' })).toBe(1)
    await b.flush()
  })

  it('rejects event writes with no owner', async () => {
    const a = acquire('a')
    await a.drainAndRelease()
    expect(() => writeEvent('same', 'session/created', { sessionId: 'same' })).toThrow('not accepting')
  })
})
