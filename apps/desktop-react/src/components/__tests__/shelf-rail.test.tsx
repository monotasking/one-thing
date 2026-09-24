import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { SettingsMock } from '../../content/SettingsMock'
import { useStageStore } from '../../stage/store'
import { initialStageSettings, initialStageState } from '../../stage/transitions'
import { useWorkbenchStore } from '../../workbench/store'
import { focusTree } from '../../focus/registry'
import type { ShelfSide } from '../../stage/types'

/**
 * **收起 ≠ 关闭,以及那条细梁把手可以整台藏起来**(2026-09-12 用户拍三条)。
 *
 * 这一份钉的是那三条的机械含义,分三组:
 *  ① 收起只隐藏树身、`closeShelf` 才卸载 —— 判据是**同一个 DOM 节点**
 *    (与 keep-alive 那一组同一条尺子:内部状态与滚动位不丢的机械含义就是它);
 *  ② `shelfRail === 'hidden'` 时收起态**零厚度、不画细梁**,而形态口还在
 *    (「架子收着」这件事没变,变的只是屏幕上留不留一条可点的边);
 *  ③ 三处入口(细梁右键 / 架子 ⋯ 菜单 / 设置页 Dock 节)写的是**同一格**,
 *    落盘与旧档案兼容各一条。
 *
 * 反证(逐条真跑过):把 `.bodyHidden` 那一支换回旧的三元(收起就不渲染树身)→ ①
 * 两条全红;把 `railShown &&` 那道闸拆掉 → ② 的「不画细梁」红;三处入口里任何一处
 * 改成写自己的本地 state → ③ 对应那一条红。
 */
beforeEach(() => {
  useStageStore.setState({ ...initialStageState, ...initialStageSettings, locale: 'zh', shelfRail: 'shown' })
  useWorkbenchStore.getState().reset()
})

afterEach(() => {
  focusTree.reset()
})

function openOnEdge(id: string, side: ShelfSide) {
  act(() => useStageStore.getState().openAs(id, { kind: 'edge', side }))
}

const NAME: Record<ShelfSide, string> = {
  left: '左侧栏',
  right: '右侧栏',
  bottom: '底栏',
}

const asideOf = (side: ShelfSide) =>
  document.querySelector(`[data-shelf="${side}"]`) as HTMLElement | null
const bodyOf = (side: ShelfSide) =>
  document.querySelector(`[data-shelf-body="${side}"]`) as HTMLElement | null

/** 收起 / 展开走的是产品那一只(快捷键 / 召唤第四格 / 檐上钮三条路的共同落点)。 */
const toggle = (side: ShelfSide) => act(() => useStageStore.getState().toggleShelfCollapsed(side))

describe('收起 ≠ 关闭:树身保挂载', () => {
  it('收起之后树身仍在、带 inert、带 .bodyHidden', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    toggle('right')
    const body = bodyOf('right')
    expect(body).toBeTruthy()
    expect(body!.hasAttribute('inert')).toBe(true)
    /* CSS Modules 的名字带哈希,**本名一定在里面**(与门那一头 `dragging` 同一法)。 */
    expect([...body!.classList].some((c) => /(^|_)bodyHidden(_|$)/.test(c))).toBe(true)
  })

  /**
   * 这一条是整单的**中心断言**:收起→展开前后 `[data-shelf-body]` 是同一个 DOM 节点。
   * 从前它必然是两个(收起那一支根本不渲染树身),于是内容子树连同滚动位、
   * 流式接续、终端缓冲、原生视图一起从零重建。
   */
  it('收起→展开前后是**同一个** DOM 节点', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    const before = bodyOf('right')
    expect(before).toBeTruthy()
    /*
     * **要比的是树身里面的节点,不是 `[data-shelf-body]` 那只 div**(Fable review):
     * 那只 div 是架子自己画的,`PaneTree` 整棵重挂它也纹丝不动 —— 第一版正是靠它
     * 「绿」着,而里面的树每收/展一次各重挂一遍。tab 层 `[data-pane-tab]` 是
     * `PaneLeaf` 画的,它换了身份就说明树被重建过。
     */
    const layerBefore = before!.querySelector('[data-pane-tab]')
    expect(layerBefore).toBeTruthy()
    toggle('right')
    expect(bodyOf('right')).toBe(before)
    expect(before!.querySelector('[data-pane-tab]')).toBe(layerBefore)
    toggle('right')
    expect(bodyOf('right')).toBe(before)
    expect(before!.querySelector('[data-pane-tab]')).toBe(layerBefore)
    expect(bodyOf('right')!.hasAttribute('inert')).toBe(false)
  })

  it('只有关闭才卸载:closeShelf 之后整条 aside 与树身都没了', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    expect(asideOf('right')).toBeTruthy()
    act(() => useStageStore.getState().closeShelf('right'))
    expect(asideOf('right')).toBeNull()
    expect(bodyOf('right')).toBeNull()
  })
})

describe('把手藏起来:收起态零厚度、不画细梁', () => {
  it('藏了之后收起态没有细梁钮、厚度是 0,而形态口还在', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    act(() => useStageStore.getState().setShelfRail('hidden'))
    toggle('right')
    const aside = asideOf('right')!
    expect(aside.hasAttribute('data-shelf-collapsed')).toBe(true)
    expect(screen.queryByLabelText(`展开${NAME.right}`)).toBeNull()
    expect(aside.style.width).toBe('0px')
    // 连那条 1px 分隔线也归零 —— 判据是那一格类在不在(数值由 CSS 说)。
    expect([...aside.classList].some((c) => /(^|_)railHidden(_|$)/.test(c))).toBe(true)
    // 树身照旧保挂载:「藏把手」藏的是把手,不是那棵树。
    expect(bodyOf('right')).toBeTruthy()
  })

  it('把手显示时收起态画细梁、厚度走 --shelf-rail', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    toggle('right')
    const aside = asideOf('right')!
    expect(screen.getByLabelText(`展开${NAME.right}`)).toBeTruthy()
    expect(aside.style.width).toBe('var(--shelf-rail)')
    expect([...aside.classList].some((c) => /(^|_)railHidden(_|$)/.test(c))).toBe(false)
  })

  it('藏了把手照样展得开 —— 取回的路一条没少(召唤 / 点瓦走的同一只)', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    act(() => useStageStore.getState().setShelfRail('hidden'))
    toggle('right')
    expect(useStageStore.getState().shelves.right.collapsed).toBe(true)
    act(() => useStageStore.getState().summonItem('files'))
    expect(useStageStore.getState().shelves.right.collapsed).toBe(false)
    expect(screen.getByLabelText(`收起${NAME.right}`)).toBeTruthy()
  })
})

describe('shelfRail 这一格偏好', () => {
  it('缺省是 shown', () => {
    expect(useStageStore.getState().shelfRail).toBe('shown')
  })

  it('落盘:partialize 摘得到它,而且它不是家具(不进 byWorkspace)', () => {
    act(() => useStageStore.getState().setShelfRail('hidden'))
    const blob = JSON.parse(localStorage.getItem('onething.stage') ?? '{}')
    expect(blob?.state?.shelfRail).toBe('hidden')
    expect(blob?.state?.byWorkspace?.default?.shelfRail).toBeUndefined()
  })

  it('旧档案里缺这一格 = 读作 shown(不需要迁移版本)', () => {
    const merge = (persisted: unknown) => {
      const opts = (useStageStore.persist as unknown as { getOptions: () => { merge: (p: unknown, c: unknown) => { shelfRail: string } } }).getOptions()
      return opts.merge(persisted, useStageStore.getState()).shelfRail
    }
    expect(merge({})).toBe('shown')
    expect(merge({ shelfRail: undefined })).toBe('shown')
    // 脏值也收进两档 —— 「不是 hidden 就是 shown」两档全覆盖。
    expect(merge({ shelfRail: 'nonsense' })).toBe('shown')
    expect(merge({ shelfRail: 'hidden' })).toBe('hidden')
  })
})

/**
 * **三处入口,一格真相**。每一条都从屏幕上那个真控件点下去,读的是同一格 store ——
 * 「它们调的是同一只 `setShelfRail`」这句话,机械含义就是这三条。
 */
describe('三处入口写的是同一格', () => {
  it('入口一:细梁右键 →「隐藏收起把手(所有边)」', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    toggle('right')
    const rail = screen.getByLabelText(`展开${NAME.right}`)
    act(() => {
      fireEvent.contextMenu(rail, { clientX: 20, clientY: 20 })
    })
    const menu = screen.getByRole('menu', { name: `${NAME.right}细梁动作` })
    act(() => {
      fireEvent.click(within(menu).getByText('隐藏收起把手(所有边)'))
    })
    expect(useStageStore.getState().shelfRail).toBe('hidden')
    // 四条边共用一格:别的边跟着一起没了把手。
    openOnEdge('diff', 'left')
    toggle('left')
    expect(screen.queryByLabelText(`展开${NAME.left}`)).toBeNull()
  })

  it('入口一:同一张表里的「展开」= 产品那只 toggleShelfCollapsed', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    toggle('right')
    act(() => {
      fireEvent.contextMenu(screen.getByLabelText(`展开${NAME.right}`), { clientX: 20, clientY: 20 })
    })
    const menu = screen.getByRole('menu', { name: `${NAME.right}细梁动作` })
    act(() => {
      fireEvent.click(within(menu).getByText(`展开${NAME.right}`))
    })
    expect(useStageStore.getState().shelves.right.collapsed).toBe(false)
  })

  it('入口二:架子 ⋯ 菜单那一行(勾选态),点一下翻到 hidden', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    const chrome = asideOf('right')!.querySelector('[data-pane-chrome]') as HTMLElement
    act(() => {
      fireEvent.contextMenu(chrome, { clientX: 10, clientY: 10 })
    })
    const menu = screen.getByRole('menu', { name: '标签动作' })
    const row = within(menu).getByText('收起后显示把手').closest('button') as HTMLElement
    // 勾选态说的就是「这一格此刻的值」。
    expect(row.getAttribute('aria-checked')).toBe('true')
    act(() => {
      fireEvent.click(row)
    })
    expect(useStageStore.getState().shelfRail).toBe('hidden')
  })

  it('入口三:设置页 Dock 节那一行', () => {
    render(<SettingsMock />)
    // 2026-09-13 分页:设置页开出来停在**通用**页,Dock 那一节在「Dock」页里。
    act(() => void fireEvent.click(screen.getByTestId('settings-nav-dock')))
    const group = screen.getByRole('radiogroup', { name: '收起后的把手' })
    act(() => {
      fireEvent.click(within(group).getByText('隐藏'))
    })
    expect(useStageStore.getState().shelfRail).toBe('hidden')
    act(() => {
      fireEvent.click(within(group).getByText('显示'))
    })
    expect(useStageStore.getState().shelfRail).toBe('shown')
  })
})
