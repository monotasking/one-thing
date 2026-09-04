import { describe, expect, it } from 'vitest'
import {
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  pushHistory,
  recallPrevious,
} from '../history'
import type { SearchHistoryEntry } from '../history'
import { INITIAL_FILTERS } from '../filters'
import { continuationEnabled } from '../continuations'

/**
 * 查询历史(检索重建 S4b,设计 §4.6 结论最后一段)。
 *
 * 它守的一句话:**续搜的返回路是一条线性历史,不是一摞帧**。
 */

const entry = (over: Partial<SearchHistoryEntry> = {}): SearchHistoryEntry => ({
  query: 'q',
  capability: 'all',
  filters: INITIAL_FILTERS,
  selected: 0,
  ...over,
})

describe('pushHistory', () => {
  it('空历史推一步:指针落在那一步上', () => {
    const h = pushHistory(EMPTY_HISTORY, entry())
    expect(h.entries).toHaveLength(1)
    expect(h.at).toBe(0)
  })

  it('同一步再推一次**不多记一格**,只更新「停在第几行」', () => {
    const h = pushHistory(pushHistory(EMPTY_HISTORY, entry()), entry({ selected: 4 }))
    expect(h.entries).toHaveLength(1)
    expect(h.entries[0].selected).toBe(4)
  })

  it('后退到中间再走一条新路 → **前进那一段被砍掉**(与地址栏同形)', () => {
    let h = pushHistory(EMPTY_HISTORY, entry({ query: 'a' }))
    h = pushHistory(h, entry({ query: 'b' }))
    h = pushHistory(h, entry({ query: 'c' }))
    h = goBack(h)!.history // 停在 b
    expect(canGoForward(h)).toBe(true)
    h = pushHistory(h, entry({ query: 'd' }))
    expect(h.entries.map(e => e.query)).toEqual(['a', 'b', 'd'])
    expect(canGoForward(h)).toBe(false)
  })

  it('封顶从**头上**砍(最老的先走),指针跟着挪', () => {
    let h = EMPTY_HISTORY
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) h = pushHistory(h, entry({ query: `q${i}` }))
    expect(h.entries).toHaveLength(HISTORY_LIMIT)
    expect(h.at).toBe(HISTORY_LIMIT - 1)
    expect(h.entries[0].query).toBe('q5')
  })
})

describe('goBack / goForward', () => {
  const three = ['a', 'b', 'c'].reduce(
    (h, query) => pushHistory(h, entry({ query })),
    EMPTY_HISTORY,
  )

  it('答的是「新历史 + 要还原成什么」—— 调用方不必按下标再取一次', () => {
    const back = goBack(three)!
    expect(back.entry.query).toBe('b')
    expect(back.history.at).toBe(1)
  })

  it('走不动时答 undefined(不是原样返回)—— 调用方一眼判「这一下什么都没发生」', () => {
    expect(goForward(three)).toBeUndefined()
    expect(goBack(EMPTY_HISTORY)).toBeUndefined()
    expect(canGoBack(EMPTY_HISTORY)).toBe(false)
  })

  it('后退再前进回到原处(**四格原样**,不是只还原一个词)', () => {
    const filters = { ...INITIAL_FILTERS, role: 'user' as const }
    const h = pushHistory(three, entry({ query: 'd', capability: 'messages', filters, selected: 3 }))
    const back = goBack(h)!
    const forward = goForward(back.history)!
    expect(forward.entry).toEqual({ query: 'd', capability: 'messages', filters, selected: 3 })
  })

  it('↑ 与 ⌘[ 落的是同一格历史(recallPrevious 就是 goBack)', () => {
    expect(recallPrevious).toBe(goBack)
  })
})

describe('continuationEnabled(范围片按不按得动由自述说)', () => {
  it('枢轴永远按得动 —— 它换的是**档**,新档摆得出什么是换过去之后的事', () => {
    expect(continuationEnabled(
      { kind: 'pivot', labelKey: 'search.pivotFileMentions', capability: 'messages', query: 'x' },
      new Set(),
    )).toBe(true)
  })

  it('范围片要那个 facet 键在这一档摆得出 —— 摆不出就是灰的', () => {
    const chip = { kind: 'scope' as const, labelKey: 'search.continueInDir' as const, chip: { key: 'dir', value: '/a', label: '/a' } }
    expect(continuationEnabled(chip, new Set(['sessionId']))).toBe(false)
    expect(continuationEnabled(chip, new Set(['dir']))).toBe(true)
  })
})
