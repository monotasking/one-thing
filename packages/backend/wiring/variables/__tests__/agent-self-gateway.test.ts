/**
 * 自我状态的取材链(agent-self-state-variables.md §4.1)。
 *
 * 数据全部现算、零新增存储:在场面从会话索引推,卡从各房看板读。这个测试守的
 * 是三条容易悄悄错掉的分线 —— 双成员 dm 房该算私聊而不是房、用户 dm 房要写
 * 用户的名字、卡只在这个 agent 真的在的房里找。错了都不会抛异常,只会让模型
 * 拿到一份看似合理的假状态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  sessionsById: new Map<string, Record<string, unknown>>(),
  cards: new Map<string, Array<{ id: string; title: string; status: 'doing' | 'blocked' }>>(),
  boardReads: [] as Array<{ roomSessionId: string; agentId: string }>,
}))

vi.mock('../../../store.js', () => ({
  getSession: (id: string) => mocks.sessionsById.get(id),
  getSessionsList: () => mocks.sessions,
  getSettings: () => ({ general: { userProfile: { name: '一天' } } }),
  updateSessionWorkingDirectory: () => undefined,
  updateSessionWorkingDirectoryRoots: () => undefined,
  updateSessionVariables: () => undefined,
}))

vi.mock('../../agents/index.js', () => ({
  findAgent: (id: string) => (id === 'fe' ? { id, name: '小李' } : id === 'be' ? { id, name: '小王' } : null),
  DEFAULT_ONETHING_AGENT_ID: 'default',
}))

vi.mock('../../../collab/board-store.js', () => ({
  getCollabSelfTaskFacts: (roomSessionId: string, agentId: string) => {
    mocks.boardReads.push({ roomSessionId, agentId })
    return mocks.cards.get(roomSessionId) ?? []
  },
}))

const { agentSelfGateway } = await import('../gateways.js')

const NOW = Date.now()

function seed(sessions: Array<Record<string, unknown>>): void {
  mocks.sessions = sessions
  mocks.sessionsById = new Map(sessions.map(session => [session.id as string, session]))
}

beforeEach(() => {
  mocks.cards.clear()
  mocks.boardReads.length = 0
  seed([
    { id: 'exec-fe', kind: 'agent', agentId: 'fe', updatedAt: NOW },
    {
      id: 'room-1',
      name: '官网改版组',
      kind: 'room',
      updatedAt: NOW,
      room: { memberAgentIds: ['fe', 'be'] },
    },
    {
      id: 'dm-user-fe',
      name: '小李',
      kind: 'room',
      updatedAt: NOW - 24 * 60 * 60 * 1000,
      room: { memberAgentIds: ['fe'], dm: true },
    },
    {
      id: 'dm-fe-be',
      name: '小李 · 小王',
      kind: 'room',
      updatedAt: NOW,
      room: { memberAgentIds: ['fe', 'be'], dm: true },
    },
  ])
})

describe('agentSelfGateway', () => {
  it('returns null for a session with no agent — no "self" to speak of', () => {
    seed([{ id: 'plain', kind: 'chat', updatedAt: NOW }])
    expect(agentSelfGateway.read('plain')).toBeNull()
    expect(agentSelfGateway.read('missing')).toBeNull()
  })

  it('splits rooms from dms, and names the person on the other side', () => {
    const facts = agentSelfGateway.read('exec-fe')
    expect(facts?.rooms).toEqual([{ name: '官网改版组', lastActiveAt: NOW }])
    // 用户 dm 房写用户的名字(不是房名);双成员 dm 房写对面那位同事。
    expect(facts?.dms).toEqual([
      { name: '一天', lastActiveAt: NOW - 24 * 60 * 60 * 1000 },
      { name: '小王', lastActiveAt: NOW },
    ])
  })

  it('collects cards from every room this agent is actually in, and nowhere else', () => {
    mocks.cards.set('room-1', [{ id: 'card-1', title: '登录页', status: 'doing' }])
    mocks.cards.set('dm-user-fe', [{ id: 'card-2', title: '周报', status: 'blocked' }])
    mocks.cards.set('room-other', [{ id: 'card-x', title: '别人的活', status: 'doing' }])

    const facts = agentSelfGateway.read('exec-fe')
    expect(facts?.cards.map(card => card.id).sort()).toEqual(['card-1', 'card-2'])
    // 看板按房查,而且只查这个 agent 在的房。
    expect(mocks.boardReads.every(read => read.agentId === 'fe')).toBe(true)
    expect(mocks.boardReads.map(read => read.roomSessionId)).not.toContain('room-other')
  })

  it('gives an agent with nothing going on three empty lists (the provider then emits nothing)', () => {
    seed([{ id: 'exec-solo', kind: 'agent', agentId: 'be', updatedAt: NOW }])
    expect(agentSelfGateway.read('exec-solo')).toEqual({ cards: [], rooms: [], dms: [] })
  })
})
