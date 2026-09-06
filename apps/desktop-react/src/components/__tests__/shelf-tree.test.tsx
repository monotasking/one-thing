import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { useWorkbenchStore, hiddenInRegion } from '../../workbench/store'
import { leavesOf } from '../../workbench/tree'
import { refId } from '../../workbench/kinds'
import { focusTree } from '../../focus/registry'
import type { ShelfSide } from '../../stage/types'

/**
 * **架子的身子是一棵拼贴树**(W4,设计 §1.3 与 §8 的 W4 行)。
 *
 * `edge-shelf.test.tsx` 守的是这条架子的**外壳**(哪条边画、收得起来、
 * keep-alive 与 inert 说两遍);这一组守的是**换树之后白拿的那些**:
 *  · 一条架子上可以同时装瓦与文件(那正是「打开方式」五档解灰的机械前提);
 *  · 架子里分得了屏,而且分屏**不重挂兄弟叶**(零重挂断言);
 *  · 树一变(加一格 / 关一格 / 分一次屏),既有那一格**还是同一个 DOM 节点**;
 *  · 「够不着的标签 ⋯」里**隐藏的那一节只列本区域的**(W1-a 留的账;
 *    W7-t / B1 起那颗钮多了「看不见的」一节,判据一个字没变)。
 */

const layerOf = (id: string) => document.querySelector(`[data-pane-tab="${id}"]`)
const shelfOf = (side: ShelfSide) => document.querySelector(`[data-shelf="${side}"]`)
const treeOf = (region: string) => useWorkbenchStore.getState().regions[region]

const fileRef = (path: string) => ({ kind: 'file', key: path })

function openOnEdge(id: string, side: ShelfSide) {
  act(() => useStageStore.getState().openAs(id, { kind: 'edge', side }))
}

beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  useWorkbenchStore.getState().reset()
})

describe('架子里装得下瓦以外的东西', () => {
  it('一个文件与一块瓦并排坐在同一条 tab 条上', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    act(() => useWorkbenchStore.getState().openRef(fileRef('/repo/a.ts'), { region: 'edge:right' }))

    const tabs = leavesOf(treeOf('edge:right')).flatMap((leaf) => leaf.tabs.map(refId))
    expect(tabs).toEqual(['panel:files', 'file:/repo/a.ts'])
    // 那条 tab 条是叶檐(`LeafStrip`),两格坐在同一条上。
    const shelf = shelfOf('right')!
    expect(within(shelf as HTMLElement).getAllByRole('tab')).toHaveLength(2)
  })

  it('**投影只报瓦**:文件不进 `shelves[side].tabs`(那张表说的是 Dock 上那些瓦)', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    act(() => useWorkbenchStore.getState().openRef(fileRef('/repo/a.ts'), { region: 'edge:right' }))
    expect(useStageStore.getState().shelves.right.tabs).toEqual(['files'])
    // 而「此刻显形的是哪一格」照旧由树说了算 —— 文件成了活动 tab,于是一块瓦都不露脸。
    expect(useStageStore.getState().shelves.right.visible).toEqual([])
  })
})

describe('架子里分得了屏', () => {
  it('分一次屏:两片叶,兄弟叶那一格**还是同一个 DOM 节点**(零重挂)', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    openOnEdge('diff', 'right')
    const kept = layerOf('panel:files')
    expect(kept).toBeTruthy()

    const leafId = leavesOf(treeOf('edge:right'))[0].id
    act(() => useWorkbenchStore.getState().splitLeaf(leafId, 'col'))

    expect(leavesOf(treeOf('edge:right'))).toHaveLength(2)
    /*
     * **零重挂**:分屏改的是树的形状,而 `PaneTree` 把每片叶画成同一个容器的
     * 直接孩子(判词在 `workbench/layout.ts` 文件头 —— 递归画会让留下来的那片叶
     * 多两层 DOM 祖先,React 按位置认组件,那棵子树整个卸载再挂一遍)。
     * 所以留在原叶里的那一格连 DOM 节点都没换。
     */
    expect(layerOf('panel:files')).toBe(kept)
  })

  it('树一变(加一格 / 关一格)既有那一格都不重挂', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    const kept = layerOf('panel:files')

    openOnEdge('diff', 'right')
    expect(layerOf('panel:files')).toBe(kept)

    act(() => useStageStore.getState().closeToDock('diff'))
    expect(layerOf('panel:files')).toBe(kept)

    act(() => useStageStore.getState().activateShelfTab('right', 'files'))
    expect(layerOf('panel:files')).toBe(kept)
  })
})

describe('隐藏的标签按区域分', () => {
  it('叶檐那格 ⋯ 只列本区域藏起来的(W1-a 留的账)', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    act(() => {
      const wb = useWorkbenchStore.getState()
      wb.openRef(fileRef('/repo/shelf.ts'), { region: 'edge:right' })
      wb.openRef(fileRef('/repo/center.ts'), { region: 'center' })
    })
    // 两个区域各藏一格。
    act(() => {
      const wb = useWorkbenchStore.getState()
      for (const [region, tree] of Object.entries(wb.regions)) {
        for (const leaf of leavesOf(tree)) {
          const at = leaf.tabs.findIndex((tab) => tab.kind === 'file')
          if (at >= 0 && region !== 'center') wb.hideTab(leaf.id, at)
        }
      }
    })
    act(() => {
      const wb = useWorkbenchStore.getState()
      const center = leavesOf(wb.regions.center)[0]
      const at = center.tabs.findIndex((tab) => tab.kind === 'file')
      if (at >= 0) wb.hideTab(center.id, at)
    })

    const hidden = useWorkbenchStore.getState().hidden
    expect(hidden).toHaveLength(2)
    // 判据整件在纯函数里(渲染层不再自己筛一遍)。
    expect(hiddenInRegion(hidden, 'edge:right').map((e) => refId(e.ref))).toEqual([
      'file:/repo/shelf.ts',
    ])
    expect(hiddenInRegion(hidden, 'center').map((e) => refId(e.ref))).toEqual([
      'file:/repo/center.ts',
    ])
  })

  it('屏幕上:右架子那格 ⋯ 里只有本区域那一行', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    act(() => {
      const wb = useWorkbenchStore.getState()
      wb.openRef(fileRef('/repo/shelf.ts'), { region: 'edge:right' })
      wb.openRef(fileRef('/repo/center.ts'), { region: 'center' })
    })
    act(() => {
      const wb = useWorkbenchStore.getState()
      const leaf = leavesOf(wb.regions['edge:right'])[0]
      wb.hideTab(leaf.id, leaf.tabs.findIndex((tab) => tab.kind === 'file'))
    })
    act(() => {
      const wb = useWorkbenchStore.getState()
      const center = leavesOf(wb.regions.center)[0]
      wb.hideTab(center.id, center.tabs.findIndex((tab) => tab.kind === 'file'))
    })

    /*
     * W7-t / B1 起这颗 ⋯ 叫「够不着的标签」,表里两节(看不见的 / 隐藏的),
     * 哪一节空就不画哪一节 —— 这一屏里条没溢出,所以只画「隐藏的」那一节。
     * 判据一个字没变:那一节仍旧**只列本区域**藏起来的。
     */
    const shelf = shelfOf('right') as HTMLElement
    act(() => within(shelf).getByLabelText('够不着的标签').click())
    const menu = screen.getByRole('menu', { name: '够不着的标签' })
    expect(within(menu).getByText('shelf.ts')).toBeTruthy()
    // 反证:把 `hiddenInRegion` 换回「列全部」→ 下面这句红。
    expect(within(menu).queryByText('center.ts')).toBeNull()
  })
})

describe('响应链:整条架子一格 shelf-layer,住户是它露脸的那一格', () => {
  it('切 tab 之后住户跟着换 —— 召唤与跟焦都按住户名精确取那一条边', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    openOnEdge('diff', 'right')
    const shelfNodes = () =>
      focusTree.dump().nodes.filter((n) => n.scope === 'shelf-layer')
    expect(shelfNodes()).toHaveLength(1)
    expect(shelfNodes()[0].owner).toBe('diff')

    act(() => useStageStore.getState().activateShelfTab('right', 'files'))
    expect(shelfNodes()[0].owner).toBe('files')
  })
})
