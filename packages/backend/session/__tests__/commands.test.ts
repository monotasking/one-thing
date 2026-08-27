/**
 * 命令面(装配层)的接线测试:每条命令落到磁盘/ sqlite / index meta 上的动作
 * 是不是与今天一模一样 —— 写计划、lazy 档、盖不盖 index、调哪个 sqlite 适配器。
 *
 * 这里刻意**不**碰真的 store:用 mock 仓库 + mock sqlite 装一个真的
 * `OnethingSessionMessageRuntime`,命令面照生产接法搭在它上面。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatSession } from '@shared/ipc.js'
import { createOnethingSessionMessageRuntime } from '@onething/runtime/sessions'
import type { SessionWritePlan } from '@onething/runtime/sessions'
import { sessionReads } from '../reads.js'
import { createSessionCommands, type SessionMessageCommandRuntime } from '../commands.js'

interface SaveCall {
  sessionId: string
  lazy: boolean
  plan: SessionWritePlan | undefined
}

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content: id, timestamp: 1, ...overrides } as ChatMessage
}

function harness(messages: ChatMessage[] = [], sessionOverrides: Partial<ChatSession> = {}) {
  const session = {
    id: 's1',
    name: 's1',
    messages,
    createdAt: 0,
    updatedAt: 0,
    ...sessionOverrides,
  } as ChatSession

  const saves: SaveCall[] = []
  const indexMetaUpdates: Record<string, unknown>[] = []
  const sqliteCalls: string[] = []
  const flushed: string[] = []
  const sessionPatches: Record<string, unknown>[] = []

  const runtime = createOnethingSessionMessageRuntime<
    ChatSession,
    ChatMessage,
    { id: string; name: string; createdAt: number; updatedAt: number; messageCount?: number; previewText?: string },
    NonNullable<ChatMessage['steps']>[number],
    NonNullable<ChatMessage['contentParts']>[number],
    NonNullable<ChatMessage['toolCalls']>[number]
  >({
    repository: {
      getSession: id => (id === 's1' ? session : undefined),
      getCachedSession: id => (id === 's1' ? session : undefined),
      saveSessionToFile: (sessionId, _session, options) => {
        saves.push({ sessionId, lazy: Boolean(options?.lazy), plan: options?.plan })
      },
      syncSessionToSqliteIfReady: () => sqliteCalls.push('syncSession'),
      updateSessionsIndexMeta: (sessionId, update) => {
        const meta = { id: sessionId, name: 's1', createdAt: 0, updatedAt: 0 }
        update(meta)
        indexMetaUpdates.push(meta as unknown as Record<string, unknown>)
        return true
      },
    },
    sqlite: {
      isSessionReady: () => true,
      syncMessage: (_id, msg, seq) => sqliteCalls.push(`syncMessage:${msg.id}:${seq}`),
      syncSessionMetadata: () => sqliteCalls.push('syncMetadata'),
      syncSessionUsage: () => sqliteCalls.push('syncUsage'),
      deleteMessage: (_id, messageId) => sqliteCalls.push(`deleteMessage:${messageId}`),
      deleteMessageAndAfter: (_id, messageId) => sqliteCalls.push(`deleteAfter:${messageId}`),
      upsertMessageAndTruncate: (_id, msg, seq) => sqliteCalls.push(`upsertTruncate:${msg.id}:${seq}`),
    },
    now: () => 1_700_000_000_000,
    logger: { log: () => {}, error: () => {} },
  })

  const commands = createSessionCommands({
    messages: runtime as unknown as SessionMessageCommandRuntime,
    getSession: id => (id === 's1' ? session : undefined),
    updateSessionsIndexMeta: (sessionId, update) => {
      const meta: Record<string, unknown> = { id: sessionId }
      update(meta)
      indexMetaUpdates.push(meta)
      return true
    },
    flushSessionSave: async sessionId => {
      flushed.push(sessionId)
    },
    stampCollabAgentId: (_sessionId, msg) => ({ ...msg, agentId: 'agent-1' }),
    patchSession: (sessionId, patch, mutateIndexMeta) => {
      if (sessionId !== 's1') return false
      Object.assign(session, patch)
      const meta: Record<string, unknown> = { id: sessionId }
      mutateIndexMeta?.(meta as never, session)
      indexMetaUpdates.push(meta)
      sessionPatches.push(patch as Record<string, unknown>)
      return true
    },
  })

  return { session, commands, saves, indexMetaUpdates, sqliteCalls, flushed, sessionPatches }
}

describe('sessionCommands — 持久化接线', () => {
  it('appendMessage:message 计划 + sqlite 同步 + index meta;stampCollab 不改调用方那条', () => {
    const h = harness([message('m1')])
    const incoming = message('m2')

    h.commands.appendMessage('s1', { message: incoming, stampCollab: true })

    expect(h.saves).toEqual([{ sessionId: 's1', lazy: false, plan: { kind: 'message', dirtySeq: 2 } }])
    expect(h.sqliteCalls).toEqual(['syncMessage:m2:2', 'syncMetadata'])
    expect(h.indexMetaUpdates).toHaveLength(1)
    // 署名是 COW 的:调用方手里那条没被动
    expect(incoming.agentId).toBeUndefined()
    expect(h.session.messages[1].agentId).toBe('agent-1')
  })

  it('appendMessage:stampCollab 关闭时原样写入', () => {
    const h = harness([])
    h.commands.appendMessage('s1', { message: message('m1') })
    expect(h.session.messages[0].agentId).toBeUndefined()
  })

  it('patchMessage:hint 决定 lazy 档', () => {
    const h = harness([message('m1'), message('m2')])

    h.commands.patchMessage('s1', { messageId: 'm2', patch: { content: 'tick' }, hint: 'stream' })
    expect(h.saves.at(-1)).toEqual({ sessionId: 's1', lazy: true, plan: { kind: 'message', dirtySeq: 2 } })

    h.commands.patchMessage('s1', { messageId: 'm2', patch: { isStreaming: false } })
    expect(h.saves.at(-1)).toEqual({ sessionId: 's1', lazy: false, plan: { kind: 'message', dirtySeq: 2 } })

    // 未命中 → 一次写都不发
    const before = h.saves.length
    expect(h.commands.patchMessage('s1', { messageId: 'nope', patch: { content: 'x' } })).toBe(false)
    expect(h.saves).toHaveLength(before)
  })

  /*
   * `appendContentPart / upsertStep / patchStep / setToolCalls:都是 message 计划`
   * 与 `patchStepsUsageByTurn:没命中就不写盘` —— **两条用例随那五条命令一起删除**
   * (F4-c c4-d,§16.27)。它们钉的是那五条**端口专用包装**的写计划档位,而包装
   * 本身生产零调用、c4-d 已删。core 那一侧的 reducer 分支留着(合同测试 A 线的
   * 词汇),它的写计划由 `packages/core/session/__tests__/commands.test.ts` 覆盖。
   */

  it('deleteMessage:structural + sqlite 删 + 补 index meta(E4)', () => {
    const h = harness([message('m1'), message('m2')])

    expect(h.commands.deleteMessage('s1', { messageId: 'm2' })).toBe(true)
    expect(h.saves).toEqual([{ sessionId: 's1', lazy: false, plan: { kind: 'structural' } }])
    expect(h.sqliteCalls).toEqual(['deleteMessage:m2', 'syncMetadata'])
    expect(h.indexMetaUpdates).toHaveLength(1)
    expect(h.indexMetaUpdates[0].updatedAt).toBe(h.session.updatedAt)
  })

  it('deleteMessage:matchMarker 形态走同一条路', () => {
    const h = harness([message('m1'), message('m2', { content: 'marker' })])
    expect(h.commands.deleteMessage('s1', { matchMarker: m => m.content === 'marker' })).toBe(true)
    expect(h.session.messages.map(m => m.id)).toEqual(['m1'])
  })

  it('truncateFrom(inclusive):structural + deleteAfter + usage 同步 + index meta', () => {
    const h = harness([message('m1'), message('m2')])
    expect(h.commands.truncateFrom('s1', { messageId: 'm2', inclusive: true })).toBe(true)
    expect(h.saves).toEqual([{ sessionId: 's1', lazy: false, plan: { kind: 'structural' } }])
    expect(h.sqliteCalls).toEqual(['deleteAfter:m2', 'syncMetadata', 'syncUsage'])
    expect(h.indexMetaUpdates).toHaveLength(1)
  })

  /**
   * **§16.25 钥匙③(装配层这一半):扣多少 token,由命令面从折叠产物算。**
   *
   * store 上那两条被砍掉的消息**一格 usage 都没有**(端口空转之后这就是常态);
   * 折叠产物上有。断言会话总账仍然被正确扣掉 —— 只可能来自投影那一份。
   *
   * 反证在同一条里:不桩投影(默认这条会话在事件侧读不出消息)时,命令面递
   * `undefined`,归约器退回老算法 —— 上面那两条 `truncateFrom` 用例正是那一支,
   * 它们一字未改仍然绿。
   */
  it('truncateFrom:用量结算从折叠产物取,store 上没有 usage 也扣得对', () => {
    const h = harness(
      [message('m1'), message('m2'), message('m3')],
      { totalInputTokens: 20, totalOutputTokens: 10, totalTokens: 30 },
    )
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    const spy = vi.spyOn(sessionReads, 'listMessages').mockReturnValue({
      messages: [
        message('m1'),
        message('m2', { usage }),
        message('m3', { usage }),
      ],
      changed: false,
    })
    // 判据同源那一口问的是**真的** store 单例(这套夹具用的是自带的假仓),
    // 所以这里替身一句:命令面认为这条消息在,才轮得到算用量。
    const present = vi.spyOn(sessionReads, 'hasMessageInStore').mockReturnValue(true)

    try {
      expect(h.commands.truncateFrom('s1', { messageId: 'm2', inclusive: true })).toBe(true)
    } finally {
      spy.mockRestore()
      present.mockRestore()
    }

    // store 侧那两条从头到尾没有 usage —— 老算法在这里会算出 0。
    expect(h.session.totalInputTokens).toBe(0)
    expect(h.session.totalOutputTokens).toBe(0)
    expect(h.session.totalTokens).toBe(0)
  })

  it('truncateFrom(!inclusive):upsertMessageAndTruncate 带 index+1', () => {
    const h = harness([message('u1', { role: 'user' }), message('m2')])
    expect(h.commands.truncateFrom('s1', {
      messageId: 'u1',
      inclusive: false,
      newContent: 'edited',
    })).toBe(true)
    expect(h.saves).toEqual([{ sessionId: 's1', lazy: false, plan: { kind: 'structural' } }])
    expect(h.sqliteCalls).toEqual(['upsertTruncate:u1:1', 'syncMetadata', 'syncUsage'])
    expect(h.session.messages).toHaveLength(1)
    expect(h.session.messages[0].content).toBe('edited')
  })

  // 批 6b(裁定 10):留档退役 —— `session/cleared` 只遮蔽不删,事件本身就是档。
  // 连带前置那次强刷("留档必须在 flush 之后")也消失,只剩写完那一次。
  it('replaceAll{clear}:写完强刷一次,索引计数归零,不再留档', async () => {
    const h = harness([message('m1'), message('m2')])

    const result = await h.commands.replaceAll('s1', { messages: [], reason: 'clear' })

    expect(result).toEqual({ replaced: true, previousCount: 2 })
    expect(h.flushed).toEqual(['s1'])
    expect(h.saves).toEqual([{ sessionId: 's1', lazy: false, plan: { kind: 'structural' } }])
    expect(h.session.messages).toEqual([])
    expect(h.indexMetaUpdates.at(-1)).toMatchObject({ messageCount: 0 })
  })

  it('replaceAll{replaced}:不强刷', async () => {
    const h = harness([message('m1')])
    const result = await h.commands.replaceAll('s1', { messages: [message('m9')], reason: 'replaced' })
    expect(result.replaced).toBe(true)
    expect(h.flushed).toEqual([])
    expect(h.session.messages.map(m => m.id)).toEqual(['m9'])
  })

  it('repairOnLoad:有东西修才写盘,structural', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = harness([message('m1', { isStreaming: true })])

    expect(h.commands.repairOnLoad('s1')).toBe(true)
    expect(h.saves).toEqual([{ sessionId: 's1', lazy: false, plan: { kind: 'structural' } }])
    expect(h.session.messages[0].isStreaming).toBe(false)

    expect(h.commands.repairOnLoad('s1')).toBe(false)
    expect(h.saves).toHaveLength(1)
    vi.restoreAllMocks()
  })

  it('upsertMessage:存在 → 后缀写不盖 index;不存在 → 追加并盖 index', () => {
    const h = harness([message('m1')])

    expect(h.commands.upsertMessage('s1', { message: message('m1', { content: 'new' }) })).toBe(true)
    expect(h.saves.at(-1)).toMatchObject({ plan: { kind: 'message', dirtySeq: 1 } })
    expect(h.indexMetaUpdates).toHaveLength(0)

    expect(h.commands.upsertMessage('s1', { message: message('m2') })).toBe(true)
    expect(h.saves.at(-1)).toMatchObject({ plan: { kind: 'message', dirtySeq: 2 } })
    expect(h.indexMetaUpdates).toHaveLength(1)
  })
})

describe('sessionCommands.patchSession — 会话级字段', () => {
  it('只改会话级字段并盖 index meta;消息一行不写', () => {
    const h = harness([message('m1')])

    expect(h.commands.patchSession('s1', {
      patch: { name: '改过的名字', isPinned: true },
      mutateIndexMeta: meta => {
        ;(meta as unknown as Record<string, unknown>).name = '改过的名字'
      },
    })).toBe(true)

    expect(h.session.name).toBe('改过的名字')
    expect(h.session.isPinned).toBe(true)
    // 消息路径一次都没写(saveSessionToFile 只由 12 条消息命令触发)
    expect(h.saves).toEqual([])
    expect(h.sessionPatches).toEqual([{ name: '改过的名字', isPinned: true }])
    expect(h.indexMetaUpdates).toHaveLength(1)
  })

  it('会话不存在时返回 false', () => {
    const h = harness([message('m1')])
    expect(h.commands.patchSession('missing', { patch: { name: 'x' } })).toBe(false)
  })
})
