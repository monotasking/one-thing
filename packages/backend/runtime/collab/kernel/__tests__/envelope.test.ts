import { describe, expect, it } from 'vitest'

import {
  ACTOR_EVENT_ID_PREFIX,
  actorRefEquals,
  createActorEvent,
  createActorEventId,
  createSeenActorEventWindow,
  formatActorRef,
  parseActorRef,
} from '../envelope.js'

describe('actor envelope', () => {
  it('生成带前缀的唯一事件 id', () => {
    const a = createActorEventId()
    const b = createActorEventId()
    expect(a.startsWith(ACTOR_EVENT_ID_PREFIX)).toBe(true)
    expect(a).not.toBe(b)
  })

  it('接受注入的 id 与时刻 —— 重放的确定性全靠这一条', () => {
    const event = createActorEvent({
      id: 'evt-fixed',
      at: 1000,
      type: 'room:posted',
      from: { kind: 'user', id: 'u1' },
      to: { kind: 'agent', id: 'a1' },
      payload: { hello: 'world' },
    })
    expect(event).toEqual({
      id: 'evt-fixed',
      at: 1000,
      type: 'room:posted',
      from: { kind: 'user', id: 'u1' },
      to: { kind: 'agent', id: 'a1' },
      payload: { hello: 'world' },
    })
  })

  it('地址在扁平形态与结构形态之间往返', () => {
    const ref = { kind: 'agent', id: 'agent-exec-x-room:1' }
    expect(formatActorRef(ref)).toBe('agent:agent-exec-x-room:1')
    // id 里含冒号(会话 id 就长这样):只切第一个冒号
    expect(parseActorRef(formatActorRef(ref))).toEqual(ref)
  })

  it('形状不对的地址返回 null 而不是硬猜', () => {
    expect(parseActorRef('noseparator')).toBeNull()
    expect(parseActorRef(':leading')).toBeNull()
    expect(parseActorRef('trailing:')).toBeNull()
  })

  it('地址相等按 kind + id', () => {
    expect(actorRefEquals({ kind: 'room', id: 'r1' }, { kind: 'room', id: 'r1' })).toBe(true)
    expect(actorRefEquals({ kind: 'room', id: 'r1' }, { kind: 'agent', id: 'r1' })).toBe(false)
  })
})

describe('seen event window', () => {
  it('第二次 remember 同一个 id 返回 false(= 这是重投)', () => {
    const window = createSeenActorEventWindow(4)
    expect(window.remember('e1')).toBe(true)
    expect(window.remember('e1')).toBe(false)
    expect(window.has('e1')).toBe(true)
    expect(window.size).toBe(1)
  })

  it('按插入序淘汰,容量封顶', () => {
    const window = createSeenActorEventWindow(3)
    for (const id of ['e1', 'e2', 'e3', 'e4']) window.remember(id)
    expect(window.size).toBe(3)
    expect(window.has('e1')).toBe(false)
    expect(window.snapshot()).toEqual(['e2', 'e3', 'e4'])
  })

  it('从快照恢复,只保留最近的一段', () => {
    const window = createSeenActorEventWindow(2, ['old', 'e1', 'e2'])
    expect(window.snapshot()).toEqual(['e1', 'e2'])
    expect(window.has('old')).toBe(false)
  })

  it('容量下限是 1 —— 传 0 不该退化成「什么都不记」', () => {
    const window = createSeenActorEventWindow(0)
    expect(window.capacity).toBe(1)
    window.remember('e1')
    expect(window.has('e1')).toBe(true)
  })
})
