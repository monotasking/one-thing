/**
 * Which room a `board` call acts on (W18).
 *
 * The room turn moved into the agent's execution session, so the board tool has
 * to find the room the same way the say executor does — through the pointer the
 * drive wrote. Without this the whole work pipeline goes dark from a room turn
 * ("this session has no room board"), which no pure test of the tool would show.
 *
 * R4b:旧 `app/collab/board-tool.ts`(一个 `Tool.define` 出来的 `BoardTool`)随
 * 旧树删除;同一条接线现在是 `app/toolkit/adapters.ts` 的 `boardAdapters()` +
 * 目录里那只 `BoardTool`。钉的语义一格没变。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeSession {
  ownerUserId?: string
  ownerWorkspaceId?: string
  id: string
  kind?: string
  agentId?: string
  collab?: { roomSessionId?: string; taskId?: string }
  room?: { memberAgentIds: string[] }
}

const mocks = vi.hoisted(() => ({
  beforeReadOrWrite: undefined as (() => void) | undefined,
  sessions: new Map<string, unknown>(),
  applied: [] as Array<{ roomSessionId: string; actor: { type: string; agentId?: string } }>,
}))

vi.mock('../../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({
    findMeta: id => mocks.sessions.get(id) as FakeSession | undefined,
  }) }
})

vi.mock('../../../store.js', () => ({
  // drive 现在要渲染用户署名(v3 V1),因此读一次设置里的身份。
  getSettings: () => ({}),
  updateSessionWorkingDirectory: vi.fn(),
  getSession: (id: string) => mocks.sessions.get(id),
}))

vi.mock('../../agents/index.js', () => ({
  findAgent: (id: string) => ({ id, name: id === 'fe' ? '小李' : id }),
}))

vi.mock('../board-store.js', () => ({
  applyBoardAction: async (
    roomSessionId: string,
    _action: unknown,
    actor: { type: string; agentId?: string },
    options: { beforeReadOrWrite?: () => void },
  ) => {
    mocks.beforeReadOrWrite = options.beforeReadOrWrite
    options.beforeReadOrWrite?.()
    mocks.applied.push({ roomSessionId, actor })
    return { board: { version: 1, tasks: [] } }
  },
}))

const { boardAdapters } = await import('../../toolkit/adapters.js')
const { createBoardTool } = await import('@onething/runtime/toolkit')
const { Decision, ToolRunner } = await import('@onething/core/toolkit')
const { ZodValidator } = await import('@onething/runtime/toolkit')

async function board(sessionId: string, executionContext?: unknown): Promise<{ output: string }> {
  const runner = new ToolRunner({
    authorizer: { async decide() { return Decision.allow() } },
    observer: { on: () => {} },
    validator: new ZodValidator(),
  })
  const outcome = await runner.run(createBoardTool(boardAdapters()), {
    callId: 'call-1',
    toolId: 'board',
    input: { action: 'list' },
    sessionId,
    messageId: 'm-1',
    principal: undefined as never,
    executionContext,
  })
  if (outcome.kind !== 'ok') throw new Error(`unexpected outcome: ${outcome.kind}`)
  return {
    output: outcome.result.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n'),
  }
}

beforeEach(() => {
  mocks.sessions.clear()
  mocks.applied.length = 0
  mocks.beforeReadOrWrite = undefined
  mocks.sessions.set('room-1', {
    id: 'room-1',
    kind: 'room',
    agentId: 'fe',
    room: { memberAgentIds: ['fe'] },
  } satisfies FakeSession)
  mocks.sessions.set('agent-exec-fe', {
    id: 'agent-exec-fe',
    kind: 'agent',
    agentId: 'fe',
    collab: { roomSessionId: 'room-1' },
  } satisfies FakeSession)
})

describe('board context from an execution session (W18)', () => {
  it('carries the invocation owner separately and rechecks before the queued board operation', async () => {
    const executionContext = { userId: 'alice', workspaceId: 'tenant-a' }
    for (const id of ['agent-exec-fe', 'room-1']) {
      Object.assign(mocks.sessions.get(id)!, { ownerUserId: 'alice', ownerWorkspaceId: 'tenant-a' })
    }
    await board('agent-exec-fe', executionContext)
    expect(mocks.applied).toHaveLength(1)
    Object.assign(mocks.sessions.get('room-1')!, { ownerUserId: 'bob' })
    expect(() => mocks.beforeReadOrWrite!()).toThrow('Session not found')
  })

  it.each(['source', 'target'] as const)('refuses a foreign %s before calling the board store', async target => {
    const id = target === 'source' ? 'agent-exec-fe' : 'room-1'
    Object.assign(mocks.sessions.get(id)!, { ownerUserId: 'bob' })
    await expect(board('agent-exec-fe')).rejects.toThrow('unexpected outcome: failed')
    expect(mocks.applied).toEqual([])
  })

  it('acts on the room the drive pointed the session at, as that agent', async () => {
    await board('agent-exec-fe')
    expect(mocks.applied).toEqual([
      { roomSessionId: 'room-1', actor: { type: 'agent', agentId: 'fe' } },
    ])
  })

  it('has no board before a drive pointed it anywhere', async () => {
    ;(mocks.sessions.get('agent-exec-fe') as FakeSession).collab = undefined
    const result = await board('agent-exec-fe')
    expect(result.output).toContain('no room board')
    expect(mocks.applied).toEqual([])
  })

  it('still resolves a pre-W18 in-room turn', async () => {
    await board('room-1')
    expect(mocks.applied).toEqual([
      { roomSessionId: 'room-1', actor: { type: 'agent', agentId: 'fe' } },
    ])
  })

  /**
   * 场子门等价(架构收敛 C3-6)。
   *
   * `resolveContext` 里那两支手写的 kind 判断改走统一判定(`venue.ts`),真值表
   * 必须逐一不变 —— 尤其 kind 缺席的网关会话:归一化把它算作 `chat`,拒。
   */
  it('场子门等价:room/agent/work 有板,chat 与 kind 缺席没有', async () => {
    mocks.sessions.set('work-1', {
      id: 'work-1',
      kind: 'work',
      agentId: 'fe',
      collab: { roomSessionId: 'room-1', taskId: 't-1' },
    } satisfies FakeSession)
    mocks.sessions.set('chat-1', { id: 'chat-1', kind: 'chat', agentId: 'fe' } satisfies FakeSession)
    // 网关会话:kind 为空、agentId 落成默认值 —— 它照旧不该有板。
    mocks.sessions.set('gateway-1', {
      id: 'gateway-1',
      agentId: 'default',
      collab: { roomSessionId: 'room-1' },
    } satisfies FakeSession)

    const seen: Array<[string, boolean]> = []
    for (const sessionId of ['room-1', 'agent-exec-fe', 'work-1', 'chat-1', 'gateway-1']) {
      const result = await board(sessionId)
      seen.push([sessionId, !String(result.output).includes('no room board')])
    }
    expect(seen).toEqual([
      ['room-1', true],
      ['agent-exec-fe', true],
      ['work-1', true],
      ['chat-1', false],
      ['gateway-1', false],
    ])
  })
})
