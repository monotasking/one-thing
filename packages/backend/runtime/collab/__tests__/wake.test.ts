import { describe, it, expect } from 'vitest'
import { isCollabStopMessage, routeCollabRoomWake } from '../wake.js'

const LIVE = { agentId: 'agent-a', reason: 'self-elected' as const }

describe('isCollabStopMessage', () => {
  it('认裸停止词,含标点与大小写', () => {
    for (const text of ['停', '停。', ' 停! ', 'stop', 'STOP', '别说了', '打住']) {
      expect(isCollabStopMessage(text)).toBe(true)
    }
  })

  it('带内容的句子不是喊停 —— 它该被读进当前回合,而不是把回合杀掉', () => {
    for (const text of ['先停一下,我们换个方向', '停车场那个方案呢', '不要停']) {
      expect(isCollabStopMessage(text)).toBe(false)
    }
  })

  /**
   * 2026-08-01 真机:用户打的「stop掉。」当时不匹配,那次喊停整个失效——
   * 回合没中止、floorEpoch 没换代、队里 6 条激活跨重启复活。
   */
  it('认带语气/趋向后缀的裸停止词', () => {
    for (const text of ['stop掉', 'stop掉。', '停掉', '停下来', '停下来吧', '停了', '别说了啊']) {
      expect(isCollabStopMessage(text)).toBe(true)
    }
  })

  it('剥后缀不剥前缀 —— 「不要停」是相反的意思', () => {
    for (const text of ['不要停', '别停', '停不下来']) {
      expect(isCollabStopMessage(text)).toBe(false)
    }
  })

  it('空与 undefined 不是喊停', () => {
    expect(isCollabStopMessage('')).toBe(false)
    expect(isCollabStopMessage(undefined)).toBe(false)
  })
})

describe('routeCollabRoomWake', () => {
  it('没人在说话:照常另起一轮', () => {
    expect(routeCollabRoomWake({ text: '这个方案行吗' })).toBe('engage')
  })

  it('有人在说话时连发一条:并进当前回合(这张表的默认值)', () => {
    expect(routeCollabRoomWake({ text: '对了还有第二个问题', liveTurns: [LIVE] })).toBe('steer')
  })

  it('裸「停」:中止,不论有没有人在说话', () => {
    expect(routeCollabRoomWake({ text: '停', liveTurns: [LIVE] })).toBe('abort')
    expect(routeCollabRoomWake({ text: 'stop' })).toBe('abort')
  })

  it('@ 了正在说话的这位:仍然并进去 —— 它马上就会读到', () => {
    expect(routeCollabRoomWake({
      text: '@小李 再补一句',
      mentionedAgentIds: ['agent-a'],
      liveTurns: [LIVE],
    })).toBe('steer')
  })

  it('@ 了别人:另起一轮 —— 不能让正在说话的那位替被点名的人回答', () => {
    expect(routeCollabRoomWake({
      text: '@小王 你看呢',
      mentionedAgentIds: ['agent-b'],
      liveTurns: [LIVE],
    })).toBe('engage')
  })

  it('同时 @ 了在说话的和另一个人:仍然另起一轮(被点名的那位必须能应)', () => {
    expect(routeCollabRoomWake({
      text: '@小李 @小王 你们俩谁来',
      mentionedAgentIds: ['agent-a', 'agent-b'],
      liveTurns: [LIVE],
    })).toBe('engage')
  })

  it('只有附件没有正文:不是空消息', () => {
    expect(routeCollabRoomWake({ text: '', hasPayload: true, liveTurns: [LIVE] })).toBe('steer')
  })

  it('空且无附件:有人在说话时什么都不做', () => {
    expect(routeCollabRoomWake({ text: '   ', liveTurns: [LIVE] })).toBe('drop')
  })

  it('空且无附件、也没人在说话:交回既有决策路径,这张表不改它', () => {
    expect(routeCollabRoomWake({ text: '' })).toBe('engage')
  })

  it('多人同时在说话:@ 到的人都在说 → 并进去', () => {
    expect(routeCollabRoomWake({
      text: '@小李 @小王 你们俩再确认下',
      mentionedAgentIds: ['agent-a', 'agent-b'],
      liveTurns: [{ agentId: 'agent-a' }, { agentId: 'agent-b' }],
    })).toBe('steer')
  })

  it('多人同时在说话:@ 到的人里有一个没在说 → 另起一轮', () => {
    expect(routeCollabRoomWake({
      text: '@小赵 你来',
      mentionedAgentIds: ['agent-c'],
      liveTurns: [{ agentId: 'agent-a' }, { agentId: 'agent-b' }],
    })).toBe('engage')
  })

  it('mention 路由只看 @ 谁,不看在跑的回合是怎么起来的', () => {
    for (const reason of ['mention', 'self-elected', 'task-event', 'schedule'] as const) {
      expect(routeCollabRoomWake({
        text: '@小王 你看呢',
        mentionedAgentIds: ['agent-b'],
        liveTurns: [{ agentId: 'agent-a', reason }],
      })).toBe('engage')
    }
  })
})
