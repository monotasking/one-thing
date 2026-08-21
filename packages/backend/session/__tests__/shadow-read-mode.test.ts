/**
 * F11(§13.2/§13.4):**读模式切到 `events` 之后,影子还能不能证明什么。**
 *
 * S2a 给 `sessionReads` 的七个方法各开了一个 `ONETHING_SESSION_READ=events` 的
 * 岔口。影子的真相侧当时用的就是 `listMessages` —— 于是开关一开,"事实"与
 * "投影"变成同一个来源:自己跟自己比,永远相等,`sessions:shadow-report` 以
 * **错误的理由**变绿。判据被污染的门比没有门更坏。
 *
 * 所以这一套用例把读模式钉在 `events` 上,让抄本(`messages.jsonl`)与事件
 * **故意分岔**,断言影子必须把它报出来。修之前这里是绿的(自比),现在是红的
 * —— 这正是它存在的理由。
 *
 * 与 `shadow.test.ts` 的分工:那边把 `reads.js` 整个替身掉(测的是断言逻辑),
 * 这里跑**真的** `reads.ts`(测的是取数口),只替身最底下的会话仓库。
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
  getSessionMessagesPage: () => ({ success: true, messages: [] }),
  getSessionUserMessageMarkers: () => [],
  readSessionTranscriptFile: () => undefined,
}))

const { appendSessionLogEvent, flushSessionEventLog, resetSessionEventLogCache } =
  await import('../event-log.js')
const { resetSessionProjectionCache } = await import('../projection-cache.js')
const { resetSessionEventReadCache } = await import('../events-reads.js')
const { resetSessionPrepareCache } = await import('../prepare.js')
const { setSessionReadModeForTesting } = await import('../read-mode.js')
const { sessionReads } = await import('../reads.js')
const {
  checkSessionRunShadow,
  getSessionShadowLogPath,
  resetSessionShadowCache,
  resetSessionShadowCoverageCache,
} = await import('../shadow.js')
const {
  flushSessionEventStats,
  readSessionShadowStats,
  resetSessionEventStatsCache,
} = await import('../event-stats.js')

const SESSION = 'read-mode-1'
const RUN = 'run-1'

beforeEach(() => {
  delete process.env.ONETHING_SESSION_SHADOW
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-shadow-read-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  state.messages = new Map()
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
  resetSessionProjectionCache()
  resetSessionEventReadCache()
  resetSessionPrepareCache()
  resetSessionShadowCache()
  resetSessionShadowCoverageCache()
  setSessionReadModeForTesting(undefined)
})

afterEach(async () => {
  await flushSessionEventLog()
  setSessionReadModeForTesting(undefined)
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

/** 事件侧的一个最小 run(与 `shadow.test.ts` 的 `recordSimpleRun` 同形)。 */
async function recordRun(text: string): Promise<void> {
  appendSessionLogEvent(SESSION, 'user/message', {
    message: { id: 'u1', role: 'user', content: 'hi', timestamp: 1000 },
  } as never, { surfaceOp: 'append' })
  appendSessionLogEvent(SESSION, 'run/start', {
    runId: RUN,
    kind: 'send',
    assistantMessageId: 'a1',
    triggerMessageId: 'u1',
    timestamp: 2000,
    provider: 'openai',
    model: 'gpt-4o',
  } as never, { surfaceOp: 'append' })
  appendSessionLogEvent(SESSION, 'assistant/chunks', {
    runId: RUN, requestIndex: 1, messageId: 'a1', partIndex: 0,
    kind: 'text', time0: 2001, dt: [0], text: [text],
  } as never)
  appendSessionLogEvent(SESSION, 'assistant/part-end', {
    runId: RUN, requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', len: text.length,
  } as never)
  appendSessionLogEvent(SESSION, 'request/end', { runId: RUN, requestIndex: 1 } as never)
  appendSessionLogEvent(SESSION, 'message/patched', {
    messageId: 'a1', patch: { runId: RUN },
  } as never)
  appendSessionLogEvent(SESSION, 'run/end', { runId: RUN, outcome: 'completed' } as never)
  await flushSessionEventLog(SESSION)
  resetSessionProjectionCache()
}

/** 抄本侧(`messages.jsonl` 的那一份)。 */
function setTranscript(assistantText: string): void {
  state.messages.set(SESSION, [
    { id: 'u1', role: 'user', content: 'hi', timestamp: 1000 },
    {
      id: 'a1',
      role: 'assistant',
      content: assistantText,
      timestamp: 2000,
      provider: 'openai',
      model: 'gpt-4o',
      runId: RUN,
      contentParts: [{ type: 'text', content: assistantText, turnIndex: 1 }],
    },
  ])
}

function shadowLineCount(): number {
  try {
    return fs.readFileSync(getSessionShadowLogPath(), 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

describe('the transcript accessor is read-mode blind (F11)', () => {
  it('listMessagesFromTranscript keeps answering from messages.jsonl in events mode', async () => {
    await recordRun('hello')
    setTranscript('TAMPERED')
    setSessionReadModeForTesting('events')

    // 产品线的读面在 events 模式下给的是投影……
    expect(sessionReads.listMessages(SESSION).messages.find(m => m.id === 'a1')?.content)
      .toBe('hello')
    // ……而影子的取数口给的仍然是抄本。两者不同,正是这道断言唯一有意义的前提。
    expect(sessionReads.listMessagesFromTranscript(SESSION).find(m => m.id === 'a1')?.content)
      .toBe('TAMPERED')
  })
})

describe.each(['messages', 'events'] as const)('run assertion under read mode %s', mode => {
  beforeEach(() => {
    setSessionReadModeForTesting(mode)
  })

  it('reports a transcript-vs-events divergence (would have been silently green in events mode)', async () => {
    await recordRun('hello')
    setTranscript('TAMPERED')

    expect(checkSessionRunShadow(SESSION, { runId: RUN, assistantMessageId: 'a1', triggerMessageId: 'u1' }))
      .toBe('mismatch')
    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ mismatches: 1, byKind: { messages: 1 } })
    expect(shadowLineCount()).toBe(1)
  })

  it('still counts a clean run when the two sides agree', async () => {
    await recordRun('hello')
    setTranscript('hello')

    expect(checkSessionRunShadow(SESSION, { runId: RUN, assistantMessageId: 'a1', triggerMessageId: 'u1' }))
      .toBe('match')
    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ runs: 1, mismatches: 0 })
    expect(shadowLineCount()).toBe(0)
  })
})
