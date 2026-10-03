/**
 * 视野窗口(history-window.ts + projection 的三路分派)。
 *
 * 这套测试守的是两条不可让步的性质,其余都是它们的推论:
 *  1. **未读永不丢** —— 折叠、上限、游标失效,任何一条路径都不能吃掉一条未读。
 *  2. **切点在一天之内恒定** —— 前缀一动,provider 的缓存(真机命中率 99.1%,
 *     单价 1/120)整块失效,发的字更少而账单贵一个数量级。
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAB_DEFAULT_HISTORY_TAIL,
  planCollabHistoryWindow,
  resolveCollabUnreadRelation,
} from '../history-window.js'
import { projectRoomHistory } from '../projection.js'
import type { CollabMessageLike } from '../types.js'

const DAY = 86_400_000
/** 2026-08-01 12:00 本地时间 —— 切点算的是本地零点,所以基准也用本地构造。 */
const NOON = new Date(2026, 7, 1, 12, 0, 0).getTime()

function say(
  id: string,
  agentId: string,
  content: string,
  timestamp: number,
  extra: Partial<CollabMessageLike> = {},
): CollabMessageLike {
  return { id, role: 'assistant', agentId, content, timestamp, source: 'collab-say', ...extra }
}

const AGENTS = [
  { id: 'a', name: 'Atlas' },
  { id: 'b', name: 'Bram' },
  { id: 'i', name: 'Iris' },
]

describe('planCollabHistoryWindow — 未读', () => {
  it('游标之后的都是未读,游标之前的不是', () => {
    const messages = [
      say('m1', 'a', '一', NOON - 3000),
      say('m2', 'b', '二', NOON - 2000),
      say('m3', 'i', '三', NOON - 1000),
    ]
    const window = planCollabHistoryWindow({ messages, seenMessageId: 'm1', now: NOON })
    expect([...window.unread]).toEqual([1, 2])
  })

  it('没有游标(第一次进这间房)= 一条未读都不产生', () => {
    const messages = [say('m1', 'a', '一', NOON - 1000)]
    const window = planCollabHistoryWindow({ messages, now: NOON })
    expect(window.unread.size).toBe(0)
  })

  it('游标失效(那条被删了)也不产生未读 —— 不能把整段历史标成新消息', () => {
    const messages = [say('m1', 'a', '一', NOON - 1000)]
    const window = planCollabHistoryWindow({ messages, seenMessageId: '已经没了', now: NOON })
    expect(window.unread.size).toBe(0)
  })

  it('自己说的话不算未读 —— 那是它写的,不是它错过的', () => {
    const messages = [
      say('m1', 'a', '别人', NOON - 3000),
      say('m2', 'b', '我自己刚说的', NOON - 2000),
      say('m3', 'i', '别人', NOON - 1000),
    ]
    const window = planCollabHistoryWindow({
      messages,
      seenMessageId: 'm1',
      selfAgentId: 'b',
      now: NOON,
    })
    expect([...window.unread]).toEqual([2])
  })

  it('drive 行不占未读名额(投影里本来就没有它)', () => {
    const messages: CollabMessageLike[] = [
      say('m1', 'a', '一', NOON - 3000),
      { id: 'd1', role: 'user', content: '<turn/>', timestamp: NOON - 2000, source: 'collab' },
      say('m2', 'i', '二', NOON - 1000),
    ]
    const window = planCollabHistoryWindow({ messages, seenMessageId: 'm1', now: NOON })
    expect([...window.unread]).toEqual([2])
  })

  it('超过上限时留最新的那些,其余退回历史并记 elided —— 不是丢掉', () => {
    const messages = Array.from({ length: 6 }, (_, index) =>
      say(`m${index}`, 'a', String(index), NOON - (6 - index) * 1000))
    const window = planCollabHistoryWindow({
      messages,
      seenMessageId: 'm0',
      now: NOON,
      unreadMax: 2,
    })
    expect([...window.unread]).toEqual([4, 5])
    expect(window.unreadElided).toBe(3)
    // 退回去的既没被折叠也没消失 —— 它们照常进 <History>。
    expect(window.folded.size).toBe(0)
  })
})

describe('planCollabHistoryWindow — 折叠', () => {
  it('早于切点的已读被折叠,今天的不动', () => {
    const messages = [
      ...Array.from({ length: 30 }, (_, index) =>
        say(`old${index}`, 'a', `旧${index}`, NOON - 3 * DAY + index * 1000)),
      say('today', 'b', '今天', NOON - 1000),
    ]
    const window = planCollabHistoryWindow({
      messages,
      seenMessageId: 'today',
      now: NOON,
      historyTailCount: 5,
    })
    // 30 条旧的,留最后 5 条,折 25 条;今天那条永远不折。
    expect(window.folded.size).toBe(25)
    expect(window.folded.has(30)).toBe(false)
  })

  it('未读永远不被折叠 —— 哪怕它是三天前的', () => {
    const messages = [
      say('m1', 'a', '很久以前', NOON - 3 * DAY),
      say('m2', 'b', '也是很久以前', NOON - 3 * DAY + 1000),
      say('m3', 'i', '还是很久以前', NOON - 3 * DAY + 2000),
    ]
    const window = planCollabHistoryWindow({
      messages,
      seenMessageId: 'm1',
      now: NOON,
      historyTailCount: 0,
    })
    expect([...window.unread]).toEqual([1, 2])
    // 只有已读的 m1 有资格被折叠。
    expect([...window.folded]).toEqual([0])
  })

  it('historyDays = 0 关闭折叠(与 budgets 那套「0 = 关掉这道闸」同约定)', () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      say(`m${index}`, 'a', String(index), NOON - 5 * DAY + index * 1000))
    const window = planCollabHistoryWindow({ messages, now: NOON, historyDays: 0 })
    expect(window.folded.size).toBe(0)
  })

  it('切点在一天之内恒定:新消息到达不改变已折叠的集合(前缀稳定)', () => {
    const base = Array.from({ length: 30 }, (_, index) =>
      say(`old${index}`, 'a', `旧${index}`, NOON - 2 * DAY + index * 1000))
    const first = planCollabHistoryWindow({ messages: base, seenMessageId: 'old29', now: NOON })
    const later = planCollabHistoryWindow({
      messages: [...base, say('new1', 'b', '新的', NOON - 500)],
      seenMessageId: 'old29',
      now: NOON + 3_600_000,
    })
    expect([...later.folded]).toEqual([...first.folded])
  })

  it('日界悬崖:切点之前仍保留 tail 条,默认不为 0', () => {
    expect(COLLAB_DEFAULT_HISTORY_TAIL).toBeGreaterThan(0)
    const messages = Array.from({ length: 50 }, (_, index) =>
      say(`m${index}`, 'a', String(index), NOON - DAY + index * 1000))
    const window = planCollabHistoryWindow({ messages, seenMessageId: 'm49', now: NOON })
    expect(messages.length - window.folded.size).toBe(COLLAB_DEFAULT_HISTORY_TAIL)
  })
})

describe('resolveCollabUnreadRelation', () => {
  it('点名按 id 认(改名不影响)', () => {
    const message = say('m1', 'a', '@Bram', NOON, { mentions: [{ agentId: 'b', label: '随便什么' }] })
    expect(resolveCollabUnreadRelation(message, 'b')).toBe('mentions-you')
  })

  it('引用回查被引那条的作者,而不是信任快照里的署名', () => {
    const quoted = say('q1', 'b', '原话', NOON - 1000)
    const message = say('m1', 'a', '回它', NOON, {
      replyTo: { messageId: 'q1', authorLabel: '改名前的旧称呼', excerpt: '原话' },
    })
    const authorOf = (id: string) => (id === quoted.id ? quoted.agentId : undefined)
    expect(resolveCollabUnreadRelation(message, 'b', authorOf)).toBe('quotes-you')
    expect(resolveCollabUnreadRelation(message, 'i', authorOf)).toBe('bystander')
  })
})

describe('projectRoomHistory — 三路分派', () => {
  const messages = [
    say('m1', 'a', '很久以前的一句', NOON - 3 * DAY),
    say('m2', 'b', '昨天的一句', NOON - DAY),
    say('m3', 'i', '我读过的', NOON - 3000),
    say('m4', 'a', '你没读过的', NOON - 1000, { mentions: [{ agentId: 'b', label: 'Bram' }] }),
  ]

  it('未读进 <Notification> 且带 rel,不在 <History> 里重复', () => {
    const window = planCollabHistoryWindow({
      messages,
      seenMessageId: 'm3',
      now: NOON,
      historyDays: 0,
    })
    const [projected] = projectRoomHistory({
      messages,
      selfAgentId: 'b',
      agents: AGENTS,
      window,
    })
    const content = projected.content
    expect(content).toContain('<Notification count=')
    expect(content).toContain('count="1"')
    expect(content).toContain('rel="mentions-you"')
    // 出现且只出现一次 —— 未读不在历史里重复一遍。
    expect(content.split('你没读过的').length - 1).toBe(1)
    // 未读块在 </ChatRoom> 之后。
    expect(content.indexOf('<Notification')).toBeGreaterThan(content.indexOf('</ChatRoom>'))
  })

  it('折叠行进 <History> 开头,数的是**投影得出的行**而不是原始消息条数', () => {
    const withNoise = [
      ...messages,
      // drive 与 thinking record 本来就进不了投影,不该被算进 count。
      { id: 'd1', role: 'user', content: '<turn/>', timestamp: NOON - 3 * DAY, source: 'collab' },
    ] as CollabMessageLike[]
    const window = planCollabHistoryWindow({
      messages: withNoise,
      seenMessageId: 'm4',
      now: NOON,
      historyTailCount: 0,
    })
    const [projected] = projectRoomHistory({
      messages: withNoise,
      selfAgentId: 'b',
      agents: AGENTS,
      window,
    })
    // m1 + m2 早于今天零点;drive 同样早,但它不产生行,所以 count 是 2 而不是 3。
    expect(projected.content).toContain('<Folded count="2"')
    expect(projected.content).not.toContain('很久以前的一句')
  })

  it('不给 window = 老行为,一个新标签都不出现', () => {
    const [projected] = projectRoomHistory({ messages, selfAgentId: 'b', agents: AGENTS })
    expect(projected.content).not.toContain('<Notification')
    expect(projected.content).not.toContain('<Folded')
    expect(projected.content).toContain('很久以前的一句')
  })

  it('只剩未读(历史全空)照样投 —— 那正是"我离开期间群里说了话"', () => {
    const only = [say('m1', 'a', '第一句', NOON - 2000), say('m2', 'a', '第二句', NOON - 1000)]
    const window = planCollabHistoryWindow({
      messages: only,
      seenMessageId: 'm1',
      now: NOON,
      historyDays: 0,
    })
    // m1 已读但把它也折掉,模拟"历史空、只有未读"。
    const forced = { ...window, folded: new Set([0]) }
    const projected = projectRoomHistory({
      messages: only,
      selfAgentId: 'b',
      agents: AGENTS,
      window: forced,
    })
    expect(projected).toHaveLength(1)
    expect(projected[0].content).toContain('第二句')
  })
})
