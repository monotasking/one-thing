/**
 * 事件日志写入器(主线 E0)。
 *
 * 守三件事:落盘顺序恒等于调用顺序、seq/requestIndex 跨重启接着数、legacy 整
 * 文件会话不被凭空建目录。第三条不是洁癖 —— storage-driver 的 `jsonlExists()`
 * 认的就是 `sessions/<id>/` 里有没有文件,凭空建目录会让它把一个还没迁移的
 * legacy 会话当成空的 jsonl 会话,整份历史当场消失。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectLogRecordsForTests } from '../../logging/index.js'

const state = vi.hoisted(() => ({ sessionsDir: '' }))

vi.mock('../../stores/paths.js', () => ({
  getSessionsDir: () => state.sessionsDir,
}))

const {
  appendSessionEvent,
  findLastSessionEventSync,
  flushSessionEventLog,
  getSessionEventsLogPath,
  nextSessionRequestIndex,
  readSessionEvents,
  resetSessionEventLogCache,
} = await import('../event-log.js')

beforeEach(() => {
  state.sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-events-'))
  resetSessionEventLogCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  fs.rmSync(state.sessionsDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeJsonlSession(sessionId: string): void {
  const dir = path.join(state.sessionsDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}')
}

describe('appendSessionEvent', () => {
  it('keeps file order equal to call order and hands back the seq', async () => {
    makeJsonlSession('s1')

    const seqs = [
      appendSessionEvent('s1', 'request/start', { requestIndex: 1, messageId: 'm1' }),
      appendSessionEvent('s1', 'tool/call', {
        callId: 'c1',
        name: 'read',
        argumentsRaw: '{"path":"a"}',
        messageId: 'm1',
      }),
      appendSessionEvent('s1', 'tool/result', { callId: 'c1', isError: false, resultPreview: 'ok', sourceSeq: 2 }),
      appendSessionEvent('s1', 'request/end', { requestIndex: 1, stopReason: 'stop' }),
    ]
    expect(seqs).toEqual([1, 2, 3, 4])

    await flushSessionEventLog('s1')
    const records = await readSessionEvents('s1')
    expect(records.map(r => [r.seq, r.type])).toEqual([
      [1, 'request/start'],
      [2, 'tool/call'],
      [3, 'tool/result'],
      [4, 'request/end'],
    ])
    expect(records.every(r => typeof r.time === 'number')).toBe(true)
  })

  it('never rewrites: a second run appends after the first', async () => {
    makeJsonlSession('s2')
    appendSessionEvent('s2', 'request/start', { requestIndex: 1, messageId: 'm1' })
    await flushSessionEventLog('s2')

    // 模拟重启:进程内缓存清空,计数器只能从文件恢复。
    resetSessionEventLogCache()
    expect(nextSessionRequestIndex('s2')).toBe(2)
    expect(appendSessionEvent('s2', 'request/start', { requestIndex: 2, messageId: 'm2' })).toBe(2)
    await flushSessionEventLog('s2')

    const records = await readSessionEvents('s2')
    expect(records.map(r => r.seq)).toEqual([1, 2])
    expect(records.map(r => (r.type === 'request/start' ? r.data.requestIndex : undefined))).toEqual([1, 2])
  })

  it('tolerates a crash-truncated tail line on read and appends past it', async () => {
    makeJsonlSession('s3')
    appendSessionEvent('s3', 'request/start', { requestIndex: 1, messageId: 'm1' })
    await flushSessionEventLog('s3')
    fs.appendFileSync(getSessionEventsLogPath('s3'), '{"seq":2,"time":1,"type":"tool/ca')

    resetSessionEventLogCache()
    expect(await readSessionEvents('s3')).toHaveLength(1)
    // 半行里的 seq 也参与恢复:下一条不会去占已经写出去的号。
    expect(appendSessionEvent('s3', 'request/end', { requestIndex: 1 })).toBe(3)
  })

  it('skips a legacy whole-file session and creates no directory for it', async () => {
    fs.writeFileSync(path.join(state.sessionsDir, 'legacy.json'), '{"id":"legacy","messages":[]}')

    expect(appendSessionEvent('legacy', 'request/start', { requestIndex: 1, messageId: 'm' })).toBeUndefined()
    expect(nextSessionRequestIndex('legacy')).toBeUndefined()
    await flushSessionEventLog()

    expect(fs.existsSync(path.join(state.sessionsDir, 'legacy'))).toBe(false)
    expect(await readSessionEvents('legacy')).toEqual([])
  })

  it('never punches a directory into the store for a session that does not exist', async () => {
    expect(appendSessionEvent('ghost', 'request/start', { requestIndex: 1, messageId: 'm' })).toBeUndefined()
    expect(nextSessionRequestIndex('ghost')).toBeUndefined()
    await flushSessionEventLog()

    expect(fs.existsSync(path.join(state.sessionsDir, 'ghost'))).toBe(false)
    expect(fs.readdirSync(state.sessionsDir)).toEqual([])
  })

  it('starts recording as soon as the session directory appears (no restart needed)', async () => {
    // 创建即发言的程序化会话:第一次 append 时 meta.json 还在 300ms 节流窗里。
    expect(appendSessionEvent('late', 'request/start', { requestIndex: 1, messageId: 'm1' })).toBeUndefined()
    expect(nextSessionRequestIndex('late')).toBeUndefined()

    // 会话存储追上,目录出现 —— 同一进程内的下一次 append 必须自动接上。
    makeJsonlSession('late')
    expect(nextSessionRequestIndex('late')).toBe(1)
    expect(appendSessionEvent('late', 'request/start', { requestIndex: 1, messageId: 'm2' })).toBe(1)
    await flushSessionEventLog('late')

    const records = await readSessionEvents('late')
    expect(records.map(r => [r.seq, r.type])).toEqual([[1, 'request/start']])
  })

  it('swallows write failures instead of breaking the caller', async () => {
    makeJsonlSession('s4')
    const logs = collectLogRecordsForTests()
    vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(new Error('disk on fire'))

    expect(() => appendSessionEvent('s4', 'request/end', { requestIndex: 1 })).not.toThrow()
    await flushSessionEventLog('s4')
    expect(logs.records.filter(record => record.level === 'warn')).toHaveLength(1)
    logs.stop()
  })
})

describe('findLastSessionEventSync', () => {
  it('reads the last record of a type straight off disk', async () => {
    makeJsonlSession('s5')
    appendSessionEvent('s5', 'request/tools', {
      requestIndex: 1,
      toolsHash: 'catalog-one',
      tools: [{ name: 'read' }],
    })
    appendSessionEvent('s5', 'request/header', {
      requestIndex: 1,
      provider: 'deepseek',
      model: 'a',
      systemPromptHash: 'one',
      toolsHash: 'catalog-one',
      reason: 'initial',
    })
    appendSessionEvent('s5', 'request/header', {
      requestIndex: 2,
      provider: 'deepseek',
      model: 'b',
      systemPromptHash: 'two',
      toolsHash: 'catalog-one',
      reason: 'change',
    })
    await flushSessionEventLog('s5')

    expect(findLastSessionEventSync('s5', 'request/header')?.data.model).toBe('b')
    // 目录事件是另一条流:header 写了两条也不影响它的"最后一条"。
    expect(findLastSessionEventSync('s5', 'request/tools')?.data.toolsHash).toBe('catalog-one')
    expect(findLastSessionEventSync('missing', 'request/header')).toBeUndefined()
  })
})
