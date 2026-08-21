/**
 * S1a:落盘纪律翻转 + blob store(§10.3 / §10.6 第 6、7 条)。
 *
 * 四条纪律各有一条用例,而且都按**可观察的后果**写,不按实现写:
 *  - 会话目录由 `session/created` 建起来(而且只有它有这个权力);
 *  - 写失败进 `session-shadow-stats.json` 的 `appendFailures`,不再静默;
 *  - 检查点 `flush` 之后盘上就是全的(队列排空 + fsync);
 *  - G12:别的写者动过这份文件,下一次 append 不会踩它的 seq。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectLogRecordsForTests } from '../../wiring/logging/index.js'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '' }))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

const {
  appendSessionLogEvent,
  flushSessionEventLog,
  getSessionEventsLogPath,
  readSessionLogEvents,
  resetSessionEventLogCache,
} = await import('../event-log.js')
const {
  flushSessionEventStats,
  getSessionShadowStatsPath,
  readSessionShadowStats,
  resetSessionEventStatsCache,
} = await import('../event-stats.js')
const {
  getSessionBlobPath,
  listSessionBlobs,
  putSessionBlob,
  readSessionBlobText,
  textOrBlobForEvent,
} = await import('../blob-store.js')

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-s1-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(state.sessionsDir, { recursive: true })
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeJsonlSession(sessionId: string): void {
  const dir = path.join(state.sessionsDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}')
}

describe('event-log discipline flip (§10.3)', () => {
  it('creates the session directory for session/created and only for it', async () => {
    // 目录还不存在:`session/created` 自己把它立起来,并成为第一条事件。
    expect(fs.existsSync(path.join(state.sessionsDir, 'fresh'))).toBe(false)
    expect(appendSessionLogEvent('fresh', 'session/created', { sessionId: 'fresh' })).toBe(1)
    await flushSessionEventLog('fresh')

    const events = await readSessionLogEvents('fresh')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('session/created')

    // 别的类型仍然一个目录都不建 —— legacy 整文件会话被误判成空 jsonl 会话
    // 就是整份历史当场消失(B4)。
    expect(appendSessionLogEvent('legacy', 'request/end', { requestIndex: 1 })).toBeUndefined()
    expect(fs.existsSync(path.join(state.sessionsDir, 'legacy'))).toBe(false)
  })

  it('counts an append failure into session-shadow-stats.json instead of swallowing it', async () => {
    makeJsonlSession('s1')
    const logs = collectLogRecordsForTests()
    vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(new Error('ENOSPC'))

    appendSessionLogEvent('s1', 'request/end', { requestIndex: 1 })
    appendSessionLogEvent('s1', 'request/end', { requestIndex: 2 })
    await flushSessionEventLog('s1')
    flushSessionEventStats()

    expect(readSessionShadowStats().appendFailures).toBe(2)
    // 每会话只 warn 一次:一个坏掉的会话会在一个回合里失败几百次。
    expect(logs.records.filter(record => record.fields?.what === 'event log write failed'))
      .toHaveLength(1)
    logs.stop()
    expect(JSON.parse(fs.readFileSync(getSessionShadowStatsPath(), 'utf8')).appendFailures).toBe(2)
  })

  it('has everything on disk after a checkpoint flush', async () => {
    makeJsonlSession('s2')
    for (let index = 1; index <= 20; index++) {
      appendSessionLogEvent('s2', 'request/end', { requestIndex: index })
    }
    await flushSessionEventLog('s2')

    const text = fs.readFileSync(getSessionEventsLogPath('s2'), 'utf8')
    expect(text.trimEnd().split('\n')).toHaveLength(20)
  })

  it('G12: reloads counters instead of overwriting another writer\'s seqs', async () => {
    makeJsonlSession('s3')
    appendSessionLogEvent('s3', 'request/end', { requestIndex: 1 })
    await flushSessionEventLog('s3')

    // 第二个写者(另一个进程)直接往文件里追了三条。
    const foreign = [2, 3, 4]
      .map(seq => `${JSON.stringify({ seq, time: Date.now(), type: 'request/end', data: { requestIndex: seq } })}\n`)
      .join('')
    fs.appendFileSync(getSessionEventsLogPath('s3'), foreign)

    const logs = collectLogRecordsForTests()
    // 守卫有 500ms 的检查间隔:把表往前拨,让下一次 append 真的去 stat。
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
    const seq = appendSessionLogEvent('s3', 'request/end', { requestIndex: 9 })
    vi.mocked(Date.now).mockRestore()
    await flushSessionEventLog('s3')

    // 接着别人的 4 往下数,而不是把 2 再写一遍(重复 seq 会让 surfaceOp 的
    // 区间遮蔽静默错乱)。
    expect(seq).toBe(5)
    expect(logs.messages().some(msg => msg.includes('another writer'))).toBe(true)
    logs.stop()
    const events = await readSessionLogEvents('s3')
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('blob store (§10.6 第 6 条)', () => {
  it('is content-addressed and write-once', () => {
    makeJsonlSession('b1')
    const first = putSessionBlob('b1', 'hello blob', 'text/plain')
    const second = putSessionBlob('b1', 'hello blob', 'text/plain')
    expect(first).toEqual(second)
    expect(first?.bytes).toBe(10)
    expect(first?.mime).toBe('text/plain')
    expect(listSessionBlobs('b1')).toEqual([first!.hash])
    expect(readSessionBlobText('b1', first!.hash)).toBe('hello blob')

    // 写一次:第二次不该再碰文件。
    const before = fs.statSync(getSessionBlobPath('b1', first!.hash)).mtimeMs
    putSessionBlob('b1', 'hello blob')
    expect(fs.statSync(getSessionBlobPath('b1', first!.hash)).mtimeMs).toBe(before)
  })

  it('keeps small text in the event line and spills large text to a blob', () => {
    makeJsonlSession('b2')
    expect(textOrBlobForEvent('b2', 'small')).toEqual({ text: 'small' })

    const big = 'z'.repeat(70 * 1024)
    const spilled = textOrBlobForEvent('b2', big)
    expect('blob' in spilled).toBe(true)
    if ('blob' in spilled) {
      expect(readSessionBlobText('b2', spilled.blob.hash)).toBe(big)
    }
  })

  it('degrades to undefined and counts the failure when the write fails', () => {
    makeJsonlSession('b3')
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('EACCES')
    })
    expect(putSessionBlob('b3', 'nope')).toBeUndefined()
    flushSessionEventStats()
    expect(readSessionShadowStats().appendFailures).toBe(1)
  })

  it('goes away with the session directory', () => {
    makeJsonlSession('b4')
    const ref = putSessionBlob('b4', 'bye')
    expect(ref).toBeDefined()
    // 会话删除 = `rmSync(sessionDir, {recursive:true})`(storage-driver 的 delete)。
    fs.rmSync(path.join(state.sessionsDir, 'b4'), { recursive: true, force: true })
    expect(readSessionBlobText('b4', ref!.hash)).toBeUndefined()
  })
})
