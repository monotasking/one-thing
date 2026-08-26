/**
 * **写侧取材:store 侧的那几口与产品读面必须是两口井。**
 *
 * 出身是 §13.18 发现 B —— 那时的纪律是"事件写侧取材**一律**走抄本真相面",理由是
 * events 读模式下活投影还停在写之前,走 `getMessage` / `findMessage` 的 `fromEvents`
 * 岔口会**自引用**滞后的旧投影,把旧正文 / 误判的类别 / 丢失的删除焊进账本。
 *
 * **F 线 F3(§16.10)把那条纪律翻面了,这组用例的意义随之改变。** F1(§16.6)之后
 * 事件在 `append` 返回前就折进活投影,"投影滞后"这条理由已经死了;写侧**默认可以
 * 读活投影**。今天仍留在 store 那一侧的只有三类具名例外(判据同源 / 事件产地缺口 /
 * 只在 store 的运行时形状,逐条写在 `commands.ts` 文件头与 `reads.ts` 各口上),
 * 名字也改成了说实话的 `*FromStore` / `*InStore`。
 *
 * 所以这组用例**不再是**"证明纪律普遍成立",而是那三类例外的**护栏**:它把两口井
 * 故意灌成不同的水,断言写侧取的是 store 那一份。谁把某处例外"顺手"改回 routed 的
 * `getMessage`,这里当场红。
 *
 * 与 `shadow-read-mode.test.ts` 同款:跑**真的** `reads.ts` / 事件日志 / 投影,
 * 只替身最底下的会话仓库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc.js'
import type { SessionLogEventRecord } from '@onething/core/session'

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
  // 命令面的生产接线口:本用例自己搭命令面,不走 `getSessionCommands()`。
  getSessionMessageCommandRuntime: () => {
    throw new Error('unused in this test')
  },
  flushSessionSave: async () => {},
  patchSessionFields: () => false,
  stampCollabAgentId: (_sessionId: string, message: ChatMessage) => message,
  updateSessionsIndexMetaForCommands: () => true,
}))

import type { SessionMessageCommandRuntime } from '../commands.js'

const { createSessionCommands } = await import('../commands.js')
const { sessionCommandEvents } = await import('../command-events.js')
const { flushSessionEventLog, readSessionLogEventsSync, resetSessionEventLogCache } = await import(
  '../event-log.js'
)
const { resetSessionSurfaceCache } = await import('../event-surface.js')
const { resetSessionRuns } = await import('../runs.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const { resetSessionProjectionCache } = await import('../projection-cache.js')
const { resetSessionEventReadCache } = await import('../events-reads.js')
const { resetSessionPrepareCache } = await import('../prepare.js')
const { sessionReads } = await import('../reads.js')

const SESSION = 'write-side-1'

beforeEach(() => {
  delete process.env.ONETHING_SESSION_SHADOW
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-write-side-'))
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

function setTranscript(messages: ChatMessage[]): void {
  state.messages.set(SESSION, messages)
}

async function events(): Promise<SessionLogEventRecord[]> {
  await flushSessionEventLog(SESSION)
  return readSessionLogEventsSync(SESSION)
}

/**
 * F2-b:取材那一步搬到了命令面(`commands.ts`),所以这条用例也要走命令面才问得到
 * "底稿从哪儿来"。store 端口只做归约器那一半(改抄本),事件那一半由命令自己产出。
 */
function commandsOverTranscript(now: number) {
  const messages: SessionMessageCommandRuntime = {
    addMessage: () => {},
    upsertMessage: () => true,
    patchMessageFields: () => true,
    addMessageContentPart: () => false,
    addMessageStep: () => false,
    updateMessageStep: () => false,
    updateStepsUsageByTurn: () => [],
    updateMessageToolCalls: () => false,
    deleteMessage: () => true,
    deleteMessageWhere: () => true,
    deleteMessageAndTruncate: () => true,
    updateMessageAndTruncate: (_sessionId, messageId, newContent, options) => {
      const list = state.messages.get(SESSION) ?? []
      const index = list.findIndex(item => item.id === messageId)
      if (index === -1) return false
      const next = list.slice()
      next[index] = { ...next[index], content: newContent, timestamp: options?.now ?? 0 }
      state.messages.set(SESSION, next.slice(0, index + 1))
      return true
    },
    replaceAllMessages: () => false,
    repairOnLoad: () => false,
  }
  return createSessionCommands(
    {
      messages,
      getSession: id => ({ id, messages: state.messages.get(id) ?? [] }) as never,
      updateSessionsIndexMeta: () => true,
      flushSessionSave: async () => {},
      patchSession: () => false,
    },
    { now: () => now },
  )
}

describe(
  'event write side takes its base from the store, not from the product read face (§16.10)',
  () => {
    it('truncateFrom(edit) takes its base from the store (base-sameness with the reducer)', async () => {
      // 投影侧:账本上那一格是 `model:'from-projection'` 的旧快照。
      setTranscript([
        { id: 'u1', role: 'user', content: 'v1', timestamp: 1000, model: 'from-projection' },
      ])
      sessionCommandEvents.appendMessage(SESSION, {
        id: 'u1',
        role: 'user',
        content: 'v1',
        timestamp: 1000,
        model: 'from-projection',
      })
      resetSessionProjectionCache(SESSION)

      // 抄本侧此刻另有一份(真机上是这条消息在别处被改过)。F2-b 之后
      // `user/message-edited` 的底稿由**命令面**在 reducer 之前取,取的必须是抄本
      // 这一份;走 `getMessage` 的 fromEvents 岔口就会取到上面那份滞后投影。
      setTranscript([
        { id: 'u1', role: 'user', content: 'v1', timestamp: 1000, model: 'from-transcript' },
      ])

      commandsOverTranscript(2000).truncateFrom(SESSION, {
        messageId: 'u1',
        inclusive: false,
        newContent: 'v2',
      })

      const edited = (await events()).find(event => event.type === 'user/message-edited')
      expect(edited).toBeDefined()
      const message = (edited?.data as { message?: ChatMessage }).message
      // 底稿来自抄本(B 的发作点);正文与时刻来自命令自己(F2-b 的翻转)。
      expect(message?.model).toBe('from-transcript')
      expect(message?.content).toBe('v2')
      expect(message?.timestamp).toBe(2000)
      // 而 store 侧(影子验证器)独立推导出的那条,timestamp 是**同一个数** ——
      // 不是"差不多相等":两侧盖的是命令决定的同一个时刻(§16.8)。
      expect(state.messages.get(SESSION)?.[0]?.timestamp).toBe(2000)
    })
  },
)

describe('store-side accessors are a second well, distinct from the projection read face (§16.10)', () => {
  it('getMessageFromStore is store-bound while getMessage answers from the projection', async () => {
    // 账本上 u1='v1'(投影侧);抄本换成 'v2'(reducer 落定侧)。upsert/truncate 写侧
    // 取材若走 getMessage 的 fromEvents 岔口,拿到的是滞后投影的旧正文。
    setTranscript([{ id: 'u1', role: 'user', content: 'v1', timestamp: 1000 }])
    sessionCommandEvents.appendMessage(SESSION, {
      id: 'u1',
      role: 'user',
      content: 'v1',
      timestamp: 1000,
    })
    await flushSessionEventLog(SESSION)
    resetSessionProjectionCache(SESSION)
    setTranscript([{ id: 'u1', role: 'user', content: 'v2', timestamp: 2000 }])

    // 产品读面(fromEvents)给的是投影里的旧正文 'v1'。
    expect(sessionReads.getMessage(SESSION, 'u1')?.content).toBe('v1')
    // 写侧取材面恒读抄本 → 'v2'。
    expect(sessionReads.getMessageFromStore(SESSION, 'u1')?.content).toBe('v2')
  })

  it('findMessageFromStore finds a marker the projection face cannot', async () => {
    setTranscript([
      { id: 'u0', role: 'user', content: 'hi', timestamp: 1 },
      { id: 'a-mark', role: 'assistant', content: 'has @@marker@@', timestamp: 6 },
    ])
    sessionCommandEvents.appendMessage(SESSION, {
      id: 'u0',
      role: 'user',
      content: 'hi',
      timestamp: 1,
    })
    await flushSessionEventLog(SESSION)
    resetSessionProjectionCache(SESSION)

    const byMarker = (m: ChatMessage) => (m.content ?? '').includes('@@marker@@')
    // 产品读面滞后 → marker-delete 会找不到 → 该翻译的 message/deleted 整条丢失。
    expect(sessionReads.findMessage(SESSION, byMarker)).toBeUndefined()
    // 写侧取材面找得到 → 事件不丢。
    expect(sessionReads.findMessageFromStore(SESSION, byMarker)?.id).toBe('a-mark')
  })

  it('批 9(§13.18 同类):中止在途工具的收尾取材读到抄本的自报标题,而非滞后投影的占位', async () => {
    // events 读模式下,中止在途工具的收尾链有两处**写侧取材**滞后投影会踩坑:
    //   ① 收尾修复(`emitFinalAssistantMessageUpdate` 的 read-modify-write)—— 读投影
    //      的占位标题再原样写回 messages.jsonl,反把 metadata 时刻 `updateMessageStep`
    //      写下的自报标题 'sleep 20' 抹成占位;
    //   ② 采集点(`captureCancelledToolResults`)—— 读投影找不到收尾修复刚落盘的
    //      cancelled step,`recordCancelledToolResults` 不触发 → 账本缺 `tool/result`
    //      → 投影永远退回占位标题。
    // 两处都必须走 `*FromTranscript`。这里把两侧**故意分岔**:抄本带自报标题,活投影
    // 停在占位,断言写侧取材面读的是抄本。
    const projectionPlaceholder: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 5,
      steps: [
        { id: 'step-c1', type: 'command', title: '调用工具: bash', status: 'cancelled', toolCallId: 'c1', timestamp: 5 },
      ],
      toolCalls: [
        { id: 'c1', toolId: 'bash', toolName: 'bash', arguments: {}, status: 'cancelled', error: 'User cancelled', timestamp: 5 },
      ],
    }
    // 账本上是占位标题那一份(收尾修复要写的 `tool/result` 还没进账本)。
    sessionCommandEvents.appendMessage(SESSION, projectionPlaceholder)
    await flushSessionEventLog(SESSION)
    resetSessionProjectionCache(SESSION)
    // 抄本(store)上是 metadata 时刻已写下的自报标题 'sleep 20'。
    setTranscript([
      {
        ...projectionPlaceholder,
        steps: [
          { id: 'step-c1', type: 'command', title: 'sleep 20', status: 'cancelled', toolCallId: 'c1', timestamp: 5 },
        ],
      },
    ])

    // 产品读面(fromEvents)给的是投影里的占位标题。
    expect(sessionReads.getMessage(SESSION, 'a1')?.steps?.[0]?.title).toBe('调用工具: bash')
    // 写侧取材面恒读抄本 → 自报标题 'sleep 20'(收尾修复不再抹掉它,采集点找得到 step)。
    expect(sessionReads.getMessageFromStore(SESSION, 'a1')?.steps?.[0]?.title).toBe('sleep 20')
  })

  /**
   * **F3(§16.10)第二类例外的护栏:事件产地缺口。**
   *
   * `stream-executor.ts` / `agent-loop-executor.ts` 那两处孪生取材点为什么翻不动 ——
   * 不是"投影滞后"(F1 之后不成立),是流中 assistant 占位在账本上**根本没有那一格**:
   * `appendMessage` 对 `isStreaming` 的 assistant 一条事件都不写(`run/start` 才是它
   * 的产地),而那两处读的产物**正是那条 `run/start`**。
   *
   * 这条用例把这件事钉成可证伪的:同一条消息,store 有、投影没有。哪天
   * `appendMessage` 给流中 assistant 也开了产地,这里会红 —— 那正是"这条例外可以
   * 退役了"的信号,而不是要把断言改回去。
   *
   * (F3 的真机反证:把那两处换成 routed 的 `getMessage`,`sessions:shadow-battery`
   * 当场 RED —— 305 条失配,assistant 的 `origin` 整格丢失、`timestamp` 差 3ms。)
   */
  it('a streaming assistant placeholder has no ledger slot yet: store sees it, the projection does not', async () => {
    const placeholder: ChatMessage = {
      id: 'a-stream',
      role: 'assistant',
      content: '',
      timestamp: 7,
      isStreaming: true,
    }
    // 命令面的事件产地:流中 assistant → 一条都不写。
    sessionCommandEvents.appendMessage(SESSION, placeholder)
    await flushSessionEventLog(SESSION)
    resetSessionProjectionCache(SESSION)
    // reducer 那一侧照常落进 store。
    setTranscript([placeholder])

    // 账本上确实一条都没有(不是"写了一条旧的")。
    expect((await events()).some(event => event.type === 'system/message')).toBe(false)
    // 于是产品读面折不出它 —— 这是"还不存在",不是"滞后"。
    expect(sessionReads.getMessage(SESSION, 'a-stream')).toBeUndefined()
    // 而两处孪生取材点要的 `timestamp`(带进 `run/start` 的那个)只有 store 给得出。
    expect(sessionReads.getMessageFromStore(SESSION, 'a-stream')?.timestamp).toBe(7)
  })

  /**
   * **F3(§16.10)第三类例外的护栏:`hasSessionInStore` 连翻都翻不了。**
   *
   * 投影对"一条事件都没有的会话"与"根本不存在的会话"给的是同一个答案,而这道判据
   * 要分的正是这两者 —— 刚建的空会话必须能追加第一条消息。
   */
  it('hasSessionInStore separates an empty session from a missing one; the projection cannot', () => {
    setTranscript([])
    // 空会话:store 说"在"(可以追加第一条),投影说"折不出"(与"不存在"同一个答案)。
    expect(sessionReads.hasSessionInStore(SESSION)).toBe(true)
    expect(sessionReads.listMessages(SESSION).messages).toEqual([])
    // 不存在的会话:store 说"不在"。
    expect(sessionReads.hasSessionInStore('no-such-session')).toBe(false)
    expect(sessionReads.listMessages('no-such-session').messages).toEqual([])
  })
})
