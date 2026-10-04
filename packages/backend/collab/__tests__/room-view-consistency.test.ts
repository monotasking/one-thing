/**
 * **三家同源的守卫**(collab-agent-view-p5.md P5-2)。
 *
 * 投影、每日摘要、`room_history` 都要回答同一个问题:这条消息算不算数、在不在
 * 折叠段里。此前这条判定写了三遍,三份答案不一样,净效果是一条卡片流转记录
 * 「在投影里是事实、在摘要里不存在、在工具里查不到」——折叠一发生就彻底蒸发。
 *
 * 所以这个文件断言的不是某个函数的输出,而是**两个集合的关系**:
 *
 *  1. 工具能查到的 === 载荷里 `<Folded count>` 说的那个数;
 *  2. 工具能查到的 ∩ 模型眼前逐字可见的 === ∅;
 *  3. 一条房间事实不会两边都不在(不许有静默蒸发)。
 *
 * 没有这三条,下一个消费者还会自己写第四遍过滤,而漂移只有在真机上才看得出来。
 */
import { describe, expect, it } from 'vitest'
import { collectCollabFoldedFacts, planCollabHistoryWindow } from '../collab-history-window.js'
import { projectRoomHistory } from '../collab-projection.js'
import type { CollabAgentLike, CollabMessageLike } from '../collab-types.js'

const DAY = 86_400_000
const NOW = new Date(2026, 7, 1, 12, 0, 0).getTime()

const AGENTS: CollabAgentLike[] = [
  { id: 'a', name: 'Atlas' },
  { id: 'i', name: 'Iris' },
]

function message(over: Partial<CollabMessageLike> & { id: string }): CollabMessageLike {
  return { role: 'assistant', timestamp: NOW, ...over } as CollabMessageLike
}

/**
 * 一间把六类消息都摆齐的房。内容刻意两两不同,因为断言 2 用的是"这段正文有没有
 * 出现在载荷里" —— 互为子串的文案会让那条断言假绿。
 */
const MESSAGES: CollabMessageLike[] = [
  message({ id: 'm1', role: 'user', content: '用户:三天前定了方向', timestamp: NOW - 3 * DAY, source: 'text' }),
  message({ id: 'm2', agentId: 'a', content: 'Atlas:我去勘探代码库', timestamp: NOW - 3 * DAY + 1, source: 'collab-say' }),
  message({ id: 'm3', role: 'system', content: '「勘探」Atlas 交付进入评审', timestamp: NOW - 3 * DAY + 2, source: 'collab-task' }),
  message({ id: 'm4', role: 'system', content: '他们连着聊了六条我先按住了', timestamp: NOW - 3 * DAY + 3, source: 'collab' }),
  message({ id: 'm5', role: 'user', content: '协调器驱动信封在此', timestamp: NOW - 3 * DAY + 4, source: 'collab' }),
  message({ id: 'm6', agentId: 'i', content: 'Iris 的思考记录不该外传', timestamp: NOW - 3 * DAY + 5, source: 'collab-turn' }),
  message({ id: 'm7', agentId: 'i', content: '[pass]', timestamp: NOW - 3 * DAY + 6, source: 'collab-say' }),
  message({ id: 'm8', agentId: 'i', content: 'Iris:那我等你结果', timestamp: NOW - 2 * DAY, source: 'collab-say' }),
  message({ id: 'm9', role: 'user', content: '用户:今天继续往下推', timestamp: NOW - 1000, source: 'text' }),
]

/** 切点前不留尾巴:小房间里 tail 默认 20,不关掉的话一条都不会折叠。 */
const NO_TAIL = { historyTailCount: 0 }

function payloadFor(seenMessageId?: string): { payload: string; window: ReturnType<typeof planCollabHistoryWindow> } {
  const window = planCollabHistoryWindow({
    messages: MESSAGES,
    now: NOW,
    selfAgentId: 'a',
    ...(seenMessageId ? { seenMessageId } : {}),
    ...NO_TAIL,
  })
  const projected = projectRoomHistory({
    messages: MESSAGES,
    selfAgentId: 'a',
    agents: AGENTS,
    window,
  })
  return { payload: projected[0]?.content ?? '', window }
}

function foldedCountInPayload(payload: string): number {
  return Number(/<Folded count="(\d+)"/.exec(payload)?.[1] ?? 0)
}

describe('三家同源', () => {
  it('工具能查到的条数 === 载荷里 <Folded count> 说的那个数', () => {
    const { payload, window } = payloadFor()
    const searchable = collectCollabFoldedFacts(MESSAGES, window)
    expect(searchable.length).toBeGreaterThan(0)
    expect(searchable.length).toBe(foldedCountInPayload(payload))
  })

  it('工具能查到的,模型眼前一条都看不见 —— 否则是重复付费', () => {
    const { payload, window } = payloadFor()
    for (const folded of collectCollabFoldedFacts(MESSAGES, window)) {
      expect(payload).not.toContain(folded.content ?? '')
    }
  })

  it('未读永不折叠,而且不会被查第二遍', () => {
    // 读到 m2 为止:m8 是它没读过的(m5..m7 是机械行,不进任何一侧)
    const { payload, window } = payloadFor('m2')
    const searchable = collectCollabFoldedFacts(MESSAGES, window)
    expect(payload).toContain('那我等你结果')
    expect(searchable.map(entry => entry.id)).not.toContain('m8')
    expect(searchable.length).toBe(foldedCountInPayload(payload))
  })

  it('一条房间事实不会两边都不在 —— 不许有静默蒸发', () => {
    const { payload, window } = payloadFor()
    const searchableIds = new Set(collectCollabFoldedFacts(MESSAGES, window).map(entry => entry.id))
    const facts = ['m1', 'm2', 'm3', 'm8', 'm9']
    for (const id of facts) {
      const fact = MESSAGES.find(entry => entry.id === id)
      const visible = payload.includes(fact?.content ?? '\u0000')
      expect(visible || searchableIds.has(id)).toBe(true)
    }
  })

  it('机械行两边都不在:drive / thinking / pass / 运营系统行', () => {
    const { payload, window } = payloadFor()
    const searchableIds = new Set(collectCollabFoldedFacts(MESSAGES, window).map(entry => entry.id))
    for (const id of ['m4', 'm5', 'm6', 'm7']) {
      const machinery = MESSAGES.find(entry => entry.id === id)
      expect(payload).not.toContain(machinery?.content ?? '\u0000')
      expect(searchableIds.has(id)).toBe(false)
    }
  })

  it('MARKED 系统行两边都在场:折叠前进 <History>,折叠后查得回来', () => {
    const taskLine = MESSAGES.find(entry => entry.id === 'm3')?.content ?? ''
    // 不折叠时:它在模型眼前
    const visible = projectRoomHistory({
      messages: MESSAGES,
      selfAgentId: 'a',
      agents: AGENTS,
    })[0]?.content ?? ''
    expect(visible).toContain(taskLine)
    // 折叠后:它在可查集合里 —— 这正是 W9.1 那个事故的结论所要求的
    const { window } = payloadFor()
    expect(collectCollabFoldedFacts(MESSAGES, window).map(entry => entry.id)).toContain('m3')
  })

  /**
   * 日界悬崖补丁那一段(切点前最后 K 条留在 `<History>` 里)是漂移的第一现场:
   * 工具此前只判"早于切点",于是这 K 条**既在模型眼前、又被工具返回一遍**。
   * 真机上 K=20,cumo 房实测重叠 20 条。
   */
  it('切点前保留的尾巴:模型看得见,工具就一条都不给', () => {
    const window = planCollabHistoryWindow({
      messages: MESSAGES,
      now: NOW,
      selfAgentId: 'a',
      // 默认 20 —— 这间小房的旧消息全落在尾巴里
    })
    const payload = projectRoomHistory({
      messages: MESSAGES,
      selfAgentId: 'a',
      agents: AGENTS,
      window,
    })[0]?.content ?? ''
    expect(payload).toContain('三天前定了方向')
    expect(collectCollabFoldedFacts(MESSAGES, window)).toEqual([])
    expect(foldedCountInPayload(payload)).toBe(0)
  })

  it('房间不折叠时(historyDays=0)可查集合为空,cut 也不给', () => {
    const window = planCollabHistoryWindow({
      messages: MESSAGES,
      now: NOW,
      selfAgentId: 'a',
      historyDays: 0,
    })
    expect(window.cut).toBeUndefined()
    expect(collectCollabFoldedFacts(MESSAGES, window)).toEqual([])
  })
})
