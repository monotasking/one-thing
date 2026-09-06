import { describe, expect, it } from 'vitest'
import type { SearchResult } from '@shared/ipc/search'
import type { SearchBlock, SearchListing, SearchPage } from '../data/search-listing-source'
import { appendPage, markPageError, moreStateOf } from './paging'
import {
  SEARCH_FIRST_PAGE,
  SEARCH_PAGE_SIZE,
  moreState,
  pageWindow,
  remoteSide,
} from './transitions'
import type { SearchMore, SearchRemoteSide } from './transitions'

/**
 * **分页**那一台机的判据(检索面终稿 附录 B §5.2–§5.3)。
 *
 * 文件里有两批用例:
 *  · 新的三件(`moreStateOf` / `appendPage` / `markPageError`)—— 本批立的产地;
 *  · 旧的三组(`remoteSide` / `pageWindow` / `moreState`)—— 从
 *    `transitions.test.ts` 搬过来的,函数本体还在那边活着(删旧是第 ⑨ 步),
 *    用例先按新家归位。
 */

/* ── 装置 ──────────────────────────────────────────────────────────────── */

function row(id: string): SearchResult {
  return { id, type: 'message', title: id, target: { kind: 'message', payload: { id } } }
}

/** `exhausted` 跟着 `cursor` 走 —— 与产地 `blockOf` 同一条恒等式。 */
function block(over: Partial<SearchBlock> = {}): SearchBlock {
  const merged: SearchBlock = {
    capability: 'messages',
    rows: [row('a'), row('b')],
    cursor: 'c1',
    exhausted: false,
    pages: 1,
    ...over,
  }
  return { ...merged, exhausted: merged.cursor === undefined }
}

function listing(...blocks: SearchBlock[]): SearchListing {
  return { mode: 'single', query: 'jira', blocks }
}

function page(ids: string[], cursor?: string): SearchPage {
  return { rows: ids.map(row), ...(cursor === undefined ? {} : { cursor }) }
}

const blockOf = (l: SearchListing | undefined, cap = 'messages'): SearchBlock | undefined =>
  l?.blocks.find(b => b.capability === cap)

/* ── 块尾那条项的四态 ──────────────────────────────────────────────────── */

describe('moreStateOf(块尾那条项的四态 + 一条读数)', () => {
  it('零命中的块一个像素都不占 —— 连「没搜成」都不在这里说', () => {
    expect(moreStateOf(block({ rows: [], error: 'boom' }), false, false)).toEqual({ kind: 'none' })
  })

  it('闸②:这一块在翻页 / 整格在重拉,都是「加载中」', () => {
    expect(moreStateOf(block(), true, false)).toEqual({ kind: 'loading' })
    expect(moreStateOf(block(), false, true)).toEqual({ kind: 'loading' })
  })

  it('忙态**盖过**翻页失败 —— 重试在飞时不该还画着「没加载出来」', () => {
    expect(moreStateOf(block({ pageError: 'boom' }), true, false)).toEqual({ kind: 'loading' })
    expect(moreStateOf(block({ pageError: 'boom' }), false, false)).toEqual({ kind: 'error' })
  })

  it('取尽 = 读数;total 不知道就报屏上这几条,不猜', () => {
    expect(moreStateOf(block({ cursor: undefined }), false, false))
      .toEqual({ kind: 'end', total: 2 })
    expect(moreStateOf(block({ cursor: undefined, total: 41 }), false, false))
      .toEqual({ kind: 'end', total: 41 })
  })

  it('还能再要一页:total 缺席就是 null —— 不拿本页条数冒充总数', () => {
    expect(moreStateOf(block(), false, false)).toEqual({ kind: 'more', shown: 2, total: null })
    expect(moreStateOf(block({ total: 41 }), false, false))
      .toEqual({ kind: 'more', shown: 2, total: 41 })
  })
})

/* ── 一页怎么落进格里 ──────────────────────────────────────────────────── */

describe('appendPage(三道闸)', () => {
  it('追加在块末尾,旧行引用一个不换;pages +1', () => {
    const before = listing(block())
    const next = appendPage(before, 'messages', 'c1', page(['c', 'd'], 'c2'))
    expect(blockOf(next)?.rows.map(r => r.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(blockOf(next)?.rows[0]).toBe(blockOf(before)?.rows[0])
    expect(blockOf(next)?.pages).toBe(2)
    expect(blockOf(next)?.cursor).toBe('c2')
    expect(blockOf(next)?.exhausted).toBe(false)
  })

  it('别的块原样交回**同一个对象**(律④:没变的不重挂)', () => {
    const other = block({ capability: 'files', rows: [row('f1')] })
    const before = listing(block(), other)
    const next = appendPage(before, 'messages', 'c1', page(['c'], 'c2'))
    expect(blockOf(next, 'files')).toBe(other)
  })

  it('闸①:发车那一刻的游标对不上就整发丢弃(恒等变换)', () => {
    const before = listing(block({ cursor: 'c2' }))
    expect(appendPage(before, 'messages', 'c1', page(['c'], 'c3'))).toBe(before)
  })

  it('按 id 去重 —— 后端把上一页重放一遍不会长出重复行', () => {
    const next = appendPage(listing(block()), 'messages', 'c1', page(['b', 'c'], 'c2'))
    expect(blockOf(next)?.rows.map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('闸③:一条新 id 都没有 = 按取尽处理 + 说出来(不是静默的「按了没反应」)', () => {
    const next = appendPage(listing(block()), 'messages', 'c1', page(['a', 'b'], 'c2'))
    expect(blockOf(next)?.rows.map(r => r.id)).toEqual(['a', 'b'])
    expect(blockOf(next)?.exhausted).toBe(true)
    expect(blockOf(next)?.cursor).toBeUndefined()
    expect(blockOf(next)?.pages).toBe(1)
  })

  it('新页没有游标 = 取尽', () => {
    const next = appendPage(listing(block()), 'messages', 'c1', page(['c']))
    expect(blockOf(next)?.exhausted).toBe(true)
    expect(blockOf(next)?.cursor).toBeUndefined()
  })

  it('成功落地顺手清掉上一次的翻页错(清它的地方只有这一处)', () => {
    const before = listing(block({ pageError: 'boom' }))
    const next = appendPage(before, 'messages', 'c1', page(['c'], 'c2'))
    expect(blockOf(next)?.pageError).toBeUndefined()
  })

  it('格空 / 块不在 = 恒等变换(`patch` 收到它就什么都不做)', () => {
    expect(appendPage(undefined, 'messages', 'c1', page(['c']))).toBeUndefined()
    const before = listing(block())
    expect(appendPage(before, 'files', 'c1', page(['c']))).toBe(before)
  })
})

describe('markPageError(行留着)', () => {
  it('行一条不丢、游标一个字不动 —— 重试要发的是同一个', () => {
    const before = listing(block())
    const next = markPageError(before, 'messages', 'boom')
    expect(blockOf(next)?.rows).toBe(blockOf(before)?.rows)
    expect(blockOf(next)?.cursor).toBe('c1')
    expect(blockOf(next)?.pageError).toBe('boom')
    expect(blockOf(next)?.pages).toBe(1)
  })

  it('格空 / 块不在 = 恒等变换', () => {
    expect(markPageError(undefined, 'messages', 'boom')).toBeUndefined()
    const before = listing(block())
    expect(markPageError(before, 'files', 'boom')).toBe(before)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * 以下三组从 `transitions.test.ts` 搬过来(第 ⑤ 步),函数本体还在那边。
 * ══════════════════════════════════════════════════════════════════════════ */

describe('remoteSide(次序是判据,不是口味)', () => {
  const cases: Array<[SearchRemoteSide[], SearchRemoteSide]> = [
    [['exhausted', 'failed'], 'failed'],
    [['pending', 'more'], 'more'],
    [['exhausted', 'pending'], 'pending'],
    [['exhausted', 'exhausted'], 'exhausted'],
    [[], 'exhausted'],
  ]
  for (const [sides, want] of cases) {
    it(`${JSON.stringify(sides)} → ${want}`, () => {
      expect(remoteSide(...sides)).toBe(want)
    })
  }
})

describe('pageWindow', () => {
  it('第一页 = 首屏;之后每页加一个增量', () => {
    expect(pageWindow(1)).toBe(SEARCH_FIRST_PAGE)
    expect(pageWindow(3)).toBe(SEARCH_FIRST_PAGE + 2 * SEARCH_PAGE_SIZE)
  })
})

describe('moreState(底部那条 item 的判据表)', () => {
  const at = (over: Partial<Parameters<typeof moreState>[0]>): SearchMore =>
    moreState({ page: 1, total: 5, remote: 'exhausted', ...over })

  it('一条行都没有 = 什么都不画', () => {
    expect(at({ total: 0 })).toEqual({ kind: 'none' })
  })

  it('取尽 + 全装得下 = 读数「共 N 条 · 已全部显示」(第一页就取尽也算数)', () => {
    expect(at({})).toEqual({ kind: 'end', total: 5 })
  })

  it('窗口装不下:取尽时报真总数,没取尽时不猜(null)', () => {
    expect(at({ total: 50 })).toEqual({ kind: 'more', shown: 20, total: 50 })
    expect(at({ total: 50, remote: 'more' })).toEqual({ kind: 'more', shown: 20, total: null })
  })

  it('远端还没落定的第一页:**报数不许诺** —— 「已显示 N 条」,不是「加载更多」', () => {
    expect(at({ remote: 'pending' })).toEqual({ kind: 'count', shown: 5 })
  })

  it('翻过页之后,加载中 / 失败才由这条 item 说', () => {
    expect(at({ page: 2, remote: 'pending' })).toEqual({ kind: 'loading' })
    expect(at({ page: 2, remote: 'failed' })).toEqual({ kind: 'error' })
  })

  it('第一页那次失败仍然给一条**能按的** item —— 「再试一次」得有地方按', () => {
    expect(at({ remote: 'failed' })).toEqual({ kind: 'more', shown: 5, total: null })
  })
})
