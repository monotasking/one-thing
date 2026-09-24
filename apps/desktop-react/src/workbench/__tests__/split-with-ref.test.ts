import { beforeEach, describe, expect, it } from 'vitest'
import { registerContentKind, resetContentKinds } from '../kinds'
import { CENTER_REGION, edgeRegion } from '../regions'
import { useWorkbenchStore } from '../store'
import { leavesOf, makeLeaf, refIdsOf } from '../tree'
import type { ContentRef } from '../kinds'
import type { PaneNode } from '../tree'

/**
 * **`splitWithRef`:拖拽「分屏」那一档的落定**(09-24)。把一格内容从它在的地方搬出来,
 * 在目标叶的那一侧切出一片新叶装它;中央区也能切(`SINGLE_LEAF_REGIONS` 已空)。
 */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })
const RIGHT = edgeRegion('right')

beforeEach(() => {
  resetContentKinds()
  registerContentKind({
    id: 'doc',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'File',
    render: () => null,
  })
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.setState({
    regions: {
      [CENTER_REGION]: makeLeaf('C', [doc('a')], 0),
      [RIGHT]: makeLeaf('S', [doc('b'), doc('c')], 0),
    },
    hidden: [],
    focusLeafId: 'C',
    dragging: false,
  })
})

const tree = (region: string): PaneNode => useWorkbenchStore.getState().regions[region]

describe('splitWithRef', () => {
  it('right:从架子搬进中央叶右侧的新叶(row,新叶在后),源叶失去它,焦点落新叶', () => {
    useWorkbenchStore.getState().splitWithRef('C', 'right', doc('b'))
    const center = tree(CENTER_REGION)
    expect(center.kind === 'split' && center.dir).toBe('row')
    const [kept, fresh] = leavesOf(center)
    expect(kept.id).toBe('C')
    expect(refIdsOf(center)).toEqual(['doc:a', 'doc:b'])
    expect(useWorkbenchStore.getState().focusLeafId).toBe(fresh.id)
    expect(refIdsOf(tree(RIGHT))).toEqual(['doc:c'])
  })

  it('top:上下分(col),新叶在前', () => {
    useWorkbenchStore.getState().splitWithRef('C', 'top', doc('b'))
    const center = tree(CENTER_REGION)
    expect(center.kind === 'split' && center.dir).toBe('col')
    const [fresh, kept] = leavesOf(center)
    expect(kept.id).toBe('C')
    expect(refIdsOf(fresh)).toEqual(['doc:b'])
    expect(useWorkbenchStore.getState().focusLeafId).toBe(fresh.id)
    expect(refIdsOf(tree(RIGHT))).toEqual(['doc:c'])
  })

  it('往自己那片只有一格的叶上切 = 空动作(状态引用恒等)', () => {
    const before = useWorkbenchStore.getState()
    useWorkbenchStore.getState().splitWithRef('C', 'left', doc('a'))
    const after = useWorkbenchStore.getState()
    expect(after.regions).toBe(before.regions)
    expect(after.focusLeafId).toBe('C')
  })
})
