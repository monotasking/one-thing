import { describe, expect, it } from 'vitest'
import {
  AgentSelfProvider,
  formatCoarseAge,
  type AgentSelfStateFacts,
} from '../providers/agent-self.js'
import { RESERVED_NAMES } from '../types.js'

const DAY = 24 * 60 * 60 * 1000
/** 2026-08-01 10:00 本地时间 —— 天粒度断言要一个明确的"今天"。 */
const NOW = new Date(2026, 7, 1, 10, 0, 0).getTime()

function provider(facts: AgentSelfStateFacts | null, now = NOW) {
  return new AgentSelfProvider({ read: () => facts }, { now: () => now })
}

const ctx = { sessionId: 'session-1' }

const EMPTY: AgentSelfStateFacts = { cards: [], rooms: [], dms: [] }

describe('agent self-state provider', () => {
  it('reserves its three names so nobody can shadow them', () => {
    for (const name of ['my_cards', 'my_rooms', 'my_dms']) {
      expect(RESERVED_NAMES as readonly string[]).toContain(name)
      expect(provider(EMPTY).claims(name)).toBe(true)
    }
    expect(provider(EMPTY).claims('my_other_thing')).toBe(false)
  })

  it('states the in-flight cards as short id / title / status', () => {
    const [cards] = provider({
      ...EMPTY,
      cards: [
        { id: 'a1b2c3d4-1111-2222-3333-444444444444', title: '给项目加 notes.txt', status: 'doing' },
        { id: 'ffffeeee-5555-6666-7777-888888888888', title: '重构配置读取', status: 'blocked' },
      ],
    }).list(ctx)

    expect(cards.name).toBe('my_cards')
    expect(cards.value).toBe('#a1b2c3d4「给项目加 notes.txt」doing; #ffffeeee「重构配置读取」blocked')
    expect(cards.readonly).toBe(true)
    expect(cards.state).toBe(true)
    // W10:第一人称说在 description 里 —— 一个光秃秃的状态词会让模型用第三人称
    // 转述自己的卡。只陈述,不指挥。
    expect(cards.description).toContain('you are the one executing them')
    expect(cards.description).not.toContain('you should')
    expect(cards.description).not.toContain('remember to')
  })

  it('renders room and dm activity at day granularity, never minutes', () => {
    const [rooms, dms] = provider({
      cards: [],
      rooms: [
        { name: '官网改版组', lastActiveAt: NOW - 5 * 60 * 1000 },
        { name: '内部工具组', lastActiveAt: NOW - 3 * DAY },
      ],
      dms: [{ name: '一天', lastActiveAt: NOW - DAY }],
    }).list(ctx)

    expect(rooms.value).toBe('「内部工具组」3 天前; 「官网改版组」今天')
    expect(dms.value).toBe('「一天」昨天')
    expect(rooms.value).not.toMatch(/分钟|minute/)
  })

  it('keeps consecutive turns byte-identical within the same day', () => {
    // ⚠️ 值里带每 tick 都变的数字 = turn 通道去重失效,每回合注入一块新的
    // (background-jobs / music-radio 都为这条栽过跟头)。
    const facts: AgentSelfStateFacts = {
      cards: [],
      rooms: [{ name: '官网改版组', lastActiveAt: NOW - 2 * 60 * 60 * 1000 }],
      dms: [],
    }
    const early = provider(facts, NOW).list(ctx)[0].value
    const later = provider(facts, NOW + 90 * 60 * 1000).list(ctx)[0].value
    expect(later).toBe(early)
    // 跨到第二天才允许翻一次(而且只翻这一次)。
    const tomorrow = provider(facts, NOW + DAY).list(ctx)[0].value
    expect(tomorrow).not.toBe(early)
  })

  it('produces nothing for the empty parts — an empty plate is not worth a prompt line', () => {
    expect(provider(EMPTY).list(ctx)).toEqual([])
    // 会话没绑 agent(或宿主没有协作子系统)时整组消失。
    expect(provider(null).list(ctx)).toEqual([])
    const onlyRooms = provider({ ...EMPTY, rooms: [{ name: 'r' }] }).list(ctx)
    expect(onlyRooms.map(variable => variable.name)).toEqual(['my_rooms'])
    // 没有时间戳就只写名字,不编一个"今天"出来。
    expect(onlyRooms[0].value).toBe('「r」')
  })

  it('renders the same bytes whatever order the board hands the cards back in', () => {
    const cards = [
      { id: 'bbbb0000', title: 'B', status: 'doing' as const },
      { id: 'aaaa1111', title: 'A', status: 'blocked' as const },
    ]
    const forwards = provider({ ...EMPTY, cards }).list(ctx)[0].value
    const backwards = provider({ ...EMPTY, cards: [...cards].reverse() }).list(ctx)[0].value
    expect(backwards).toBe(forwards)
    expect(forwards.startsWith('#aaaa1111')).toBe(true)
  })

  it('shortens a runaway card title instead of eating the whole budget', () => {
    const [cards] = provider({
      ...EMPTY,
      cards: [{ id: 'a1b2c3d4', title: '标'.repeat(80), status: 'doing' }],
    }).list(ctx)
    expect(cards.value.length).toBeLessThan(60)
    expect(cards.value).toContain('…')
  })
})

describe('formatCoarseAge', () => {
  it('speaks in days, and only in days', () => {
    expect(formatCoarseAge(NOW - 60 * 1000, NOW)).toBe('今天')
    expect(formatCoarseAge(NOW - DAY, NOW)).toBe('昨天')
    expect(formatCoarseAge(NOW - 3 * DAY, NOW)).toBe('3 天前')
    expect(formatCoarseAge(NOW - 90 * DAY, NOW)).toBe('30 天以上没动静')
    // 未来时间戳(时钟回拨/多机写入)不该渲染成负数天。
    expect(formatCoarseAge(NOW + DAY, NOW)).toBe('今天')
  })
})
