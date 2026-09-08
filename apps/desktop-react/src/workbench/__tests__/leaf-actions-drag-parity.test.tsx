import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { LeafActions } from '../LeafActions'
import { dropRef, pairIntoIndex, reorderTab, unpairTab } from '../drop-commit'
import { openLeafMenuAt } from '../leaf-menu'
import { CENTER_REGION, edgeRegion } from '../regions'
import { registerContentKind, refId, resetContentKinds } from '../kinds'
import { useWorkbenchStore } from '../store'
import { useStageStore } from '../../stage/store'
import { t } from '../../i18n'
import { pairContentKind } from '../../content/kinds/pair'
import { DEFAULT_PANEL_VISIBILITY } from '../../content/visibility'
import { pairRefOf } from '../../content/kinds/pair-ref'
import { findLeaf, makeLeaf, refIdsOf } from '../tree'
import { leafCount } from '../layout'
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

/**
 * **开这片叶的动作表**(W7-c)。
 *
 * 从前这里按的是檐右端那颗「分屏」钮(`pane-split:<叶 id>`);裁定 2 把它删了 ——
 * 一张作用在某一格标签上的表,它的产地本来就该是那一格的右键菜单,留一颗钮等于
 * 同一张表有两个入口,而其中一个还写着它第一项的名字。
 *
 * 用例里没有真的标签条(它只渲染 `LeafActions` 一件),所以走**那个唯一的产地**:
 * `workbench/leaf-menu` 那一格 store。真机上右键 / Shift+F10 / 右键檐上的空白
 * 三条路调的都是它 —— 这一句因此不是「测试专用后门」,是那三条路的同一句话。
 */
function openLeafMenu(leafId: string): void {
  act(() => {
    openLeafMenuAt(leafId, { x: 10, y: 10 })
  })
}

/** 菜单里那一项(按文案认人,与本文件既有那几条正则同一体例)。 */
function menuItem(re: RegExp): HTMLElement {
  const hit = screen.getAllByRole('menuitem').find((el) => re.test((el.textContent ?? '').trim()))
  expect(hit, `菜单里有 ${re}`).toBeTruthy()
  return hit as HTMLElement
}

/** 点一项。 */
function clickItem(re: RegExp): void {
  act(() => {
    fireEvent.click(menuItem(re))
  })
}

/** 展开一格子菜单,再点它里面那一项。 */
function clickSubItem(parent: RegExp, child: RegExp): void {
  clickItem(parent)
  const sub = screen.getAllByRole('menu').at(-1) as HTMLElement
  const hit = Array.from(sub.querySelectorAll('[role="menuitem"]')).find((el) =>
    child.test((el.textContent ?? '').trim()),
  )
  expect(hit, `子菜单里有 ${child}`).toBeTruthy()
  act(() => {
    fireEvent.click(hit as HTMLElement)
  })
}

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

/** 「移到架子 ▸」那四行。名字取自字典 —— 与檐上、与播报说的是同一个词。 */
const SHELF_SIDES = ['left', 'right', 'top', 'bottom'] as const
const SHELF_LABEL: Record<(typeof SHELF_SIDES)[number], RegExp> = {
  left: new RegExp(`^${t('shelf.labelLeft')}$`),
  right: new RegExp(`^${t('shelf.labelRight')}$`),
  top: new RegExp(`^${t('shelf.labelTop')}$`),
  bottom: new RegExp(`^${t('shelf.labelBottom')}$`),
}

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
  /*
   * **「移到架子 ▸」四边全在,每一边都与拖过去同一只动作**(W7-c 裁定 3 起它是
   * 一格子菜单:四行平铺是「菜单太多」的一半)。四条各跑一遍,不是只跑「右侧」——
   * 「每个落点都能从菜单到达」是**可数的**,而一张按表生成的菜单最可能的错法是
   * 那张表少一行。
   */
  it.each(SHELF_SIDES)('「移到架子 ▸ %s」与 dropRef(edge) 交出同一棵树', (side) => {
    // ① 菜单那条路。
    const leaf = seed()
    render(<LeafActions leaf={leaf} />)
    openLeafMenu(leaf.id)
    clickSubItem(/^移到架子|^Move to shelf/, SHELF_LABEL[side])
    const viaMenu = snapshot()

    // ② 拖拽落定那条路(同一份出厂树、同一个落点)。
    act(() => {
      seed()
      dropRef(A, { kind: 'edge', side })
    })
    const viaDrag = snapshot()

    expect(viaMenu).toBe(viaDrag)
    // 顺带钉住「它真的搬过去了」——两边都空转的话上面那一句也会绿。
    expect(JSON.parse(viaDrag).regions[edgeRegion(side)]).toEqual([refId(A)])
  })

  it('「撕成浮窗」与 dropRef(float) 交出同一棵树', () => {
    const leaf = seed()
    render(<LeafActions leaf={leaf} />)
    openLeafMenu(leaf.id)
    clickItem(/撕成浮窗|Tear off/)
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
/**
 * **条内换序:键盘命令与拖拽是同一个动作**(W3-b 裁定 8 立;W7-c 换了主人)。
 *
 * W7-c 把「左移一位 / 右移一位」从标签动作表里删掉了(裁定 3:换序靠拖拽),
 * 键盘那条路升格成两条**全局命令**(`workbench.moveTabLeft` / `Right`)。
 * 这一组守的那件事一个字没变 —— **两条路必须调同一只 `reorderTab`** ——
 * 变的只是平局的一边:从「菜单里那一项」换成「派发器跑那条命令」。
 *
 * 反证:把 `keymap/dispatch` 里那一段换成自己拼一次 `moveRefIntoLeaf`,
 * 第二条断言当场红(那条路会把它插到末位)。
 */
describe('条内换序:键盘命令与拖拽是同一个动作', () => {
  /** 派发器那条路真正跑的那一句(`keymap/dispatch` 里的 `step` 与这里同源)。 */
  function runMoveCommand(step: -1 | 2): void {
    const st = useWorkbenchStore.getState()
    const leaf = findLeaf(st.regions[CENTER_REGION], 'leaf-reorder')
    if (!leaf) throw new Error('没有这片叶')
    act(() => {
      reorderTab(leaf.id, leaf.active, leaf.active + step)
    })
  }

  it('拖着换序与命令「标签左移一位」换出同一棵树', () => {
    // ① 拖拽那条路:把第 2 格拖到第 1 位。
    seedTwo()
    act(() => {
      dropRef(B, { kind: 'strip', leafId: 'leaf-reorder', at: 0 })
    })
    const viaDrag = leafNow('leaf-reorder')
    expect(viaDrag.tabs.map(refId), '序真的换了').toEqual([refId(B), refId(A)])

    // ② 键盘命令那条路,同一份出厂树。
    seedTwo()
    runMoveCommand(-1)
    const viaKey = leafNow('leaf-reorder')
    expect(viaKey.tabs.map(refId)).toEqual(viaDrag.tabs.map(refId))
    expect(viaKey.active).toBe(viaDrag.active)
  })

  it('命令「标签右移一位」= 插到后一格之后(那格 +2 是坐标系的定义,不是魔法数)', () => {
    const leaf = makeLeaf('leaf-reorder', [A, B], 0)
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: leaf },
      hidden: [],
      focusLeafId: leaf.id,
      dragging: false,
    })
    runMoveCommand(2)
    expect(leafNow('leaf-reorder').tabs.map(refId)).toEqual([refId(B), refId(A)])
  })

  /**
   * **那张表里不许再长出这两行**(W7-c 裁定 3)。它守的不是「少两行好看」——
   * 是「同一件事只有一个产地」:换序既然升格成了全局命令,菜单里再摆一份就等于
   * 那件事有了两个落点,而两个落点迟早分叉。
   */
  it('标签动作表里没有「左移 / 右移」', () => {
    const leaf = seedTwo()
    render(<LeafActions leaf={leaf} />)
    openLeafMenu(leaf.id)
    const texts = screen.getAllByRole('menuitem').map((el) => (el.textContent ?? '').trim())
    expect(texts.filter((x) => /左移|右移|Move tab/.test(x))).toEqual([])
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
  it('菜单「与右边的标签二合一」与拖拽那条路的落定交出同一棵树', () => {
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
    /*
     * ── **拖拽那条路的入口 U1 换过一次**(2026-09-08)────────────────────────
     * 从前它是 `dropRef({kind:'pairTab'})`(外来来源落到某一格标签正中);那一档
     * 随拖拽 v4 退役,「把一格标签压到另一格上」今天只剩**条内**那一形
     * (`useTabDrag` 的 onto 带,手压到条底缘下 6–24px 松手)。它的落定那一句
     * 就是 `pairIntoIndex(dragged, leafId, hostIndex, 'right')` —— 所以这一组
     * 比的仍旧是**同一下手势的结果**,只是从「模拟一个已经不存在的落点」改成
     * 「叫那条路真正调的那一只」。
     *
     * 比的东西一个字没变:**结果**(树 + 形态机),不是「谁调了哪只函数」。
     * 反证仍旧成立 —— 把 `LeafActions` 那一项的 side 换一边,第二条断言当场红。
     */
    // ① 拖拽那条路:把 B 压到左边那格 A 上。
    seedTwo()
    act(() => {
      pairIntoIndex(B, 'leaf-reorder', 0, 'right')
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
    openLeafMenu(leaf.id)
    clickItem(/与右边的标签二合一|Join with the tab on the right/)
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
    openLeafMenu(leaf.id)
    clickItem(/^(拆开|Split apart)$/)
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
    openLeafMenu(leaf.id)
    clickItem(/^(拆开|Split apart)$/)
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

/**
 * **「关闭」走的是 `useCloseLeafTab`,不是一句 `store.closeTab`**(W7-c 裁定 3 的
 * 第六项)。
 *
 * 平局的两边是「菜单那一项」与「tab 上那颗 ✕ / ⌘W」——三条路共用那一只 hook,
 * 而它自己会先问种类(`beforeClose`,脏文件那一问)、会在关不掉时播报。
 * 判据因此不是「树少了一格」(那句话一句 `closeTab` 也能满足),而是
 * **那一问真的被问了**:装一种 `beforeClose` 答 `'cancel'` 的内容,点「关闭」
 * 之后树一个字都不许动。反证:把菜单那一项换成 `store().closeTab(...)`,
 * 第一条当场红(它会绕过那一问直接关掉)。
 */
describe('关闭:菜单那一项与 ✕ / ⌘W 是同一只', () => {
  function seedAsking(answer: 'close' | 'cancel'): PaneLeafNode {
    resetContentKinds()
    registerContentKind({
      id: 'parity-ask',
      singleton: false,
      title: (ref) => ({ text: ref.key }),
      icon: () => 'File',
      render: () => null,
      beforeClose: () => Promise.resolve(answer),
    })
    registerContentKind(pairContentKind)
    const ref: ContentRef = { kind: 'parity-ask', key: 'q' }
    const leaf = makeLeaf('leaf-close', [ref, { ...ref, key: 'q2' }], 0)
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: leaf },
      hidden: [],
      focusLeafId: leaf.id,
      dragging: false,
    })
    return leaf
  }

  it('种类答 cancel 时点「关闭」什么都不发生(那一问真的被问了)', async () => {
    const leaf = seedAsking('cancel')
    render(<LeafActions leaf={leaf} />)
    openLeafMenu(leaf.id)
    clickItem(/^(关闭|Close)$/)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(refIdsOf(useWorkbenchStore.getState().regions[CENTER_REGION])).toHaveLength(2)
  })

  it('种类答 close 时那一格真的关掉', async () => {
    const leaf = seedAsking('close')
    render(<LeafActions leaf={leaf} />)
    openLeafMenu(leaf.id)
    clickItem(/^(关闭|Close)$/)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(refIdsOf(useWorkbenchStore.getState().regions[CENTER_REGION])).toHaveLength(1)
  })
})

/**
 * **「分屏 ▸」四向:菜单与 `store.splitLeaf` 是同一只**,而且**只在多叶区域画**
 * (W6-a / W7-c)。中央区收成一条标签条之后那四项在那里没有落点 ——
 * 一颗永远做不成的动作比禁灰更糟(禁灰说的是「此刻不行」,而那里是「这个区域里
 * 不存在这件事」)。所以这一组两件都守:架子叶上四向全在且都真分得开,
 * 中央叶上整节不画。
 */
describe('分屏 ▸:只在多叶区域,四向各与 splitLeaf 平局', () => {
  const SPLITS = [
    { label: /^(在右侧|To the right)$/, dir: 'row', before: false },
    { label: /^(在左侧|To the left)$/, dir: 'row', before: true },
    { label: /^(在下方|Below)$/, dir: 'col', before: false },
    { label: /^(在上方|Above)$/, dir: 'col', before: true },
  ] as const

  /** 架子上一片叶两格(分屏要两格才切得动)。 */
  function seedOnShelf(): PaneLeafNode {
    const leaf = makeLeaf('leaf-shelf', [A, B], 0)
    useWorkbenchStore.setState({
      regions: { [edgeRegion('right')]: leaf },
      hidden: [],
      focusLeafId: leaf.id,
      dragging: false,
    })
    return leaf
  }

  it.each(SPLITS)('架子叶:「分屏 ▸ $dir/$before」与 splitLeaf 交出同一棵树', (choice) => {
    // ① 菜单那条路。
    const leaf = seedOnShelf()
    render(<LeafActions leaf={leaf} />)
    openLeafMenu(leaf.id)
    clickSubItem(/^(分屏|Split)$/, choice.label)
    const viaMenu = JSON.stringify(
      refIdsOf(useWorkbenchStore.getState().regions[edgeRegion('right')]),
    )
    const shapeMenu = leafCount(useWorkbenchStore.getState().regions[edgeRegion('right')])

    // ② store 那条路(拖拽落定与它同源;分屏没有拖拽手势,产地就是这一只)。
    seedOnShelf()
    act(() => {
      useWorkbenchStore.getState().splitLeaf('leaf-shelf', choice.dir, undefined, choice.before)
    })
    expect(viaMenu).toBe(
      JSON.stringify(refIdsOf(useWorkbenchStore.getState().regions[edgeRegion('right')])),
    )
    expect(shapeMenu).toBe(leafCount(useWorkbenchStore.getState().regions[edgeRegion('right')]))
    expect(shapeMenu, '真的切成了两片').toBe(2)
  })

  it('中央叶上整节不画(单叶政策)', () => {
    const leaf = seedTwo()
    render(<LeafActions leaf={leaf} />)
    openLeafMenu(leaf.id)
    const texts = screen.getAllByRole('menuitem').map((el) => (el.textContent ?? '').trim())
    expect(texts.filter((x) => /^(分屏|Split)$/.test(x))).toEqual([])
  })
})
