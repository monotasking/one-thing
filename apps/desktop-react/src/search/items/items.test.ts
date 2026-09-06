import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '@shared/ipc/search'
import type { SearchBlock, SearchListing } from '../../data/search-listing-source'
import { actionItemId, moreItemId, rowItemId, sequenceOf } from '../sequence'
import type { SearchItem } from '../sequence'
import { itemKindNames, registerItemKind, resolveItemKind, resetItemKinds } from './index'
import type { SearchItemContext } from './registry'

/**
 * **序列项注册表**的判据(检索面终稿 附录 B §0 ③)。
 *
 * 两件事在验:
 *  · 表本身(注册 / 重复 / 注销 / 查不到不是错误)——它是「加一种项 = 一个模块 +
 *    一行注册」这条硬指标的载体;
 *  · 三种项的 `activate` / `survivesGrowth` —— 本批只立行为那一半,所以用例也只
 *    验行为(`Render` 是最小实现,画法归第 ⑥⑦ 步)。
 */

afterEach(() => {
  vi.restoreAllMocks()
})

/* ── 装置 ──────────────────────────────────────────────────────────────── */

function row(id: string): SearchResult {
  return { id, type: 'message', title: id, target: { kind: 'message', payload: { id } } }
}

function block(capability: string, ids: string[], over: Partial<SearchBlock> = {}): SearchBlock {
  const merged: SearchBlock = {
    capability,
    rows: ids.map(row),
    cursor: 'c1',
    exhausted: false,
    pages: 1,
    ...over,
  }
  return { ...merged, exhausted: merged.cursor === undefined }
}

function listing(blocks: SearchBlock[], over: Partial<SearchListing> = {}): SearchListing {
  return { mode: 'overview', query: 'jira', blocks, ...over }
}

function ctxOf(l: SearchListing | undefined, over: Partial<SearchItemContext> = {}) {
  const openRow = vi.fn()
  const loadMore = vi.fn()
  const runAction = vi.fn()
  const ctx: SearchItemContext = { listing: l, openRow, loadMore, runAction, ...over }
  return { ctx, openRow, loadMore, runAction }
}

const itemOf = (l: SearchListing, id: string): SearchItem => sequenceOf(l).find(i => i.id === id)!

/* ── 表 ────────────────────────────────────────────────────────────────── */

describe('注册表', () => {
  it('三种项开箱就在(barrel 是唯一的注册处)', () => {
    expect(itemKindNames().sort()).toEqual(['action', 'more', 'row'])
  })

  it('重复注册 = 抛错(与目标渲染器那张表逐字同款)', () => {
    const one = resolveItemKind('row')!
    expect(() => registerItemKind(one)).toThrow(/already registered/)
  })

  it('注销只删自己那一条,而且幂等', () => {
    const stub = {
      kind: 'zzz-probe',
      Render: () => null,
      activate: () => undefined,
      survivesGrowth: () => true,
    }
    const off = registerItemKind(stub)
    expect(resolveItemKind('zzz-probe')).toBe(stub)
    off()
    off()
    expect(itemKindNames()).not.toContain('zzz-probe')
  })

  it('查不到**不是错误**:答 undefined(调用方当没这一项)', () => {
    expect(resolveItemKind('zzz-nobody')).toBeUndefined()
  })
})

/* ── 行 ────────────────────────────────────────────────────────────────── */

describe('row', () => {
  const l = listing([block('chats', ['a', 'b'])])
  const kind = () => resolveItemKind('row')!

  it('⏎ = 打开它;行找不到就当没按', () => {
    const { ctx, openRow } = ctxOf(l)
    kind().activate(itemOf(l, rowItemId('chats', 'a')), ctx)
    expect(openRow).toHaveBeenCalledWith(l.blocks[0].rows[0], 'chats')

    const stale = ctxOf(listing([block('chats', ['b'])]))
    kind().activate(itemOf(l, rowItemId('chats', 'a')), stale.ctx)
    expect(stale.openRow).not.toHaveBeenCalled()
  })

  it('翻一页之后这一行还在;换了一份答案之后不在了', () => {
    const item = itemOf(l, rowItemId('chats', 'a'))
    expect(kind().survivesGrowth(item, listing([block('chats', ['a', 'b', 'c'])]))).toBe(true)
    expect(kind().survivesGrowth(item, listing([block('chats', ['x'])]))).toBe(false)
    expect(kind().survivesGrowth(item, undefined)).toBe(false)
  })
})

/* ── 块尾 ──────────────────────────────────────────────────────────────── */

describe('more', () => {
  const l = listing([block('chats', ['a'])])
  const kind = () => resolveItemKind('more')!
  const item = () => itemOf(l, moreItemId('chats'))

  it('⏎ = 带着**发车这一刻**那一块的游标再要一页', () => {
    const { ctx, loadMore } = ctxOf(l)
    kind().activate(item(), ctx)
    expect(loadMore).toHaveBeenCalledWith('chats', 'c1')
  })

  it('取尽的块当没按(没有下一页可要)', () => {
    const done = listing([block('chats', ['a'], { cursor: undefined })])
    const { ctx, loadMore } = ctxOf(done)
    kind().activate({ id: moreItemId('chats'), kind: 'more', block: 'chats' }, ctx)
    expect(loadMore).not.toHaveBeenCalled()
  })

  it('闸②:面板说此刻不能翻就当没按(**不是排队** —— 排队等于延迟发作)', () => {
    const { ctx, loadMore } = ctxOf(l, { canLoadMore: () => false })
    kind().activate(item(), ctx)
    expect(loadMore).not.toHaveBeenCalled()
  })

  it('取尽之后这条项就没了 —— 那正是 reconcile 要把活动位交出去的时刻', () => {
    expect(kind().survivesGrowth(item(), listing([block('chats', ['a', 'b'])]))).toBe(true)
    expect(kind().survivesGrowth(item(), listing([block('chats', ['a', 'b'], { cursor: undefined })])))
      .toBe(false)
    expect(kind().survivesGrowth(item(), listing([block('chats', [], { cursor: undefined })])))
      .toBe(false)
  })
})

/* ── 动作 ──────────────────────────────────────────────────────────────── */

describe('action', () => {
  const l = listing(
    [block('prompts', ['p1'], { cursor: undefined, actions: [{ id: 'create', labelKey: 'k' }] })],
    { actions: [{ id: 'page-level', labelKey: 'k2' }] },
  )
  const kind = () => resolveItemKind('action')!

  it('⏎ = 跑它(块级的带块名,页级的不带)', () => {
    const a = ctxOf(l)
    kind().activate(itemOf(l, actionItemId('prompts', 'create')), a.ctx)
    expect(a.runAction).toHaveBeenCalledWith({ id: 'create', labelKey: 'k' }, 'prompts')

    const b = ctxOf(l)
    kind().activate(itemOf(l, actionItemId('', 'page-level')), b.ctx)
    expect(b.runAction).toHaveBeenCalledWith({ id: 'page-level', labelKey: 'k2' }, undefined)
  })

  it('动作**跟着答案走**:新的那份里没有同一个 id 就不在了', () => {
    const item = itemOf(l, actionItemId('prompts', 'create'))
    expect(kind().survivesGrowth(item, l)).toBe(true)
    expect(kind().survivesGrowth(item, listing([block('prompts', ['p1'])]))).toBe(false)
  })

  it('R3:动作项是序列的末项', () => {
    const seq = sequenceOf(l)
    expect(seq[seq.length - 1].kind).toBe('action')
  })
})

/* ── 表被清空之后 ──────────────────────────────────────────────────────── */

describe('resetItemKinds', () => {
  it('清表之后一格都查不到(测试用口;产品代码一处都不该调它)', () => {
    resetItemKinds()
    expect(itemKindNames()).toEqual([])
  })
})
