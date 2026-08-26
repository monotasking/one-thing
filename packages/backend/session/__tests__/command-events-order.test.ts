/**
 * **F2 合同:命令即事件**(`docs/design/session-event-sourcing-2026-08.md`
 * §16.7 = F2-a、§16.8 = F2-b)。
 *
 * 两件事,一件都不能少:
 *
 * 1. **产地**:`appendMessage` / `deleteMessage` / `patchMessage`(F2-a)与
 *    `upsertMessage` / `truncateFrom`(F2-b)的事件构造已经不在翻译器里了
 *    (翻译器上连这五个方法名都没有),它住在 `command-events.ts`,是命令
 *    的第一手表达。而**写出来的事件逐字段与翻转前相同** —— 翻的是产地,不是账本。
 * 2. **时序**:事件 append 在 reducer 应用到 store **之前**。断言方式是从 store 端口
 *    (reducer 的那一步)**内部**回头看一眼活投影:如果事件真的先落了,那一刻投影里
 *    已经有这次命令的结果。用 `peekSessionProjection`(不推进)而不是
 *    `getLiveSessionProjection`(自己会 drain 尾巴)—— 后者拿来断言等于什么都没钉住。
 *
 * harness 与 `write-side-visibility.test.ts` 同款:跑**真的**事件日志 / 投影 /
 * surface,只替身最底下的会话仓库与 store 端口。
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
  /** 每次 store 端口被调到时,活投影(不推进)里的读数。 */
  seenByStorePort: [] as { port: string; visible: string[]; patches: Record<string, unknown> }[],
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
  // 生产接线的那几口:本用例自己搭命令面,不走 `getSessionCommands()`。
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
const { sessionEventTranslator } = await import('../event-translator.js')
const { flushSessionEventLog, readSessionLogEventsSync, resetSessionEventLogCache } = await import(
  '../event-log.js'
)
const { resetSessionSurfaceCache } = await import('../event-surface.js')
const { resetSessionRuns } = await import('../runs.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const { getLiveSessionProjection, peekSessionProjection, resetSessionProjectionCache } =
  await import('../projection-cache.js')
const { resetSessionEventReadCache } = await import('../events-reads.js')
const { resetSessionPrepareCache } = await import('../prepare.js')

const SESSION = 'f2a-order'

beforeEach(() => {
  delete process.env.ONETHING_SESSION_SHADOW
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-f2a-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  state.messages = new Map([[SESSION, []]])
  state.seenByStorePort = []
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

/** 活投影**不推进地**看一眼:只有已经折进去的事件才在这里面。 */
function peekedMessageIds(): string[] {
  return (peekSessionProjection(SESSION)?.nodes ?? [])
    .filter(node => !node.hidden)
    .map(node => node.messageId)
}

function peekedNode(messageId: string) {
  return peekSessionProjection(SESSION)?.nodes.find(node => node.messageId === messageId)
}

function noteStorePort(port: string): void {
  const patches: Record<string, unknown> = {}
  for (const node of peekSessionProjection(SESSION)?.nodes ?? []) {
    // 节点上的 `patch` 是常驻的空对象 —— 只记真的落了补丁的那些。
    if (node.patch && Object.keys(node.patch).length > 0) patches[node.messageId] = node.patch
  }
  state.seenByStorePort.push({ port, visible: peekedMessageIds(), patches })
}

function storeMessages(): ChatMessage[] {
  return state.messages.get(SESSION) ?? []
}

/**
 * store 端口 = F0 的影子验证器那一侧。这里的每个方法在动 store 之前先记一笔
 * "此刻活投影里看得见什么" —— 那正是"事件有没有先落"的读数。
 */
function storePort(): SessionMessageCommandRuntime {
  const find = (messageId: string) => storeMessages().findIndex(item => item.id === messageId)
  return {
    addMessage(_sessionId, message) {
      noteStorePort('addMessage')
      state.messages.set(SESSION, [...storeMessages(), message])
    },
    patchMessageFields(_sessionId, messageId, patch) {
      noteStorePort('patchMessageFields')
      const index = find(messageId)
      if (index === -1) return false
      const next = storeMessages().slice()
      next[index] = { ...next[index], ...patch } as ChatMessage
      state.messages.set(SESSION, next)
      return true
    },
    deleteMessage(_sessionId, messageId) {
      noteStorePort('deleteMessage')
      const index = find(messageId)
      if (index === -1) return false
      const next = storeMessages().slice()
      next.splice(index, 1)
      state.messages.set(SESSION, next)
      return true
    },
    deleteMessageWhere(_sessionId, matchMarker) {
      noteStorePort('deleteMessageWhere')
      const index = storeMessages().findIndex(matchMarker)
      if (index === -1) return false
      const next = storeMessages().slice()
      next.splice(index, 1)
      state.messages.set(SESSION, next)
      return true
    },
    upsertMessage(_sessionId, message) {
      noteStorePort('upsertMessage')
      const index = find(message.id)
      const next = storeMessages().slice()
      if (index === -1) next.push(message)
      else next[index] = message
      state.messages.set(SESSION, next)
      return true
    },
    deleteMessageAndTruncate(_sessionId, messageId) {
      noteStorePort('deleteMessageAndTruncate')
      const index = find(messageId)
      if (index === -1) return false
      state.messages.set(SESSION, storeMessages().slice(0, index))
      return true
    },
    updateMessageAndTruncate(_sessionId, messageId, newContent, options) {
      noteStorePort('updateMessageAndTruncate')
      const index = find(messageId)
      if (index === -1) return false
      const next = storeMessages().slice(0, index + 1)
      // 归约器那一半:改正文 + 盖命令递进来的时刻(`applyTruncate` 同款)。
      next[index] = { ...next[index], content: newContent, timestamp: options?.now ?? 0 }
      state.messages.set(SESSION, next)
      return true
    },
    addMessageContentPart: () => false,
    addMessageStep: () => false,
    updateMessageStep: () => false,
    updateStepsUsageByTurn: () => [],
    updateMessageToolCalls: () => false,
    replaceAllMessages: () => false,
    repairOnLoad: () => false,
  }
}

function commandsOverStore(now = 4242) {
  return createSessionCommands(
    {
      messages: storePort(),
      getSession: id => ({ id, messages: state.messages.get(id) ?? [] }) as never,
      updateSessionsIndexMeta: () => true,
      flushSessionSave: async () => {},
      patchSession: () => false,
    },
    { now: () => now },
  )
}

function userMessage(id: string, content = 'hi'): ChatMessage {
  return { id, role: 'user', content, timestamp: 1 }
}

async function events(): Promise<SessionLogEventRecord[]> {
  await flushSessionEventLog(SESSION)
  return readSessionLogEventsSync(SESSION)
}

describe('F2 产地:五条命令的事件构造已经不在翻译器上(§16.7 / §16.8)', () => {
  it('翻译器不再认得 appendMessage / deleteMessage / patchMessage / upsertMessage / truncateFrom', () => {
    // 这五格搬去了 `command-events.ts`。留一个方法名在这里 = 两个产地,
    // 而"同一条命令写出两种事件"是静默的。
    // 剩下的四个里只有 replaceAll / patchSession 还是命令(F2-c 翻),
    // sessionCreated / sessionCompacted 是非命令采集点。
    expect(Object.keys(sessionEventTranslator).sort()).toEqual([
      'patchSession',
      'replaceAll',
      'sessionCompacted',
      'sessionCreated',
    ])
  })

  it('事件逐字段与翻转前相同:user/message + message/patched + message/deleted', async () => {
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    commands.patchMessage(SESSION, { messageId: 'u1', patch: { steered: true } as Partial<ChatMessage> })
    commands.deleteMessage(SESSION, { messageId: 'u2' })

    const line = await events()
    expect(line.map(event => event.type)).toEqual([
      'user/message',
      'user/message',
      'message/patched',
      'message/deleted',
    ])
    expect(line[0].surfaceOp).toBe('append')
    expect((line[0].data as unknown as { message: ChatMessage }).message).toEqual(userMessage('u1'))
    expect(line[2].data).toEqual({ messageId: 'u1', patch: { steered: true } })
    expect(line[2].surfaceOp).toBeUndefined()
    expect(line[3].data).toEqual({ messageId: 'u2' })
    // 只遮蔽它自己那一格(u2 是 seq 2)。
    expect(line[3].surfaceOp).toEqual({ op: 'replace', start: 2, end: 2 })
    expect(line[3].sourceEventSeqs).toEqual([2])
  })

  it('正文 / 派生字段照旧不进 message/patched;剩下全空就一条都不写', async () => {
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.patchMessage(SESSION, {
      messageId: 'u1',
      patch: { content: 'rewritten', isStreaming: false, steps: [] } as Partial<ChatMessage>,
    })

    expect((await events()).map(event => event.type)).toEqual(['user/message'])
  })

  it('那条消息不在 = 一条事件都不写(判据与 reducer 的 changed 同源)', async () => {
    const commands = commandsOverStore()
    commands.patchMessage(SESSION, { messageId: 'ghost', patch: { steered: true } as Partial<ChatMessage> })
    commands.deleteMessage(SESSION, { messageId: 'ghost' })
    commands.truncateFrom(SESSION, { messageId: 'ghost', inclusive: true })
    commands.truncateFrom(SESSION, { messageId: 'ghost', inclusive: false, newContent: 'x' })

    expect(await events()).toEqual([])
  })

  /**
   * §14.1 表 `commands.ts:209` 的 existed 探测判例:**流中的 assistant 消息在活投影
   * 里还没有那一格**(它的 surface 格子是 `run/start`),走随读模式分岔的门面会把
   * "就地换掉"误判成"新增",于是一条 `message/patched` 被写成了 `system/message`。
   * 判据走抄本真相面,所以流中 upsert 与落定 upsert 分得清清楚楚。
   */
  it('upsertMessage:流中 = 一条不写;落定 = fullBody 的 message/patched', async () => {
    const commands = commandsOverStore()
    const streaming: ChatMessage = {
      id: 'a1', role: 'assistant', content: '', timestamp: 1, isStreaming: true,
    }
    // 抄本里还没有 a1 → 新增支;而它是流中 assistant,一条都不写。
    commands.upsertMessage(SESSION, { message: streaming })
    expect(await events()).toEqual([])

    // 结算:抄本里已经有 a1 了 → 就地换掉支,走 fullBody(正文三件套照旧带上)。
    commands.upsertMessage(SESSION, {
      message: { ...streaming, content: 'settled', isStreaming: false },
    })
    const line = await events()
    expect(line.map(event => event.type)).toEqual(['message/patched'])
    expect(line[0].data).toEqual({
      messageId: 'a1',
      patch: { role: 'assistant', content: 'settled', timestamp: 1 },
    })
  })

  it('upsertMessage:新增支写的就是 appendMessage 那一条(同一份构造)', async () => {
    const commands = commandsOverStore()
    commands.upsertMessage(SESSION, { message: userMessage('u1') })

    const line = await events()
    expect(line.map(event => event.type)).toEqual(['user/message'])
    expect(line[0].surfaceOp).toBe('append')
    expect((line[0].data as unknown as { message: ChatMessage }).message).toEqual(userMessage('u1'))
  })

  it('truncateFrom(regenerate):message/deleted 遮蔽"这条到末尾"', async () => {
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    commands.appendMessage(SESSION, { message: userMessage('u3') })

    commands.truncateFrom(SESSION, { messageId: 'u2', inclusive: true })

    const line = await events()
    expect(line.map(event => event.type)).toEqual([
      'user/message', 'user/message', 'user/message', 'message/deleted',
    ])
    expect(line[3].data).toEqual({ messageId: 'u2' })
    // 遮蔽的是 u2(seq 2)到末尾(seq 3),不是它自己一格。
    expect(line[3].surfaceOp).toEqual({ op: 'replace', start: 2, end: 3 })
    expect(line[3].sourceEventSeqs).toEqual([2, 3])
  })

  it('truncateFrom(edit):user/message-edited 的底稿来自抄本,正文与时刻来自命令', async () => {
    const commands = commandsOverStore(7777)
    commands.appendMessage(SESSION, {
      message: { ...userMessage('u1', 'before'), model: 'from-transcript' },
    })
    commands.appendMessage(SESSION, { message: userMessage('u2') })

    commands.truncateFrom(SESSION, { messageId: 'u1', inclusive: false, newContent: 'after' })

    const line = await events()
    expect(line.map(event => event.type)).toEqual([
      'user/message', 'user/message', 'user/message-edited',
    ])
    expect(line[2].surfaceOp).toEqual({ op: 'replace', start: 1, end: 2 })
    expect(line[2].sourceEventSeqs).toEqual([1, 2])
    // 逐字镜像 core 的 `applyTruncate`:底稿原样 + 新正文 + 新时刻。
    expect((line[2].data as unknown as { message: ChatMessage }).message).toEqual({
      id: 'u1', role: 'user', content: 'after', timestamp: 7777, model: 'from-transcript',
    })
    // 而影子验证器(store 那一侧)盖的是**同一个数**,不是它自己读的表。
    expect(storeMessages()[0].timestamp).toBe(7777)
  })

  it('truncateFrom(edit):contentParts 只在显式带了那个键时才动', async () => {
    const withParts: ChatMessage = {
      ...userMessage('u1'),
      contentParts: [{ type: 'text', content: 'keep me' }],
    }
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: withParts })
    commands.truncateFrom(SESSION, { messageId: 'u1', inclusive: false, newContent: 'after' })

    const kept = (await events())[1]
    expect((kept.data as unknown as { message: ChatMessage }).message.contentParts)
      .toEqual([{ type: 'text', content: 'keep me' }])
  })

  it('truncateFrom(edit):显式 contentParts:null = 清空那一格', async () => {
    const withParts: ChatMessage = {
      ...userMessage('u1'),
      contentParts: [{ type: 'text', content: 'drop me' }],
    }
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: withParts })
    commands.truncateFrom(SESSION, {
      messageId: 'u1', inclusive: false, newContent: 'after', contentParts: null,
    })

    const cleared = (await events())[1]
    expect((cleared.data as unknown as { message: ChatMessage }).message)
      .not.toHaveProperty('contentParts')
  })
})

describe('F2-a 时序:事件 append 先于 reducer 应用到 store(§16.7)', () => {
  it('appendMessage:store 端口被调到的那一刻,活投影里已经有这条消息', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()

    commands.appendMessage(SESSION, { message: userMessage('u1') })

    expect(state.seenByStorePort).toEqual([{ port: 'addMessage', visible: ['u1'], patches: {} }])
    // 而 store 侧(影子验证器)也确实推导出了同一条。
    expect(storeMessages().map(message => message.id)).toEqual(['u1'])
  })

  it('patchMessage:补丁在 store 端口之前就落在活投影的那条节点上', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    state.seenByStorePort = []

    commands.patchMessage(SESSION, { messageId: 'u1', patch: { steered: true } as Partial<ChatMessage> })

    // store 端口那一刻已经能读到自己刚写的补丁 —— 这就是 F1 的同步可见落在命令面上。
    expect(state.seenByStorePort).toEqual([
      { port: 'patchMessageFields', visible: ['u1'], patches: { u1: { steered: true } } },
    ])
    expect((peekedNode('u1')?.patch as Record<string, unknown> | undefined)?.steered).toBe(true)
  })

  it('deleteMessage(messageId):遮蔽先生效,store 端口进门时那条已经不在投影上', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    state.seenByStorePort = []

    commands.deleteMessage(SESSION, { messageId: 'u2' })

    expect(state.seenByStorePort).toEqual([{ port: 'deleteMessage', visible: ['u1'], patches: {} }])
    expect(storeMessages().map(message => message.id)).toEqual(['u1'])
  })

  it('deleteMessage(matchMarker):同一条纪律 —— 先找、先记事件、后删 store', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    state.seenByStorePort = []

    commands.deleteMessage(SESSION, { matchMarker: message => message.id === 'u1' })

    expect(state.seenByStorePort).toEqual([{ port: 'deleteMessageWhere', visible: ['u2'], patches: {} }])
    expect(storeMessages().map(message => message.id)).toEqual(['u2'])
  })

  it('upsertMessage:store 端口进门时,活投影上已经是换过的那一条', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    state.seenByStorePort = []

    commands.upsertMessage(SESSION, { message: { ...userMessage('u1'), steered: true } as ChatMessage })

    expect(state.seenByStorePort).toEqual([
      { port: 'upsertMessage', visible: ['u1'], patches: { u1: { role: 'user', timestamp: 1, steered: true, content: 'hi' } } },
    ])
  })

  it('truncateFrom(regenerate):遮蔽先生效,store 端口进门时那一段已经不在投影上', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    commands.appendMessage(SESSION, { message: userMessage('u3') })
    state.seenByStorePort = []

    commands.truncateFrom(SESSION, { messageId: 'u2', inclusive: true })

    expect(state.seenByStorePort).toEqual([
      { port: 'deleteMessageAndTruncate', visible: ['u1'], patches: {} },
    ])
    expect(storeMessages().map(message => message.id)).toEqual(['u1'])
  })

  it('truncateFrom(edit):改写与截断都在 store 端口之前就落在活投影上', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore(7777)
    commands.appendMessage(SESSION, { message: userMessage('u1', 'before') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    state.seenByStorePort = []

    commands.truncateFrom(SESSION, { messageId: 'u1', inclusive: false, newContent: 'after' })

    expect(state.seenByStorePort).toEqual([
      { port: 'updateMessageAndTruncate', visible: ['u1'], patches: {} },
    ])
    // 新节点接上了,而且带的就是命令合成的那一份。(编辑重发是"遮蔽旧格 + 加新格",
    // 所以要取**没被遮蔽**的那一格 —— 按 id 取第一格拿到的是旧的。)
    const visible = peekSessionProjection(SESSION)?.nodes.find(
      node => !node.hidden && node.kind === 'message' && node.messageId === 'u1',
    )
    const shown = (visible as { message?: ChatMessage } | undefined)?.message
    expect(shown?.content).toBe('after')
    expect(shown?.timestamp).toBe(7777)
    expect(storeMessages()).toEqual([
      { id: 'u1', role: 'user', content: 'after', timestamp: 7777 },
    ])
  })
})
