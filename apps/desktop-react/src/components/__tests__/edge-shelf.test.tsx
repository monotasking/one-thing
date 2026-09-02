import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import type { ShelfSide } from '../../stage/types'
import { focusTree } from '../../focus/registry'

/**
 * 四边架子的挂载路径:形态机说「它在某条边上」,外壳就该在那条边画出一条架子。
 * 厚度算术与吸附判定在 transitions 的纯函数里测(那里能给定视口),
 * 这里只钉四件事:哪条边有 tab 就画哪条、空的一条都不画、收得起来、点细梁展得开。
 */
beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
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

describe('四边架子', () => {
  it('四条边各挂一个:哪条边上有 tab 就画哪一条', () => {
    render(<AppShell />)
    openOnEdge('files', 'left')
    openOnEdge('diff', 'right')
    openOnEdge('terminal', 'top')
    openOnEdge('browser', 'bottom')
    for (const side of ['left', 'right', 'top', 'bottom'] as ShelfSide[]) {
      expect(screen.getByRole('complementary', { name: NAME[side] })).toBeTruthy()
    }
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
    fireEvent.click(screen.getByLabelText('收起底栏'))
    expect(useStageStore.getState().shelves.bottom.collapsed).toBe(true)
    expect(screen.queryByRole('tablist')).toBeNull()
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
    expect(screen.getByRole('tablist', { name: NAME.left })).toBeTruthy()
  })
})

/**
 * keep-alive(08-30):同一条架子上的一组 tab **全部保持挂载**,切 tab 只换哪一层显形。
 * 这里钉的是它的三条边界 —— 别的都在门里量(gate-perf 场景②:延迟、长帧、滚动位置)。
 */
describe('同组 tab 是 keep-alive 的', () => {
  const layer = (id: string) => document.querySelector(`[data-panel-layer="${id}"]`)

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
      expect(layer(id)!.getAttribute('data-focus-scope')).toBe('shelf-layer')
    }
    // 树上两格 shelf-layer:活动那格可交互,切走那格 inert。
    const shelves = focusTree.dump().nodes.filter((n) => n.scope === 'shelf-layer')
    expect(shelves.length).toBe(2)
    expect(shelves.filter((n) => n.inert).length).toBe(1)
    expect(shelves.filter((n) => !n.inert).length).toBe(1)
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

  it('边界只画到这一组:离开 shelf.tabs 的那一块当场卸载', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    openOnEdge('terminal', 'right')
    act(() => useStageStore.getState().closeToDock('terminal'))
    expect(layer('terminal')).toBeNull()
    expect(layer('files')).toBeTruthy()
    act(() => useStageStore.getState().edgeToFloat('files'))
    expect(layer('files')).toBeNull()
  })
})
