import { describe, expect, it } from 'vitest'
import type { SearchResult } from '@shared/ipc/search'
import type { SearchBlock, SearchListing, SearchPage } from '../data/search-listing-source'
import { appendPage, landScan, landScanError, markPageError, moreStateOf } from './paging'

/**
 * **分页**那一台机的判据(检索面终稿 附录 B §5.2–§5.3)。
 *
 * 三件产地:`moreStateOf`(块尾那条项此刻是什么)/ `appendPage`(落一页)/
 * `markPageError`(这一页没落成)。
 *
 * ── 第 ⑨ 步:旧那三组用例随函数本体一起下葬 ────────────────────────────────
 * 第 ⑤ 步把 `remoteSide` / `pageWindow` / `moreState` 的用例从 `transitions.test.ts`
 * 搬来这里「按新家归位」,那时函数本体还在 `transitions.ts` 活着。本批删旧:
 * 那三只函数没有消费者(旧那台「递增 limit 重查」的分页机整台作废),用例跟着走。
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

/* ── 09-07 事故第二/三条修:两个新态 ───────────────────────────────────── */

describe('moreStateOf 的两个新态(scanning / partial)', () => {
  it('`scanning` 排在「零命中不占行」前面 —— 「还没问」不是「问过了没有」', () => {
    const scanning = block({ capability: 'files', rows: [], cursor: undefined, scanning: true })
    /*
     * 反证:把 `moreStateOf` 里 `if (block.scanning === true)` 那一行挪到
     * `rows.length === 0` 后面 → 这里当场变成 `none`,屏上那一块整块不画,
     * 文件那一档于是在半秒后凭空冒出来(用户刚读到的是「它说没有」)。
     */
    expect(moreStateOf(scanning, false, false)).toEqual({ kind: 'scanning' })
  })

  it('`scanning` 压过忙态:整格在重拉时它仍然说「扫描中」', () => {
    const scanning = block({ capability: 'files', rows: [], cursor: undefined, scanning: true })
    expect(moreStateOf(scanning, true, true)).toEqual({ kind: 'scanning' })
  })

  it('`partial`:说手上有几条,**不说总数**(这一路答不出总数)', () => {
    const partial = block({ rows: [row('a'), row('b')], cursor: undefined, partial: true })
    expect(moreStateOf(partial, false, false)).toEqual({ kind: 'partial', shown: 2 })
  })

  it('`partial` 压过 `end`:取尽了也不许画「共 N 条」', () => {
    const partial = block({ rows: [row('a')], cursor: undefined, partial: true, total: 99 })
    expect(moreStateOf(partial, false, false).kind).toBe('partial')
  })

  it('没标 partial 的那一页照旧走 `end`(行为零变化)', () => {
    expect(moreStateOf(block({ cursor: undefined }), false, false))
      .toEqual({ kind: 'end', total: 2 })
  })
})

describe('landScan / landScanError(补扫怎么落地)', () => {
  it('落地:摘 `scanning`、填行、按这一页的游标定取尽', () => {
    const before = listing(block({ capability: 'files', rows: [], cursor: undefined, scanning: true }))
    const after = landScan(before, 'files', page(['f1', 'f2'], 'c1'))
    const one = blockOf(after, 'files')
    expect(one?.scanning).toBeUndefined()
    expect(one?.rows.map(r => r.id)).toEqual(['f1', 'f2'])
    expect(one?.cursor).toBe('c1')
    expect(one?.exhausted).toBe(false)
    expect(one?.pages).toBe(1)
  })

  it('落地也带 `partial`(扫了一半就到点的那一页)', () => {
    const before = listing(block({ capability: 'files', rows: [], cursor: undefined, scanning: true }))
    const after = landScan(before, 'files', { rows: [row('f1')], partial: true })
    expect(blockOf(after, 'files')?.partial).toBe(true)
    expect(blockOf(after, 'files')?.exhausted).toBe(true)
  })

  it('别的块**对象引用不换**(律④)', () => {
    const other = block({ capability: 'chats' })
    const before = listing(other, block({ capability: 'files', rows: [], cursor: undefined, scanning: true }))
    const after = landScan(before, 'files', page(['f1']))
    expect(blockOf(after, 'chats')).toBe(other)
  })

  it('这一块已经不在了(换词换出去的旧格)= 恒等变换', () => {
    const before = listing(block({ capability: 'chats' }))
    expect(landScan(before, 'files', page(['f1']))).toBe(before)
    expect(landScanError(before, 'files', 'boom')).toBe(before)
  })

  it('塌了落 `error`(头页的失败归页脚那一行),`scanning` 同时摘掉', () => {
    const before = listing(block({ capability: 'files', rows: [], cursor: undefined, scanning: true }))
    const after = landScanError(before, 'files', 'rg gone')
    expect(blockOf(after, 'files')?.error).toBe('rg gone')
    expect(blockOf(after, 'files')?.scanning).toBeUndefined()
    expect(blockOf(after, 'files')?.pageError).toBeUndefined()
  })
})
