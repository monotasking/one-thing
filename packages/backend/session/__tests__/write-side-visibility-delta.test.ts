/**
 * **F4-c c3-a 合同:逻辑 delta 盖章即折**
 * (`docs/design/session-event-sourcing-2026-08.md` §16.23)。
 *
 * 定律二(§16.19)把 `assistant/chunks` 判成**存储编码**之后,还剩一条时间差:
 * 编码器为了攒批把逻辑 delta 压在写缓冲里(2s / 64 条两道闸),而折叠只在那一行
 * 落账时才动 —— 于是引擎写 store 的那一刻,投影侧还是空的。c3-a 探针实测:
 * `updateMessageContent` **126/126 不等,而且 120/120 是纯滞后**(A 永远是 B 的
 * 前缀,其中 112 次 A 整段为空)。
 *
 * 这一批把「逻辑事实」与「存储编码」解耦。本文件钉三条:
 *
 * 1. **盖章即可见**:一条 delta 交给 `foldLiveSessionLogicalDelta` 之后,
 *    **不推进**的活投影上立刻有那段正文 —— 一行 `assistant/chunks` 都还没落。
 * 2. **不许折第二遍**:那一行随后落账并声明 `projectionPreFolded` 时,正文不翻倍。
 *    反证在同一个 describe 里:**不声明**就会翻倍(证明这句声明是承重的)。
 * 3. **声明不被盲信**:活投影中途重建过(尾巴溢出 / 折坏)时 `aheadDeltas` 归零,
 *    这一行必须**照常折** —— 否则一段正文会静默消失。
 *
 * harness 与 `write-side-visibility.test.ts` 同款:真的事件日志 / 投影,只替身
 * 最底下的会话仓库。断言一律用 `peekSessionProjection`(只看缓存、一步不推进)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc.js'
import type { SessionLogicalDelta } from '@onething/core/session'

const state = vi.hoisted(() => ({
  storeDir: '',
  sessionsDir: '',
  messages: new Map<string, ChatMessage[]>(),
}))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

vi.mock('../../stores/sessions.js', () => ({
  getSession: (id: string) => ({ id, messages: state.messages.get(id) ?? [] }),
  getSessionRaw: (id: string) => ({ id, messages: state.messages.get(id) ?? [] }),
  getSessions: () => [],
  getSessionMessages: (id: string) => state.messages.get(id),
  getSessionMessagesPage: () => ({ success: true, messages: [] }),
  getSessionUserMessageMarkers: () => [],
  readSessionTranscriptFile: () => undefined,
}))

const { flushSessionEventLog, resetSessionEventLogCache } = await import('../event-log.js')
const { writeSessionEvent } = await import('../event-writer.js')
const { resetSessionSurfaceCache } = await import('../event-surface.js')
const { resetSessionRuns } = await import('../runs.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const {
  foldLiveSessionLogicalDelta,
  getLiveSessionProjection,
  liveSessionProjectionAheadDeltas,
  peekSessionProjection,
  resetSessionProjectionCache,
} = await import('../projection-cache.js')
const { resetSessionEventReadCache } = await import('../events-reads.js')
const { resetSessionPrepareCache } = await import('../prepare.js')

const SESSION = 'c3a-delta-visibility'
const RUN = 'run-1'
const MESSAGE = 'a1'

beforeEach(() => {
  delete process.env.ONETHING_SESSION_SHADOW
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-c3a-delta-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  state.messages = new Map()
  resetSessionEventLogCache()
  resetSessionSurfaceCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
  resetSessionProjectionCache()
  resetSessionEventReadCache()
  resetSessionPrepareCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

/** 开一次执行:`run/start` 是这条 assistant 消息在账本上的产地(§16.20)。 */
function beginRun(): void {
  getLiveSessionProjection(SESSION)
  writeSessionEvent(SESSION, 'run/start', {
    runId: RUN,
    kind: 'chat',
    assistantMessageId: MESSAGE,
    timestamp: 1000,
  } as never)
}

function delta(text: string, time: number): SessionLogicalDelta {
  return {
    runId: RUN,
    requestIndex: 1,
    messageId: MESSAGE,
    partIndex: 1,
    kind: 'text',
    turnIndex: 1,
    time,
    text,
  }
}

/** 打包行:与编码器刷出来的那一行同形(`time0 + dt[i]` 还原每条的时刻)。 */
function chunksRow(texts: readonly string[], time0: number) {
  return {
    runId: RUN,
    requestIndex: 1,
    messageId: MESSAGE,
    partIndex: 1,
    kind: 'text',
    turnIndex: 1,
    time0,
    dt: texts.map((_, index) => index),
    text: [...texts],
  }
}

/** 活投影**不推进地**看一眼这一段正文。 */
function peekedText(): string {
  const run = peekSessionProjection(SESSION)?.runs.get(RUN)
  return run?.parts.get(1)?.text ?? ''
}

describe('c3-a:盖过章的逻辑 delta 当场进折叠(§16.23)', () => {
  it('一行 assistant/chunks 都没落,活投影上已经有那段正文', () => {
    beginRun()
    expect(peekedText()).toBe('')

    expect(foldLiveSessionLogicalDelta(SESSION, RUN, delta('我查', 1001))).toBe(true)
    expect(foldLiveSessionLogicalDelta(SESSION, RUN, delta('一下。', 1002))).toBe(true)

    // 没 await、没 flush、没有任何一次读口的 drain,更没有一行打包行。
    expect(peekedText()).toBe('我查一下。')
    expect(liveSessionProjectionAheadDeltas(SESSION)).toBe(2)
  })

  it('这次执行的节点还不在 = 折不进去,如实返回 false', () => {
    getLiveSessionProjection(SESSION)
    // `run/start` 没落 —— 折叠侧没有这次执行,提前折无从谈起。
    expect(foldLiveSessionLogicalDelta(SESSION, RUN, delta('孤儿', 1001))).toBe(false)
    expect(liveSessionProjectionAheadDeltas(SESSION)).toBe(0)
  })

  it('这条会话还没有活投影 = 不建表,如实返回 false', () => {
    // 观察者那条纪律的同款:建表要同步读整份文件,不许挂在逐 token 的热路径上。
    expect(foldLiveSessionLogicalDelta(SESSION, RUN, delta('无表', 1001))).toBe(false)
  })
})

describe('c3-a:打包行落账时不许把同一段正文折第二遍(§16.23)', () => {
  it('声明 projectionPreFolded 之后,正文不翻倍', () => {
    beginRun()
    foldLiveSessionLogicalDelta(SESSION, RUN, delta('我查', 1001))
    foldLiveSessionLogicalDelta(SESSION, RUN, delta('一下。', 1002))

    writeSessionEvent(SESSION, 'assistant/chunks', chunksRow(['我查', '一下。'], 1001) as never, {
      projectionPreFolded: true,
      preFoldedDeltaCount: 2,
    })

    expect(peekedText()).toBe('我查一下。')
    expect(liveSessionProjectionAheadDeltas(SESSION)).toBe(0)
  })

  it('反证:**不**声明就会翻倍 —— 那句声明是承重的', () => {
    beginRun()
    foldLiveSessionLogicalDelta(SESSION, RUN, delta('我查', 1001))
    foldLiveSessionLogicalDelta(SESSION, RUN, delta('一下。', 1002))

    writeSessionEvent(SESSION, 'assistant/chunks', chunksRow(['我查', '一下。'], 1001) as never)

    expect(peekedText()).toBe('我查一下。我查一下。')
  })

  it('没提前折过的那一行照常折(声明缺席 = 打包行自己负责)', () => {
    beginRun()
    writeSessionEvent(SESSION, 'assistant/chunks', chunksRow(['直接', '落账'], 1001) as never)
    expect(peekedText()).toBe('直接落账')
  })
})

describe('c3-a:声明不被盲信 —— 投影重建过就照常折(§16.23)', () => {
  it('活投影中途重建(aheadDeltas 归零)时,声明过的那一行仍然被折进去', () => {
    beginRun()
    foldLiveSessionLogicalDelta(SESSION, RUN, delta('提前折的那一段', 1001))
    expect(liveSessionProjectionAheadDeltas(SESSION)).toBe(1)

    // 尾巴溢出 / 折坏的现场:那份 state 连同它领先的那几条一起没了,
    // 下一次读从文件整份重折 —— 而文件上还没有这一行。
    resetSessionProjectionCache(SESSION)
    getLiveSessionProjection(SESSION)
    expect(liveSessionProjectionAheadDeltas(SESSION)).toBe(0)

    writeSessionEvent(SESSION, 'assistant/chunks', chunksRow(['提前折的那一段'], 1001) as never, {
      projectionPreFolded: true,
      preFoldedDeltaCount: 1,
    })

    // 盲信那句声明的话,这一段正文会静默消失。
    expect(peekedText()).toBe('提前折的那一段')
  })
})
