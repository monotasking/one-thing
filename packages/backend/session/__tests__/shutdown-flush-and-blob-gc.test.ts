/**
 * S3w 批 5:关停链的事件账本收尾(§15.12(a)(b))+ blob GC(§15.12 B1)。
 *
 * 每条按**可观察的后果**写,而且验过反向:
 *  - 排空:队列里在途的那条事件,`flushSessionEventLedger()` 回来之后必须在盘上;
 *  - 时限:排空卡住时它按时返回 `timedOut:true` 且**不抛**(关停不能被钉住);
 *  - 统计表:排空过程记的 `appendFailures` 必须已经落盘(它排在排空之后);
 *  - blob GC:孤儿归档而不是硬删,四道跳过闸各拦住一类"看着像孤儿其实不是"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '' }))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

const { flushAllSessionEventLogs, flushSessionEventLedger, flushSessionEventLog, getSessionEventsLogPath, resetSessionEventLogCache, SESSION_EVENT_SHUTDOWN_FLUSH_TIMEOUT_MS } = await import('../event-log.js')
const { writeSessionEvent } = await import('../event-writer.js')
const {
  getSessionShadowStatsPath,
  resetSessionEventStatsCache,
} = await import('../event-stats.js')
const { putSessionBlob } = await import('../blob-store.js')
const {
  runSessionBlobGc,
  scanSessionBlobGc,
  scheduleSessionBlobGcOnStartup,
  SESSION_BLOB_ORPHAN_DIRNAME,
} = await import('../blob-gc.js')

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-s3w4-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(state.sessionsDir, { recursive: true })
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
  delete process.env.ONETHING_SESSION_BLOB_GC
})

afterEach(async () => {
  await flushSessionEventLog()
  delete process.env.ONETHING_SESSION_BLOB_GC
  fs.rmSync(state.storeDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeJsonlSession(sessionId: string): string {
  const dir = path.join(state.sessionsDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}')
  return dir
}

// ============ (a)(b) 关停链的收尾 ============

describe('flushSessionEventLedger (§15.12 (a)(b))', () => {
  it('drains the queued append and fsyncs before it returns', async () => {
    const sessionId = 's-drain'
    makeJsonlSession(sessionId)
    writeSessionEvent(sessionId, 'session/created', { sessionId })
    writeSessionEvent(sessionId, 'user/message', {
      message: { id: 'm1', role: 'user', content: 'hi', timestamp: 1 },
    })
    // 反向:排空之前那条事件还只在队列里(append 是排队异步落盘的)。
    expect(fs.existsSync(getSessionEventsLogPath(sessionId))).toBe(false)

    const result = await flushSessionEventLedger()

    expect(result.timedOut).toBe(false)
    const text = fs.readFileSync(getSessionEventsLogPath(sessionId), 'utf8')
    expect(text).toContain('"user/message"')
  })

  it('lands the failures recorded *during* the drain in the stats file', async () => {
    // 顺序就是这条用例的全部内容(§15.12(b)):统计表是 1s 节流写的 `unref`
    // 定时器,而队列尾巴上那几条正是最容易失败的 —— 统计表必须排在排空**之后**
    // 落盘,否则门读到的是少一截的账。
    const sessionId = 's-stats'
    makeJsonlSession(sessionId)
    writeSessionEvent(sessionId, 'session/created', { sessionId })
    await flushSessionEventLog(sessionId)
    expect(fs.existsSync(getSessionShadowStatsPath())).toBe(false)

    vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(new Error('disk full'))
    writeSessionEvent(sessionId, 'user/message', {
      message: { id: 'm1', role: 'user', content: 'hi', timestamp: 1 },
    })

    await flushSessionEventLedger()

    const stats = JSON.parse(fs.readFileSync(getSessionShadowStatsPath(), 'utf8')) as {
      appendFailures: number
    }
    expect(stats.appendFailures).toBeGreaterThanOrEqual(1)
  })

  it('returns timedOut instead of hanging (and never throws) when the queue stalls', async () => {
    const sessionId = 's-stall'
    makeJsonlSession(sessionId)
    writeSessionEvent(sessionId, 'session/created', { sessionId })
    await flushSessionEventLog(sessionId)
    // 卡住那一刀落在 append 上:排空 = 等这条队列。
    vi.spyOn(fs.promises, 'appendFile').mockImplementation(
      () => new Promise<void>(() => undefined),
    )
    writeSessionEvent(sessionId, 'user/message', {
      message: { id: 'm1', role: 'user', content: 'hi', timestamp: 1 },
    })

    const started = Date.now()
    const result = await flushAllSessionEventLogs({ timeoutMs: 30 })

    expect(result.timedOut).toBe(true)
    // 上限是"按时回来",不是"立刻回来"。
    expect(Date.now() - started).toBeLessThan(SESSION_EVENT_SHUTDOWN_FLUSH_TIMEOUT_MS)

    // 那条 append 永远不会 resolve —— 把这个会话的状态丢掉,否则 afterEach 的
    // 排空会挂在它上面(队列是每会话一条链)。
    vi.restoreAllMocks()
    resetSessionEventLogCache(sessionId)
  })

  it('is a no-op with no sessions in memory', async () => {
    await expect(flushAllSessionEventLogs()).resolves.toEqual({ timedOut: false })
  })
})

// ============ B1 blob GC ============

describe('session blob GC (§15.12 B1)', () => {
  /** 造一条"写了 blob 但没有事件引用它"的孤儿(GC 唯一的正当对象)。 */
  function makeOrphan(sessionId: string, body: string): string {
    const ref = putSessionBlob(sessionId, body, 'text/plain')
    expect(ref).toBeDefined()
    const file = path.join(state.sessionsDir, sessionId, 'blobs', ref!.hash)
    // 老到过得了年龄闸(默认 24h)。
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000)
    fs.utimesSync(file, old, old)
    return ref!.hash
  }

  it('archives an unreferenced blob into blobs/orphan/ instead of deleting it', async () => {
    const sessionId = 's-gc'
    makeJsonlSession(sessionId)
    writeSessionEvent(sessionId, 'session/created', { sessionId })
    const referenced = putSessionBlob(sessionId, 'x'.repeat(100), 'text/plain')!
    writeSessionEvent(sessionId, 'user/message', {
      message: { id: 'm1', role: 'user', content: 'hi', timestamp: 1, blob: referenced },
    })
    await flushSessionEventLog(sessionId)
    const orphan = makeOrphan(sessionId, 'y'.repeat(100))
    // 被引用的那一份也得过年龄闸,否则"没动它"证明不了是引用的功劳。
    const referencedFile = path.join(state.sessionsDir, sessionId, 'blobs', referenced.hash)
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000)
    fs.utimesSync(referencedFile, old, old)

    const dry = scanSessionBlobGc(sessionId, { sessionsDir: state.sessionsDir })
    expect(dry.orphans).toEqual([orphan])
    expect(dry.archived).toBe(0)
    // dry-run 一个字节都没动。
    expect(fs.existsSync(path.join(state.sessionsDir, sessionId, 'blobs', orphan))).toBe(true)

    const applied = scanSessionBlobGc(sessionId, { sessionsDir: state.sessionsDir, dryRun: false })
    expect(applied.archived).toBe(1)
    expect(applied.errors).toEqual([])
    const orphanDir = path.join(state.sessionsDir, sessionId, 'blobs', SESSION_BLOB_ORPHAN_DIRNAME)
    // 归档不是硬删:文件还在,只是换了个目录。
    expect(fs.readFileSync(path.join(orphanDir, orphan), 'utf8')).toBe('y'.repeat(100))
    // 被引用的那一份一动不动。
    expect(fs.existsSync(referencedFile)).toBe(true)
  })

  it('never touches a session whose events are missing or malformed', async () => {
    // 1. 没有事件 —— 引用集是空的,整个 blobs/ 会被当成孤儿。
    const noEvents = 's-no-events'
    makeJsonlSession(noEvents)
    const orphanA = makeOrphan(noEvents, 'a'.repeat(80))
    const reportA = scanSessionBlobGc(noEvents, { sessionsDir: state.sessionsDir, dryRun: false })
    expect(reportA.skipped).toBe('no-events')
    expect(reportA.archived).toBe(0)
    expect(fs.existsSync(path.join(state.sessionsDir, noEvents, 'blobs', orphanA))).toBe(true)

    // 2. 有坏行 —— `parseSessionLogEventLog` 会静默跳过那一行,它里面的引用
    //    会凭空消失,而它指着的 blob 会当场变成"孤儿"。
    const malformed = 's-malformed'
    makeJsonlSession(malformed)
    writeSessionEvent(malformed, 'session/created', { sessionId: malformed })
    await flushSessionEventLog(malformed)
    const orphanB = makeOrphan(malformed, 'b'.repeat(80))
    fs.appendFileSync(getSessionEventsLogPath(malformed), '{ this is not json\n')
    const reportB = scanSessionBlobGc(malformed, { sessionsDir: state.sessionsDir, dryRun: false })
    expect(reportB.skipped).toBe('malformed-events')
    expect(reportB.archived).toBe(0)
    expect(fs.existsSync(path.join(state.sessionsDir, malformed, 'blobs', orphanB))).toBe(true)
  })

  it('leaves a freshly written blob alone (its event may not be on disk yet)', async () => {
    const sessionId = 's-fresh'
    makeJsonlSession(sessionId)
    writeSessionEvent(sessionId, 'session/created', { sessionId })
    await flushSessionEventLog(sessionId)
    const ref = putSessionBlob(sessionId, 'z'.repeat(90), 'text/plain')!

    const report = scanSessionBlobGc(sessionId, { sessionsDir: state.sessionsDir, dryRun: false })
    expect(report.orphans).toEqual([])
    expect(fs.existsSync(path.join(state.sessionsDir, sessionId, 'blobs', ref.hash))).toBe(true)

    // 反向:把年龄闸开到 0(并让"现在"往后挪一点,免得 mtime 的取整比 now 还大)
    // —— 同一个文件立刻就是孤儿,证明上面拦住它的是年龄而不是别的。
    const forced = scanSessionBlobGc(sessionId, {
      sessionsDir: state.sessionsDir,
      minAgeMs: 0,
      now: () => Date.now() + 5_000,
    })
    expect(forced.orphans).toEqual([ref.hash])
  })

  it('does not re-archive what already sits in blobs/orphan/', async () => {
    const sessionId = 's-twice'
    makeJsonlSession(sessionId)
    writeSessionEvent(sessionId, 'session/created', { sessionId })
    await flushSessionEventLog(sessionId)
    makeOrphan(sessionId, 'c'.repeat(80))

    expect(scanSessionBlobGc(sessionId, { sessionsDir: state.sessionsDir, dryRun: false }).archived).toBe(1)
    const second = scanSessionBlobGc(sessionId, { sessionsDir: state.sessionsDir, dryRun: false })
    // `orphan/` 是目录,扫描只看文件 —— 归过档的那一份不会被当成新孤儿再数一遍。
    expect(second.orphans).toEqual([])
    expect(second.present).toBe(0)
  })

  it('reports missing references even for sessions it skips', async () => {
    const sessionId = 's-missing'
    makeJsonlSession(sessionId)
    writeSessionEvent(sessionId, 'session/created', { sessionId })
    writeSessionEvent(sessionId, 'user/message', {
      message: {
        id: 'm1',
        role: 'user',
        content: 'hi',
        timestamp: 1,
        blob: { hash: 'deadbeefdeadbeef', bytes: 10 },
      },
    })
    await flushSessionEventLog(sessionId)

    const report = runSessionBlobGc({ sessionsDir: state.sessionsDir })
    expect(report.skipped['no-blobs']).toBe(1)
    // 有引用没文件不是 GC 的对象(归 `sessions:verify` 的 #4),但报成 0 是假话。
    expect(report.missing).toBe(1)
    expect(report.orphans).toBe(0)
  })

  it('is off unless ONETHING_SESSION_BLOB_GC says otherwise', () => {
    expect(scheduleSessionBlobGcOnStartup()).toBeUndefined()
    process.env.ONETHING_SESSION_BLOB_GC = '0'
    expect(scheduleSessionBlobGcOnStartup()).toBeUndefined()
    process.env.ONETHING_SESSION_BLOB_GC = '1'
    const cancel = scheduleSessionBlobGcOnStartup({ delayMs: 60_000 })
    expect(typeof cancel).toBe('function')
    cancel?.()
  })

  /**
   * C0 R3(方案 `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.3)。
   *
   * A0 ⑨ 从前用 `process.getActiveResourcesInfo()` 数定时器,而这个挂点的
   * `setTimeout` 是 **`unref` 过**的 —— 那张表里根本看不见它,于是那半条断言在
   * 量的是别人(vitest 自己的超时钟与同 worker 的邻居),恒绿。`vi.useFakeTimers()`
   * 的 `getTimerCount()` 看得见 unref 定时器,所以泄漏判据挪到这里,由每个起
   * 定时器的模块自己钉。
   *
   * 反证(实跑过):把 `blob-gc.ts` 里 `return () => clearTimeout(timer)` 换成
   * `return () => {}` → 最后一句 `toBe(0)` 红(`expected 1 to be +0`)。
   */
  it('C0 R3:cancel 之后不留定时器(unref 的也算)', () => {
    vi.useFakeTimers()
    try {
      expect(vi.getTimerCount()).toBe(0)
      process.env.ONETHING_SESSION_BLOB_GC = '1'
      const cancel = scheduleSessionBlobGcOnStartup({ delayMs: 60_000 })
      expect(vi.getTimerCount()).toBe(1)
      cancel?.()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
