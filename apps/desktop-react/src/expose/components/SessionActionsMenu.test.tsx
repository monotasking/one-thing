import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { ConfirmHost, useConfirmHub } from '../../ui/Dialog'
import { seedSessionsSource } from '../../data/__fixtures__/sessions'
import { useWorkbenchStore } from '../../workbench/store'
import { useExposeStore } from '../store'
import { initialExposeState } from '../transitions'
import { SessionActionsMenu } from './SessionActionsMenu'

/**
 * **一条会话的那张动作表**(A2 把它补成八行)。
 *
 * 这一组逐行钉的是「点下去交出去的是哪一句话」与「这一行在不在场」——
 * 落点本身各有自己的门(`closeRef` 在 `workbench/__tests__/close-ref.test.ts`、
 * 改名与删除的写路在 `data/sessions-source.test.ts`、置顶那一口在
 * `SessionTree.test.tsx`),这里不重测一遍:菜单这只组件的全部职责就是
 * **把八句话摆对、把两格快照读对**。
 *
 * 断言写的是中文那一份文案,所以语言钉死(jsdom 的 navigator.language 是
 * en-US,'system' 档会解析成英文 —— 与 `row-menu.test.tsx` 同一手)。
 */

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState })
  useWorkbenchStore.getState().reset()
})

afterEach(() => {
  /*
   * 单槽 confirm hub 是**进程级**的:不结掉会把一个悬着的 promise 漏进下一条用例。
   * 包在 `act` 里是因为结掉它会让还挂着的 `ConfirmHost` 重渲一次 —— 一次 React
   * 更新落在 act 之外就是那条 "not wrapped in act" 的告警(它是真的,不是噪音:
   * 那一拍的渲染没人等)。
   */
  act(() => useConfirmHub.getState().settle(false))
  vi.restoreAllMocks()
})

function menu(over: Partial<Parameters<typeof SessionActionsMenu>[0]> = {}) {
  const props = {
    sessionId: 'os-provider',
    title: '重构 provider 抽象',
    isPinned: false,
    openState: null as 'shown' | 'hidden' | null,
    x: 0,
    y: 0,
    onClose: vi.fn(),
    ...over,
  }
  render(
    <>
      <SessionActionsMenu {...props} />
      <ConfirmHost />
    </>,
  )
  return props
}

const rows = () =>
  [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) =>
    (el.textContent ?? '').trim(),
  )
const row = (name: RegExp | string) => screen.getByRole('menuitem', { name })

describe('八行的次序与在场', () => {
  it('这条会话没开着时是七行 —— 「关闭」**整格不在场**(它没有对象,不是做不了)', () => {
    menu()
    expect(rows()).toEqual([
      '打开查看',
      '在右侧打开',
      '在新标签页打开',
      '预览',
      '置顶',
      '重命名…',
      '删除…',
    ])
  })

  it('开着(显示中)时「关闭」在场,排在第二段头一行', () => {
    menu({ openState: 'shown' })
    expect(rows()[4]).toBe('关闭')
  })

  it('**藏起来了也算开着**(那颗空心点)—— 与行尾那颗点同一句话', () => {
    menu({ openState: 'hidden' })
    expect(rows()[4]).toBe('关闭')
  })

  it('置顶那一行说的是**按下去会发生什么**:置顶着的行念「取消置顶」', () => {
    menu({ isPinned: true })
    expect(rows()).toContain('取消置顶')
    expect(rows()).not.toContain('置顶')
  })

  it('「删除…」是 danger(状态色只上字不上底),而且只有它是', () => {
    menu()
    const danger = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].filter((el) =>
      [...el.classList].some((c) => c.includes('itemDanger')),
    )
    expect(danger.map((el) => (el.textContent ?? '').trim())).toEqual(['删除…'])
  })
})

describe('八行各自交出去的那一句话', () => {
  it('打开 → enterSession,并关掉菜单', () => {
    const enterSession = vi.fn()
    useExposeStore.setState({ enterSession })
    const props = menu()
    fireEvent.click(row('打开查看'))
    expect(enterSession).toHaveBeenCalledWith('os-provider')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('Quick Look → openQuickLook(与 Space 同一口)', () => {
    const openQuickLook = vi.fn()
    useExposeStore.setState({ openQuickLook })
    menu()
    fireEvent.click(row('预览'))
    expect(openQuickLook).toHaveBeenCalledWith('os-provider')
  })

  it('关闭 → `workbench.closeRef`(**不删数据**:一发写都不打)', () => {
    const closeRef = vi.fn(() => 'closed' as const)
    const remove = vi.fn()
    useWorkbenchStore.setState({ closeRef })
    const props = menu({ openState: 'shown' })
    fireEvent.click(row('关闭'))
    expect(closeRef).toHaveBeenCalledWith({ kind: 'session', key: 'os-provider' })
    expect(remove).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('置顶 → togglePin(**与 ⌘⇧P 同一口**,所以播报只有一个产地)', async () => {
    const togglePin = vi.fn(async () => ({ ok: true, isPinned: true, name: 'x' }))
    useExposeStore.setState({ togglePin })
    menu()
    await act(async () => {
      fireEvent.click(row('置顶'))
      await Promise.resolve()
    })
    expect(togglePin).toHaveBeenCalledWith('os-provider')
  })

  it('重命名… → 只翻形态(startRename),**不是一次写**', () => {
    menu()
    fireEvent.click(row('重命名…'))
    expect(useExposeStore.getState().renamingId).toBe('os-provider')
  })
})

describe('删除:唯一允许的确认(数据会没)', () => {
  it('点它先关菜单再开确认框,正文**点名那条会话**', async () => {
    const props = menu()
    await act(async () => {
      fireEvent.click(row('删除…'))
      await Promise.resolve()
    })
    // 次序:菜单先卸载,确认框才开(两层浮层叠着 Esc 该退哪一层说不清)。
    expect(props.onClose).toHaveBeenCalledTimes(1)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('删除会话')
    expect(dialog.textContent).toContain('重构 provider 抽象')
    // 有逃生口(`ui/Dialog` 的硬规矩:禁止只有「确定」的死胡同)。
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
  })

  it('按「取消」→ 一发写都不打(确认不是形式)', async () => {
    const deleteSession = vi.fn(async () => ({ ok: true as const }))
    useExposeStore.setState({ deleteSession })
    menu()
    await act(async () => {
      fireEvent.click(row('删除…'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      await Promise.resolve()
    })
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('按「删除」→ 才走 `deleteSession`(编排在 store:先摘格子再删账本)', async () => {
    const deleteSession = vi.fn(async () => ({ ok: true as const }))
    useExposeStore.setState({ deleteSession })
    menu()
    await act(async () => {
      fireEvent.click(row('删除…'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }))
      await Promise.resolve()
    })
    expect(deleteSession).toHaveBeenCalledWith('os-provider')
  })
})
