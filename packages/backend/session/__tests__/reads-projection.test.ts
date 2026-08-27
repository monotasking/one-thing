/**
 * 读门面的取数 —— **S3w-3 批 6b 之后只有一条路**(§13.14-C / §15.22)。
 *
 * S2a/S2b 时代这个文件问的是"抄本与事件两条读路给出的答案一致";批 6b 烧掉了
 * `ONETHING_SESSION_READ` 并删掉了每个 routed 方法右边的 `?? getSessionMessages`
 * 兜底,于是判据换成更强的一条:**读门面只认事件投影**。仓库替身里那份被故意
 * 改坏的"抄本"从此一个字也漏不进产品读路 —— 谁把某个方法改回去当场红。
 *
 * `sliceForHistory` 仍然走 `projectModelHistory`(模型历史,不是"再抄一遍投影");
 * 它下面那条 store 切片路不是抄本兜底,是**能力缺口**的退路(没装构造器 /
 * 给了 `upToMessageId`),所以留着,并且有自己的用例。
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
import { rehydrateSessionFromStorage } from '@onething/runtime/sessions/session-dehydrate'

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
const { hydrateSessionMessagesFromProjection } = await import('../hydrate.js')
const { sessionProjectionOptions } = await import('../projection-blobs.js')
const { sessionReads, configureSessionHistoryBuilder } = await import('../reads.js')
const { flushSessionEventStats, readSessionShadowStats, resetSessionEventStatsCache } =
  await import('../event-stats.js')

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
  resetSessionEventStatsCache()
  configureSessionHistoryBuilder({
    fromMessages: (messages, session) =>
      buildHistoryMessages([...messages] as never, session as never, RECIPE as never),
    recipe: () => RECIPE as never,
  })
})

afterEach(async () => {
  await flushSessionEventLog()
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

/** ChatMessage 的可比投影:两条读路的会话身份/正文一致(events 侧多带 seq)。 */
function identity(message: { id?: string; role?: string; content?: unknown } | undefined) {
  return message ? { id: message.id, role: message.role, content: message.content } : undefined
}

describe('读门面只认事件投影(批 6b 删兜底之后)', () => {
  /**
   * 抄本与事件**故意分岔**:仓库替身里那一份写着 TAMPERED,事件里写着 EVENTS。
   * 每个方法都必须读到事件那一份 —— 把任何一个改回 `getSessionMessages` 当场红。
   */
  beforeEach(async () => {
    await recordRun('EVENTS', 'events-user')
    setTranscript('TAMPERED', 'tampered-user')
  })

  it('findMessage reflects the events projection', () => {
    const found = sessionReads.findMessage(SESSION, m => m.role === 'assistant')
    expect(found?.content).toBe('EVENTS')
    expect(identity(found)).toEqual({ id: 'a1', role: 'assistant', content: 'EVENTS' })
  })

  it('findMessage from:end agrees too', () => {
    expect(sessionReads.findMessage(SESSION, m => m.role === 'user', { from: 'end' })?.content)
      .toBe('events-user')
  })

  it('firstUserPreview reflects the events projection', () => {
    expect(sessionReads.firstUserPreview(SESSION)).toBe('events-user')
  })

  it('iterateMessages reflects the events projection', () => {
    expect([...sessionReads.iterateMessages(SESSION)].map(m => m.content))
      .toEqual(['events-user', 'EVENTS'])
  })

  it('listMessages / countMessages / getMessage reflect the events projection', () => {
    expect(sessionReads.listMessages(SESSION).messages.map(m => m.content))
      .toEqual(['events-user', 'EVENTS'])
    expect(sessionReads.countMessages(SESSION)).toBe(2)
    expect(sessionReads.getMessage(SESSION, 'a1')?.content).toBe('EVENTS')
    expect(sessionReads.getMessageIndex(SESSION, 'a1')).toBe(1)
    expect(sessionReads.lastMessageOfRole(SESSION, 'assistant')?.content).toBe('EVENTS')
  })

  it('sliceForHistory reflects the events projection (model history)', () => {
    const history = sessionReads.sliceForHistory(SESSION)
    expect(JSON.stringify(history)).toContain('EVENTS')
    expect(JSON.stringify(history)).not.toContain('TAMPERED')
    // provider 历史形状(不是 ChatMessage 切片):没有 timestamp / contentParts。
    expect(history.map((m: unknown) => (m as { role?: string }).role)).toEqual(['user', 'assistant'])
  })

  it('sliceForHistory == projectModelHistory with the same recipe (shadow parity)', () => {
    const state0 = getLiveSessionProjection(SESSION)
    const expected = materializeModelHistory(state0, { id: SESSION }, {
      ...RECIPE,
      ...sessionProjectionOptions(SESSION),
    } as never)
    expect(sessionReads.sliceForHistory(SESSION)).toEqual(expected)
  })

  it('sliceForHistory still takes the store slice when no builder is configured (能力缺口,不是抄本兜底)', () => {
    configureSessionHistoryBuilder(undefined)
    const slice = sessionReads.sliceForHistory(SESSION)
    // 老形状(ChatMessage 切片):带 id / timestamp。取的是内存 store,不是抄本文件。
    expect((slice as Array<{ id?: string }>).map(m => m.id)).toEqual(['u1', 'a1'])
  })
})

/**
 * 批 6b 的**删兜底自证**:事件里折不出历史的会话,读门面给的是空 —— 而不是
 * 悄悄从仓库里另取一份。这条是 §15.22 那批删除的反向断言:哪天有人把
 * `?? getSessionMessages(...)` 加回来,它就红。
 *
 * 判据干净的前提在真机上已核过:400 间会话已 `message/imported`、33 间原生覆盖、
 * 0 间"有事件却折不出消息",legacy 整文件 0 间(且按裁定 9b 首触即迁)。
 */
describe('批 6b — 事件折不出历史时不再退回仓库', () => {
  const NO_EVENTS = 'reads-no-events'

  beforeEach(() => {
    state.messages.set(NO_EVENTS, [
      { id: 'u1', role: 'user', content: 'legacy', timestamp: 1 },
    ])
  })

  it('listMessages / countMessages / iterateMessages 都给空', () => {
    expect(sessionReads.listMessages(NO_EVENTS).messages).toEqual([])
    expect(sessionReads.countMessages(NO_EVENTS)).toBe(0)
    expect([...sessionReads.iterateMessages(NO_EVENTS)]).toEqual([])
    expect(sessionReads.firstUserPreview(NO_EVENTS)).toBeUndefined()
    expect(sessionReads.getMessage(NO_EVENTS, 'u1')).toBeUndefined()
    expect(sessionReads.getMessageIndex(NO_EVENTS, 'u1')).toBe(-1)
    expect(sessionReads.lastMessageOfRole(NO_EVENTS, 'user')).toBeUndefined()
  })

  it('store 侧那一口(写侧判据同源)照旧读得到 —— 它本来就不经过投影', () => {
    // `listMessagesFromStore` 随恒等门一起删了(F4-c c4);`getLiveRunWriterMessage`
    // 随写手窗口一起删了(c4-b,§16.25 钥匙①)。剩下这一口不是"第二份真相",
    // 它回答的是"这次命令改不改得成",判据必须与 reducer 同源,理由见 `reads.ts`。
    expect(sessionReads.getMessageFromStore(NO_EVENTS, 'u1')?.content).toBe('legacy')
  })
})

/**
 * S3w-1(§14.4 / §15.10):**冷加载补水源**。位置字段 `seq` 摘掉(投影不产出
 * 位置,把事件坐标写回抄本正是形状漂移)。
 *
 * **档位已退役**(F4-a,§16.12 / §16.11 拍板 5):从前这里是 `messages |
 * projection` 的岔口,批 3 把默认扳到投影、`messages` 留作回滚杆。抄本停写之后
 * 那根杆扳下去补出来的是空,所以烧掉了 —— 于是"默认值"与"回滚杆"两条用例也
 * 随之退役(没有档,就没有默认值这个概念)。剩下的两条验的是**唯一那条路**:
 * 折得出历史就物化(不带 `seq`),折不出就交回给仓库。
 */
describe('S3w-1 — projection hydrate source', () => {
  beforeEach(async () => {
    await recordRun('hello')
  })

  it('materializes the projection without the position seq', () => {
    const messages = hydrateSessionMessagesFromProjection(SESSION)
    expect(messages?.map(message => message.id)).toEqual(['u1', 'a1'])
    expect(messages?.every(message => !('seq' in message))).toBe(true)
    expect(messages?.[1].content).toBe('hello')
  })

  it('falls back (undefined) when the events hold no history for this session', () => {
    expect(hydrateSessionMessagesFromProjection('reads-no-events')).toBeUndefined()
  })
})

/**
 * §15.13(refold 门真机首杀):**补水不得改写活投影**。
 *
 * `materializeMessageNode` 对 `message/imported` 节点是浅展开 —— 交出去的
 * `steps` 数组与 step 对象都是活投影节点本体;而冷加载下游
 * (`session-repository.loadStoredSession` → `rehydrateSessionFromStorage`)是**就地**
 * 写者(`step.toolCall = linked`)。补水出口不深拷,活投影上就会多出事件里根本
 * 没有的 `steps[].toolCall`,refold(文件全量重折 ≡ 活投影)当场失配。
 *
 * 反证:把 `hydrate.ts` 里那次 `structuredClone` 撤掉,这条必红。
 */
describe('S3w-1 — projection hydrate never writes back into the live projection', () => {
  const IMPORTED = 'reads-read-mode-imported'

  it('leaves the live MessageNode alone while the downstream rehydrates in place', async () => {
    fs.mkdirSync(path.join(state.sessionsDir, IMPORTED), { recursive: true })
    // 迁移后的脱水形状:step 只有 `toolCallId`(没有 `toolCall`),消息级
    // `toolCalls` 齐 —— 正是 rehydrate 会去补的那一格。
    appendSessionLogEvent(IMPORTED, 'message/imported', {
      message: {
        id: 'a1',
        role: 'assistant',
        content: 'done',
        timestamp: 2000,
        toolCalls: [{ id: 'tc1', toolName: 'edit', status: 'completed', result: 'ok' }],
        steps: [{ type: 'tool-call', toolCallId: 'tc1', status: 'completed', timestamp: 2000 }],
      },
    } as never, { surfaceOp: 'append' })
    await flushSessionEventLog(IMPORTED)
    resetSessionProjectionCache()

    const projected = hydrateSessionMessagesFromProjection(IMPORTED)
    // 生产里这一步在 `loadStoredSession` 里:补水的那份直接交给就地写者。
    rehydrateSessionFromStorage({ id: IMPORTED, messages: projected })

    const node = getLiveSessionProjection(IMPORTED).nodes
      .find(candidate => candidate.kind === 'message') as { message: { steps: { toolCall?: unknown }[] } } | undefined
    expect(node?.message.steps[0].toolCall).toBeUndefined()
    // 反面:写模型手里那一份**应该**被补上 —— 断开的是引用,不是行为。
    expect((projected?.[0] as { steps?: { toolCall?: unknown }[] }).steps?.[0].toolCall).toBeDefined()
  })
})
