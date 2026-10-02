import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc/chat.js'
import {
  ACP_IMPORT_ORIGIN_SOURCE,
  AcpSessionLifecycle,
  classifyAcpLifecycleError,
  foldAcpReplay,
  type AcpLocalSessionFacts,
  type AcpSessionLifecyclePorts,
} from '../session-lifecycle.js'

/**
 * A5 会话生命的装配半边:回放折成消息(纯)、认领 / 分叉 / 列表的编排与查重。
 * 管家与本地会话都是假的 —— 协议那一半在 `runtime/acp/__tests__/client-session-lifecycle.test.ts`。
 */

const text = (value: string) => ({ type: 'text' as const, text: value })

const REPLAY: SessionUpdate[] = [
  { sessionUpdate: 'user_message_chunk', content: text('hello ') },
  { sessionUpdate: 'user_message_chunk', content: text('world') },
  { sessionUpdate: 'agent_thought_chunk', content: text('hmm') },
  { sessionUpdate: 'agent_message_chunk', content: text('Hi ') },
  { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.txt', kind: 'read', status: 'pending', rawInput: { path: 'a.txt' } },
  { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { ok: true } },
  { sessionUpdate: 'agent_message_chunk', content: text('done.') },
  { sessionUpdate: 'available_commands_update', availableCommands: [] },
  { sessionUpdate: 'session_info_update', title: 'Remote title' },
  { sessionUpdate: 'user_message_chunk', content: text('again') },
  { sessionUpdate: 'agent_message_chunk', content: text('ok') },
  { sessionUpdate: 'tool_call_update', toolCallId: 'orphan', status: 'failed', content: [{ type: 'content', content: text('boom') }] },
] as SessionUpdate[]

describe('foldAcpReplay', () => {
  it('按角色切消息,正文 / 思考 / 工具按序进 contentParts,状态类更新跳过', () => {
    let n = 0
    const messages = foldAcpReplay(REPLAY, { agentId: 'fake', startAt: 1000, newId: () => `m${++n}` })
    expect(messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'hello world'],
      ['assistant', 'Hi done.'],
      ['user', 'again'],
      ['assistant', 'ok'],
    ])
    const [user, assistant, , last] = messages as [ChatMessage, ChatMessage, ChatMessage, ChatMessage]
    expect(user.origin).toMatchObject({ source: ACP_IMPORT_ORIGIN_SOURCE })
    expect(assistant).toMatchObject({ provider: 'acp', model: 'fake', reasoning: 'hmm' })
    expect(assistant.contentParts?.map(part => part.type)).toEqual(['reasoning', 'text', 'tool-call', 'text'])
    expect(assistant.toolCalls).toEqual([
      expect.objectContaining({ id: 't1', toolName: 'Read a.txt', toolId: 'read', status: 'completed', arguments: { path: 'a.txt' }, result: '{"ok":true}' }),
    ])
    // 没见过 tool_call 的 update 照样开一格(落在当下那条助手消息上)。
    expect(last.toolCalls).toEqual([expect.objectContaining({ id: 'orphan', status: 'failed', result: 'boom', error: 'boom' })])
    // 时刻单调递增。
    const times = messages.map(message => message.timestamp)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('空回放 → 没有消息', () => {
    expect(foldAcpReplay([], { agentId: 'fake' })).toEqual([])
  })
})

describe('classifyAcpLifecycleError', () => {
  it('带 code 的照抄;停用 / 找不到按 unavailable;其余 failed', () => {
    expect(classifyAcpLifecycleError(Object.assign(new Error('x'), { code: 'unsupported' }), 'request').code).toBe('unsupported')
    expect(classifyAcpLifecycleError(Object.assign(new Error('x'), { code: 'unavailable' }), 'request').code).toBe('unavailable')
    expect(classifyAcpLifecycleError(new Error('ACP agent "x" not found'), 'request').code).toBe('unavailable')
    expect(classifyAcpLifecycleError(new Error('ACP agent "x" is disabled'), 'request').code).toBe('unavailable')
    expect(classifyAcpLifecycleError(new Error('Unknown sessionId'), 'request').code).toBe('failed')
  })
})

function harness(overrides: Partial<AcpSessionLifecyclePorts['manager']> = {}) {
  const sessions = new Map<string, AcpLocalSessionFacts>()
  const linked = new Map<string, string[]>()
  const imported = new Map<string, ChatMessage[]>()
  const localMessages = new Map<string, ChatMessage[]>()
  let ids = 0
  const manager: AcpSessionLifecyclePorts['manager'] = {
    listRemoteSessions: vi.fn(async () => [
      { acpSessionId: 'r1', cwd: '/w', title: 'One' },
      { acpSessionId: 'r2', cwd: '/w' },
    ]),
    adoptRemoteSession: vi.fn(async (agentId: string, localSessionId: string, acpSessionId: string, cwd: string) => {
      linked.set(`${agentId}:${acpSessionId}`, [localSessionId, ...(linked.get(`${agentId}:${acpSessionId}`) ?? [])])
      return { acpSessionId, cwd, replay: REPLAY }
    }),
    forkSession: vi.fn(async (_agentId: string, _source: string, _target: string, cwd?: string) => ({ acpSessionId: 'forked', cwd: cwd ?? '/w' })),
    linkedLocalSessions: vi.fn((agentId: string, acpSessionId: string) => linked.get(`${agentId}:${acpSessionId}`) ?? []),
    canonicalAgentId: vi.fn((agentId: string) => (agentId === 'old-id' ? 'fake' : agentId)),
    ...overrides,
  }
  const ports: AcpSessionLifecyclePorts = {
    manager,
    getSession: id => sessions.get(id),
    createSession: vi.fn(async ({ sessionId, name, cwd, agentId }) => {
      sessions.set(sessionId, { name, workingDirectory: cwd, lastProvider: 'acp', lastModel: agentId })
      return { ok: true as const, sessionId }
    }),
    listMessages: vi.fn((sessionId: string) => localMessages.get(sessionId) ?? []),
    importMessages: vi.fn(async (sessionId: string, messages: ChatMessage[]) => { imported.set(sessionId, messages) }),
    discardSession: vi.fn(async (sessionId: string) => { sessions.delete(sessionId) }),
    newId: () => `local-${++ids}`,
  }
  return { ports, manager, sessions, linked, imported, localMessages }
}

describe('AcpSessionLifecycle', () => {
  it('认领:建本地会话(目录、acp / agent、远端标题)、折回放进账本;再认领一次答同一条', async () => {
    const { ports, manager, sessions, imported } = harness()
    const lifecycle = new AcpSessionLifecycle(ports)
    const first = await lifecycle.adoptSession({ agentId: 'fake', acpSessionId: 'r1', cwd: '/w' })
    expect(first).toEqual({ ok: true, sessionId: 'local-1', imported: 4, alreadyAdopted: false })
    expect(sessions.get('local-1')).toMatchObject({ name: 'Remote title', workingDirectory: '/w', lastProvider: 'acp', lastModel: 'fake' })
    expect(imported.get('local-1')?.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])

    // 旧 id 认回现 id 之后查重,仍然是同一条。
    const again = await lifecycle.adoptSession({ agentId: 'old-id', acpSessionId: 'r1', cwd: '/w' })
    expect(again).toEqual({ ok: true, sessionId: 'local-1', imported: 0, alreadyAdopted: true })
    expect(manager.adoptRemoteSession).toHaveBeenCalledTimes(1)
  })

  it('认领过的本地会话删了 → 再认领建新的', async () => {
    const { ports, sessions } = harness()
    const lifecycle = new AcpSessionLifecycle(ports)
    await lifecycle.adoptSession({ agentId: 'fake', acpSessionId: 'r1', cwd: '/w' })
    sessions.delete('local-1')
    const again = await lifecycle.adoptSession({ agentId: 'fake', acpSessionId: 'r1', cwd: '/w' })
    expect(again).toMatchObject({ ok: true, sessionId: 'local-2', alreadyAdopted: false })
  })

  it('同时来两发认领只 load 一次', async () => {
    const { ports, manager } = harness()
    const lifecycle = new AcpSessionLifecycle(ports)
    const [a, b] = await Promise.all([
      lifecycle.adoptSession({ agentId: 'fake', acpSessionId: 'r1', cwd: '/w' }),
      lifecycle.adoptSession({ agentId: 'fake', acpSessionId: 'r1', cwd: '/w' }),
    ])
    expect(manager.adoptRemoteSession).toHaveBeenCalledTimes(1)
    expect(a).toMatchObject({ ok: true, alreadyAdopted: false })
    expect(b).toMatchObject({ ok: true, sessionId: (a as { sessionId: string }).sessionId, alreadyAdopted: true })
  })

  it('load 失败 → 不建本地会话,答分类后的错误', async () => {
    const { ports, sessions } = harness({
      adoptRemoteSession: vi.fn(async () => { throw Object.assign(new Error('no load'), { code: 'unsupported' }) }),
    })
    const result = await new AcpSessionLifecycle(ports).adoptSession({ agentId: 'fake', acpSessionId: 'r1', cwd: '/w' })
    expect(result).toEqual({ ok: false, code: 'unsupported', error: 'no load' })
    expect(sessions.size).toBe(0)
  })

  it('列表:标出已认领的那几条', async () => {
    const { ports } = harness()
    const lifecycle = new AcpSessionLifecycle(ports)
    await lifecycle.adoptSession({ agentId: 'fake', acpSessionId: 'r2', cwd: '/w' })
    const listed = await lifecycle.listRemoteSessions({ agentId: 'fake' })
    expect(listed).toEqual({
      ok: true,
      sessions: [
        { acpSessionId: 'r1', cwd: '/w', title: 'One' },
        { acpSessionId: 'r2', cwd: '/w', adoptedSessionId: 'local-1' },
      ],
    })
  })

  it('分叉:建本地会话 → fork 到它名下 → 抄本地历史(新 id);agent 失败就收回本地那条', async () => {
    const { ports, manager, sessions, imported, localMessages } = harness()
    sessions.set('src', { name: 'Src', workingDirectory: '/w', lastProvider: 'acp', lastModel: 'fake' })
    localMessages.set('src', [
      { id: 'u1', role: 'user', content: 'q', timestamp: 1, seq: 1, sessionId: 'src' },
      { id: 'a1', role: 'assistant', content: 'a', timestamp: 2, runId: 'run-1' },
      { id: 'a2', role: 'assistant', content: '', timestamp: 3, isStreaming: true },
    ])
    const lifecycle = new AcpSessionLifecycle(ports)
    const forked = await lifecycle.forkSession({ sessionId: 'src' })
    expect(forked).toEqual({ ok: true, sessionId: 'local-1' })
    expect(sessions.get('local-1')).toMatchObject({ name: 'Src (fork)', workingDirectory: '/w', lastModel: 'fake' })
    expect(manager.forkSession).toHaveBeenCalledWith('fake', 'src', 'local-1', '/w')
    expect(imported.get('local-1')).toEqual([
      { id: 'local-2', role: 'user', content: 'q', timestamp: 1 },
      { id: 'local-3', role: 'assistant', content: 'a', timestamp: 2 },
    ])

    ;(manager.forkSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'unsupported' }))
    const refused = await lifecycle.forkSession({ sessionId: 'src' })
    expect(refused).toEqual({ ok: false, code: 'unsupported', error: 'nope' })
    expect(sessions.has('local-4')).toBe(false)
    expect(ports.discardSession).toHaveBeenCalledWith('local-4')
  })

  it('分叉:不是 ACP 会话 / 没有目录 → 不动任何东西', async () => {
    const { ports, sessions, manager } = harness()
    sessions.set('plain', { name: 'Plain', workingDirectory: '/w', lastProvider: 'openai', lastModel: 'gpt' })
    sessions.set('nowd', { name: 'NoWd', lastProvider: 'acp', lastModel: 'fake' })
    const lifecycle = new AcpSessionLifecycle(ports)
    expect(await lifecycle.forkSession({ sessionId: 'plain' })).toMatchObject({ ok: false, code: 'unavailable' })
    expect(await lifecycle.forkSession({ sessionId: 'nowd' })).toMatchObject({ ok: false, code: 'failed' })
    expect(manager.forkSession).not.toHaveBeenCalled()
  })
})
