/**
 * A3(M6):在场面的纯规则 —— 四路分类只读结构化字段。
 *
 * 口径与侧栏 Agent 组(packages/renderer/utils/agent-sessions.ts
 * `buildAgentRosterRows`)对齐:那边也是 kind==='agent' + agentId 分组,这边的
 * execSessionIds 是同一集合。
 */
import { describe, expect, it } from 'vitest'
import {
  computeAgentPresence,
  hasAgentReference,
  isEmptyAgentPresence,
  type AgentPresenceSessionLike,
} from '../presence.js'
import { userDmRoomId } from '../identity.js'

function room(id: string, memberAgentIds: string[], extra: { dm?: boolean } = {}): AgentPresenceSessionLike {
  return { id, kind: 'room', room: { memberAgentIds, ...extra } }
}

function exec(id: string, agentId: string, roomSessionId?: string): AgentPresenceSessionLike {
  return { id, kind: 'agent', agentId, collab: roomSessionId ? { roomSessionId } : undefined }
}

function work(id: string, agentId: string, roomSessionId = 'room-1', taskId = 't-1'): AgentPresenceSessionLike {
  return { id, kind: 'work', agentId, collab: { roomSessionId, taskId } }
}

describe('computeAgentPresence:四路分类', () => {
  it('房间 / 执行会话 / 工作台会话各归各位', () => {
    const sessions: AgentPresenceSessionLike[] = [
      room('room-1', ['fe', 'pm']),
      room('room-2', ['fe']),
      exec('agent-exec-fe-room-1', 'fe', 'room-1'),
      exec('agent-exec-fe-room-2', 'fe', 'room-2'),
      work('work-1', 'fe'),
      { id: 'chat-1', kind: 'chat', agentId: 'fe' },
    ]

    expect(computeAgentPresence('fe', sessions)).toEqual({
      dmRoomId: null,
      // room-2 只有 fe 一个成员,但既无 dm 标记、id 也不是 dm 幂等键 → 还是普通房
      roomSessionIds: ['room-1', 'room-2'],
      execSessionIds: ['agent-exec-fe-room-1', 'agent-exec-fe-room-2'],
      workSessionIds: ['work-1'],
    })
  })

  it('kind=chat 的直聊会话不进任何一路(那是 persona 绑定,不是在场)', () => {
    const presence = computeAgentPresence('fe', [{ id: 'chat-1', kind: 'chat', agentId: 'fe' }])
    expect(isEmptyAgentPresence(presence)).toBe(true)
  })

  it('无关会话不误收:别人的房间、别人的执行会话、无主会话', () => {
    const sessions: AgentPresenceSessionLike[] = [
      room('room-9', ['pm']),
      exec('agent-exec-pm-room-9', 'pm', 'room-9'),
      work('work-9', 'pm', 'room-9'),
      { id: 'agent-exec-orphan', kind: 'agent' },
      { id: 'room-nomembers', kind: 'room', room: { memberAgentIds: [] } },
      { id: 'room-noconfig', kind: 'room' },
    ]

    expect(computeAgentPresence('fe', sessions)).toEqual({
      dmRoomId: null,
      roomSessionIds: [],
      execSessionIds: [],
      workSessionIds: [],
    })
  })

  it('空输入 / 空 agentId / undefined 一律全空,不炸', () => {
    const empty = { dmRoomId: null, roomSessionIds: [], execSessionIds: [], workSessionIds: [] }
    expect(computeAgentPresence('fe', [])).toEqual(empty)
    expect(computeAgentPresence('fe', undefined)).toEqual(empty)
    expect(computeAgentPresence('fe', null)).toEqual(empty)
    expect(computeAgentPresence('', [room('room-1', ['fe'])])).toEqual(empty)
    expect(computeAgentPresence('   ', [room('room-1', ['fe'])])).toEqual(empty)
    expect(computeAgentPresence(undefined, [room('room-1', ['fe'])])).toEqual(empty)
  })

  it('agentId 前后空白照样认得出来', () => {
    const presence = computeAgentPresence('  fe  ', [room('room-1', ['fe'])])
    expect(presence.roomSessionIds).toEqual(['room-1'])
  })
})

describe('computeAgentPresence:dm 房识别', () => {
  it('带 room.dm 标记的单成员房 → dmRoomId,且不再计入房间数', () => {
    const sessions = [room('whatever-id', ['fe'], { dm: true }), room('room-1', ['fe', 'pm'])]
    expect(computeAgentPresence('fe', sessions)).toMatchObject({
      dmRoomId: 'whatever-id',
      roomSessionIds: ['room-1'],
    })
  })

  it('没有标记时,id 恰是 userDmRoomId 幂等键的单成员房也算(构造+比对,非反解)', () => {
    const dmId = userDmRoomId('fe')!
    expect(computeAgentPresence('fe', [room(dmId, ['fe'])])).toMatchObject({
      dmRoomId: 'agent-dm-fe',
      roomSessionIds: [],
    })
  })

  it('双成员房即使带 dm 标记也算房间 —— dmRoomId 那一栏只给用户私聊', () => {
    const sessions = [room('agent-dm-room-fe--pm', ['fe', 'pm'], { dm: true })]
    expect(computeAgentPresence('fe', sessions)).toMatchObject({
      dmRoomId: null,
      roomSessionIds: ['agent-dm-room-fe--pm'],
    })
  })

  it('别人的 dm 房不算我的', () => {
    const sessions = [room(userDmRoomId('pm')!, ['pm'], { dm: true })]
    expect(computeAgentPresence('fe', sessions).dmRoomId).toBeNull()
  })

  it('两间都够格时只认第一间,第二间退回房间(结果确定,不看运气)', () => {
    const sessions = [room('dm-a', ['fe'], { dm: true }), room('dm-b', ['fe'], { dm: true })]
    expect(computeAgentPresence('fe', sessions)).toMatchObject({
      dmRoomId: 'dm-a',
      roomSessionIds: ['dm-b'],
    })
  })
})

describe('isEmptyAgentPresence(在场四路)', () => {
  it('四路任一非空即算在场', () => {
    expect(isEmptyAgentPresence(computeAgentPresence('fe', [room('room-1', ['fe'])]))).toBe(false)
    expect(isEmptyAgentPresence(computeAgentPresence('fe', [exec('agent-exec-fe', 'fe')]))).toBe(false)
    expect(isEmptyAgentPresence(computeAgentPresence('fe', [work('work-1', 'fe')]))).toBe(false)
    expect(isEmptyAgentPresence(computeAgentPresence('fe', [room(userDmRoomId('fe')!, ['fe'])]))).toBe(false)
    expect(isEmptyAgentPresence(computeAgentPresence('fe', [room('room-9', ['pm'])]))).toBe(true)
  })
})

/**
 * A2 的硬删判定(§3.2)。刻意比在场面**宽一格**:履历四栏按定义不认直聊会话,
 * 但直聊会话的 agentId 就是 persona 绑定,那批消息的署名指着这个 id —— 按在场
 * 面判定就会把一个有历史署名的 agent 当成"从未被引用"删掉。
 */
describe('hasAgentReference(A2 硬删判定)', () => {
  it('在场四路任一命中即算被引用', () => {
    expect(hasAgentReference('fe', [room('room-1', ['fe'])])).toBe(true)
    expect(hasAgentReference('fe', [exec('agent-exec-fe', 'fe')])).toBe(true)
    expect(hasAgentReference('fe', [work('work-1', 'fe')])).toBe(true)
    expect(hasAgentReference('fe', [room(userDmRoomId('fe')!, ['fe'])])).toBe(true)
  })

  it('直聊会话的 persona 绑定也算引用(在场面看不见的那一格)', () => {
    const chat: AgentPresenceSessionLike = { id: 'chat-1', kind: 'chat', agentId: 'fe' }
    expect(isEmptyAgentPresence(computeAgentPresence('fe', [chat]))).toBe(true)
    expect(hasAgentReference('fe', [chat])).toBe(true)
  })

  it('会话元数据只递得出 agentId(server 的摘要形状)也判得出来', () => {
    expect(hasAgentReference('fe', [{ agentId: 'fe' }])).toBe(true)
    expect(hasAgentReference('fe', [{ agentId: 'pm' }])).toBe(false)
  })

  it('谁都没提到过它 → 允许硬删;空 id / 空列表同理', () => {
    expect(hasAgentReference('fe', [room('room-9', ['pm']), { id: 'chat-1', kind: 'chat', agentId: 'pm' }]))
      .toBe(false)
    expect(hasAgentReference('fe', [])).toBe(false)
    expect(hasAgentReference('', [room('room-1', ['fe'])])).toBe(false)
    expect(hasAgentReference(undefined, undefined)).toBe(false)
  })
})
