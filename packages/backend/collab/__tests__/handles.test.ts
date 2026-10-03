import { describe, expect, it } from 'vitest'
import {
  COLLAB_AGENT_HANDLE_CHARS,
  collabAgentHandle,
  collabAgentIdKey,
  formatCollabAgentHandle,
  parseCollabHandleMentions,
  resolveCollabAgentHandle,
  stripCollabAgentHandles,
} from '../handles.js'
import type { CollabAgentLike } from '../types.js'

const LI = { id: 'agent-3f9c1e2a-7b41-4c8d-9e21-000000000001', name: '小李', title: '后端' }
const MING = { id: 'agent-7b41c8d9-1111-2222-3333-000000000002', name: '阿明', title: '测试' }
/** 重名:文本分辨不了,句柄可以。 */
const LI2 = { id: 'agent-c0ffee11-4444-5555-6666-000000000003', name: '小李', title: '前端' }
const DEFAULT_AGENT = { id: 'default', name: '助手' }

const ROOM: CollabAgentLike[] = [LI, MING]

describe('collabAgentHandle', () => {
  it('句柄 = id 去掉 agent- 前缀后的前 8 位', () => {
    expect(collabAgentHandle(LI.id)).toBe('3f9c1e2a')
    expect(collabAgentHandle(MING.id)).toBe('7b41c8d9')
    expect(COLLAB_AGENT_HANDLE_CHARS).toBe(8)
  })

  it('短 id 原样用(内置 default agent 的 id 不是 uuid)', () => {
    expect(collabAgentHandle('default')).toBe('default')
    expect(collabAgentIdKey('default')).toBe('default')
  })

  it('前 8 位真撞车时两人同句柄 —— 响亮的失败,不是安静的错人', () => {
    const twinA = { id: 'agent-aaaaaaaa-1111-0000-0000-000000000001', name: 'A' }
    const twinB = { id: 'agent-aaaaaaaa-2222-0000-0000-000000000002', name: 'B' }
    expect(collabAgentHandle(twinA.id)).toBe(collabAgentHandle(twinB.id))
    // 解析拒绝并列出候选,而不是挑一个。
    const result = resolveCollabAgentHandle('#aaaaaaaa', [twinA, twinB])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('不止一个')
  })
})

describe('formatCollabAgentHandle', () => {
  it('名字后面拼句柄', () => {
    expect(formatCollabAgentHandle(LI.id, '小李')).toBe('小李#3f9c1e2a')
  })

  it('退休/离开本群的人照样给句柄 —— id 是真的,dm 过去会得到「已注销」', () => {
    expect(formatCollabAgentHandle('agent-deadbeef-0000', '前成员')).toBe('前成员#deadbeef')
  })

  it('没有 id 就没有句柄(用户、系统行、无名占位)', () => {
    expect(formatCollabAgentHandle(undefined, '用户')).toBe('用户')
    expect(formatCollabAgentHandle('', '系统')).toBe('系统')
  })
})

describe('resolveCollabAgentHandle', () => {
  const agents = [LI, LI2, MING]

  it('全 id 照单全收', () => {
    expect(resolveCollabAgentHandle(LI.id, agents)).toEqual({ ok: true, agentId: LI.id })
  })

  it('句柄(带不带 # 都行)', () => {
    expect(resolveCollabAgentHandle('#3f9c1e2a', agents)).toEqual({ ok: true, agentId: LI.id })
    expect(resolveCollabAgentHandle('3f9c1e2a', agents)).toEqual({ ok: true, agentId: LI.id })
  })

  it('名字#句柄:句柄说了算(名字过时也不影响)', () => {
    expect(resolveCollabAgentHandle('老李#3f9c1e2a', agents)).toEqual({ ok: true, agentId: LI.id })
  })

  it('裸名字唯一命中才算', () => {
    expect(resolveCollabAgentHandle('阿明', agents)).toEqual({ ok: true, agentId: MING.id })
    expect(resolveCollabAgentHandle('@阿明', agents)).toEqual({ ok: true, agentId: MING.id })
  })

  it('重名的裸名字拒绝,并把候选的名字#句柄列出来', () => {
    const result = resolveCollabAgentHandle('小李', agents)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('小李#3f9c1e2a')
    expect(result.ok === false && result.error).toContain('小李#c0ffee11')
  })

  it('重名带句柄就精确 —— 这正是句柄存在的理由', () => {
    expect(resolveCollabAgentHandle('小李#c0ffee11', agents)).toEqual({ ok: true, agentId: LI2.id })
  })

  it('句柄写错但名字对得上时,说清是句柄那一半错了', () => {
    const result = resolveCollabAgentHandle('阿明#deadbeef', agents)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('#7b41c8d9')
  })

  it('查无此人', () => {
    expect(resolveCollabAgentHandle('小王', agents).ok).toBe(false)
    expect(resolveCollabAgentHandle('', agents).ok).toBe(false)
  })
})

describe('parseCollabHandleMentions', () => {
  it('按句柄认人,重名精确到一个', () => {
    const mentions = parseCollabHandleMentions('@小李#c0ffee11 你看一下', [LI, LI2])
    expect(mentions).toEqual([{ agentId: LI2.id, label: '小李' }])
  })

  it('label 从名册现取,不采信模型写的名字(W14a 防冒名)', () => {
    const mentions = parseCollabHandleMentions('@随便什么名字#3f9c1e2a 在吗', ROOM)
    expect(mentions).toEqual([{ agentId: LI.id, label: '小李' }])
  })

  it('@#句柄(没写名字)也认', () => {
    expect(parseCollabHandleMentions('@#7b41c8d9 看下', ROOM))
      .toEqual([{ agentId: MING.id, label: '阿明' }])
  })

  it('多处点名去重,保持首次出现顺序', () => {
    const mentions = parseCollabHandleMentions('@阿明#7b41c8d9 和 @小李#3f9c1e2a,还有 @阿明#7b41c8d9', ROOM)
    expect(mentions.map(m => m.agentId)).toEqual([MING.id, LI.id])
  })

  it('孤零零的 #a1b2c3d4 是看板卡号,不是人', () => {
    expect(parseCollabHandleMentions('看下 #3f9c1e2a 这张卡', ROOM)).toEqual([])
  })

  it('@ 与 # 之间隔着空白就不是一次点名', () => {
    expect(parseCollabHandleMentions('@小李 看下 #3f9c1e2a', ROOM)).toEqual([])
  })

  it('认不出的句柄不算点名', () => {
    expect(parseCollabHandleMentions('@小李#deadbeef 在吗', ROOM)).toEqual([])
  })
})

describe('stripCollabAgentHandles', () => {
  it('落库前把句柄剥掉 —— 群里看到的是干净的一句话', () => {
    expect(stripCollabAgentHandles('@小李#3f9c1e2a 你看一下这个', ROOM))
      .toBe('@小李 你看一下这个')
  })

  it('@#句柄 补上现名,免得群里出现一串十六进制', () => {
    expect(stripCollabAgentHandles('@#7b41c8d9 在吗', ROOM)).toBe('@阿明 在吗')
  })

  it('认不出的原样留着(模型下一轮能看见自己写错了)', () => {
    const text = '@小李#deadbeef 在吗'
    expect(stripCollabAgentHandles(text, ROOM)).toBe(text)
  })

  it('看板卡号一个字节都不动', () => {
    const text = '这张卡 #3f9c1e2a「重构」我来'
    expect(stripCollabAgentHandles(text, ROOM)).toBe(text)
  })

  it('多处剥离,其余文本原样', () => {
    expect(stripCollabAgentHandles('@小李#3f9c1e2a 和 @阿明#7b41c8d9 一起看下 a#b', ROOM))
      .toBe('@小李 和 @阿明 一起看下 a#b')
  })

  it('剥离与解析扫的是同一批 —— 剥掉的必然是认出的', () => {
    const text = '@小李#3f9c1e2a @阿明#deadbeef'
    const mentions = parseCollabHandleMentions(text, ROOM)
    const stripped = stripCollabAgentHandles(text, ROOM)
    expect(mentions.map(m => m.agentId)).toEqual([LI.id])
    expect(stripped).toBe('@小李 @阿明#deadbeef')
  })
})
