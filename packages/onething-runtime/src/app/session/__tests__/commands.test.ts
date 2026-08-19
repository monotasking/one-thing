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
  const archived: string[] = []
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
    archiveMessages: sessionId => {
      archived.push(sessionId)
      return `/tmp/${sessionId}.archive.jsonl`
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

  return { session, commands, saves, indexMetaUpdates, sqliteCalls, archived, flushed, sessionPatches }
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

  it('appendContentPart / upsertStep / patchStep / setToolCalls:都是 message 计划', () => {
    const h = harness([message('m1', { steps: [{ id: 'st1', title: 't' }] as ChatMessage['steps'] })])

    h.commands.appendContentPart('s1', { messageId: 'm1', part: { type: 'text', text: 'a' } as never })
    expect(h.saves.at(-1)).toMatchObject({ lazy: false, plan: { kind: 'message', dirtySeq: 1 } })

    h.commands.upsertStep('s1', { messageId: 'm1', step: { id: 'st2', title: 'x', toolCallId: 'c1' } as never })
    expect(h.saves.at(-1)).toMatchObject({ lazy: false, plan: { kind: 'message', dirtySeq: 1 } })

    h.commands.patchStep('s1', { messageId: 'm1', stepId: 'st1', updates: { title: 'tick' } as never })
    expect(h.saves.at(-1)).toMatchObject({ lazy: true, plan: { kind: 'message', dirtySeq: 1 } })

    h.commands.patchStep('s1', { messageId: 'm1', stepId: 'st1', updates: { status: 'success' } as never })
    expect(h.saves.at(-1)).toMatchObject({ lazy: false, plan: { kind: 'message', dirtySeq: 1 } })

    h.commands.setToolCalls('s1', { messageId: 'm1', toolCalls: [] })
    expect(h.saves.at(-1)).toMatchObject({ lazy: false, plan: { kind: 'message', dirtySeq: 1 } })
  })

  it('patchStepsUsageByTurn:没命中就不写盘', () => {
    const h = harness([
      message('m1', { steps: [{ id: 'st1', title: 't', turnIndex: 0 }] as ChatMessage['steps'] }),
    ])

    expect(h.commands.patchStepsUsageByTurn('s1', {
      messageId: 'm1',
      turnIndex: 0,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    })).toEqual(['st1'])
    expect(h.saves).toHaveLength(1)

    expect(h.commands.patchStepsUsageByTurn('s1', {
      messageId: 'm1',
      turnIndex: 9,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    })).toEqual([])
    expect(h.saves).toHaveLength(1)
  })

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

  it('replaceAll{clear}:留档在强刷之后,写完再强刷一次,索引计数归零', async () => {
    const h = harness([message('m1'), message('m2')])

    const result = await h.commands.replaceAll('s1', { messages: [], reason: 'clear' })

    expect(result).toEqual({
      replaced: true,
      previousCount: 2,
      archivePath: '/tmp/s1.archive.jsonl',
    })
    expect(h.flushed).toEqual(['s1', 's1'])
    expect(h.archived).toEqual(['s1'])
    expect(h.saves).toEqual([{ sessionId: 's1', lazy: false, plan: { kind: 'structural' } }])
    expect(h.session.messages).toEqual([])
    expect(h.indexMetaUpdates.at(-1)).toMatchObject({ messageCount: 0 })
  })

  it('replaceAll{replaced}:不留档、不强刷', async () => {
    const h = harness([message('m1')])
    const result = await h.commands.replaceAll('s1', { messages: [message('m9')], reason: 'replaced' })
    expect(result.replaced).toBe(true)
    expect(h.flushed).toEqual([])
    expect(h.archived).toEqual([])
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
