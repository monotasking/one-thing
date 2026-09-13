import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isKnownContent, registerContentKind, resetContentKinds } from '../kinds'
import { makeLeaf, refIdsOf, sanitize } from '../tree'
import { normalizeHidden, normalizeRegions } from '../store'
import type { ContentKind, ContentRef } from '../kinds'
import type { PaneLocation, PaneNode } from '../tree'

/**
 * **`ContentKind.exists`:种类还在、那一个没了**(2026-09-13,起因:模型服务
 * 那块瓦并进设置页)。
 *
 * `sanitize` 从前只问得出「这**一种**还在不在」,于是一格 `panel:providers` 会
 * 活下来,在标签条上变成一格点开是空白的 tab。这一组量的是三处:`isKnownContent`
 * 自己、`sanitize` 那一遍、以及隐藏表那一遍。
 *
 * 用**自造的一种内容**而不是真的 `panel`:这一条守的是机制,而 `panel` 认得哪几块
 * 瓦是瓦表的事(它自己那一格由 `panel.tsx` 与瓦表守)。
 */

const ALIVE = 'p-alive'

const kind: ContentKind = {
  id: 'tile',
  singleton: true,
  exists: (ref: ContentRef) => ref.key === ALIVE,
  title: (ref) => ({ text: ref.key }),
  icon: () => 'LayoutGrid',
  render: () => null,
}

/** 一种**不自述** `exists` 的内容:缺席 = 每一格都算认得出。 */
const plain: ContentKind = {
  id: 'doc',
  singleton: false,
  title: (ref) => ({ text: ref.key }),
  icon: () => 'File',
  render: () => null,
}

const tile = (key: string): ContentRef => ({ kind: 'tile', key })
const doc = (key: string): ContentRef => ({ kind: 'doc', key })

beforeEach(() => {
  resetContentKinds()
  registerContentKind(kind)
  registerContentKind(plain)
})

afterEach(() => {
  resetContentKinds()
})

describe('isKnownContent', () => {
  it('种类不在表上 = 认不出(与从前逐字相同)', () => {
    expect(isKnownContent({ kind: 'gone', key: ALIVE })).toBe(false)
  })

  it('种类在、那一个也在 = 认得出', () => {
    expect(isKnownContent(tile(ALIVE))).toBe(true)
  })

  it('**种类在、那一个没了 = 认不出**(这一批新开的那一格)', () => {
    expect(isKnownContent(tile('p-retired'))).toBe(false)
  })

  it('没自述 `exists` 的种类:每一格都算认得出(缺席 = 都认)', () => {
    expect(isKnownContent(doc('anything'))).toBe(true)
  })
})

describe('sanitize 那一遍', () => {
  const known = isKnownContent
  const singleton = () => false

  it('退役的那一格整个丢掉,同叶其余的 tab 原样', () => {
    const tree = makeLeaf('L1', [doc('a'), tile('p-retired'), tile(ALIVE)], 2)
    const clean = sanitize(tree, { known, singleton })!
    expect(refIdsOf(clean)).toEqual(['doc:a', `tile:${ALIVE}`])
    // 活动下标跟着夹回范围内。
    expect((clean as { active: number }).active).toBe(1)
  })

  it('一格都没死时**引用恒等**(幂等)', () => {
    const tree = makeLeaf('L1', [doc('a'), tile(ALIVE)])
    expect(sanitize(tree, { known, singleton })).toBe(tree)
  })
})

describe('store 的两遍', () => {
  it('`normalizeRegions`:树里那格退役的 tab 没了,别的 tab 原样', () => {
    const regions: Record<string, PaneNode> = {
      'edge:right': makeLeaf('L1', [tile('p-retired'), doc('a')]),
    }
    const out = normalizeRegions(regions)
    expect(refIdsOf(out['edge:right']!)).toEqual(['doc:a'])
  })

  it('`normalizeRegions`:还认得出的那一格活着(不是把整种都剔了)', () => {
    const regions: Record<string, PaneNode> = {
      'edge:right': makeLeaf('L1', [tile(ALIVE), doc('a')]),
    }
    expect(refIdsOf(normalizeRegions(regions)['edge:right']!)).toEqual([`tile:${ALIVE}`, 'doc:a'])
  })

  it('`normalizeHidden` 同理:退役的那一行剔掉,活着的留下', () => {
    const returnTo: PaneLocation = { region: 'edge:right', leafId: 'L1', index: 0 }
    const out = normalizeHidden([
      { ref: tile('p-retired'), returnTo },
      { ref: tile(ALIVE), returnTo },
      { ref: doc('a'), returnTo },
    ])
    expect(out.map((row) => `${row.ref.kind}:${row.ref.key}`)).toEqual([
      `tile:${ALIVE}`,
      'doc:a',
    ])
  })
})
