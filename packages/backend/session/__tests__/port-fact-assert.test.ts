/**
 * **端口事实断言**(F4-c c4,§16.24)—— 恒等门退役之后"A 类端口的事实已经在流上"
 * 那句话的逐格证人。
 *
 * 四条用例,对应它的四个失效模式:
 *  - **报得出来**:折叠值与端口入参不同 → 一行 `kind:'port'` + `portMismatches`;
 *  - **不误报**:相同 → 一条账都没有,但 `portChecks` 要涨(**比过**了);
 *  - **判据只有一把尺**:`usage.durationMs` 是 canonical 明文丢掉的那一格
 *    (一次流的墙钟量测),它**不许**报出来 —— 施工时第一版直接 `deepEqual`,
 *    battery 当场 265 条假红;
 *  - **自证**:`ProjectionNode` 上不存在的那一格永远不比,`portChecks` 一次不涨
 *    (`content` 探针的教训:0 失配 + 0 比较 = 什么都没证明)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  storeDir: '',
  sessionsDir: '',
}))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

const { flushSessionEventLog, resetSessionEventLogCache } =
  await import('../event-log.js')
const { writeSessionEvent } = await import('../event-writer.js')
const { getLiveSessionProjection, resetSessionProjectionCache } = await import('../projection-cache.js')
const { resetSessionPrepareCache } = await import('../prepare.js')
const { getSessionShadowLogPath } = await import('../shadow.js')
const {
  flushSessionEventStats,
  readSessionShadowStats,
  resetSessionEventStatsCache,
} = await import('../event-stats.js')
const {
  assertPortFactIsFolded,
  resetSessionPortAssertDedupe,
  setSessionPortAssertEnabled,
} = await import('../port-fact-assert.js')

const SESSION = 'port-assert-1'
const RUN = 'run-1'

beforeEach(() => {
  delete process.env.ONETHING_SESSION_SHADOW
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-port-assert-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
  resetSessionProjectionCache()
  resetSessionPrepareCache()
  resetSessionPortAssertDedupe()
  setSessionPortAssertEnabled(true)
})

afterEach(async () => {
  setSessionPortAssertEnabled(undefined)
  await flushSessionEventLog()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

function shadowLines(): Array<Record<string, unknown>> {
  try {
    return fs.readFileSync(getSessionShadowLogPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** 一条带 usage 的助手 run,折进活投影。 */
function recordRunWithUsage(usage: Record<string, number>): void {
  writeSessionEvent(SESSION, 'run/start', {
    runId: RUN,
    kind: 'send',
    assistantMessageId: 'a1',
    timestamp: 2000,
    provider: 'openai',
    model: 'gpt-4o',
  } as never, { surfaceOp: 'append' })
  writeSessionEvent(SESSION, 'request/response', {
    runId: RUN,
    requestIndex: 1,
    usage,
  } as never)
  // 活投影建表(建了之后断言才肯比 —— 它绝不主动建表)。
  getLiveSessionProjection(SESSION)
}

const USAGE = { inputTokens: 10, outputTokens: 20, totalTokens: 30 }

describe('port fact assertion', () => {
  it('records one line + one counter when the fold and the port disagree', () => {
    recordRunWithUsage(USAGE)

    assertPortFactIsFolded(SESSION, 'a1', 'usage', { ...USAGE, totalTokens: 99 })

    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ portMismatches: 1, portChecks: 1 })
    const lines = shadowLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: 'port', sessionId: SESSION })
  })

  it('stays silent — but counts the check — when they agree', () => {
    recordRunWithUsage(USAGE)

    assertPortFactIsFolded(SESSION, 'a1', 'usage', { ...USAGE })

    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ portMismatches: 0, portChecks: 1 })
    expect(shadowLines()).toHaveLength(0)
  })

  /**
   * 反证一:判据只有 `canonicalChatMessage` 一把尺。`usage.durationMs` 是它明文
   * 丢掉的那一格("一次流的墙钟量测,不是用量",`canonical.ts`)—— 引擎在收尾时
   * 写进消息,账本上按 `request/response.usage` 求和,里面从来没有它。
   * 手写第二个判官的那一版在 battery 上报了 265 条这样的假红。
   */
  it('does not report a field the single judge drops (usage.durationMs)', () => {
    recordRunWithUsage(USAGE)

    assertPortFactIsFolded(SESSION, 'a1', 'usage', { ...USAGE, durationMs: 1234 })

    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ portMismatches: 0, portChecks: 1 })
    expect(shadowLines()).toHaveLength(0)
  })

  /**
   * 反证二:这条会话还没有活投影时**一次都不比**(边界 2:不主动建表)——
   * 而且 `portChecks` 一次不涨,所以"0 失配"不会伪装成"证明过了"。
   */
  it('never builds the projection just to assert — and says so in portChecks', () => {
    // 事件写下去了,但没有人建过活投影。
    writeSessionEvent(SESSION, 'run/start', {
      runId: RUN, kind: 'send', assistantMessageId: 'a1', timestamp: 2000,
      provider: 'openai', model: 'gpt-4o',
    } as never, { surfaceOp: 'append' })

    assertPortFactIsFolded(SESSION, 'a1', 'usage', { ...USAGE, totalTokens: 99 })

    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ portMismatches: 0, portChecks: 0 })
    expect(shadowLines()).toHaveLength(0)
  })

  it('the switch turns it off entirely', () => {
    recordRunWithUsage(USAGE)
    setSessionPortAssertEnabled(false)

    assertPortFactIsFolded(SESSION, 'a1', 'usage', { ...USAGE, totalTokens: 99 })

    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ portMismatches: 0, portChecks: 0 })
    expect(shadowLines()).toHaveLength(0)
  })
})
