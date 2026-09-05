import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { LeafActions } from '../LeafActions'
import { dropRef, unpairTab } from '../drop-commit'
import { CENTER_REGION, edgeRegion } from '../regions'
import { registerContentKind, refId, resetContentKinds } from '../kinds'
import { useWorkbenchStore } from '../store'
import { useStageStore } from '../../stage/store'
import { t } from '../../i18n'
import { pairContentKind } from '../../content/kinds/pair'
import { DEFAULT_PANEL_VISIBILITY } from '../../content/visibility'
import { pairRefOf } from '../../content/kinds/pair-ref'
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
  /*
   * **被测的那一种自己装回去**(与 `pair.test.tsx` 逐字同一条):`resetContentKinds`
   * 把模块级注册的 `pair` 也摘了,而「二合一 / 拆开」两条路问的正是它的自述
   * (`composite`)—— 不装回去,两条路会一起空转,平局断言当场变成一句空话。
   */
  registerContentKind(pairContentKind)
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

/**
 * 「已拆开」那句话按**机器的语言**走(全新 user-data-dir 上未必是中文)——
 * 与本文件既有那几条 `/移到右侧|Move to the right/` 同一体例。两条路念的必须是
 * 同一句,而这一句本身取自字典,不在用例里再抄一份。
 */
const UNPAIRED = t('workbench.unpaired')

beforeEach(() => {
  // 播报那一拍要推得动(`announce` 是 `setTimeout(…, 0)` 的先清后写)。
  vi.useFakeTimers()
  // 播报口是模块级的一个 DOM 节点,活过整个文件 —— 每条用例各读各的那一句。
  clearLive()
  seedKinds()
  useWorkbenchStore.getState().reset()
})

afterEach(() => {
  vi.useRealTimers()
  resetContentKinds()
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

/**
 * 播报口里此刻那句话(`announce` 走一拍 `setTimeout`:先清空再写,读屏才会重念)。
 * 用例里用假计时器把那一拍推完,所以读的是**落定后**的那一句。
 */
function liveText(): string {
  act(() => {
    vi.advanceTimersByTime(50)
  })
  return document.querySelector('[data-live="polite"]')?.textContent?.trim() ?? ''
}

/** 把播报口清成空 —— 两条路各读各的,不许读到上一条留下的那句。 */
function clearLive(): void {
  const el = document.querySelector('[data-live="polite"]')
  if (el) el.textContent = ''
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

/**
 * **二合一:菜单与拖拽是同一个动作**(W6-c,设计 v3 §7 那张表的第二行)。
 *
 * 与上面两组同一条判据 —— 比的是**结果**(树 + 形态机),不是「菜单调了哪只函数」。
 * 反证实测:把 `LeafActions` 的「与右边的标签二合一」换成直接
 * `useWorkbenchStore.getState().pairRefs(leaf.id, leaf.active + 1, active, 'left')`
 * (侧别换一边),第二条断言当场红(两格的次序反过来)。
 */
describe('二合一:菜单与拖拽是同一个动作', () => {
  it('菜单「与右边的标签二合一」与 dropRef(pairTab) 交出同一棵树', () => {
    /*
     * ── 等价的那一下是**哪一下**(施工时当场量出来的一处真差别)──────────────
     * 「二合一」这件事里,**谁是宿主**决定了两格的左右次序:`pairIntoIndex` 把
     * `ref` 放到第 `at` 格那位宿主的 `side` 侧。所以
     *   · 菜单「与右边的标签二合一」(活动格 = A,右邻居 = B)= 宿主 A、被并的 B、右侧
     *     → `A ⫽ B`;
     *   · 而拖 **A 到 B 上** = 宿主 B、被并的 A、右侧 → `B ⫽ A`。
     * 两者是**两个手势**,结果本就该不同(拖谁上去谁在右,这正是 §5「放到标签上」的
     * 语义)。所以这一组比的是与菜单**真正同一下**的那个手势:拖 **B 到 A 上**。
     * 第一版按 `A → B` 写,当场红并打出 `pair:parity-a:a…` vs `pair:parity-b:b…`
     * —— 那不是分叉,是把两个手势当成了一个。
     */
    // ① 拖拽那条路:把 B 放到左边那格 A 上(§5「标签正中 = 与它二合一」)。
    seedTwo()
    act(() => {
      dropRef(B, { kind: 'pairTab', region: CENTER_REGION, leafId: 'leaf-reorder', at: 0 })
    })
    const viaDrag = snapshot()
    // 顺带钉住它真的并成了一格 —— 两边都空转的话平局那一句也会绿。
    expect(refIdsOf(leafNow('leaf-reorder')), '两格并成一格').toEqual([
      refId(pairRefOf(A, B)),
    ])

    // ② 菜单那条路。活动格 = A(第 0 格),右边那格是 B。
    const leaf = makeLeaf('leaf-reorder', [A, B], 0)
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: leaf },
      hidden: [],
      focusLeafId: leaf.id,
      dragging: false,
    })
    render(<LeafActions leaf={leaf} />)
    act(() => {
      fireEvent.click(screen.getByTestId(`pane-split:${leaf.id}`))
    })
    const item = screen
      .getAllByRole('menuitem')
      .find((el) => /与右边的标签二合一|Join with the tab on the right/.test(el.textContent ?? ''))
    expect(item, '菜单里有「与右边的标签二合一」那一项').toBeTruthy()
    act(() => {
      fireEvent.click(item as HTMLElement)
    })
    expect(snapshot()).toBe(viaDrag)
  })
})

/**
 * **拆开:菜单与格头上那颗钮是同一个动作**(W6-c,设计 v3 §7 那张表的第三行
 * 「菜单『拆开』;格头上的按钮」)。
 *
 * 这一组比的是**树 + 那句播报**两件。拆开没有拖拽等价(拖不出「拆开」这个手势),
 * 所以平局的两边是**菜单**与**格头那颗钮**——而后者调的就是 `unpairTab`(产地)。
 * 反证实测:把 `LeafActions` 那一项改回 `store.unpairAt` + 自己 `announce`,
 * 树那一句照旧绿、**播报那一句照旧绿**(它自己念了),但把 `pair.tsx` 那颗钮
 * 改回直接调 store 之后,「格头那颗钮也说话」当场红 —— 那正是修前的真实状态。
 */
describe('拆开:菜单与格头按钮是同一个动作', () => {
  /** 出厂:一片叶两格,第 0 格是 A⫽B 那一种,活动 = 第 0 格。 */
  function seedPaired(): PaneLeafNode {
    const leaf = makeLeaf('leaf-unpair', [pairRefOf(A, B)], 0)
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: leaf },
      hidden: [],
      focusLeafId: leaf.id,
      dragging: false,
    })
    return leaf
  }

  it('菜单「拆开」与格头那颗钮走的 unpairTab 交出同一棵树', () => {
    // ① 产地那条路(= 格头上那颗钮:`pair.tsx` 的 `unpair` 调的就是它)。
    seedPaired()
    act(() => {
      unpairTab('leaf-unpair', 0)
    })
    const viaButton = snapshot()
    expect(refIdsOf(leafNow('leaf-unpair')), '拆成两格').toEqual([refId(A), refId(B)])

    // ② 菜单那条路。
    const leaf = seedPaired()
    render(<LeafActions leaf={leaf} />)
    act(() => {
      fireEvent.click(screen.getByTestId(`pane-split:${leaf.id}`))
    })
    const item = screen
      .getAllByRole('menuitem')
      .find((el) => /^(拆开|Split apart)$/.test((el.textContent ?? '').trim()))
    expect(item, '菜单里有「拆开」那一项').toBeTruthy()
    act(() => {
      fireEvent.click(item as HTMLElement)
    })
    expect(snapshot()).toBe(viaButton)
  })

  it('两条路都说同一句话 —— 播报住在 unpairTab 里,不在菜单上', () => {
    /*
     * **按的是格头上那颗真钮**,不是替它调一次 `unpairTab`。
     * 第一版就是那么写的,于是把 `pair.tsx` 改回直接调 `store.unpairAt`(修前的
     * 真实状态)之后这条用例**照旧全绿** —— 它守的其实是产地自己,而不是那颗钮
     * 有没有走产地。改成渲染 `pair` 那一种、点它的 `pair-unpair:<id>`,反证才咬得住。
     */
    seedPaired()
    const { container } = render(
      <>{pairContentKind.render(pairRefOf(A, B), DEFAULT_PANEL_VISIBILITY)}</>,
    )
    /* 两格各有一颗「拆开」(它们调的是同一口),按左边那一颗就够 ——
     * testid 上带的是**那一格**的 id,所以按前缀取,与 `gate:a11y` 那一屏同一条查法。 */
    const button = container.querySelector('[data-testid^="pair-unpair:"]')
    expect(button, '格头上有那颗「拆开」').toBeTruthy()
    act(() => {
      fireEvent.click(button as HTMLElement)
    })
    expect(liveText(), '格头那颗钮按下去,播报口里有话').toBe(UNPAIRED)

    // 菜单那条路,同一句话。
    clearLive()
    const leaf = seedPaired()
    render(<LeafActions leaf={leaf} />)
    act(() => {
      fireEvent.click(screen.getByTestId(`pane-split:${leaf.id}`))
    })
    const item = screen
      .getAllByRole('menuitem')
      .find((el) => /^(拆开|Split apart)$/.test((el.textContent ?? '').trim()))
    act(() => {
      fireEvent.click(item as HTMLElement)
    })
    expect(liveText()).toBe(UNPAIRED)
  })

  it('本来就不是两格 = 空动作,也不播报(念一句而屏幕没变是撒谎)', () => {
    const leaf = makeLeaf('leaf-unpair', [A, B], 0)
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: leaf },
      hidden: [],
      focusLeafId: leaf.id,
      dragging: false,
    })
    const before = snapshot()
    act(() => {
      unpairTab('leaf-unpair', 0)
    })
    expect(snapshot()).toBe(before)
    expect(liveText()).toBe('')
  })
})
