/**
 * 历史检索的授权判据（docs/design/collab-history-search.md §3）。
 *
 * 这个文件守的是一条**产品决定**，不是一个实现细节：
 * 「看得到「我最后一次在场那一刻」之前的一切，看不到之后的。」
 *
 * 判错的两个方向代价不对称：多给 = 一位同事读到它离开之后别人说的话（泄密）；
 * 少给 = 它读不到自己当时在场时读过的话（让它记错自己的过去）。所以两边都钉。
 */
import { describe, expect, it } from 'vitest'
import { collabRoomVisibleUntil, isCollabMessageVisible } from '../visibility.js'

const T = new Date(2026, 7, 1, 12, 0, 0).getTime()

describe('collabRoomVisibleUntil', () => {
  it('当前成员 → 全部可见（含它入房之前的历史）', () => {
    expect(collabRoomVisibleUntil({ memberAgentIds: ['a', 'b'] }, 'a'))
      .toBe(Number.POSITIVE_INFINITY)
  })

  it('被移出 → 只到那一刻', () => {
    expect(collabRoomVisibleUntil(
      { memberAgentIds: ['b'], formerMembers: [{ agentId: 'a', removedAt: T }] },
      'a',
    )).toBe(T)
  })

  it('移出两次 → 取较晚的那次', () => {
    expect(collabRoomVisibleUntil(
      {
        memberAgentIds: ['b'],
        formerMembers: [
          { agentId: 'a', removedAt: T - 86_400_000 },
          { agentId: 'a', removedAt: T },
        ],
      },
      'a',
    )).toBe(T)
  })

  it('移出后又被拉回 → 当前成员优先，全部可见', () => {
    expect(collabRoomVisibleUntil(
      { memberAgentIds: ['a'], formerMembers: [{ agentId: 'a', removedAt: T }] },
      'a',
    )).toBe(Number.POSITIVE_INFINITY)
  })

  it('从不在场 → undefined（这间房对它不存在，连房名都不该露出）', () => {
    expect(collabRoomVisibleUntil({ memberAgentIds: ['b'] }, 'a')).toBeUndefined()
    expect(collabRoomVisibleUntil({ memberAgentIds: ['b'], formerMembers: [] }, 'a'))
      .toBeUndefined()
  })

  it('别人的移出记录不给我开门', () => {
    expect(collabRoomVisibleUntil(
      { memberAgentIds: ['b'], formerMembers: [{ agentId: 'c', removedAt: T }] },
      'a',
    )).toBeUndefined()
  })

  it('房或 agentId 缺席 → undefined，绝不默认放行', () => {
    expect(collabRoomVisibleUntil(undefined, 'a')).toBeUndefined()
    expect(collabRoomVisibleUntil({ memberAgentIds: ['a'] }, undefined)).toBeUndefined()
    expect(collabRoomVisibleUntil({ memberAgentIds: ['a'] }, '')).toBeUndefined()
  })

  it('坏数据不当成放行：removedAt 不是有限数就跳过这条', () => {
    expect(collabRoomVisibleUntil(
      { memberAgentIds: [], formerMembers: [{ agentId: 'a', removedAt: Number.NaN }] },
      'a',
    )).toBeUndefined()
  })
})

describe('isCollabMessageVisible', () => {
  it('窗口内可见，窗口外不可见，边界那一刻算可见', () => {
    expect(isCollabMessageVisible(T - 1, T)).toBe(true)
    expect(isCollabMessageVisible(T, T)).toBe(true)
    expect(isCollabMessageVisible(T + 1, T)).toBe(false)
  })

  it('当前成员：任何时刻都可见', () => {
    expect(isCollabMessageVisible(T, Number.POSITIVE_INFINITY)).toBe(true)
  })

  it('不可见的房 / 没有时间戳的消息 → 一律不可见', () => {
    expect(isCollabMessageVisible(T, undefined)).toBe(false)
    expect(isCollabMessageVisible(undefined, Number.POSITIVE_INFINITY)).toBe(false)
  })
})
