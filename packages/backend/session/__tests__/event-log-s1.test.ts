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
import { installSessionLayerForTest } from '../testing/session-layer.js'

let sessionFixture: ReturnType<typeof installSessionLayerForTest>
let previousStorePath: string | undefined
let expectedPersistenceFailure = false

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '' }))

vi.mock('@onething/runtime/storage', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/runtime/storage')>(),
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

const { flushSessionEventLog, getSessionEventsLogPath, readSessionLogEvents, resetSessionEventLogCache } = await import('../event-log.js')
const { writeSessionEvent } = await import('../event-writer.js')
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
  readSessionBlob,
  readSessionBlobBase64,
  readSessionBlobText,
  textOrBlobForEvent,
} = await import('../blob-store.js')
const { sessionProjectionOptions } = await import('../projection-blobs.js')
const { projectChatMessages } = await import('@onething/core/session')

beforeEach(() => {
  expectedPersistenceFailure = false
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-s1-'))
  previousStorePath = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = state.storeDir
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(state.sessionsDir, { recursive: true })
  sessionFixture = installSessionLayerForTest()
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
})

afterEach(async () => {
  await sessionFixture.dispose().catch(error => {
    if (!expectedPersistenceFailure) throw error
    expect(error).toMatchObject({ name: 'SessionEventWriteError' })
  })
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
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
    expect(writeSessionEvent('fresh', 'session/created', { sessionId: 'fresh' })).toBe(1)
    await flushSessionEventLog('fresh')

    const events = await readSessionLogEvents('fresh')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('session/created')

    // 别的类型仍然一个目录都不建 —— legacy 整文件会话被误判成空 jsonl 会话
    // 就是整份历史当场消失(B4)。
    expect(writeSessionEvent('legacy', 'request/end', { requestIndex: 1 })).toBeUndefined()
    expect(fs.existsSync(path.join(state.sessionsDir, 'legacy'))).toBe(false)
  })

  it('counts an append failure into session-shadow-stats.json instead of swallowing it', async () => {
    makeJsonlSession('s1')
    const logs = collectLogRecordsForTests()
    vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(new Error('ENOSPC'))

    writeSessionEvent('s1', 'request/end', { requestIndex: 1 })
    writeSessionEvent('s1', 'request/end', { requestIndex: 2 })
    await expect(flushSessionEventLog('s1')).rejects.toThrow('session event log write failed')
    flushSessionEventStats()

    // The first failed append stops the queue; later accepted events are never attempted.
    expect(readSessionShadowStats().appendFailures).toBe(1)
    // 每会话只 warn 一次:一个坏掉的会话会在一个回合里失败几百次。
    expect(logs.records.filter(record => record.fields?.what === 'event log append failed'))
      .toHaveLength(1)
    logs.stop()
    expect(JSON.parse(fs.readFileSync(getSessionShadowStatsPath(), 'utf8')).appendFailures).toBe(1)
    resetSessionEventLogCache('s1')
  })

  it('has everything on disk after a checkpoint flush', async () => {
    makeJsonlSession('s2')
    for (let index = 1; index <= 20; index++) {
      writeSessionEvent('s2', 'request/end', { requestIndex: index })
    }
    await flushSessionEventLog('s2')

    const text = fs.readFileSync(getSessionEventsLogPath('s2'), 'utf8')
    expect(text.trimEnd().split('\n')).toHaveLength(20)
  })

  /**
   * S3w-0b(§14.6 裁定 3):**第二个写者写进来之后,这个进程再也写不进去。**
   *
   * 从前的行为是"重装计数器接着写"(接到别人的 4 后面写 5)。那会让两个进程
   * 交错着往同一份账本上写,而 `surfaceOp: replace` 的区间引用的是 seq ——
   * 遮蔽从此指向对方的事件,校验还照样放行。事件成为唯一真相之前必须换成拒写。
   */
  it('G12: refuses the append once another writer touched the log', async () => {
    makeJsonlSession('s3')
    writeSessionEvent('s3', 'request/end', { requestIndex: 1 })
    await flushSessionEventLog('s3')

    // 第二个写者(另一个进程)直接往文件里追了三条。
    const foreign = [2, 3, 4]
      .map(seq => `${JSON.stringify({ seq, time: Date.now(), type: 'request/end', data: { requestIndex: seq } })}\n`)
      .join('')
    fs.appendFileSync(getSessionEventsLogPath('s3'), foreign)

    const logs = collectLogRecordsForTests()
    // 守卫有 500ms 的检查间隔:把表往前拨,让下一次 append 真的去 stat。
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
    // 批 6b(裁定 7)起拒写**上抛**:唯一账本写不进去不再是可吞的旁路故障。
    // 拒写仍是**一路拒到底**的:守卫认定之后不再 stat,后续 append 同样写不进去。
    expect(() => writeSessionEvent('s3', 'request/end', { requestIndex: 9 }))
      .toThrow('session event log write failed')
    expect(() => writeSessionEvent('s3', 'request/end', { requestIndex: 10 }))
      .toThrow('session event log write failed')
    vi.mocked(Date.now).mockRestore()
    await flushSessionEventLog('s3')

    expect(logs.messages().some(msg => msg.includes('refusing to append'))).toBe(true)
    logs.stop()

    // 盘上只有第二个写者那四条:我们一个字节都没有接上去。
    const events = await readSessionLogEvents('s3')
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4])

    // 每一次拒写都是一笔"这条事件永远补不回来了" —— 进 appendFailures,门看得见。
    flushSessionEventStats()
    expect(readSessionShadowStats().appendFailures).toBe(2)
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

  it('raises and counts the failure when the write fails (批 6b 起不再降级)', () => {
    expectedPersistenceFailure = true
    makeJsonlSession('b3')
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('EACCES')
    })
    // 从前返回 undefined(正文还在抄本里);抄本没了之后同一次失败 = 正文永久
    // 丢失(§14.7 风险④),所以按裁定 7 上抛。计数照旧。
    expect(() => putSessionBlob('b3', 'nope')).toThrow('session event log write failed')
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

/**
 * #3(§13.13):图片 blob 二进制往返 + sha256 读时自校验。
 *
 * 病根:附件图片以**原始字节**落 blob(`Buffer.from(base64,'base64')`,正确),
 * 但读侧一律 `utf8` —— 二进制被改写成 `�`。修法:投影读口按 mime 分流,image/*
 * 走 base64;文本仍 utf8。老盘上的字节本来就是对的(只有读错),修读即恢复。
 */
describe('#3(§13.13):图片 blob 二进制往返', () => {
  // PNG 魔术字节(‰PNG␍␊␚␊)+ 一段确定的二进制,足以暴露 utf8 改写。
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(Array.from({ length: 3000 }, (_, index) => index % 256)),
  ])
  const base64 = png.toString('base64')

  it('an attachment image round-trips through the projection as byte-identical base64', () => {
    makeJsonlSession('img1')
    const ref = putSessionBlob('img1', png, 'image/png')
    expect(ref?.mime).toBe('image/png')

    const events = [{
      seq: 1, time: 1, type: 'user/message',
      data: { message: { id: 'u1', role: 'user', content: 'see', timestamp: 1, attachments: [{ id: 'a', fileName: 'x.png', mimeType: 'image/png', base64Data: ref }] } },
      surfaceOp: 'append',
    }]
    const projected = projectChatMessages(events as never, sessionProjectionOptions('img1')).messages
    const attachment = (projected[0] as unknown as { attachments: Array<{ base64Data: string }> }).attachments[0]
    expect(attachment.base64Data).toBe(base64)
    expect(Buffer.from(attachment.base64Data, 'base64')).toEqual(png)

    // 反证(改回 utf8 读法):二进制被改写成 `�PNG…`,与 base64 不同 —— 就是修前的
    // 那道腐蚀签名。
    const utf8 = readSessionBlobText('img1', ref!.hash)!
    expect(utf8.startsWith('�PNG')).toBe(true)
    expect(utf8).not.toBe(base64)
  })

  it('readSessionBlobBase64 equals the source base64', () => {
    makeJsonlSession('img2')
    const ref = putSessionBlob('img2', png, 'image/png')!
    expect(readSessionBlobBase64('img2', ref.hash)).toBe(base64)
  })

  it('a text blob still resolves as utf8, not base64', () => {
    makeJsonlSession('txt1')
    const big = 'hello 世界 '.repeat(50)
    const ref = putSessionBlob('txt1', big, 'text/plain')!
    expect(sessionProjectionOptions('txt1').resolveBlob!(ref)).toBe(big)
  })

  it('sha256 self-check: a tampered blob reads as undefined', () => {
    makeJsonlSession('corrupt1')
    const ref = putSessionBlob('corrupt1', png, 'image/png')!
    // 覆盖成别的字节 —— 文件名(hash)不再等于内容 sha256。
    fs.writeFileSync(getSessionBlobPath('corrupt1', ref.hash), Buffer.from('tampered bytes'))
    expect(readSessionBlob('corrupt1', ref.hash)).toBeUndefined()
    expect(readSessionBlobBase64('corrupt1', ref.hash)).toBeUndefined()
    // 投影读口因此退化(F6 会记 blob-missing),不把脏字节投出去。
    expect(sessionProjectionOptions('corrupt1').resolveBlob!(ref)).toBeUndefined()
  })
})
