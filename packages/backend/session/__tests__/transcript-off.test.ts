/**
 * S3w-2:抄本三态开关 + 写失败上抛 + refold 自洽环
 * (`docs/design/session-event-sourcing-2026-08.md` §14.3 / §14.6 裁定 5–7 / §15.11)。
 *
 * 每一条都按**可观察的后果**写,而且都验过"反向":
 *  - 三态开关:**默认 `off`**(批 6a 翻,§15.19),三个值都显式认,拼错回默认;
 *    `shadow` / `primary` 现在是显式回滚杆,所以每一处要它的用例都显式扳过去;
 *  - 写失败上抛在 `off` 生效 = **默认行为** —— 同一刀注下去,`shadow` 只计数、`off` 抛;
 *  - refold:文件字节与内存活投影不等时记 `kind:'refold'` 并计 `refoldMismatches`;
 *    相等时一行不写(否则这道门只是在打印日志)。
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

// refold 经 `shadow.ts` 拽进读面,而读面会把整只 app store 拉起来(设置仓库、
// 会话仓库…)。这一套用例问的是"文件字节 vs 内存活投影",与抄本无关 ——
// 与 `shadow.test.ts` 同款,把读面替换成一只空壳。
vi.mock('../reads.js', () => ({
  sessionReads: {
    listMessagesFromTranscript: () => [],
    getMessage: () => undefined,
    getSession: () => undefined,
  },
}))

const {
  appendSessionLogEvent,
  flushSessionEventLog,
  getSessionEventsLogPath,
  resetSessionEventLogCache,
  SessionEventWriteError,
} = await import('../event-log.js')
const { putSessionBlob } = await import('../blob-store.js')
const {
  flushSessionEventStats,
  readSessionShadowStats,
  resetSessionEventStatsCache,
} = await import('../event-stats.js')
const {
  DEFAULT_SESSION_TRANSCRIPT_MODE,
  getSessionTranscriptMode,
  isSessionTranscriptOff,
  setSessionTranscriptModeForTesting,
} = await import('../read-mode.js')
const { checkSessionRefold, resetSessionRefoldSampling, scheduleSessionRefold } = await import('../refold.js')
const { getSessionShadowLogPath } = await import('../shadow.js')
const { resetSessionProjectionCache, getLiveSessionProjection } = await import('../projection-cache.js')

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-s3w2-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(state.sessionsDir, { recursive: true })
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
  resetSessionProjectionCache()
  resetSessionRefoldSampling()
  setSessionTranscriptModeForTesting(undefined)
  delete process.env.ONETHING_SESSION_TRANSCRIPT
})

afterEach(async () => {
  await flushSessionEventLog()
  setSessionTranscriptModeForTesting(undefined)
  delete process.env.ONETHING_SESSION_TRANSCRIPT
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
  appendSessionLogEvent(sessionId, 'user/message', {
    message: { id, role: 'user', content: `hello ${id}`, timestamp: 1 },
  })
}

// ============ 三态开关(裁定 5) ============

describe('ONETHING_SESSION_TRANSCRIPT (§14.6 裁定 5;批 6a 翻默认 §15.19)', () => {
  // 钉的是**常量**,不是"什么都不设时读到什么"(批 3 判例,§15.10):后者要去读
  // 进程环境变量,于是谁在 shell 里扳过回滚杆这条就红,而那是开关在正常工作、
  // 不是默认值改了。两档回滚杆各自的行为由下面显式设档的用例担着。
  it('defaults to off — the transcript is no longer written', () => {
    expect(DEFAULT_SESSION_TRANSCRIPT_MODE).toBe('off')
    setSessionTranscriptModeForTesting(DEFAULT_SESSION_TRANSCRIPT_MODE)
    expect(getSessionTranscriptMode()).toBe('off')
    expect(isSessionTranscriptOff()).toBe(true)
    setSessionTranscriptModeForTesting(undefined)
  })

  it('reads all three values explicitly; a typo falls back to the default', () => {
    for (const mode of ['primary', 'shadow', 'off'] as const) {
      process.env.ONETHING_SESSION_TRANSCRIPT = mode
      expect(getSessionTranscriptMode()).toBe(mode)
    }
    // 拼错 = 默认。默认翻到 `off` 之后,`shadow` / `primary` 是那两根必须被显式
    // 认出来的**回滚杆**,谁也不该被"非 off 即默认"吞掉;而一个不认识的值只能
    // 回到默认那一档。
    process.env.ONETHING_SESSION_TRANSCRIPT = 'shadoww'
    expect(getSessionTranscriptMode()).toBe(DEFAULT_SESSION_TRANSCRIPT_MODE)
  })

  it('shadow is the rollback lever: the transcript comes back and writes stop escalating', () => {
    process.env.ONETHING_SESSION_TRANSCRIPT = 'shadow'
    expect(getSessionTranscriptMode()).toBe('shadow')
    expect(isSessionTranscriptOff()).toBe(false)
    process.env.ONETHING_SESSION_TRANSCRIPT = 'primary'
    expect(getSessionTranscriptMode()).toBe('primary')
    expect(isSessionTranscriptOff()).toBe(false)
  })

  it('the testing override wins over the environment and gives it back', () => {
    process.env.ONETHING_SESSION_TRANSCRIPT = 'primary'
    setSessionTranscriptModeForTesting('off')
    expect(isSessionTranscriptOff()).toBe(true)
    setSessionTranscriptModeForTesting(undefined)
    expect(getSessionTranscriptMode()).toBe('primary')
  })
})

// ============ 写失败上抛(裁定 7) ============

describe('write failure escalation (§14.6 裁定 7)', () => {
  it('shadow counts a queued append failure; off raises it on the next write', async () => {
    // 批 6a 之后 `off` 是默认,所以 `shadow` 那一半要**显式扳过去** —— 它现在是
    // 回滚杆,不再是"什么都不设"的那一档。
    setSessionTranscriptModeForTesting('shadow')
    makeJsonlSession('w1')
    userMessage('w1', 'm1')
    await flushSessionEventLog('w1')

    // 注入:账本从这一刻起写不进去(与 battery 探针同一刀,只是这里直接换实现)。
    const appendFile = vi.spyOn(fs.promises, 'appendFile')
      .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))

    // 回滚杆 shadow:失败只计数,写口一如既往地返回 seq。
    expect(appendSessionLogEvent('w1', 'user/message', {
      message: { id: 'm2', role: 'user', content: 'x' },
    })).toBeDefined()
    await flushSessionEventLog('w1')
    flushSessionEventStats()
    expect(readSessionShadowStats().appendFailures).toBeGreaterThan(0)
    // 反向:同一刀下,shadow 档的**下一次**写口照样不抛。
    expect(() => appendSessionLogEvent('w1', 'user/message', {
      message: { id: 'm3', role: 'user', content: 'x' },
    })).not.toThrow()
    await flushSessionEventLog('w1')

    // 扳到 off:同一份粘住的失败,现在是命令失败。
    setSessionTranscriptModeForTesting('off')
    expect(() => appendSessionLogEvent('w1', 'user/message', {
      message: { id: 'm4', role: 'user', content: 'x' },
    })).toThrow(SessionEventWriteError)

    appendFile.mockRestore()
  })

  it('off turns a G12 refusal into a throw; shadow keeps returning undefined', async () => {
    setSessionTranscriptModeForTesting('shadow')
    makeJsonlSession('w2')
    appendSessionLogEvent('w2', 'request/end', { requestIndex: 1 })
    await flushSessionEventLog('w2')

    // 第二个写者直接往文件里追了一条。
    fs.appendFileSync(
      getSessionEventsLogPath('w2'),
      `${JSON.stringify({ seq: 2, time: Date.now(), type: 'request/end', data: { requestIndex: 2 } })}\n`,
    )
    // 守卫有 500ms 检查间隔:把表往前拨,让下一次 append 真的去 stat。
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)

    // shadow(回滚杆):拒写 + 记账,但不打扰调用方。
    expect(appendSessionLogEvent('w2', 'request/end', { requestIndex: 9 })).toBeUndefined()

    // off:同一次拒写升级成上抛。
    setSessionTranscriptModeForTesting('off')
    expect(() => appendSessionLogEvent('w2', 'request/end', { requestIndex: 10 }))
      .toThrow(SessionEventWriteError)
  })

  it('off lets the failure out of the translator; shadow keeps swallowing it', async () => {
    const { sessionEventTranslator } = await import('../event-translator.js')
    const message = (id: string) =>
      ({ id, role: 'user', content: `x-${id}`, timestamp: 1 } as unknown as Parameters<
        typeof sessionEventTranslator.appendMessage
      >[1])

    setSessionTranscriptModeForTesting('shadow')
    makeJsonlSession('w4')
    sessionEventTranslator.appendMessage('w4', message('m1'))
    await flushSessionEventLog('w4')

    const appendFile = vi.spyOn(fs.promises, 'appendFile')
      .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    sessionEventTranslator.appendMessage('w4', message('m2'))
    await flushSessionEventLog('w4')

    // 回滚杆 shadow:翻译器照旧自吞(抄本还在写,吞掉是对的)。
    expect(() => sessionEventTranslator.appendMessage('w4', message('m3'))).not.toThrow()

    // 停写档:同一条错误穿过 `safely` 上抛 —— 命令面于是报得出来。
    setSessionTranscriptModeForTesting('off')
    expect(() => sessionEventTranslator.appendMessage('w4', message('m4')))
      .toThrow(SessionEventWriteError)

    appendFile.mockRestore()
  })

  it('off raises a blob write failure; shadow degrades to undefined', () => {
    setSessionTranscriptModeForTesting('shadow')
    makeJsonlSession('w3')
    const writeFile = vi.spyOn(fs, 'writeFileSync')
      .mockImplementation(() => { throw new Error('ENOSPC') })

    expect(putSessionBlob('w3', 'body')).toBeUndefined()

    setSessionTranscriptModeForTesting('off')
    expect(() => putSessionBlob('w3', 'body')).toThrow(SessionEventWriteError)

    writeFile.mockRestore()
  })
})

// ============ refold 自洽环(§14.3-B) ============

describe('refold self-consistency loop (§14.3-B)', () => {
  async function seedProjection(sessionId: string): Promise<void> {
    makeJsonlSession(sessionId)
    appendSessionLogEvent(sessionId, 'session/created', { sessionId })
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
