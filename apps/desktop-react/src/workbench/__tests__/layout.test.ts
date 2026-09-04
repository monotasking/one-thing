import { describe, expect, it } from 'vitest'
import { layoutTree, leafCount, ratioVar, ratioVars } from '../layout'
import { makeLeaf } from '../tree'
import type { PaneNode } from '../tree'

/**
 * **摊平**(W1)。这一组守三件:①一片叶时铺满;②切分把地一分为二,而且比例
 * 走一格 CSS 变量(拖拽期间一帧不经过 React);③嵌套时算式**乘进去**,
 * 而不是各算各的。
 */

const leaf = (id: string) => makeLeaf(id, [{ kind: 'k', key: id }])

const split = (id: string, dir: 'row' | 'col', a: PaneNode, b: PaneNode, ratio = 50): PaneNode => ({
  kind: 'split',
  id,
  dir,
  ratio,
  a,
  b,
})

describe('一片叶', () => {
  it('铺满,没有缝', () => {
    const out = layoutTree(leaf('L1'))
    expect(out.seams).toHaveLength(0)
    expect(out.leaves[0].box).toEqual({
      left: 'calc(0%)',
      top: 'calc(0%)',
      width: 'calc(100%)',
      height: 'calc(100%)',
    })
  })
})

describe('一次切分', () => {
  const tree = split('S1', 'row', leaf('L1'), leaf('L2'))

  it('左右两块地各按比例,而比例是**一格变量**不是一个数', () => {
    const { leaves } = layoutTree(tree)
    expect(leaves.map((l) => l.leaf.id)).toEqual(['L1', 'L2'])
    // 变量名进算式 —— 拖拽期间浏览器自己重排,React 一帧都不跑。
    expect(leaves[0].box.width).toContain('var(--pr-S1, 50)')
    expect(leaves[1].box.left).toContain('var(--pr-S1, 50)')
    // 两块地加起来正好是整块(第二块是「总宽减去第一块」,不是「100 减比例」——
    // 后者在嵌套里会算错)。
    expect(leaves[1].box.width).toBe('calc((100% - (100% * var(--pr-S1, 50) / 100)))')
  })

  it('缝坐在分界上,量比例的那个盒铺的是**这一次切分自己那块地**', () => {
    const { seams } = layoutTree(tree)
    expect(seams).toHaveLength(1)
    expect(seams[0].id).toBe('S1')
    expect(seams[0].box.width).toBe('calc(100%)')
    expect(seams[0].seam.left).toContain('var(--pr-S1, 50)')
  })

  it('上下切分换一条轴', () => {
    const { leaves, seams } = layoutTree(split('S1', 'col', leaf('L1'), leaf('L2')))
    expect(leaves[0].box.height).toContain('var(--pr-S1, 50)')
    expect(leaves[0].box.width).toBe('calc(100%)')
    expect(seams[0].seam.top).toContain('var(--pr-S1, 50)')
  })
})

describe('嵌套:算式乘进去', () => {
  const tree = split('S1', 'row', leaf('L1'), split('S2', 'col', leaf('L2'), leaf('L3')))

  it('里层那片叶的宽度带着外层那格比例(不是各算各的)', () => {
    const { leaves } = layoutTree(tree)
    const l2 = leaves.find((l) => l.leaf.id === 'L2')!
    expect(l2.box.width).toContain('var(--pr-S1, 50)')
    expect(l2.box.height).toContain('var(--pr-S2, 50)')
    // 里层的左边界 = 外层那条缝的位置。
    expect(l2.box.left).toContain('var(--pr-S1, 50)')
  })

  it('叶仍然按阅读序出(顶栏标签组的分组次序读它)', () => {
    expect(layoutTree(tree).leaves.map((l) => l.leaf.id)).toEqual(['L1', 'L2', 'L3'])
  })
})

describe('比例表与叶数', () => {
  it('每一次切分一行,变量名是唯一产地', () => {
    const tree = split('S1', 'row', leaf('L1'), split('S2', 'col', leaf('L2'), leaf('L3'), 30), 70)
    expect(ratioVars(tree)).toEqual({ [ratioVar('S1')]: '70', [ratioVar('S2')]: '30' })
  })

  it('叶数(焦点边画不画的判据)', () => {
    expect(leafCount(leaf('L1'))).toBe(1)
    expect(leafCount(split('S1', 'row', leaf('L1'), leaf('L2')))).toBe(2)
  })
})
