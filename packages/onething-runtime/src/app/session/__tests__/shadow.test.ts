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

vi.mock('../../stores/paths.js', () => ({
  getSessionsDir: () => state.sessionsDir,
  getLogDir: () => path.join(state.storeDir, 'log'),
}))

vi.mock('../reads.js', () => ({
  sessionReads: {
    listMessages: () => ({ messages: state.messages, changed: false }),
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
