import { describe, expect, it } from 'vitest'
import * as T from '../tree'
import { refId } from '../kinds'
import type { ContentRef } from '../kinds'
import type { PaneNode } from '../tree'

/**
 * **拼贴树的纯函数簇**(W1,设计 §1.2)。
 *
 * 这一组守三件:①每一口的语义(表驱动,逐格);②**结构共享** —— 没改到的那一支
 * 交回同一个对象(那是「分屏 / 并 tab / 关叶不重挂兄弟叶」那条零重挂断言的
 * 结构前提);③`sanitize` 是**幂等**的入口闸(存量档案里的未知种类当场剔掉)。
 *
 * 整只文件里**一个内容种类名都没有** —— 与被测的那只文件同一条纪律。
 * 用例里的 `kind` 是 `'k'` / `'solo'` 这种占位名,正是为了让「树不认识种类」
 * 这件事在测试里也成立:换成 `'file'` / `'chat'` 反而会把读者引向错的直觉。
 */

const ref = (kind: string, key: string): ContentRef => ({ kind, key })
const A = ref('k', 'a')
const B = ref('k', 'b')
const C = ref('k', 'c')

/** 认得所有种类、都不是单例 —— 大部分用例不关心这两格。 */
const OPEN: T.SanitizeOptions = { known: () => true, singleton: () => false }

function leaf(tabs: ContentRef[] = [], active = 0, preview: string | null = null) {
  return T.makeLeaf('L1', tabs, active, preview)
}

describe('插一格', () => {
  it('缺省插在末尾并激活', () => {
    const next = T.insertTab(leaf([A]), 'L1', B)
    const l = T.findLeaf(next, 'L1')!
    expect(l.tabs.map(refId)).toEqual(['k:a', 'k:b'])
    expect(l.active).toBe(1)
  })

  it('已经在这片叶里 = 只激活,不插第二格', () => {
    const next = T.insertTab(leaf([A, B], 0), 'L1', B)
    const l = T.findLeaf(next, 'L1')!
    expect(l.tabs).toHaveLength(2)
    expect(l.active).toBe(1)
  })

  it('已经在这片叶里**而且已经是活动的** = 恒等变换(连订阅都不该推)', () => {
    const before = leaf([A, B], 1)
    expect(T.insertTab(before, 'L1', B)).toBe(before)
  })

  it('预览:一片叶至多一个 —— 第二次单击**就地替换**,位置不变', () => {
    const first = T.insertTab(leaf([A]), 'L1', B, { preview: true })
    expect(T.findLeaf(first, 'L1')!.preview).toBe('k:b')
    const second = T.insertTab(first, 'L1', C, { preview: true })
    const l = T.findLeaf(second, 'L1')!
    // 十个文件十个 tab 那条病的反面:仍然只有两格,预览那一格换了内容。
    expect(l.tabs.map(refId)).toEqual(['k:a', 'k:c'])
    expect(l.preview).toBe('k:c')
    expect(l.active).toBe(1)
  })

  it('插在活动 tab **之前**时活动下标跟着挪(下标制 tab 条最容易漏的一格)', () => {
    const next = T.insertTab(leaf([A, B], 1), 'L1', C, { at: 0, activate: false })
    const l = T.findLeaf(next, 'L1')!
    expect(l.tabs.map(refId)).toEqual(['k:c', 'k:a', 'k:b'])
    // 屏幕上活动的还是 b。
    expect(refId(l.tabs[l.active])).toBe('k:b')
  })
})

describe('摘一格', () => {
  it('关掉活动那一条 = 右边那条顶上来', () => {
    const l = T.findLeaf(T.removeTab(leaf([A, B, C], 1), 'L1', 1), 'L1')!
    expect(l.tabs.map(refId)).toEqual(['k:a', 'k:c'])
    expect(refId(l.tabs[l.active])).toBe('k:c')
  })

  it('关掉最后一条 = 退一格', () => {
    const l = T.findLeaf(T.removeTab(leaf([A, B], 1), 'L1', 1), 'L1')!
    expect(refId(l.tabs[l.active])).toBe('k:a')
  })

  it('关掉活动**之前**那条 = 屏幕上不换内容', () => {
    const l = T.findLeaf(T.removeTab(leaf([A, B, C], 2), 'L1', 0), 'L1')!
    expect(refId(l.tabs[l.active])).toBe('k:c')
  })

  it('摘掉的正好是预览那一格 → 预览位清空', () => {
    const before = leaf([A, B], 1, 'k:b')
    expect(T.findLeaf(T.removeTab(before, 'L1', 1), 'L1')!.preview).toBeNull()
  })
})

describe('固定预览(「保留」)', () => {
  it('是预览的那一格 → 预览位清空', () => {
    expect(T.findLeaf(T.pinTab(leaf([A, B], 1, 'k:b'), 'L1', 1), 'L1')!.preview).toBeNull()
  })

  it('不是预览的那一格 → 恒等变换', () => {
    const before = leaf([A, B], 0, 'k:b')
    expect(T.pinTab(before, 'L1', 0)).toBe(before)
  })
})

describe('分屏', () => {
  const two = leaf([A, B], 1)

  it('把活动 tab 拉到新的那一片去,原叶留下其余的', () => {
    const next = T.splitLeaf(two, 'L1', 'row', 'L2', 'S1', null)
    expect(next.kind).toBe('split')
    const [first, second] = T.leavesOf(next)
    expect(first.tabs.map(refId)).toEqual(['k:a'])
    expect(second.tabs.map(refId)).toEqual(['k:b'])
  })

  it('`before` = 新叶排在原叶前面(向上 / 向左分)', () => {
    const next = T.splitLeaf(two, 'L1', 'col', 'L2', 'S1', null, { before: true })
    expect(T.leavesOf(next).map((l) => l.id)).toEqual(['L2', 'L1'])
  })

  it('只有一格时切不动 —— 切出去原叶就空了,那等于什么都没做', () => {
    const one = leaf([A])
    expect(T.splitLeaf(one, 'L1', 'row', 'L2', 'S1', null)).toBe(one)
  })

  it('点名了 ref = 开一份新的到旁边,原叶一格都不少', () => {
    const next = T.splitLeaf(leaf([A]), 'L1', 'row', 'L2', 'S1', C)
    const [first, second] = T.leavesOf(next)
    expect(first.tabs.map(refId)).toEqual(['k:a'])
    expect(second.tabs.map(refId)).toEqual(['k:c'])
  })
})

describe('结构共享:没改到的那一支交回同一个对象(零重挂的结构前提)', () => {
  const tree: PaneNode = {
    kind: 'split',
    id: 'S1',
    dir: 'row',
    ratio: 50,
    a: T.makeLeaf('L1', [A]),
    b: T.makeLeaf('L2', [B, C], 0),
  }

  it('改左边那一支,右边那一支引用不变', () => {
    const next = T.insertTab(tree, 'L1', C) as T.PaneSplitNode
    expect(next).not.toBe(tree)
    expect(next.b).toBe(tree.b)
  })

  it('改不到任何一支 = 整棵树交回同一个对象', () => {
    expect(T.activate(tree, 'L2', 0)).toBe(tree)
    expect(T.setRatio(tree, 'S1', 50)).toBe(tree)
    expect(T.insertTab(tree, 'nope', C)).toBe(tree)
  })
})

describe('剪枝', () => {
  it('空叶剪掉,split 只剩一支就把那一支提上来', () => {
    const tree: PaneNode = {
      kind: 'split',
      id: 'S1',
      dir: 'row',
      ratio: 50,
      a: T.makeLeaf('L1', []),
      b: T.makeLeaf('L2', [B]),
    }
    expect(T.prune(tree)).toEqual(T.makeLeaf('L2', [B]))
  })

  it('整棵都空了回 null —— 「空了怎么办」不是树的事,树只负责说实话', () => {
    expect(T.prune(T.makeLeaf('L1', []))).toBeNull()
  })
})

describe('sanitize:存量档案的入口闸', () => {
  it('未知种类**整格丢掉**(插件卸载了 / 版本回退了)', () => {
    const tree = T.makeLeaf('L1', [A, ref('gone', 'x'), B], 2)
    const clean = T.sanitize(tree, { known: (k) => k === 'k', singleton: () => false })!
    expect(T.leavesOf(clean)[0].tabs.map(refId)).toEqual(['k:a', 'k:b'])
    // 活动下标跟着夹回范围内(2 已经越界了)。
    expect(T.leavesOf(clean)[0].active).toBe(1)
  })

  it('单例重复 = 留第一格(单例的定义就是不许有第二份)', () => {
    const solo = ref('solo', 'one')
    const tree: PaneNode = {
      kind: 'split',
      id: 'S1',
      dir: 'row',
      ratio: 50,
      a: T.makeLeaf('L1', [solo]),
      b: T.makeLeaf('L2', [solo, B]),
    }
    const clean = T.sanitize(tree, { known: () => true, singleton: (k) => k === 'solo' })!
    expect(T.refIdsOf(clean)).toEqual(['solo:one', 'k:b'])
  })

  it('预览指着一个已经不在的 refId → 清掉', () => {
    const clean = T.sanitize(T.makeLeaf('L1', [A], 0, 'k:zzz'), OPEN)!
    expect(T.leavesOf(clean)[0].preview).toBeNull()
  })

  it('形状烂了(不是一棵树 / ratio 是 NaN)照样交出能渲染的东西', () => {
    expect(T.sanitize(null, OPEN)).toBeNull()
    expect(T.sanitize({ kind: 'nope' } as unknown as PaneNode, OPEN)).toBeNull()
    const bad: PaneNode = {
      kind: 'split',
      id: 'S1',
      dir: 'row',
      ratio: Number.NaN,
      a: T.makeLeaf('L1', [A]),
      b: T.makeLeaf('L2', [B]),
    }
    expect((T.sanitize(bad, OPEN) as T.PaneSplitNode).ratio).toBe(T.DEFAULT_SPLIT_RATIO)
  })

  it('**幂等**:洗过一遍的树再洗一遍交回同一个对象', () => {
    const once = T.sanitize(T.makeLeaf('L1', [A, ref('gone', 'x')]), {
      known: (k) => k === 'k',
      singleton: () => false,
    })!
    expect(T.sanitize(once, { known: (k) => k === 'k', singleton: () => false })).toBe(once)
  })
})

describe('查询', () => {
  const tree: PaneNode = {
    kind: 'split',
    id: 'S1',
    dir: 'col',
    ratio: 50,
    a: T.makeLeaf('L1', [A]),
    b: T.makeLeaf('L2', [B, C], 1),
  }

  it('叶按阅读序摊平(顶栏标签组的排序读它)', () => {
    expect(T.leavesOf(tree).map((l) => l.id)).toEqual(['L1', 'L2'])
  })

  it('定位:哪个区域、哪片叶、第几格', () => {
    expect(T.locateRef(tree, 'center', 'k:c')).toEqual({
      region: 'center',
      leafId: 'L2',
      index: 1,
    })
    expect(T.locateRef(tree, 'center', 'k:zzz')).toBeNull()
  })

  it('数同种还剩几个(「最后一格不可关」那条判据读它)', () => {
    expect(T.countKind(tree, 'k')).toBe(3)
    expect(T.countKind(tree, 'solo')).toBe(0)
  })
})

describe('搬一格', () => {
  const tree: PaneNode = {
    kind: 'split',
    id: 'S1',
    dir: 'row',
    ratio: 50,
    a: T.makeLeaf('L1', [A, B], 0),
    b: T.makeLeaf('L2', [C], 0),
  }

  it('跨叶搬:从这一片摘掉,插进那一片并激活', () => {
    const next = T.moveTab(tree, { leafId: 'L1', index: 1 }, { leafId: 'L2' })
    const [first, second] = T.leavesOf(next)
    expect(first.tabs.map(refId)).toEqual(['k:a'])
    expect(second.tabs.map(refId)).toEqual(['k:c', 'k:b'])
    expect(second.active).toBe(1)
  })

  it('同叶内排序:摘掉之后目标下标要往前收一格(splice 双动作那个经典坑)', () => {
    const next = T.moveTab(T.makeLeaf('L1', [A, B, C], 0), { leafId: 'L1', index: 0 }, { leafId: 'L1', at: 2 })
    expect(T.leavesOf(next)[0].tabs.map(refId)).toEqual(['k:b', 'k:a', 'k:c'])
  })
})
