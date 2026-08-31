import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { SpaceRecord } from '@shared/ipc/spaces'
import { Dock } from '../../components/Dock'
import { configureSpacesPort } from '../../data/spaces-port'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { WORKSPACE_ITEM_ID } from '../../stage/items'
import { useKeymapStore } from '../../keymap/store'
import { initialKeymapState } from '../../keymap/transitions'
import { useWorkspacePalette } from '../components/palette-hub'
import { useWorkspaceStore } from '../store'
import { DEFAULT_SPACE_ID } from '../types'

/**
 * 瓦与右键快切表(08-31 追补裁定「切换器 = 一块普通 Dock 瓦,零新原语」)。
 *
 * 钉三件:瓦面画的是**当前工作区**的字标(而不是一枚固定图标)、
 * 右键出的是快切表(不是那排落点单选)、以及点一行真的切了。
 */

const DEFAULT: SpaceRecord = { id: DEFAULT_SPACE_ID, name: '默认', createdAt: 0, color: 'violet' }
const LENOVO: SpaceRecord = { id: 'ws-lenovo', name: 'Lenovo 工作', createdAt: 100, color: 'blue' }

beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  useKeymapStore.setState({ ...initialKeymapState })
  useWorkspaceStore.getState().reset()
  useWorkspacePalette.setState({ open: false })
  configureSpacesPort({
    ready: async () => undefined,
    list: async () => ({ success: true, spaces: [DEFAULT, LENOVO] }),
    create: async () => ({ success: false, error: 'not stubbed' }),
    update: async () => ({ success: true }),
    remove: async () => ({ success: true, removed: true }),
  })
})

/**
 * 列表由**开工序**(main.tsx)拉一次,不由 Dock 拉 —— Dock 是投影不是取数的地方。
 * 所以这里也是先 load 再 render:用例复现的是真实的先后,不是自己造一个顺序。
 */
async function renderDock() {
  await useWorkspaceStore.getState().load()
  render(<Dock />)
}

function tile() {
  return screen.getByTestId(`dock-tile-${WORKSPACE_ITEM_ID}`)
}

describe('工作区瓦', () => {
  it('瓦面画当前工作区的字标 —— 它同时就是「我在哪」的常驻指示', async () => {
    await renderDock()
    expect(tile().textContent).toContain('默')

    act(() => useWorkspaceStore.getState().switchTo('ws-lenovo'))
    expect(tile().textContent).toContain('L')
  })

  it('列表读不到时退回兜底表,瓦面照样说得出话', async () => {
    configureSpacesPort({
      ready: async () => undefined,
      list: async () => ({ success: false, error: 'core unreachable' }),
      create: async () => ({ success: false }),
      update: async () => ({ success: false }),
      remove: async () => ({ success: false }),
    })
    await renderDock()
    expect(useWorkspaceStore.getState().status).toBe('error')
    expect(tile()).toBeTruthy()
  })
})

describe('右键快切表', () => {
  it('列出每个工作区,当前那条勾上,并且**不出**那排落点单选', async () => {
    await renderDock()
    act(() => void fireEvent.contextMenu(tile()))

    expect(screen.getByText('默认')).toBeTruthy()
    expect(screen.getByText('Lenovo 工作')).toBeTruthy()
    // 勾由 MenuItem 的 checked 画成 menuitemradio 的 aria-checked。
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    // 这块瓦的菜单短到一眼能读完:落点单选被快切表接管了。
    expect(screen.queryByText('打开方式')).toBeNull()
    expect(screen.queryByText('浮窗')).toBeNull()
  })

  it('两条动作行都在:总览与新建', async () => {
    await renderDock()
    act(() => void fireEvent.contextMenu(tile()))
    expect(screen.getByText('工作区总览…')).toBeTruthy()
    expect(screen.getByText('新建工作区')).toBeTruthy()
  })

  it('点一行就切过去,并把菜单收掉', async () => {
    await renderDock()
    act(() => void fireEvent.contextMenu(tile()))
    act(() => void fireEvent.click(screen.getByText('Lenovo 工作')))

    expect(useWorkspaceStore.getState().currentId).toBe('ws-lenovo')
    expect(screen.queryByText('工作区总览…')).toBeNull()
  })

  it('「新建工作区」的落点是命令面板 —— 菜单不自己挂一个收名字的对话框', async () => {
    await renderDock()
    act(() => void fireEvent.contextMenu(tile()))
    act(() => void fireEvent.click(screen.getByText('新建工作区')))
    expect(useWorkspacePalette.getState().open).toBe(true)
  })

  it('别的瓦照旧是那排落点单选 —— 快切表只接管工作区那一块', async () => {
    await renderDock()
    act(() => void fireEvent.contextMenu(screen.getByTestId('dock-tile-files')))
    expect(screen.getByText('打开方式')).toBeTruthy()
    expect(screen.queryByText('工作区总览…')).toBeNull()
  })
})

describe('序号注记', () => {
  it('读的是注册表**当下**的绑定;解绑之后一个键帽都不画', async () => {
    await renderDock()
    act(() => void fireEvent.contextMenu(tile()))
    /*
     * 断言键面上那个**数字**而不是 ⌘:主修饰键的字面按平台变(mac 画 ⌘,
     * 别处画 Ctrl),而 jsdom 的 UA 不是 mac —— 拿 ⌘ 当选择器就是让用例
     * 依赖跑在哪台机器上(与「不拿翻译过的 aria-label 当选择器」同一条判据)。
     */
    expect(screen.getAllByText('1').length).toBeGreaterThan(0)

    act(() => void fireEvent.keyDown(document.body, { key: 'Escape' }))
    act(() => {
      useKeymapStore.setState({
        overrides: { 'workspace.slot:1': null, 'workspace.slot:2': null, 'workspace.slot:3': null },
      })
    })
    act(() => void fireEvent.contextMenu(tile()))
    expect(screen.queryByText('1')).toBeNull()
  })
})

describe('取数不在 Dock 里', () => {
  it('渲染 Dock 一次端口都不打 —— 列表由开工序拉,瓦只读结论', async () => {
    const list = vi.fn(async () => ({ success: true, spaces: [DEFAULT, LENOVO] }))
    configureSpacesPort({
      ready: async () => undefined,
      list,
      create: async () => ({ success: false }),
      update: async () => ({ success: false }),
      remove: async () => ({ success: false }),
    })
    render(<Dock />)
    await act(async () => undefined)
    expect(list).not.toHaveBeenCalled()
  })
})
