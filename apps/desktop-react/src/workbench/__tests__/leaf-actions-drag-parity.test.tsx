import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { LeafActions } from '../LeafActions'
import { dropRef } from '../drop-commit'
import { CENTER_REGION, edgeRegion } from '../regions'
import { registerContentKind, refId, resetContentKinds } from '../kinds'
import { useWorkbenchStore } from '../store'
import { useStageStore } from '../../stage/store'
import { findLeaf, makeLeaf, refIdsOf } from '../tree'
import type { ContentRef } from '../kinds'
import type { PaneLeafNode } from '../tree'

/**
 * **「菜单与拖拽是同一个动作」的守卫**(W3 裁定 9;派工令验收的反证第五条:
 * 「菜单与拖拽走两个动作 →『同一事务』单测红」)。
 *
 * 断言的形状是**平局**,不是「菜单调了某个函数」:同一份出厂树,一边走
 * 叶动作组菜单里那一项、一边直接 `dropRef(ref, target)`,两边跑完之后
 * **树与形态机的读数逐字相同**。
 *
 * 这么写而不是去 spy 那只函数,是因为要守的东西是**结果**:哪天有人给菜单
 * 那一路补了一句「顺手再展开一下」「顺手记一格记忆」,spy 照样绿,而用户看到的
 * 是「菜单里搬过去和拖过去结果不一样」—— 那正是这条反证要拦的病。
 */

const A: ContentRef = { kind: 'parity-a', key: 'a' }
const B: ContentRef = { kind: 'parity-b', key: 'b' }

function seedKinds(): void {
  resetContentKinds()
  for (const kind of ['parity-a', 'parity-b']) {
    registerContentKind({
      id: kind,
      singleton: false,
      title: (ref) => ({ text: ref.key }),
      icon: () => 'File',
      render: () => null,
    })
  }
}

/** 出厂:中央区一片叶,活动那一格是 A。 */
function seed(): PaneLeafNode {
  const leaf = makeLeaf('leaf-parity', [A, B], 0)
  useWorkbenchStore.setState({
    regions: { [CENTER_REGION]: leaf },
    hidden: [],
    focusLeafId: leaf.id,
    dragging: false,
  })
  /*
   * 右架子出厂**收着**:落定那条路会顺手把它展开(「新入架子顺手展开」),
   * 而一条只搬树不管宿主的捷径不会 —— 这一格就是两条路会不会分叉的**照妖镜**。
   * 反证实测:把菜单那一项换成 `workbench.moveRef` 之后,这一格当场红。
   */
  useStageStore.setState((st) => ({
    floats: {},
    floatOrder: [],
    shelves: { ...st.shelves, right: { ...st.shelves.right, collapsed: true } },
  }))
  return leaf
}

/** 两边跑完之后拿来比的那一份读数。 */
function snapshot() {
  const regions = useWorkbenchStore.getState().regions
  const stage = useStageStore.getState()
  return JSON.stringify({
    regions: Object.fromEntries(
      Object.entries(regions).map(([region, tree]) => [region, refIdsOf(tree)]),
    ),
    shelves: Object.fromEntries(
      Object.entries(stage.shelves).map(([side, s]) => [side, s.collapsed]),
    ),
  })
}

beforeEach(() => {
  seedKinds()
  useWorkbenchStore.getState().reset()
})

describe('叶动作组菜单 = 拖拽落定,同一个事务', () => {
  it('「移到右侧」与 dropRef(edge:right) 交出同一棵树', () => {
    // ① 菜单那条路。
    const leaf = seed()
    render(<LeafActions leaf={leaf} />)
    act(() => {
      fireEvent.click(screen.getByTestId(`pane-split:${leaf.id}`))
    })
    const item = screen
      .getAllByRole('menuitem')
      .find((el) => /移到右侧|Move to the right/.test(el.textContent ?? ''))
    expect(item, '菜单里有「移到右侧」那一项(裁定 9:每个落点都能从菜单到达)').toBeTruthy()
    act(() => {
      fireEvent.click(item as HTMLElement)
    })
    const viaMenu = snapshot()

    // ② 拖拽落定那条路(同一份出厂树、同一个落点)。
    act(() => {
      seed()
      dropRef(A, { kind: 'edge', side: 'right' })
    })
    const viaDrag = snapshot()

    expect(viaMenu).toBe(viaDrag)
    // 顺带钉住「它真的搬过去了」——两边都空转的话上面那一句也会绿。
    expect(JSON.parse(viaDrag).regions[edgeRegion('right')]).toEqual([refId(A)])
  })

  it('「撕成浮窗」与 dropRef(float) 交出同一棵树', () => {
    const leaf = seed()
    render(<LeafActions leaf={leaf} />)
    act(() => {
      fireEvent.click(screen.getByTestId(`pane-split:${leaf.id}`))
    })
    const item = screen
      .getAllByRole('menuitem')
      .find((el) => /撕成浮窗|Tear off/.test(el.textContent ?? ''))
    expect(item, '菜单里有「撕成浮窗」那一项').toBeTruthy()
    act(() => {
      fireEvent.click(item as HTMLElement)
    })
    const menuFloats = Object.keys(useWorkbenchStore.getState().regions).filter((r) =>
      r.startsWith('float:'),
    )
    const menuTabs = refIdsOf(useWorkbenchStore.getState().regions[menuFloats[0]])

    act(() => {
      seed()
      dropRef(A, { kind: 'float' })
    })
    const dragFloats = Object.keys(useWorkbenchStore.getState().regions).filter((r) =>
      r.startsWith('float:'),
    )
    const dragTabs = refIdsOf(useWorkbenchStore.getState().regions[dragFloats[0]])

    // 窗号是**新铸**的(两次不同,那正是 `nextFloatId` 该做的),所以比的是里面装了什么。
    expect(menuFloats).toHaveLength(1)
    expect(dragFloats).toHaveLength(1)
    expect(menuTabs).toEqual(dragTabs)
    expect(menuTabs).toEqual([refId(A)])
  })
})

/** 出厂:一片叶两格,活动 = 第二格。 */
function seedTwo(): PaneLeafNode {
  const leaf = makeLeaf('leaf-reorder', [A, B], 1)
  useWorkbenchStore.setState({
    regions: { [CENTER_REGION]: leaf },
    hidden: [],
    focusLeafId: leaf.id,
    dragging: false,
  })
  return leaf
}

function leafNow(id: string): PaneLeafNode {
  const found = findLeaf(useWorkbenchStore.getState().regions[CENTER_REGION], id)
  if (!found) throw new Error(`没有这片叶:${id}`)
  return found
}

/**
 * **条内换序:拖着走完与按菜单走完是同一个动作**(W3-b 裁定 8)。
 *
 * W6-a 之前这一组断言的是「预览那一格的身份跟着搬」(W5-b 合树接缝 a 的了结)。
 * 预览 tab 整档退役之后那句话没有对象了,而它守的那件事**还在**:两条路必须调
 * 同一只 `reorderTab`。所以这一组保留、断言换成序本身。
 * 反证:把 `LeafActions` 的「左移」改成自己拼一次 `moveRefIntoLeaf`,
 * 第二条断言当场红(那条路会把它插到末位)。
 */
describe('条内换序:菜单与拖拽是同一个动作', () => {
  it('拖着换序与菜单「左移」换出同一棵树', () => {
    // ① 拖拽那条路:把第 2 格拖到第 1 位。
    seedTwo()
    act(() => {
      dropRef(B, { kind: 'strip', leafId: 'leaf-reorder', at: 0 })
    })
    const viaDrag = leafNow('leaf-reorder')
    expect(viaDrag.tabs.map(refId), '序真的换了').toEqual([refId(B), refId(A)])

    // ② 菜单那条路(左移),同一份出厂树 —— 两条路必须是同一个动作。
    const leaf = seedTwo()
    render(<LeafActions leaf={leaf} />)
    act(() => {
      fireEvent.click(screen.getByTestId(`pane-split:${leaf.id}`))
    })
    const item = screen
      .getAllByRole('menuitem')
      .find((el) => /左移一位|Move left/.test(el.textContent ?? ''))
    expect(item, '菜单里有「左移」那一项').toBeTruthy()
    act(() => {
      fireEvent.click(item as HTMLElement)
    })
    const viaMenu = leafNow('leaf-reorder')
    expect(viaMenu.tabs.map(refId)).toEqual(viaDrag.tabs.map(refId))
    expect(viaMenu.active).toBe(viaDrag.active)
  })
})
