/**
 * S2a:读门面的两种模式(§11.1)。
 *
 * 门是一句话:**同一条会话,`messages` 模式与 `events` 模式给出同一份答案**。
 * 所以这一套的主体是参数化的 —— 七个方法各跑两遍,断言同一个期望值;真正
 * 分岔的只有坐标(`seq` 在事件模式下是 eventSeq)与"事件里还没有这条会话"
 * 时必须退回消息模式那一条。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  storeDir: '',
  sessionsDir: '',
  messages: new Map<string, unknown[]>(),
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
  getSessionMessagesPage: (request: { sessionId: string; limit?: number }) => {
    const all = (state.messages.get(request.sessionId) ?? []) as Array<Record<string, unknown>>
    const limit = request.limit ?? 16
    const page = all.slice(Math.max(0, all.length - limit))
    return {
      success: true,
      messages: page.map((message, index) => ({ ...message, seq: all.length - page.length + index + 1 })),
      totalCount: all.length,
      hasMoreBefore: all.length > page.length,
      hasMoreAfter: false,
      nextCursor: null,
      backwardsCursor: null,
    }
  },
  getSessionUserMessageMarkers: (id: string) =>
    ((state.messages.get(id) ?? []) as Array<Record<string, unknown>>)
      .map((message, index) => ({ message, seq: index + 1 }))
      .filter(entry => entry.message.role === 'user')
      .map(entry => ({
        id: entry.message.id as string,
        seq: entry.seq,
        timestamp: entry.message.timestamp as number,
        preview: String(entry.message.content).slice(0, 80),
      })),
  readSessionTranscriptFile: () => undefined,
}))

const { appendSessionLogEvent, flushSessionEventLog, resetSessionEventLogCache } =
  await import('../event-log.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const { resetSessionProjectionCache } = await import('../projection-cache.js')
const { resetSessionEventReadCache } = await import('../events-reads.js')
const { resetSessionPrepareCache } = await import('../prepare.js')
const { setSessionReadModeForTesting, getSessionReadMode } = await import('../read-mode.js')
const { sessionReads } = await import('../reads.js')

const SESSION = 'sess-1'

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-s2a-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  state.messages = new Map()
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
  resetSessionProjectionCache()
  resetSessionEventReadCache()
  resetSessionPrepareCache()
  setSessionReadModeForTesting(undefined)
})

afterEach(async () => {
  await flushSessionEventLog()
  setSessionReadModeForTesting(undefined)
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

/** 一轮对话:同时写事件与"今天的那份消息",两条路的输入因此是同一件事。 */
function turn(index: number): void {
  const userId = `u${index}`
  const assistantId = `a${index}`
  const runId = `r${index}`
  appendSessionLogEvent(SESSION, 'user/message', {
    message: { id: userId, role: 'user', content: `ask ${index}`, timestamp: index * 10 },
  } as never, { surfaceOp: 'append' })
  appendSessionLogEvent(SESSION, 'run/start', {
    runId, kind: 'send', assistantMessageId: assistantId, timestamp: index * 10 + 1,
  } as never, { surfaceOp: 'append' })
  appendSessionLogEvent(SESSION, 'assistant/chunks', {
    runId, requestIndex: index, messageId: assistantId, partIndex: index * 2,
    kind: 'text', time0: 1, dt: [0], text: [`reply ${index}`],
  } as never)
  appendSessionLogEvent(SESSION, 'run/end', { runId, outcome: 'completed' } as never)

  const existing = (state.messages.get(SESSION) ?? []) as unknown[]
  state.messages.set(SESSION, [
    ...existing,
    { id: userId, role: 'user', content: `ask ${index}`, timestamp: index * 10 },
    { id: assistantId, role: 'assistant', content: `reply ${index}`, timestamp: index * 10 + 1, runId },
  ])
}

async function conversation(turns: number): Promise<void> {
  for (let index = 1; index <= turns; index++) turn(index)
  await flushSessionEventLog(SESSION)
  resetSessionProjectionCache()
}

describe('read-mode switch', () => {
  it('defaults to messages and only flips on the exact value', () => {
    expect(getSessionReadMode()).toBe('messages')
    setSessionReadModeForTesting('events')
    expect(getSessionReadMode()).toBe('events')
    setSessionReadModeForTesting(undefined)
    expect(getSessionReadMode()).toBe('messages')
  })
})

describe.each(['messages', 'events'] as const)('sessionReads in %s mode', mode => {
  beforeEach(() => {
    setSessionReadModeForTesting(mode)
  })

  it('answers the seven routed reads with the same content', async () => {
    await conversation(3)

    expect(sessionReads.listMessages(SESSION).messages.map(m => m.id))
      .toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    expect(sessionReads.countMessages(SESSION)).toBe(6)
    expect(sessionReads.getMessage(SESSION, 'a2')?.content).toBe('reply 2')
    expect(sessionReads.getMessageIndex(SESSION, 'u2')).toBe(2)
    expect(sessionReads.lastMessageOfRole(SESSION, 'user')?.id).toBe('u3')
    expect(sessionReads.listUserMarkers(SESSION)?.map(marker => marker.id)).toEqual(['u1', 'u2', 'u3'])
    expect(sessionReads.pageMessages({ sessionId: SESSION, anchor: 'tail', limit: 2 }).messages?.map(m => m.id))
      .toEqual(['u3', 'a3'])
  })

  it('hides a deleted message on both sides', async () => {
    await conversation(3)
    appendSessionLogEvent(SESSION, 'message/deleted', { messageId: 'u2' } as never)
    await flushSessionEventLog(SESSION)
    resetSessionProjectionCache()
    state.messages.set(SESSION, (state.messages.get(SESSION) as Array<{ id: string }>).filter(m => m.id !== 'u2'))

    expect(sessionReads.listMessages(SESSION).messages.map(m => m.id))
      .toEqual(['u1', 'a1', 'a2', 'u3', 'a3'])
    expect(sessionReads.countMessages(SESSION)).toBe(5)
  })

  it('falls back to the messages path for a session with no event history', () => {
    // 老会话:目录在、事件里只有 E0 那七类(surface 是空的),消息事实在
    // messages.jsonl 里。事件模式必须原样退回,而不是给出一份空历史。
    appendSessionLogEvent(SESSION, 'request/start', { requestIndex: 1, messageId: 'legacy' } as never)
    state.messages.set(SESSION, [
      { id: 'old1', role: 'user', content: 'legacy ask', timestamp: 1 },
      { id: 'old2', role: 'assistant', content: 'legacy reply', timestamp: 2 },
    ])
    resetSessionProjectionCache()

    expect(sessionReads.listMessages(SESSION).messages.map(m => m.id)).toEqual(['old1', 'old2'])
    expect(sessionReads.countMessages(SESSION)).toBe(2)
    expect(sessionReads.pageMessages({ sessionId: SESSION, anchor: 'tail', limit: 10 }).messages?.map(m => m.id))
      .toEqual(['old1', 'old2'])
  })
})

describe('events mode specifics', () => {
  beforeEach(() => {
    setSessionReadModeForTesting('events')
  })

  it('stamps seq with the eventSeq, not the position', async () => {
    await conversation(2)
    const messages = sessionReads.listMessages(SESSION).messages as unknown as Array<{ id: string; seq?: number }>
    // 位置是 1..4,事件坐标不是 —— 一条消息在日志里由第几条事件开头就是几。
    expect(messages.map(m => m.seq)).toEqual([1, 2, 5, 6])
    const page = sessionReads.pageMessages({ sessionId: SESSION, anchor: 'tail', limit: 2 })
    expect(page.messages?.map(m => m.seq)).toEqual([5, 6])
  })

  it('the file pager and the live projection agree page for page', async () => {
    await conversation(8)
    const request = { sessionId: SESSION, anchor: 'tail' as const, limit: 5 }

    // 冷路(没有活投影)= core 的倒读 pager。
    const fromFile = sessionReads.pageMessages(request)
    // 热路(活投影在内存里)= 内存分页。
    sessionReads.listMessages(SESSION)
    const fromMemory = sessionReads.pageMessages(request)

    expect(fromMemory.messages?.map(m => m.id)).toEqual(fromFile.messages?.map(m => m.id))
    expect(fromMemory.messages?.map(m => (m as { seq?: number }).seq))
      .toEqual(fromFile.messages?.map(m => (m as { seq?: number }).seq))
    expect(fromMemory.hasMoreBefore).toBe(fromFile.hasMoreBefore)
  })

  it('walks older pages through the cursor down to the head', async () => {
    await conversation(6)
    const collected: string[] = []
    let response = sessionReads.pageMessages({ sessionId: SESSION, anchor: 'tail', limit: 3 })
    collected.unshift(...(response.messages ?? []).map(m => m.id))
    while (response.hasMoreBefore && response.nextCursor) {
      response = sessionReads.pageMessages({
        sessionId: SESSION, cursor: response.nextCursor, direction: 'older', limit: 3,
      })
      collected.unshift(...(response.messages ?? []).map(m => m.id))
    }
    expect(collected).toEqual(sessionReads.listMessages(SESSION).messages.map(m => m.id))
  })
})
