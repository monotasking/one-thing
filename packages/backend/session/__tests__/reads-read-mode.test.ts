/**
 * S2b step C(§13.14-C):读门面里最后四个方法在 `events` 读模式下的取数。
 *
 * `findMessage` / `firstUserPreview` / `iterateMessages` 走事件投影(与 S2a 那
 * 七个同一条岔口),`sliceForHistory` 走 `projectModelHistory`(模型历史,不是
 * "再抄一遍投影")。这一套用例证明的正是切读的安全前提:同一条会话上,
 * **抄本(messages)与事件(events)两条读路给出的答案一致**。
 *
 * 与 `shadow-read-mode.test.ts` 同一套骨架:跑**真的** `reads.ts`,只替身最底下
 * 的会话仓库;`sliceForHistory` 需要模型历史构造器,测试用 core 的默认配方装上
 * (生产由 `configureAppRuntimeAdapters` 装宿主配方)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHistoryMessages } from '@onething/core/engine'
import { defaultHistoryMessageContent, materializeModelHistory } from '@onething/core/session'

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
const { getLiveSessionProjection, resetSessionProjectionCache } =
  await import('../projection-cache.js')
const { resetSessionEventReadCache } = await import('../events-reads.js')
const { resetSessionPrepareCache } = await import('../prepare.js')
const { setSessionReadModeForTesting } = await import('../read-mode.js')
const { sessionProjectionOptions } = await import('../projection-blobs.js')
const { sessionReads, configureSessionHistoryBuilder } = await import('../reads.js')

const SESSION = 'reads-read-mode-1'
const RUN = 'run-1'

/** core 默认配方:纯文本消息上与桌面端逐字节一致(见 model-history.ts 注释)。 */
const RECIPE = { buildMessageContent: defaultHistoryMessageContent }

beforeEach(() => {
  delete process.env.ONETHING_SESSION_SHADOW
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-reads-read-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  state.messages = new Map()
  resetSessionEventLogCache()
  resetSessionProjectionCache()
  resetSessionEventReadCache()
  resetSessionPrepareCache()
  setSessionReadModeForTesting(undefined)
  configureSessionHistoryBuilder({
    fromMessages: (messages, session) =>
      buildHistoryMessages([...messages] as never, session as never, RECIPE as never),
    recipe: () => RECIPE as never,
  })
})

afterEach(async () => {
  await flushSessionEventLog()
  setSessionReadModeForTesting(undefined)
  configureSessionHistoryBuilder(undefined)
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

/** 事件侧的一个最小 run(与 `shadow-read-mode.test.ts` 的 `recordRun` 同形)。 */
async function recordRun(text: string, userText = 'hi'): Promise<void> {
  appendSessionLogEvent(SESSION, 'user/message', {
    message: { id: 'u1', role: 'user', content: userText, timestamp: 1000 },
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

/** 抄本侧(`messages.jsonl` 的那一份),与事件侧同一段对话。 */
function setTranscript(assistantText: string, userText = 'hi'): void {
  state.messages.set(SESSION, [
    { id: 'u1', role: 'user', content: userText, timestamp: 1000 },
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

function readIn<T>(mode: 'messages' | 'events', fn: () => T): T {
  setSessionReadModeForTesting(mode)
  try {
    return fn()
  } finally {
    setSessionReadModeForTesting(undefined)
  }
}

/** ChatMessage 的可比投影:两条读路的会话身份/正文一致(events 侧多带 seq)。 */
function identity(message: { id?: string; role?: string; content?: unknown } | undefined) {
  return message ? { id: message.id, role: message.role, content: message.content } : undefined
}

describe('S2b step C — the last four reads agree across read modes', () => {
  beforeEach(async () => {
    await recordRun('hello')
    setTranscript('hello')
  })

  it('findMessage returns the same message in both modes', () => {
    const fromMessages = readIn('messages', () =>
      sessionReads.findMessage(SESSION, m => m.role === 'assistant'))
    const fromEvents = readIn('events', () =>
      sessionReads.findMessage(SESSION, m => m.role === 'assistant'))
    expect(identity(fromEvents)).toEqual(identity(fromMessages))
    expect(fromEvents?.content).toBe('hello')
  })

  it('findMessage from:end agrees too', () => {
    const fromMessages = readIn('messages', () =>
      sessionReads.findMessage(SESSION, m => m.role === 'user', { from: 'end' }))
    const fromEvents = readIn('events', () =>
      sessionReads.findMessage(SESSION, m => m.role === 'user', { from: 'end' }))
    expect(identity(fromEvents)).toEqual(identity(fromMessages))
    expect(fromEvents?.id).toBe('u1')
  })

  it('firstUserPreview agrees in both modes', () => {
    const fromMessages = readIn('messages', () => sessionReads.firstUserPreview(SESSION))
    const fromEvents = readIn('events', () => sessionReads.firstUserPreview(SESSION))
    expect(fromEvents).toBe(fromMessages)
    expect(fromEvents).toBe('hi')
  })

  it('iterateMessages yields the same sequence in both modes', () => {
    const fromMessages = readIn('messages', () =>
      [...sessionReads.iterateMessages(SESSION)].map(identity))
    const fromEvents = readIn('events', () =>
      [...sessionReads.iterateMessages(SESSION)].map(identity))
    expect(fromEvents).toEqual(fromMessages)
    expect(fromEvents.map(m => m?.id)).toEqual(['u1', 'a1'])
  })

  it('sliceForHistory: events mode == messages mode (the S2b history safety premise)', () => {
    const fromMessages = readIn('messages', () => sessionReads.sliceForHistory(SESSION))
    const fromEvents = readIn('events', () => sessionReads.sliceForHistory(SESSION))
    expect(fromEvents).toEqual(fromMessages)
    // provider 历史形状(不是 ChatMessage 切片):没有 timestamp / contentParts。
    expect(fromEvents.map((m: unknown) => (m as { role?: string }).role))
      .toEqual(['user', 'assistant'])
  })

  it('sliceForHistory events mode == projectModelHistory with the same recipe (shadow parity)', () => {
    const fromEvents = readIn('events', () => sessionReads.sliceForHistory(SESSION))
    const state0 = getLiveSessionProjection(SESSION)
    const expected = materializeModelHistory(state0, { id: SESSION }, {
      ...RECIPE,
      ...sessionProjectionOptions(SESSION),
    } as never)
    expect(fromEvents).toEqual(expected)
  })

  it('sliceForHistory falls back to the transcript slice when no builder is configured', () => {
    configureSessionHistoryBuilder(undefined)
    const slice = readIn('messages', () => sessionReads.sliceForHistory(SESSION))
    // 老形状(ChatMessage 切片):带 id / timestamp。
    expect((slice as Array<{ id?: string }>).map(m => m.id)).toEqual(['u1', 'a1'])
  })
})

/**
 * 路由自证:抄本与事件**故意分岔**,`events` 模式必须读到事件那一份 ——
 * 把某个方法改回 `getSessionMessages` 当场红(否则相同内容的一致性用例证明不了
 * 岔口真的接上了)。
 */
describe('S2b step C — events mode reads the projection, not the transcript', () => {
  beforeEach(async () => {
    await recordRun('EVENTS', 'events-user')
    setTranscript('TAMPERED', 'tampered-user')
  })

  it('findMessage reflects the events projection', () => {
    expect(readIn('events', () => sessionReads.findMessage(SESSION, m => m.role === 'assistant'))?.content)
      .toBe('EVENTS')
    expect(readIn('messages', () => sessionReads.findMessage(SESSION, m => m.role === 'assistant'))?.content)
      .toBe('TAMPERED')
  })

  it('firstUserPreview reflects the events projection', () => {
    expect(readIn('events', () => sessionReads.firstUserPreview(SESSION))).toBe('events-user')
    expect(readIn('messages', () => sessionReads.firstUserPreview(SESSION))).toBe('tampered-user')
  })

  it('iterateMessages reflects the events projection', () => {
    expect(readIn('events', () => [...sessionReads.iterateMessages(SESSION)].map(m => m.content)))
      .toEqual(['events-user', 'EVENTS'])
    expect(readIn('messages', () => [...sessionReads.iterateMessages(SESSION)].map(m => m.content)))
      .toEqual(['tampered-user', 'TAMPERED'])
  })

  it('sliceForHistory reflects the events projection (model history)', () => {
    const fromEvents = readIn('events', () => sessionReads.sliceForHistory(SESSION))
    const fromMessages = readIn('messages', () => sessionReads.sliceForHistory(SESSION))
    expect(JSON.stringify(fromEvents)).toContain('EVENTS')
    expect(JSON.stringify(fromEvents)).not.toContain('TAMPERED')
    expect(JSON.stringify(fromMessages)).toContain('TAMPERED')
  })
})
