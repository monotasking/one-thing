/**
 * S1b:影子断言(`docs/design/session-event-sourcing-2026-08.md` §10.4)。
 *
 * 三组用例,对应这道门的三个失效模式:
 *  - **比对本身**:相等要认得出来,不等要记下来,摘要要被 2KB 预算截住;
 *  - **历史断言**:同一条 surface 上,投影出来的历史与 `buildHistoryMessages`
 *    的输出过同一个序列化器之后逐字节相同;
 *  - **关闸**:`ONETHING_SESSION_SHADOW=0` 之后一条账都不记(事件照旧落盘)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc.js'

const state = vi.hoisted(() => ({
  storeDir: '',
  sessionsDir: '',
  messages: [] as ChatMessage[],
  session: undefined as unknown,
}))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

vi.mock('../reads.js', () => ({
  sessionReads: {
    // F11:影子只许走抄本这一口。`listMessages` 在这里故意**抛** —— 哪天有人
    // 把真相侧改回它,这一整套用例当场红,而不是安静地自己跟自己比。
    listMessages: () => {
      throw new Error('shadow must read the transcript (F11), not the read-mode-aware listMessages')
    },
    listMessagesFromTranscript: () => state.messages,
    getMessage: (_sessionId: string, messageId: string) =>
      state.messages.find(message => message.id === messageId),
    getSession: () => state.session,
  },
}))

const {
  canonicalHistory,
  checkSessionHistoryShadow,
  checkSessionRunShadow,
  getSessionShadowLogPath,
  resetSessionShadowCache,
  resetSessionShadowCoverageCache,
  summarizeShadowDiff,
} = await import('../shadow.js')
const { appendSessionLogEvent, flushSessionEventLog, resetSessionEventLogCache } = await import('../event-log.js')
const { beginSessionRun, endSessionRun, resetSessionRuns } = await import('../runs.js')
const {
  flushSessionEventStats,
  readSessionShadowStats,
  resetSessionEventStatsCache,
} = await import('../event-stats.js')
const { projectModelHistory } = await import('@onething/core/session')

const SESSION = 'shadow-1'

beforeEach(() => {
  delete process.env.ONETHING_SESSION_SHADOW
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-shadow-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  state.messages = []
  state.session = { id: SESSION }
  resetSessionEventLogCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
  resetSessionShadowCache()
  resetSessionShadowCoverageCache()
})

afterEach(async () => {
  delete process.env.ONETHING_SESSION_SHADOW
  await flushSessionEventLog()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: 1000 }
}

/** 一个最小 run:用户消息 + 一条只有文本的助手回答。 */
function recordSimpleRun(assistantId: string, text: string): string {
  appendSessionLogEvent(SESSION, 'user/message', {
    message: userMessage('u1', 'hi') as never,
  }, { surfaceOp: 'append' })
  const run = beginSessionRun(SESSION, {
    kind: 'send',
    assistantMessageId: assistantId,
    triggerMessageId: 'u1',
    timestamp: 2000,
    provider: 'openai',
    model: 'gpt-4o',
  })
  appendSessionLogEvent(SESSION, 'assistant/chunks', {
    runId: run.runId,
    requestIndex: 1,
    messageId: assistantId,
    partIndex: 0,
    kind: 'text',
    time0: 2001,
    dt: [0],
    text: [text],
  })
  appendSessionLogEvent(SESSION, 'assistant/part-end', {
    runId: run.runId,
    requestIndex: 1,
    messageId: assistantId,
    partIndex: 0,
    kind: 'text',
    len: text.length,
  })
  // 记录器在 `turn-end` 上无条件写这一条 —— 它是"这一轮的 part 落到消息上了"
  // 的账(§10.14 第 7 类:走不到它的那一轮,contentParts 一格都没有)。
  appendSessionLogEvent(SESSION, 'request/end', { runId: run.runId, requestIndex: 1 })
  // 真机里这一条由 `stream-executor` 在开 run 之后立刻打上(`ChatMessage.runId`)。
  appendSessionLogEvent(SESSION, 'message/patched', {
    messageId: assistantId,
    patch: { runId: run.runId },
  })
  return run.runId
}

/**
 * `endSessionRun` 会在检查点之后**排一次**影子断言(生产就是这么跑的)。
 * 用例要断言的是自己那一次,所以先把排队的那一次跑完,再把账清零。
 */
async function settleScheduledShadow(): Promise<void> {
  await flushSessionEventLog(SESSION)
  await new Promise(resolve => setTimeout(resolve, 10))
  resetSessionEventStatsCache()
  fs.rmSync(getSessionShadowLogPath(), { force: true })
}

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

describe('run assertion (kind: messages)', () => {
  it('counts a run when the projection equals the messages', async () => {
    const runId = recordSimpleRun('a1', 'hello')
    endSessionRun(SESSION, runId, { outcome: 'completed' })
    await settleScheduledShadow()
    state.messages = [
      userMessage('u1', 'hi'),
      {
        id: 'a1',
        role: 'assistant',
        content: 'hello',
        timestamp: 2000,
        provider: 'openai',
        model: 'gpt-4o',
        runId,
        contentParts: [{ type: 'text', content: 'hello', turnIndex: 1 }],
      } as unknown as ChatMessage,
    ]

    expect(checkSessionRunShadow(SESSION, { runId, assistantMessageId: 'a1', triggerMessageId: 'u1' }))
      .toBe('match')
    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ runs: 1, mismatches: 0 })
    expect(shadowLines()).toHaveLength(0)
  })

  it('records one line + one counter when the bodies differ', async () => {
    const runId = recordSimpleRun('a1', 'hello')
    endSessionRun(SESSION, runId, { outcome: 'completed' })
    await settleScheduledShadow()
    state.messages = [
      userMessage('u1', 'hi'),
      {
        id: 'a1',
        role: 'assistant',
        // 正文被改过 —— 这正是影子要抓的那一类。
        content: 'HELLO',
        timestamp: 2000,
        provider: 'openai',
        model: 'gpt-4o',
        runId,
        contentParts: [{ type: 'text', content: 'HELLO', turnIndex: 1 }],
      } as unknown as ChatMessage,
    ]

    expect(checkSessionRunShadow(SESSION, { runId, assistantMessageId: 'a1', triggerMessageId: 'u1' }))
      .toBe('mismatch')
    flushSessionEventStats()
    const stats = readSessionShadowStats()
    expect(stats).toMatchObject({ runs: 0, mismatches: 1, byKind: { messages: 1 } })
    expect(stats.lastMismatchAt).toBeGreaterThan(0)

    const lines = shadowLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ sessionId: SESSION, runId, kind: 'messages' })
    const diff = lines[0].diff as Array<{ path: string; a?: string; b?: string }>
    expect(diff.some(entry => entry.path.endsWith('content') && entry.a === 'HELLO' && entry.b === 'hello'))
      .toBe(true)
  })

  it('never throws into the engine — a broken projection just skips', () => {
    // 没有任何事件 = 没有可比的东西(legacy 整文件会话就是这样)。
    expect(checkSessionRunShadow('nope', { runId: 'r', assistantMessageId: 'a' })).toBe('skipped')
  })
})

/**
 * 真机形状的一个 run:**推理有两个落点**。
 *
 * 逐字照抄 `sessions/8b74a9f7…/events.jsonl` 与 `fd899977…` 里那两段的结构
 * (正文换成短串):turn 1 的 partIndex 0 是 reasoning、partIndex 1 是 text;
 * 第二轮请求再来一段 reasoning(partIndex 2)+ text(partIndex 3)。
 *
 * 引擎侧对应的事实是:**partIndex 0 那段只进 `message.reasoning` 字段**
 * (placement 'top' → `updateMessageReasoning`),partIndex 2 那段进 contentParts
 * (placement 'inline' → `appendOrderedPart`)。
 */
function recordTwoPlacementRun(assistantId: string): string {
  appendSessionLogEvent(SESSION, 'user/message', {
    message: userMessage('u1', 'hi') as never,
  }, { surfaceOp: 'append' })
  const run = beginSessionRun(SESSION, {
    kind: 'send',
    assistantMessageId: assistantId,
    triggerMessageId: 'u1',
    timestamp: 2000,
    provider: 'deepseek',
    model: 'deepseek-chat',
  })
  const part = (partIndex: number, kind: 'text' | 'reasoning', requestIndex: number, text: string): void => {
    appendSessionLogEvent(SESSION, 'assistant/chunks', {
      runId: run.runId,
      requestIndex,
      messageId: assistantId,
      partIndex,
      kind,
      time0: 2000 + partIndex,
      dt: [0],
      text: [text],
    })
    appendSessionLogEvent(SESSION, 'assistant/part-end', {
      runId: run.runId,
      requestIndex,
      messageId: assistantId,
      partIndex,
      kind,
      len: text.length,
    })
  }
  part(0, 'reasoning', 1, 'thinking first')
  part(1, 'text', 1, 'looking')
  appendSessionLogEvent(SESSION, 'request/end', { runId: run.runId, requestIndex: 1 })
  part(2, 'reasoning', 2, 'now I know')
  part(3, 'text', 2, ' done')
  appendSessionLogEvent(SESSION, 'request/end', { runId: run.runId, requestIndex: 2 })
  appendSessionLogEvent(SESSION, 'message/patched', {
    messageId: assistantId,
    patch: { runId: run.runId },
  })
  return run.runId
}

describe('reasoning has two landing spots (真机第一天 class 2)', () => {
  it('matches the engine: top reasoning is a field, inline reasoning is a contentPart', async () => {
    const runId = recordTwoPlacementRun('a1')
    endSessionRun(SESSION, runId, { outcome: 'completed' })
    await settleScheduledShadow()
    // 这一份就是引擎真的写进 messages.jsonl 的形状。
    state.messages = [
      userMessage('u1', 'hi'),
      {
        id: 'a1',
        role: 'assistant',
        content: 'looking done',
        reasoning: 'thinking first',
        timestamp: 2000,
        provider: 'deepseek',
        model: 'deepseek-chat',
        runId,
        contentParts: [
          { type: 'text', content: 'looking', turnIndex: 1 },
          { type: 'reasoning', content: 'now I know', turnIndex: 2 },
          { type: 'text', content: ' done', turnIndex: 2 },
        ],
      } as unknown as ChatMessage,
    ]

    expect(checkSessionRunShadow(SESSION, { runId, assistantMessageId: 'a1', triggerMessageId: 'u1' }))
      .toBe('match')
    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ runs: 1, mismatches: 0 })
    expect(shadowLines()).toHaveLength(0)
  })
})

/**
 * 老会话(S1a 之前建的):`events.jsonl` 只覆盖了历史的一段尾巴,
 * messages.jsonl 里前面那些消息事件侧根本不认识。
 */
function recordLegacyPartialSession(): string {
  const runId = recordSimpleRun('a1', 'hello')
  endSessionRun(SESSION, runId, { outcome: 'completed' })
  // 事实侧比事件侧多出两条"升级之前"的老消息。
  state.messages = [
    userMessage('old-1', '很久以前问的'),
    { id: 'old-2', role: 'assistant', content: '很久以前答的', timestamp: 900 } as ChatMessage,
    userMessage('u1', 'hi'),
    {
      id: 'a1',
      role: 'assistant',
      content: 'hello',
      timestamp: 2000,
      provider: 'openai',
      model: 'gpt-4o',
      runId,
      contentParts: [{ type: 'text', content: 'hello', turnIndex: 1 }],
    } as unknown as ChatMessage,
  ]
  return runId
}

describe('legacy sessions are out of the history shadow (真机第一天 class 1)', () => {
  it('skips the history assertion and counts skipped.legacyPartial instead of a mismatch', async () => {
    const runId = recordLegacyPartialSession()
    await settleScheduledShadow()
    state.messages = state.messages.slice()

    // 事实侧那 101 条 vs 投影侧那 1 条 —— 从前这里每次请求记一次 mismatch。
    expect(checkSessionHistoryShadow(SESSION, {
      runId,
      actual: [{ role: 'user', content: '很久以前问的' }, { role: 'user', content: 'hi' }],
    })).toBe('skipped')

    flushSessionEventStats()
    const stats = readSessionShadowStats()
    expect(stats.mismatches).toBe(0)
    expect(stats.byKind.history ?? 0).toBe(0)
    expect(stats.skipped).toMatchObject({ legacyPartial: 1 })
    expect(shadowLines()).toHaveLength(0)
  })

  it('keeps the run assertion on — the run\'s own messages ARE event-covered', async () => {
    const runId = recordLegacyPartialSession()
    await settleScheduledShadow()

    expect(checkSessionRunShadow(SESSION, { runId, assistantMessageId: 'a1', triggerMessageId: 'u1' }))
      .toBe('match')
    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ runs: 1, mismatches: 0 })
  })

  it('skips the run assertion only when the trigger message itself predates the events', async () => {
    const runId = recordLegacyPartialSession()
    await settleScheduledShadow()

    // 对一条比事件还老的用户消息 retry / edit-resend:事实侧有它,投影侧没有。
    expect(checkSessionRunShadow(SESSION, { runId, assistantMessageId: 'a1', triggerMessageId: 'old-1' }))
      .toBe('skipped')
    flushSessionEventStats()
    const stats = readSessionShadowStats()
    expect(stats.mismatches).toBe(0)
    expect(stats.skipped).toMatchObject({ legacyPartial: 1 })
  })
})

describe('diff summary', () => {
  it('reports the first differences and keeps the line under the 2KB budget', () => {
    const a = Array.from({ length: 200 }, (_, index) => ({ id: `m${index}`, content: 'x'.repeat(300) }))
    const b = Array.from({ length: 200 }, (_, index) => ({ id: `m${index}`, content: 'y'.repeat(300) }))
    const { diff, truncated } = summarizeShadowDiff(a, b)

    expect(diff.length).toBeGreaterThan(0)
    expect(diff.length).toBeLessThanOrEqual(12)
    expect(truncated).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(diff), 'utf8')).toBeLessThanOrEqual(2048)
    // 长值被截断成"前 120 字 + 总长",不是整段抄进日志。
    expect(diff[0].a).toContain('…(300)')
  })

  it('is empty for equal shapes regardless of key order', () => {
    expect(summarizeShadowDiff({ a: 1, b: 2 }, { b: 2, a: 1 }).diff).toEqual([])
  })
})

describe('history assertion (kind: history)', () => {
  it('matches the projection against the same recipe over the same surface', async () => {
    const runId = recordSimpleRun('a1', 'hello')
    endSessionRun(SESSION, runId, { outcome: 'completed' })
    await settleScheduledShadow()

    const { readSessionLogEventsSync } = await import('../event-log.js')
    const events = readSessionLogEventsSync(SESSION)
    const expected = projectModelHistory(events, { id: SESSION })

    expect(checkSessionHistoryShadow(SESSION, { runId, actual: expected })).toBe('match')
    flushSessionEventStats()
    expect(readSessionShadowStats().mismatches).toBe(0)
  })

  it('records a history line when the sent history differs', async () => {
    const runId = recordSimpleRun('a1', 'hello')
    endSessionRun(SESSION, runId, { outcome: 'completed' })
    await settleScheduledShadow()

    expect(checkSessionHistoryShadow(SESSION, {
      runId,
      actual: [{ role: 'user', content: 'something else entirely' }],
    })).toBe('mismatch')

    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ mismatches: 1, byKind: { history: 1 } })
    expect(shadowLines()[0]).toMatchObject({ kind: 'history' })
  })

  it('canonicalHistory ignores key order and undefined values', () => {
    expect(canonicalHistory([{ role: 'user', content: 'x', extra: undefined }]))
      .toBe(canonicalHistory([{ content: 'x', role: 'user' }]))
  })
})

/**
 * F9(§13.2/§13.4):统计口径。
 *
 * 历史断言每轮请求跑一遍 —— 一个真实的不等在 12 轮的 run 里从前会被记 12 次
 * (`mismatches` 通胀 12 倍,日志里 12 行一模一样的摘要)。折叠的是**重复**,
 * 不是不等:同一个 run 里换一处不等照记。
 */
describe('mismatch accounting (F9)', () => {
  it('collapses a repeated identical diff inside one run and counts every check', async () => {
    const runId = recordSimpleRun('a1', 'hello')
    endSessionRun(SESSION, runId, { outcome: 'completed' })
    await settleScheduledShadow()

    const wrong = [{ role: 'user', content: 'something else entirely' }]
    expect(checkSessionHistoryShadow(SESSION, { runId, actual: wrong })).toBe('mismatch')
    // 第 2 轮请求,同一处不等 —— 仍然是 mismatch(它确实不等),但不再记第二笔账。
    expect(checkSessionHistoryShadow(SESSION, { runId, actual: wrong })).toBe('mismatch')
    expect(checkSessionHistoryShadow(SESSION, { runId, actual: wrong })).toBe('mismatch')

    flushSessionEventStats()
    const stats = readSessionShadowStats()
    expect(stats).toMatchObject({
      mismatches: 1,
      duplicateMismatches: 2,
      byKind: { history: 1 },
      // 请求粒度的次数照实记 —— 它与 run 数不是一回事。
      historyChecks: 3,
    })
    expect(shadowLines()).toHaveLength(1)
  })

  it('still records a *different* diff inside the same run', async () => {
    const runId = recordSimpleRun('a1', 'hello')
    endSessionRun(SESSION, runId, { outcome: 'completed' })
    await settleScheduledShadow()

    expect(checkSessionHistoryShadow(SESSION, { runId, actual: [{ role: 'user', content: 'A' }] }))
      .toBe('mismatch')
    expect(checkSessionHistoryShadow(SESSION, { runId, actual: [{ role: 'user', content: 'B' }] }))
      .toBe('mismatch')

    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ mismatches: 2, duplicateMismatches: 0 })
    expect(shadowLines()).toHaveLength(2)
  })

  it('counts runs once per run — not once per request', async () => {
    const runId = recordSimpleRun('a1', 'hello')
    endSessionRun(SESSION, runId, { outcome: 'completed' })
    await settleScheduledShadow()
    state.messages = [
      userMessage('u1', 'hi'),
      {
        id: 'a1',
        role: 'assistant',
        content: 'hello',
        timestamp: 2000,
        provider: 'openai',
        model: 'gpt-4o',
        runId,
        contentParts: [{ type: 'text', content: 'hello', turnIndex: 1 }],
      } as unknown as ChatMessage,
    ]

    const { readSessionLogEventsSync } = await import('../event-log.js')
    const expected = projectModelHistory(readSessionLogEventsSync(SESSION), { id: SESSION })
    // 三轮请求 + 一次 run 收尾。
    expect(checkSessionHistoryShadow(SESSION, { runId, actual: expected })).toBe('match')
    expect(checkSessionHistoryShadow(SESSION, { runId, actual: expected })).toBe('match')
    expect(checkSessionHistoryShadow(SESSION, { runId, actual: expected })).toBe('match')
    expect(checkSessionRunShadow(SESSION, { runId, assistantMessageId: 'a1', triggerMessageId: 'u1' }))
      .toBe('match')

    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ runs: 1, historyChecks: 3, mismatches: 0 })
  })
})

describe('the off switch', () => {
  it('ONETHING_SESSION_SHADOW=0 records nothing at all', () => {
    process.env.ONETHING_SESSION_SHADOW = '0'
    const runId = recordSimpleRun('a1', 'hello')
    endSessionRun(SESSION, runId, { outcome: 'completed' })
    state.messages = [userMessage('u1', 'hi')]

    expect(checkSessionRunShadow(SESSION, { runId, assistantMessageId: 'a1' })).toBe('skipped')
    expect(checkSessionHistoryShadow(SESSION, { runId, actual: [] })).toBe('skipped')

    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ runs: 0, mismatches: 0 })
    expect(shadowLines()).toHaveLength(0)
  })

  it('still writes the events themselves while the shadow is off', async () => {
    process.env.ONETHING_SESSION_SHADOW = '0'
    const runId = recordSimpleRun('a1', 'hello')
    endSessionRun(SESSION, runId, { outcome: 'completed' })
    await flushSessionEventLog(SESSION)

    const { readSessionLogEventsSync } = await import('../event-log.js')
    const types = readSessionLogEventsSync(SESSION).map(event => event.type)
    expect(types).toContain('run/start')
    expect(types).toContain('run/end')
  })
})
