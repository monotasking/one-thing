/**
 * 事件账本**写失败上抛** + refold 自洽环
 * (`docs/design/session-event-sourcing-2026-08.md` §14.3 / §14.6 裁定 7 / §15.11 /
 * §15.22)。
 *
 * 从前这个文件还兼管抄本三态开关(`ONETHING_SESSION_TRANSCRIPT`),连同"同一刀
 * 注下去,`shadow` 只计数、`off` 抛"的对照用例。**S3w-3 批 6b 把那个开关连同抄本
 * 写代码一起退役了**,于是:
 *  - 开关那一组用例整组删除(没有开关可问);
 *  - 上抛那四条从"对照"变成"直断":同一刀注下去,**无条件**抛
 *    `SessionEventWriteError` —— `events.jsonl` 是唯一账本,写不进去必须让调用方
 *    感知得到。文件因此改名 `transcript-off` → `event-write-failure`。
 *  - refold 那一组一字未动(它问的是"文件字节 vs 内存活投影",与抄本无关)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// refold 经 `shadow.ts` 拽进读面,而读面会把整只 app store 拉起来(设置仓库、
// 会话仓库…)。这一套用例问的是"文件字节 vs 内存活投影",与抄本无关 ——
// 与 `shadow.test.ts` 同款,把读面替换成一只空壳。
vi.mock('../reads.js', async importOriginal => ({
  ...await importOriginal<typeof import('../reads.js')>(),
  sessionReads: {
    listMessagesFromStore: () => [],
    getMessage: () => undefined,
    getSession: () => undefined,
  },
}))

const { flushSessionEventLog, getSessionEventsLogPath, resetSessionEventLogCache, SessionEventWriteError } = await import('../event-log.js')
const { writeSessionEvent } = await import('../event-writer.js')
const { putSessionBlob } = await import('../blob-store.js')
const {
  flushSessionEventStats,
  readSessionShadowStats,
  resetSessionEventStatsCache,
} = await import('../event-stats.js')
const { checkSessionRefold, resetSessionRefoldSampling, scheduleSessionRefold } = await import('../refold.js')
const { getSessionShadowLogPath } = await import('../shadow.js')
const { resetSessionProjectionCache, getLiveSessionProjection } = await import('../projection-cache.js')

beforeEach(() => {
  expectedPersistenceFailure = false
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-s3w2-'))
  previousStorePath = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = state.storeDir
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(state.sessionsDir, { recursive: true })
  sessionFixture = installSessionLayerForTest()
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
  resetSessionProjectionCache()
  resetSessionRefoldSampling()
})

afterEach(async () => {
  await sessionFixture.dispose().catch(error => {
    if (!expectedPersistenceFailure) throw error
    expect(error).toMatchObject({ name: 'SessionEventWriteError' })
  })
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  delete process.env.ONETHING_SESSION_REFOLD
  delete process.env.ONETHING_SESSION_REFOLD_EVERY
  fs.rmSync(state.storeDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeJsonlSession(sessionId: string): void {
  const dir = path.join(state.sessionsDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}')
}

function userMessage(sessionId: string, id: string): void {
  writeSessionEvent(sessionId, 'user/message', {
    message: { id, role: 'user', content: `hello ${id}`, timestamp: 1 },
  })
}

// ============ 写失败上抛(裁定 7) ============

describe('write failure escalation (§14.6 裁定 7;批 6b 起无条件)', () => {
  it('a queued append failure sticks and the next write raises it', async () => {
    makeJsonlSession('w1')
    userMessage('w1', 'm1')
    await flushSessionEventLog('w1')

    // 注入:账本从这一刻起写不进去(与 battery 探针同一刀,只是这里直接换实现)。
    const appendFile = vi.spyOn(fs.promises, 'appendFile')
      .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))

    // 第一刀还拿得到 seq —— append 是排队异步落盘的,失败天生晚于调用它的那一句。
    expect(writeSessionEvent('w1', 'user/message', {
      message: { id: 'm2', role: 'user', content: 'x' },
    })).toBeDefined()
    await expect(flushSessionEventLog('w1')).rejects.toThrow(SessionEventWriteError)
    flushSessionEventStats()
    expect(readSessionShadowStats().appendFailures).toBeGreaterThan(0)

    // 失败粘住了:下一次写口就是一次可见的命令失败。
    expect(() => writeSessionEvent('w1', 'user/message', {
      message: { id: 'm3', role: 'user', content: 'x' },
    })).toThrow(SessionEventWriteError)

    appendFile.mockRestore()
    resetSessionEventLogCache('w1')
  })

  it('a G12 refusal is a throw, not a silent undefined', async () => {
    makeJsonlSession('w2')
    writeSessionEvent('w2', 'request/end', { requestIndex: 1 })
    await flushSessionEventLog('w2')

    // 第二个写者直接往文件里追了一条。
    fs.appendFileSync(
      getSessionEventsLogPath('w2'),
      `${JSON.stringify({ seq: 2, time: Date.now(), type: 'request/end', data: { requestIndex: 2 } })}\n`,
    )
    // 守卫有 500ms 检查间隔:把表往前拨,让下一次 append 真的去 stat。
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)

    expect(() => writeSessionEvent('w2', 'request/end', { requestIndex: 9 }))
      .toThrow(SessionEventWriteError)
  })

  it('the translator lets a write failure out (everything else it still swallows)', async () => {
    const { sessionCommandEvents } = await import('../command-events.js')
    const message = (id: string) =>
      ({ id, role: 'user', content: `x-${id}`, timestamp: 1 } as unknown as Parameters<
        typeof sessionCommandEvents.appendMessage
      >[1])

    makeJsonlSession('w4')
    sessionCommandEvents.appendMessage('w4', message('m1'))
    await flushSessionEventLog('w4')

    const appendFile = vi.spyOn(fs.promises, 'appendFile')
      .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    sessionCommandEvents.appendMessage('w4', message('m2'))
    await expect(flushSessionEventLog('w4')).rejects.toThrow(SessionEventWriteError)

    // 同一条错误穿过 `safely` 上抛 —— 命令面于是报得出来。
    expect(() => sessionCommandEvents.appendMessage('w4', message('m3')))
      .toThrow(SessionEventWriteError)

    appendFile.mockRestore()
    resetSessionEventLogCache('w4')
  })

  it('a blob write failure raises instead of degrading to undefined', () => {
    expectedPersistenceFailure = true
    makeJsonlSession('w3')
    const writeFile = vi.spyOn(fs, 'writeFileSync')
      .mockImplementation(() => { throw new Error('ENOSPC') })

    // 从前这里返回 undefined,调用方退回"正文进事件行";抄本没了之后同一次失败
    // 就是正文永久丢失(§14.7 风险④),所以不再可吞。
    expect(() => putSessionBlob('w3', 'body')).toThrow(SessionEventWriteError)

    writeFile.mockRestore()
  })
})

// ============ refold 自洽环(§14.3-B) ============

describe('refold self-consistency loop (§14.3-B)', () => {
  async function seedProjection(sessionId: string): Promise<void> {
    makeJsonlSession(sessionId)
    writeSessionEvent(sessionId, 'session/created', { sessionId })
    userMessage(sessionId, 'm1')
    userMessage(sessionId, 'm2')
    await flushSessionEventLog(sessionId)
    // 活投影建起来(此刻两侧同源同形)。
    getLiveSessionProjection(sessionId)
  }

  it('matches when the file and the live projection agree, and writes nothing', async () => {
    await seedProjection('r1')
    await expect(checkSessionRefold('r1')).resolves.toBe('match')
    flushSessionEventStats()
    const stats = readSessionShadowStats()
    expect(stats.refoldChecks).toBe(1)
    expect(stats.refoldMismatches).toBe(0)
    // 相等时一行都不写 —— 否则这道门只是在打印日志。
    expect(fs.existsSync(getSessionShadowLogPath())).toBe(false)
  })

  it('catches a line that silently vanished from the file', async () => {
    await seedProjection('r2')
    // 一条 append 静默丢了(§13.16 的反方向):文件少一行,末条 seq 不变,
    // 于是游标仍然对得齐 —— 只有重折才看得出来。
    const logPath = getSessionEventsLogPath('r2')
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    fs.writeFileSync(logPath, `${[lines[0], lines[2]].join('\n')}\n`)

    await expect(checkSessionRefold('r2')).resolves.toBe('mismatch')
    flushSessionEventStats()
    const stats = readSessionShadowStats()
    expect(stats.refoldMismatches).toBe(1)
    // 它记的是**自己那本账**:语义层的 `mismatches` 一动不动(两道门问的
    // 不是同一件事)。
    expect(stats.mismatches).toBe(0)

    const line = JSON.parse(fs.readFileSync(getSessionShadowLogPath(), 'utf8').trim())
    expect(line.kind).toBe('refold')
    expect(line.sessionId).toBe('r2')
    expect(line.diff.length).toBeGreaterThan(0)
  })

  it('skips instead of crying wolf when the cursor moved between flush and read', async () => {
    await seedProjection('r3')
    // 另一个写者在采样与读文件之间又追了一条:文件比活投影长。此刻比出来的
    // "多了一段"说明的是采样撞上了写,不是账本坏了。
    fs.appendFileSync(
      getSessionEventsLogPath('r3'),
      `${JSON.stringify({ seq: 99, time: Date.now(), type: 'user/message', data: { message: { id: 'm9', role: 'user', content: 'x' } } })}\n`,
    )
    await expect(checkSessionRefold('r3')).resolves.toBe('skipped')
    flushSessionEventStats()
    expect(readSessionShadowStats().refoldChecks).toBe(0)
  })

  /**
   * 回归:批 4 第一版把活投影这一侧的物化排在 `await readFile` **之后**,而活投影
   * 是全进程共用、就地推进的 —— await 期间任何一个消费者(读路径 / 影子 / 下一次
   * 采样)把新事件折进去,回来物化到的就是一份"比游标多一段"的投影,于是报假红。
   * battery 上 4 跑 1 红,就是这一条。
   */
  it('does not cry wolf when the live projection is advanced during the file read', async () => {
    await seedProjection('r6')
    const realRead = fs.promises.readFile.bind(fs.promises)
    const read = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (...args: unknown[]) => {
      // 别人在这一刻推进了活投影(就地改的正是我们手里那份 state)。
      userMessage('r6', 'm-late')
      getLiveSessionProjection('r6')
      return realRead(...(args as Parameters<typeof realRead>))
    }) as unknown as typeof fs.promises.readFile)

    // 'match'(文件还没追上那条新事件)或 'skipped'(追上了 → 游标对不齐)都对;
    // **'mismatch' 就是那个 bug**。
    await expect(checkSessionRefold('r6')).resolves.not.toBe('mismatch')
    read.mockRestore()
  })

  it('samples the first run and then every N-th (ONETHING_SESSION_REFOLD_EVERY)', async () => {
    await seedProjection('r4')
    process.env.ONETHING_SESSION_REFOLD_EVERY = '3'
    const sampled: number[] = []
    const timers = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      sampled.push(1)
      void fn
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout)
    for (let index = 0; index < 7; index++) scheduleSessionRefold('r4', `run-${index}`)
    timers.mockRestore()
    // 第 1、4、7 个 run —— 首个必采,之后每 3 个一次。
    expect(sampled.length).toBe(3)
  })

  it('is switchable off (ONETHING_SESSION_REFOLD=0)', async () => {
    await seedProjection('r5')
    process.env.ONETHING_SESSION_REFOLD = '0'
    await expect(checkSessionRefold('r5')).resolves.toBe('skipped')
    flushSessionEventStats()
    expect(readSessionShadowStats().refoldChecks).toBe(0)
  })
})
