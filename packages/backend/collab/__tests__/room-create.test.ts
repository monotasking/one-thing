/**
 * 建群房的唯一入口(架构收敛 C3 §4 / A5)。
 *
 * 这里盯两件事:
 *
 *  1. **规则书**:成员归一、查无此人、PM 在册、budgets 取值、dm 只认字面 true。
 *     从前这一套在 Electron handler 与 CLI daemon 里各有一份删节版,两份都不是
 *     完整的那一份;
 *  2. **落库的原子性**:一间房是两次写,第二次写失败必须把半成品会话删掉。一条
 *     `kind` 缺失的会话在列表里长得像普通聊天,点进去是一间没有成员的"群",而
 *     没人知道它是怎么来的。
 *
 * 「创建与更新对退休 agent 给同一个答案」那条钉在 coordinator-retired-member
 * 里 —— 它要的是两个函数在同一套假件下对照,放在那边才对得起来。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeSession {
  id: string
  name: string
  kind?: string
  room?: Record<string, unknown>
  messages: unknown[]
}

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, FakeSession>(),
  agents: new Map<string, { id: string; name: string; status?: string }>(),
  collabWriteOk: true,
  deleted: [] as string[],
}))

vi.mock('../../store.js', () => ({
  getSession: (id: string) => mocks.sessions.get(id),
  createSessionWithoutFocus: (id: string, name: string) => {
    const session: FakeSession = { id, name, messages: [] }
    mocks.sessions.set(id, session)
    return session
  },
  updateSessionCollab: (id: string, fields: { kind?: string; room?: Record<string, unknown> }) => {
    if (!mocks.collabWriteOk) return false
    const session = mocks.sessions.get(id)
    if (!session) return false
    if (fields.kind !== undefined) session.kind = fields.kind
    if (fields.room !== undefined) session.room = fields.room
    return true
  },
  deleteSession: (id: string) => {
    mocks.deleted.push(id)
    mocks.sessions.delete(id)
    return { deletedIds: [id] }
  },
}))

vi.mock('../../wiring/agents/index.js', () => ({
  findAgent: (id: string) => mocks.agents.get(id) ?? null,
}))

const { ensureCollabGroupRoom } = await import('../room-create.js')

const ID = 'room-new'

function room(): FakeSession['room'] {
  return (mocks.sessions.get(ID) as FakeSession | undefined)?.room
}

beforeEach(() => {
  mocks.sessions.clear()
  mocks.agents.clear()
  mocks.deleted.length = 0
  mocks.collabWriteOk = true
  mocks.agents.set('pm', { id: 'pm', name: '阿明' })
  mocks.agents.set('fe', { id: 'fe', name: '小李' })
})

describe('ensureCollabGroupRoom — 校验', () => {
  it('至少要有一位成员', () => {
    expect(ensureCollabGroupRoom('群', { memberAgentIds: [] }, { sessionId: ID }))
      .toEqual({ success: false, error: 'Room needs at least one member agent' })
    expect(ensureCollabGroupRoom('群', undefined, { sessionId: ID }).error)
      .toBe('Room needs at least one member agent')
    expect(mocks.sessions.size).toBe(0)
  })

  it('非字符串/空串成员被滤掉,重复成员去重', () => {
    const created = ensureCollabGroupRoom('群', {
      memberAgentIds: ['pm', '', null, 42, 'pm', 'fe'],
    }, { sessionId: ID })
    expect(created.success).toBe(true)
    expect(room()?.memberAgentIds).toEqual(['pm', 'fe'])
  })

  it('查无此人:报出是哪一个 id,一个字都不写', () => {
    expect(ensureCollabGroupRoom('群', { memberAgentIds: ['pm', 'ghost'] }, { sessionId: ID }))
      .toEqual({ success: false, error: 'Unknown agent: ghost' })
    expect(mocks.sessions.size).toBe(0)
  })

  it('PM 必须在册', () => {
    expect(ensureCollabGroupRoom('群', { memberAgentIds: ['pm'], pmAgentId: 'fe' }, { sessionId: ID }))
      .toEqual({ success: false, error: 'PM must be a room member' })
  })

  it('budgets 归一:负数与非数一律忽略,整数闸取整', () => {
    ensureCollabGroupRoom('群', {
      memberAgentIds: ['pm'],
      budgets: { dailyCostUSD: 12.5, maxChain: 3.9, maxTurnToolCalls: -1, maxTurnSayCalls: '4' },
    }, { sessionId: ID })
    expect(room()?.budgets).toEqual({ dailyCostUSD: 12.5, maxChain: 3 })
  })

  it('budgets 全被滤掉时不落一个空对象', () => {
    ensureCollabGroupRoom('群', { memberAgentIds: ['pm'], budgets: { dailyCostUSD: -5 } }, { sessionId: ID })
    expect(room()).not.toHaveProperty('budgets')
  })

  it('并行化那几个闸也过得来 —— 这条路从前只认 dailyCostUSD 和 maxChain', () => {
    ensureCollabGroupRoom('群', {
      memberAgentIds: ['pm'],
      budgets: { maxConcurrentTurns: 2, maxTurnSayCalls: 5 },
    }, { sessionId: ID })
    expect(room()?.budgets).toEqual({ maxConcurrentTurns: 2, maxTurnSayCalls: 5 })
  })

  it('dm 只认字面 true —— 这个字段会改变房间的激活语义', () => {
    ensureCollabGroupRoom('群', { memberAgentIds: ['pm'], dm: 1 }, { sessionId: ID })
    expect(room()).not.toHaveProperty('dm')

    mocks.sessions.clear()
    ensureCollabGroupRoom('私聊', { memberAgentIds: ['pm'], dm: true }, { sessionId: ID })
    expect(room()?.dm).toBe(true)
  })
})

describe('ensureCollabGroupRoom — 落库的原子性', () => {
  it('第二次写失败时把半成品会话删掉再报错', () => {
    mocks.collabWriteOk = false
    expect(ensureCollabGroupRoom('群', { memberAgentIds: ['pm'] }, { sessionId: ID }))
      .toEqual({ success: false, error: 'Failed to write room config' })
    expect(mocks.deleted).toEqual([ID])
    expect(mocks.sessions.get(ID)).toBeUndefined()
  })

  it('成功时返回的是落库之后的那条会话,不是建出来那一刻的空壳', () => {
    const created = ensureCollabGroupRoom('群', { memberAgentIds: ['pm'] }, { sessionId: ID })
    expect(created.session?.kind).toBe('room')
    expect(created.session).toBe(mocks.sessions.get(ID))
    expect(mocks.deleted).toEqual([])
  })
})
