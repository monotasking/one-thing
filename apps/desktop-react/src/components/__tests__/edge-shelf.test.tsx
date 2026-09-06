import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { useWorkbenchStore } from '../../workbench/store'
import type { ShelfSide } from '../../stage/types'
import { focusTree } from '../../focus/registry'

/**
 * 四边架子的挂载路径:形态机说「它在某条边上」,外壳就该在那条边画出一条架子。
 * 厚度算术与吸附判定在 transitions 的纯函数里测(那里能给定视口),
 * 这里只钉四件事:哪条边有 tab 就画哪条、空的一条都不画、收得起来、点细梁展得开。
 */
beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  /*
   * **两台 store 都要归零**(W4):架子上有什么从今天起住在拼贴树里
   * (`workbench.regions['edge:<side>']`),`placements` 只是它的投影。
   * 只归零 stage 的话,上一例摆的那条架子会跟着走进这一例 ——
   * 「空架子不渲染」那条当场读到两条 aside。
   */
  useWorkbenchStore.getState().reset()
})

afterEach(() => {
  focusTree.reset()
})

/** store 在 React 事件之外被推动,所以得进 act —— 否则断言会读到上一帧。 */
function openOnEdge(id: string, side: ShelfSide) {
  act(() => useStageStore.getState().openAs(id, { kind: 'edge', side }))
}

const NAME: Record<ShelfSide, string> = {
  left: '左侧栏',
  right: '右侧栏',
  top: '顶栏',
  bottom: '底栏',
}

/**
 * 视口是**共同预算**的分母(W7-p 裁定 3),所以四条边那两例必须自己说清楚窗子多大 ——
 * jsdom 的出厂视口是 1024×768,在那台窗子里「四条边各钉 400」本来就摆不下
 * (1024 − 中央最小 480 = 544,两条竖边分不到两个 240)。
 *
 * **竖轴还要先扣顶栏**(W7-p 修一轮裁定 6):可用高度是 `视口高 − 44`,所以
 * 1000 高的窗里「上 400 + 下 400」差 4px 就摆不下(1000 − 44 − 320 − 400 = 236 < 240)。
 * 1100 是「四条边都摆得下」的那一档,不是随手加的高度。
 */
function setViewport(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true })
}

describe('四边架子', () => {
  afterEach(() => setViewport(1024, 768))

  it('四条边各挂一个:哪条边上有 tab 就画哪一条', () => {
    // 摆得下的窗子里才问「画不画」—— 摆不下那一档是下面那一例的事。
    setViewport(1600, 1100)
    render(<AppShell />)
    openOnEdge('files', 'left')
    openOnEdge('diff', 'right')
    openOnEdge('terminal', 'top')
    openOnEdge('browser', 'bottom')
    for (const side of ['left', 'right', 'top', 'bottom'] as ShelfSide[]) {
      expect(screen.getByRole('complementary', { name: NAME[side] })).toBeTruthy()
    }
  })

  /**
   * **摆不下就拒绝,不许把中央区压成 0**(W7-p 裁定 3,审计 A 的 A3:真机上四边
   * 各钉 400,中央区量到 h = 0,输入框浮在上架子的内容上)。
   *
   * 反证:把 `placeAs` 的 edge 支里那句 `canNailShelf` 拆掉 → 右架子照样画出来,
   * 这一条当场红。
   */
  it('对边摆不下时拒绝并保持原样:窄窗里钉了左边就钉不上右边', () => {
    setViewport(1024, 768)
    render(<AppShell />)
    openOnEdge('files', 'left')
    openOnEdge('diff', 'right')
    expect(screen.getByRole('complementary', { name: NAME.left })).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: NAME.right })).toBeNull()
    // 拒绝 = **一格状态都不写**:那块瓦仍旧在 Dock 里,不是「开了但没画」。
    expect(useStageStore.getState().shelves.right.tabs).toEqual([])
  })

  it('空架子不渲染 —— 也就不占一丝布局', () => {
    render(<AppShell />)
    expect(screen.queryByRole('complementary')).toBeNull()
    openOnEdge('files', 'top')
    expect(screen.getAllByRole('complementary')).toHaveLength(1)
    expect(screen.getByRole('complementary', { name: NAME.top })).toBeTruthy()
  })

  it('收起后只剩细梁:tab 条与内容都不在了,展开键还在', () => {
    render(<AppShell />)
    openOnEdge('files', 'bottom')
    const shelf = screen.getByRole('complementary', { name: NAME.bottom })
    fireEvent.click(screen.getByLabelText('收起底栏'))
    expect(useStageStore.getState().shelves.bottom.collapsed).toBe(true)
    /*
     * **在这条架子里面**问(W1):中央区从今天起也有一条 tab 条(叶檐 —— 单 tab 时
     * 它是那块内容的身份带),所以「整扇窗里没有 tablist」不再等于「这条架子收起来了」。
     * 这一条要验的一直是后者。
     */
    expect(within(shelf).queryByRole('tablist')).toBeNull()
    expect(screen.getByLabelText('展开底栏')).toBeTruthy()
  })

  it('点细梁展开回去,tab 次序与活动 tab 一个都没动', () => {
    render(<AppShell />)
    openOnEdge('files', 'left')
    openOnEdge('diff', 'left')
    fireEvent.click(screen.getByLabelText('收起左侧栏'))
    fireEvent.click(screen.getByLabelText('展开左侧栏'))
    const shelf = useStageStore.getState().shelves.left
    expect(shelf.collapsed).toBe(false)
    expect(shelf.tabs).toEqual(['files', 'diff'])
    expect(shelf.activeId).toBe('diff')
  })
})

/**
 * keep-alive(08-30):同一条架子上的一组 tab **全部保持挂载**,切 tab 只换哪一层显形。
 * 这里钉的是它的三条边界 —— 别的都在门里量(gate-perf 场景②:延迟、长帧、滚动位置)。
 */
describe('同组 tab 是 keep-alive 的', () => {
  /*
   * W4:一格 tab 的那一层从架子自己那份 `ShelfTabLayer` 换成了树的
   * `PaneLeaf` → `PaneTabLayer`(判词在 `EdgeShelf.module.css` 里那段退役注)。
   * 取件口因此从 `data-panel-layer=<瓦 id>` 换成 `data-pane-tab=<refId>`;
   * **这一组要守的三条边界一个字没改**(不卸载 / inert 说两遍 / 同一个 DOM 节点)。
   */
  const layer = (id: string) => document.querySelector(`[data-pane-tab="panel:${id}"]`)
  /** 这一格此刻在不在**这条架子**里(浮窗也画 `data-pane-tab`,所以要限定容器)。 */
  const layerInShelf = (side: ShelfSide, id: string) =>
    document.querySelector(`[data-shelf-body="${side}"] [data-pane-tab="panel:${id}"]`)

  it('切走的那一块不卸载:两层都在,非活动那层 inert', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    openOnEdge('terminal', 'right')
    expect(useStageStore.getState().shelves.right.activeId).toBe('terminal')
    expect(layer('files')).toBeTruthy()
    expect(layer('terminal')).toBeTruthy()
    expect(layer('files')!.hasAttribute('inert')).toBe(true)
    expect(layer('terminal')!.hasAttribute('inert')).toBe(false)
  })

  /**
   * **`inert` 要说两遍,而且必须是同一个判据**(09-02 R1)。
   * 一遍给 DOM(上面那条:浏览器据此把这一层移出焦点序与辅助树),一遍给树 ——
   * 注册表据此不选它当第一响应者,**路径经过它就在那儿截断**。
   * 少了给树的那一遍,后台那层照样能当第一响应者,它的局部键会在看不见的地方响;
   * 而「切 tab 之后焦点变孤儿」(I1)那条也就没人接得住。
   * 反证:把 `<FocusScope scope="shelf-layer" inert={!on}>` 的 `inert` 摘掉 → 本条红。
   */
  it('每一层都是树上的一格 shelf-layer,而且 inert 与 DOM 那一遍**同一个判据**', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    openOnEdge('terminal', 'right')

    for (const id of ['files', 'terminal']) {
      expect(layer(id)!.getAttribute('data-focus-scope')).toBe('leaf')
    }
    /*
     * W4 起层次是**两级**:整条架子一格 `shelf-layer`(住户 = 它露脸的那格瓦 ——
     * 召唤与跟焦按 `owner` 精确取它),里面每一格 tab 一格 `leaf`。
     * 「后台那格不可当第一响应者」这条判据一个字没改,只是落在 `leaf` 上了。
     */
    const shelves = focusTree.dump().nodes.filter((n) => n.scope === 'shelf-layer')
    expect(shelves.length).toBe(1)
    expect(shelves[0].owner).toBe('terminal')
    // 一格叶根 + 两格 tab 层:活动那格可交互,切走那格 inert。
    const tabs = focusTree.dump().nodes.filter((n) => n.scope === 'leaf' && n.owner?.startsWith('panel:'))
    expect(tabs.length).toBe(2)
    expect(tabs.filter((n) => n.inert).length).toBe(1)
    expect(tabs.filter((n) => !n.inert).length).toBe(1)
  })

  it('切回来是**同一个 DOM 节点** —— 这就是「内部状态与滚动位置不丢」的机械含义', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    const before = layer('files')
    openOnEdge('terminal', 'right')
    act(() => useStageStore.getState().activateShelfTab('right', 'files'))
    expect(layer('files')).toBe(before)
    expect(layer('files')!.hasAttribute('inert')).toBe(false)
  })

  it('边界只画到这一组:离开这条架子的那一块当场卸载', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    openOnEdge('terminal', 'right')
    act(() => useStageStore.getState().closeToDock('terminal'))
    expect(layer('terminal')).toBeNull()
    expect(layer('files')).toBeTruthy()
    act(() => useStageStore.getState().edgeToFloat('files'))
    /*
     * W4:撕成浮窗之后这一格**并没有消失** —— 它换了个宿主(浮窗的身子也是一棵树,
     * 画的也是 `data-pane-tab`)。这一条守的一直是「**这条架子**上不再有它」,
     * 所以按容器限定;整条架子随之空掉、整个 `<aside>` 卸载,那是同一件事的另一面。
     */
    expect(layerInShelf('right', 'files')).toBeNull()
    expect(document.querySelector('[data-shelf="right"]')).toBeNull()
    expect(layer('files')).toBeTruthy()
  })
})
