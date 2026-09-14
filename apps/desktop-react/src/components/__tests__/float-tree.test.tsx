import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { useWorkbenchStore } from '../../workbench/store'
import { leavesOf } from '../../workbench/tree'
import { refId } from '../../workbench/kinds'

/**
 * **浮窗的身子是一棵树,标题栏就是它根叶那条檐**(W4,设计 §2.2)。
 *
 * 三件事这一组各钉一条:
 *  · 窗里能并 tab、能分屏(与架子、与中央区同一件 `PaneTree`);
 *  · **这扇窗一共只有一条带子** —— 从前那条 40px 的 `<header>` 整件退役,
 *    于是 09-01 那条「浮窗双檐」判例在结构上不可能重演;
 *  · 那颗 ✕ 关的是**这扇窗**,里面的标签转为**隐藏**(不是关闭)。
 */

const fileRef = (path: string) => ({ kind: 'file', key: path })
const win = () => screen.getAllByRole('dialog')[0] as HTMLElement
const treeOf = (region: string) => useWorkbenchStore.getState().regions[region]
const tabsOf = (region: string) =>
  leavesOf(treeOf(region)).flatMap((leaf) => leaf.tabs.map(refId))

beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  useWorkbenchStore.getState().reset()
})

function openFloat(id: string) {
  act(() => useStageStore.getState().openAs(id, { kind: 'float' }))
}

describe('窗里并 tab / 分屏', () => {
  it('一扇窗装得下两格,tab 条就是它的标题栏', () => {
    render(<AppShell />)
    openFloat('files')
    act(() => useWorkbenchStore.getState().openRef(fileRef('/a.ts'), { region: 'float:files' }))

    expect(tabsOf('float:files')).toEqual(['panel:files', 'file:/a.ts'])
    expect(within(win()).getAllByRole('tab')).toHaveLength(2)
  })

  it('**一扇窗只有一条带子**:没有第二条 `<header>`(09-01 双檐判例的结构化)', () => {
    render(<AppShell />)
    openFloat('files')
    expect(win().querySelectorAll('[data-pane-chrome]')).toHaveLength(1)
    expect(win().querySelector('header')).toBeNull()
  })

  it('窗里分得了屏,而且兄弟叶那一格**还是同一个 DOM 节点**(零重挂)', () => {
    render(<AppShell />)
    openFloat('files')
    act(() => useWorkbenchStore.getState().openRef(fileRef('/a.ts'), { region: 'float:files' }))
    const kept = document.querySelector('[data-pane-tab="panel:files"]')

    const leafId = leavesOf(treeOf('float:files'))[0].id
    act(() => useWorkbenchStore.getState().splitLeaf(leafId, 'row'))

    expect(leavesOf(treeOf('float:files'))).toHaveLength(2)
    expect(document.querySelector('[data-pane-tab="panel:files"]')).toBe(kept)
  })
})

describe('那颗 ✕:关这扇窗 = 里面的标签全部隐藏', () => {
  it('两格都进隐藏表,各记自己的位置;窗随之没了', () => {
    render(<AppShell />)
    openFloat('files')
    act(() => useWorkbenchStore.getState().openRef(fileRef('/a.ts'), { region: 'float:files' }))

    fireEvent.click(within(win()).getByLabelText('关闭这扇窗'))

    expect(useStageStore.getState().floatOrder).toEqual([])
    expect(treeOf('float:files')).toBeUndefined()
    const hidden = useWorkbenchStore.getState().hidden
    expect(hidden.map((e) => refId(e.ref))).toEqual(['panel:files', 'file:/a.ts'])
    expect(hidden.map((e) => e.returnTo.index)).toEqual([0, 1])
  })

  /*
   * **反证**:把 `closeFloat` 换回 `closeToDock` → 这一条红。
   * 「收回 Dock」只对瓦说得通(它的家在 Dock 上),而窗里可能装着文件 ——
   * 文件没有 Dock 可回,隐藏才是它回得来的那条路(设计 §2.3)。
   */
  it('隐藏之后**请得回来**,而且回到它原来那扇窗(矩形也还在)', () => {
    render(<AppShell />)
    openFloat('files')
    act(() => useWorkbenchStore.getState().openRef(fileRef('/a.ts'), { region: 'float:files' }))
    const rect = useStageStore.getState().floats.files

    fireEvent.click(within(win()).getByLabelText('关闭这扇窗'))
    act(() => useWorkbenchStore.getState().restoreHidden('file:/a.ts'))

    expect(tabsOf('float:files')).toEqual(['file:/a.ts'])
    expect(useStageStore.getState().floatOrder).toEqual(['files'])
    expect(useStageStore.getState().floats.files).toEqual(rect)
  })
})

/**
 * **只对瓦说得通的那一件**(W7-c 起它是菜单项,不是钮;2026-09-14 起只剩「上舞台」)。
 *
 * 判据:活动那格不是瓦时「上舞台」**禁灰**,不是画出来点了没反应 —— 舞台是瓦的瞬态。
 * `ui/Menu` 走的是**原生 `disabled`**,所以判据仍是那格属性。
 *
 * 「钉到边 ▸」**不在这一组里了**(2026-09-14,报障「浏览器拖到四条边都滑回原位」的同病):
 * 它开在窗的标题栏上,钉的是**这扇窗**(`floatWindowToEdge`),窗里装着文件 / 浏览器 /
 * 终端一样钉得上 —— 所以活动格是文件时它**不灰**,而且点下去整扇窗进架子。
 */
describe('只对瓦说得通的那一件(叶菜单里)', () => {
  /** 右键这扇窗的标题栏(= 根叶那条檐)= 开它的叶菜单。 */
  function leafMenu() {
    const chrome = win().querySelector('[data-pane-chrome]') as HTMLElement
    act(() => {
      fireEvent.contextMenu(chrome, { clientX: 10, clientY: 10 })
    })
    return screen.getByRole('menu', { name: '标签动作' })
  }

  it('活动那格不是瓦时,「上舞台」禁灰(不是画出来点了没反应);「钉到边」照旧活着', () => {
    render(<AppShell />)
    openFloat('files')
    act(() => useWorkbenchStore.getState().openRef(fileRef('/a.ts'), { region: 'float:files' }))
    // 文件成了活动 tab。
    const menu = leafMenu()
    expect(within(menu).getByText('钉到边').closest('button')).toHaveProperty('disabled', false)
    expect(within(menu).getByText('上舞台').closest('button')).toHaveProperty('disabled', true)
    act(() => {
      fireEvent.keyDown(menu, { key: 'Escape' })
    })
    // 切回那格瓦 —— 两行当场活过来。
    act(() => {
      const leaf = leavesOf(treeOf('float:files'))[0]
      useWorkbenchStore.getState().activateTab(leaf.id, 0)
    })
    const again = leafMenu()
    expect(within(again).getByText('上舞台').closest('button')).toHaveProperty('disabled', false)
  })

  it('活动格是文件时点「钉到边 ▸ 右边」:整扇窗(瓦 + 文件)一起进右架子', () => {
    render(<AppShell />)
    openFloat('files')
    act(() => useWorkbenchStore.getState().openRef(fileRef('/a.ts'), { region: 'float:files' }))
    const menu = leafMenu()
    act(() => { fireEvent.click(within(menu).getByText('钉到边')) })
    const sub = screen.getByRole('menu', { name: '钉到边' })
    act(() => { fireEvent.click(within(sub).getByText('右边')) })
    expect(tabsOf('edge:right')).toEqual(['panel:files', 'file:/a.ts'])
    expect(useStageStore.getState().placements.files).toEqual({ kind: 'edge', side: 'right' })
    expect(useWorkbenchStore.getState().regions['float:files']).toBeUndefined()
  })
})
