/**
 * **读侧唯一真相**(F4-c c4 改判,§16.24;原 F11 §13.2/§13.4)。
 *
 * 夹具一字未动、结论翻了个面。原来这套用例服务于恒等门:它让抄本(store 那一份)
 * 与事件**故意分岔**,断言门必须把它报出来 —— 判据同源(两侧都读投影)会让门以
 * 错误的理由变绿,那比没有门更坏。
 *
 * c4 把恒等门退役了(读侧早已只有投影一条路,验证器侧因此没有了消费者)。同一份
 * 分岔夹具于是改证**另一件事,也是 c4 真正要立的那一条**:
 *
 * > 内存 store 上那条消息被改成什么样,产品读面都只回答**事件折出来的那一份**。
 *
 * 它是"store 退化为物化缓存"这句话的可执行版本 —— 哪天有人把某个读口接回
 * `getSessionMessages`,这里当场红。
 *
 * 与 `shadow.test.ts` 的分工:那边只测记录面(差异摘要 / 计数 / 关闸),
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
const { sessionReads } = await import('../reads.js')
const { resetSessionShadowCache } = await import('../shadow.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')

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
})

afterEach(async () => {
  await flushSessionEventLog()
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

describe('every product read answers from the events, never from the store (F4-c c4)', () => {
  it('a tampered store message changes nothing the read surface says', async () => {
    await recordRun('hello')
    setTranscript('TAMPERED')

    // 整会话 / 单条 / 遍历 / 预览 —— 四个入口,同一个答案。
    expect(sessionReads.listMessages(SESSION).messages.find(m => m.id === 'a1')?.content)
      .toBe('hello')
    expect(sessionReads.getMessage(SESSION, 'a1')?.content).toBe('hello')
    expect([...sessionReads.iterateMessages(SESSION)].find(m => m.id === 'a1')?.content)
      .toBe('hello')
    expect(sessionReads.lastMessageOfRole(SESSION, 'assistant')?.content).toBe('hello')
  })

  /**
   * 反证:这条会话的 store 侧**确实**被改过了。少这一句,上面那组断言在
   * "替身根本没生效"的情况下也会绿。
   */
  it('the tampering really happened — the live-run writer view still sees it', async () => {
    await recordRun('hello')
    setTranscript('TAMPERED')

    // 判据同源那一口照旧读 store(它回答的是"这次命令改不改得成")—— 用它做反证。
    // (从前这里用的是 `getLiveRunWriterMessage`;那一口随写手窗口退役在 c4-b 删了,
    //  §16.25 钥匙①。两口的实现本来就逐字相同,反证的力度一字未减。)
    expect(sessionReads.getMessageFromStore(SESSION, 'a1')?.content).toBe('TAMPERED')
  })
})
