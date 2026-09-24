import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerContentKind, resetContentKinds } from '../kinds'
import { leavesOf, makeLeaf, refIdsOf } from '../tree'
import { normalizeRegions } from '../store'
import type { ContentKind, ContentRef } from '../kinds'
import type { PaneNode } from '../tree'

/**
 * **退役的顶边架子那棵树并进底边**(09-24:顶架子退役,三边只剩左右下)。
 *
 * 老档案里躺着的 `edge:top` 不能原样留着(没有宿主再画它 = 一组看不见的标签),
 * 也不能丢(那是用户开着的东西)。这一组钉两档:底边空着 → 整棵挪过去;底边有树 →
 * 顶边那几格接到底边第一片叶末尾,不抢活动格。
 */

const doc: ContentKind = {
  id: 'doc',
  singleton: false,
  title: (ref) => ({ text: ref.key }),
  icon: () => 'File',
  render: () => null,
}
const d = (key: string): ContentRef => ({ kind: 'doc', key })

/** 顶边那棵:左右分屏,左叶两格(活动在第二格)、右叶一格。 */
const topTree = (): PaneNode => ({
  kind: 'split',
  id: 'split-top',
  dir: 'row',
  ratio: 30,
  a: makeLeaf('leaf-top-a', [d('a'), d('b')], 1),
  b: makeLeaf('leaf-top-b', [d('c')], 0),
})

beforeEach(() => {
  resetContentKinds()
  registerContentKind(doc)
})

afterEach(() => {
  resetContentKinds()
})

describe('normalizeRegions:edge:top → edge:bottom', () => {
  it('底边空着:整棵树原样挪过去(叶 id、分屏比例、活动格都不变)', () => {
    const out = normalizeRegions({ 'edge:top': topTree() })
    expect(out['edge:top']).toBeUndefined()
    expect(out['edge:bottom']).toEqual(topTree())
  })

  it('底边有树:顶边那几格按阅读序接到底边第一片叶末尾,活动格仍是底边原来那格', () => {
    const out = normalizeRegions({
      'edge:top': topTree(),
      'edge:bottom': makeLeaf('leaf-bottom', [d('x'), d('y')], 0),
    })
    expect(out['edge:top']).toBeUndefined()
    const bottom = out['edge:bottom']!
    expect(refIdsOf(bottom)).toEqual(['doc:x', 'doc:y', 'doc:a', 'doc:b', 'doc:c'])
    const [home] = leavesOf(bottom)
    expect(home.id).toBe('leaf-bottom')
    expect(home.tabs[home.active]).toEqual(d('x'))
  })
})
