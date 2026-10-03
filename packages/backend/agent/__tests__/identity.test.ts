/**
 * A3(M6):派生 id 单点属主的约定测试。
 *
 * 这些字面量断言是**故意**写死的:它们断言的正是被持久化的约定本身,一条会话
 * id 换了形状就是数据迁移事故。所以这里的字面量与 identity.ts 里的前缀常量
 * 互为对照,而不是重复。
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_DM_PAIR_ROOM_PREFIX,
  AGENT_DM_PAIR_SEPARATOR,
  AGENT_DM_ROOM_PREFIX,
  AGENT_EXEC_SESSION_PREFIX,
  agentDmRoomId,
  execSessionId,
  execSessionIdsForScan,
  isAgentDmRoomId,
  isAgentExecSessionId,
  isAgentInfraSessionId,
  userDmRoomId,
} from '../identity.js'
import { collabAgentSessionId, collabAgentSessionIdsForScan } from '../../collab/agent-session.js'

describe('execSessionId', () => {
  it('每群每 agent 一条:带房间的形态', () => {
    expect(execSessionId('fe', 'room-1')).toBe('agent-exec-fe-room-1')
    expect(AGENT_EXEC_SESSION_PREFIX).toBe('agent-exec-')
  })

  it('省略房间时是旧的全局形态(迁移期扫描 + 只看前缀的读者)', () => {
    expect(execSessionId('fe')).toBe('agent-exec-fe')
    expect(execSessionId('fe', '')).toBe('agent-exec-fe')
    expect(execSessionId('fe', '   ')).toBe('agent-exec-fe')
  })

  it('幂等键:空白归一,空 id 没有会话', () => {
    expect(execSessionId('  fe  ')).toBe(execSessionId('fe'))
    expect(execSessionId('fe', '  room-1  ')).toBe(execSessionId('fe', 'room-1'))
    expect(execSessionId('')).toBeNull()
    expect(execSessionId('   ')).toBeNull()
    expect(execSessionId('fe')).not.toBe(execSessionId('pm'))
  })

  it('扫描集 = 新形态 + 旧全局形态,顺序固定', () => {
    expect(execSessionIdsForScan('fe', 'room-1')).toEqual(['agent-exec-fe-room-1', 'agent-exec-fe'])
    expect(execSessionIdsForScan('', 'room-1')).toEqual([])
  })
})

/**
 * 行为守恒:collab 的旧名字现在是委托,输出必须与迁移前逐字节一致。既有调用点
 * (app/collab/agent-session.ts、turn.ts、budget.ts、queue.ts)读的是这两个名字。
 */
describe('collabAgentSessionId 兼容(迁移后逐字节不变)', () => {
  it('旧导出与 identity 的输出完全相同', () => {
    const cases: Array<[string, string | undefined]> = [
      ['fe', 'room-1'],
      ['fe', undefined],
      ['  fe  ', '  room-1  '],
      ['agent-research', 'room-2'],
      ['', 'room-1'],
      ['   ', undefined],
    ]
    for (const [agentId, roomSessionId] of cases) {
      expect(collabAgentSessionId(agentId, roomSessionId)).toBe(execSessionId(agentId, roomSessionId))
    }
    // 迁移前的产出快照(硬编码,不经被测代码算出来)
    expect(collabAgentSessionId('fe', 'room-1')).toBe('agent-exec-fe-room-1')
    expect(collabAgentSessionId('fe')).toBe('agent-exec-fe')
    expect(collabAgentSessionId('')).toBeNull()
  })

  it('扫描集的旧名字同样是委托', () => {
    expect(collabAgentSessionIdsForScan('fe', 'room-1')).toEqual(execSessionIdsForScan('fe', 'room-1'))
    expect(collabAgentSessionIdsForScan('fe', 'room-1')).toEqual(['agent-exec-fe-room-1', 'agent-exec-fe'])
  })
})

describe('userDmRoomId(本期无消费方,只立约定)', () => {
  it('单成员 dm 房 id', () => {
    expect(userDmRoomId('fe')).toBe('agent-dm-fe')
    expect(AGENT_DM_ROOM_PREFIX).toBe('agent-dm-')
  })

  it('空白归一,空 id 无房', () => {
    expect(userDmRoomId('  fe  ')).toBe('agent-dm-fe')
    expect(userDmRoomId('')).toBeNull()
    expect(userDmRoomId('   ')).toBeNull()
  })
})

describe('agentDmRoomId(本期无消费方,只立约定)', () => {
  it('字典序排序 → 同一对 agent 无论谁发起都是同一间房', () => {
    expect(agentDmRoomId('fe', 'pm')).toBe('agent-dm-room-fe--pm')
    expect(agentDmRoomId('pm', 'fe')).toBe('agent-dm-room-fe--pm')
    expect(AGENT_DM_PAIR_ROOM_PREFIX).toBe('agent-dm-room-')
    expect(AGENT_DM_PAIR_SEPARATOR).toBe('--')
  })

  it('双横线分隔:agentId 含单横线时不与另一对撞车', () => {
    // 单横线分隔会让 ('a-b','c') 与 ('a','b-c') 撞成同一间房。
    expect(agentDmRoomId('a-b', 'c')).toBe('agent-dm-room-a-b--c')
    expect(agentDmRoomId('a', 'b-c')).toBe('agent-dm-room-a--b-c')
    expect(agentDmRoomId('a-b', 'c')).not.toBe(agentDmRoomId('a', 'b-c'))
  })

  it('排序按 UTF-16 码元序,与 locale 无关(id 要落库)', () => {
    expect(agentDmRoomId('Z', 'a')).toBe('agent-dm-room-Z--a')
    expect(agentDmRoomId('a', 'Z')).toBe('agent-dm-room-Z--a')
  })

  it('空白归一;自己与自己没有私聊房', () => {
    expect(agentDmRoomId('  fe  ', ' pm ')).toBe('agent-dm-room-fe--pm')
    expect(agentDmRoomId('fe', 'fe')).toBeNull()
    expect(agentDmRoomId('fe', '  fe  ')).toBeNull()
    expect(agentDmRoomId('fe', '')).toBeNull()
    expect(agentDmRoomId('', 'pm')).toBeNull()
  })
})

describe('isAgentInfraSessionId', () => {
  it('exec 族与 dm 族都算基础设施', () => {
    expect(isAgentInfraSessionId(execSessionId('fe', 'room-1')!)).toBe(true)
    expect(isAgentInfraSessionId(execSessionId('fe')!)).toBe(true)
    expect(isAgentInfraSessionId(userDmRoomId('fe')!)).toBe(true)
    expect(isAgentInfraSessionId(agentDmRoomId('fe', 'pm')!)).toBe(true)
  })

  it('普通会话与房间不算', () => {
    expect(isAgentInfraSessionId('room-1')).toBe(false)
    expect(isAgentInfraSessionId('work-1')).toBe(false)
    expect(isAgentInfraSessionId('session-abc')).toBe(false)
    expect(isAgentInfraSessionId(undefined)).toBe(false)
    expect(isAgentInfraSessionId(null)).toBe(false)
    expect(isAgentInfraSessionId('')).toBe(false)
  })

  it('两族各自的窄判定不串味', () => {
    expect(isAgentExecSessionId('agent-exec-fe')).toBe(true)
    expect(isAgentExecSessionId('agent-dm-fe')).toBe(false)
    expect(isAgentDmRoomId('agent-dm-fe')).toBe(true)
    // 双成员房前缀是单成员房前缀的子命名空间 —— 一次判完是刻意的。
    expect(isAgentDmRoomId('agent-dm-room-fe--pm')).toBe(true)
    expect(isAgentDmRoomId('agent-exec-fe')).toBe(false)
  })
})

/**
 * 纪律测试:本模块只有构造,没有解析。一旦有人加了反函数,这条会红 —— 反解
 * 靠猜分隔符,猜错了就是把两个 agent 的历史合成一个人(agentId 可含横线)。
 */
describe('禁反解纪律', () => {
  it('模块导出面里没有任何 parse/extract 形状的函数', async () => {
    const identity = await import('../identity.js')
    const suspicious = Object.keys(identity).filter(name => /^(parse|extract|split|decode)/i.test(name)
      || /AgentIdFrom|IdFromSession/i.test(name))
    expect(suspicious).toEqual([])
  })
})
