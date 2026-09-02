import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { SpaceRecord } from '@shared/ipc/spaces'
import { configureSpacesPort } from '../../data/spaces-port'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { useKeymapStore } from '../../keymap/store'
import { initialKeymapState } from '../../keymap/transitions'
import { WorkspacePalette } from '../components/WorkspacePalette'
import { useWorkspacePalette } from '../components/palette-hub'
import { useWorkspaceStore } from '../store'
import { DEFAULT_SPACE_ID } from '../types'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'

/**
 * ⌘⇧W 命令面板。三件事,一件不多:过滤 / ↵ 切换 / 一条「新建『<词>』」的出口。
 * 序号直达那一下**不经过面板**(它是全局快捷键,在 keymap 那一份用例里钉),
 * 面板只把键面画出来告诉你有这条路。
 */

const DEFAULT: SpaceRecord = { id: DEFAULT_SPACE_ID, name: '默认', createdAt: 0, color: 'violet' }
const LENOVO: SpaceRecord = { id: 'ws-lenovo', name: 'Lenovo 工作', createdAt: 100, color: 'blue' }
const PERSONAL: SpaceRecord = { id: 'ws-personal', name: '个人', createdAt: 200, color: 'green' }

beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  useKeymapStore.setState({ ...initialKeymapState })
  useWorkspaceStore.getState().reset()
  useWorkspaceStore.setState({ spaces: [DEFAULT, LENOVO, PERSONAL], status: 'ready' })
  useWorkspacePalette.setState({ open: true })
  configureSpacesPort({
    ready: async () => undefined,
    list: async () => ({ success: true, spaces: [DEFAULT, LENOVO, PERSONAL] }),
    create: async () => ({ success: false, error: 'not stubbed' }),
    update: async () => ({ success: true }),
    remove: async () => ({ success: true, removed: true }),
  })
})

afterEach(() => {
  focusTree.reset()
})

function type(text: string) {
  act(() => void fireEvent.change(screen.getByTestId('workspace-palette-input'), { target: { value: text } }))
}

describe('过滤', () => {
  it('空词列全表,当前那条标出来', () => {
    render(<WorkspacePalette />)
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByText('当前')).toBeTruthy()
  })

  it('打字只留命中', () => {
    render(<WorkspacePalette />)
    type('个')
    const rows = screen.getAllByRole('option')
    // 一条命中 + 一条「新建『个』工作区…」
    expect(rows).toHaveLength(2)
    expect(screen.getByTestId('workspace-palette-row-ws-personal')).toBeTruthy()
  })

  it('一条都没命中时说出来,并仍然留着新建那条出口', () => {
    render(<WorkspacePalette />)
    type('zzz')
    expect(screen.getByTestId('workspace-palette-create')).toBeTruthy()
  })

  it('词与某条**逐字同名**时不提议新建 —— 那只会造出两个同名工作区', () => {
    render(<WorkspacePalette />)
    type('个人')
    expect(screen.queryByTestId('workspace-palette-create')).toBeNull()
  })
})

describe('键盘', () => {
  it('↵ 切到当前高亮的那一条,并把面板关掉', () => {
    render(<WorkspacePalette />)
    type('Lenovo')
    act(() => void fireEvent.keyDown(screen.getByTestId('workspace-palette-input'), { key: 'Enter' }))
    expect(useWorkspaceStore.getState().currentId).toBe('ws-lenovo')
    expect(useWorkspacePalette.getState().open).toBe(false)
  })

  it('↓ 移到第二条再 ↵ —— 高亮就是 ↵ 的落点', () => {
    render(<WorkspacePalette />)
    const input = screen.getByTestId('workspace-palette-input')
    act(() => void fireEvent.keyDown(input, { key: 'ArrowDown' }))
    act(() => void fireEvent.keyDown(input, { key: 'Enter' }))
    expect(useWorkspaceStore.getState().currentId).toBe('ws-lenovo')
  })

  it('改词把高亮拉回第一条 —— 命中变了还停在第三行,↵ 会切错人', () => {
    render(<WorkspacePalette />)
    const input = screen.getByTestId('workspace-palette-input')
    act(() => void fireEvent.keyDown(input, { key: 'ArrowDown' }))
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    type('个')
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true')
  })

  /*
   * Esc 从 window 打:这块面自己不挂监听,认领这一下的是响应链上唯一那个派发器
   * (`FocusDispatchHarness` 就是它)。**逃生口与焦点在哪无关**这条判据没变,
   * 变的是它靠什么成立 —— 从前靠「监听挂在 window 而不是面板上」(08-31 真机
   * 露馅的正是相反那种写法),现在靠「这一格在不在活动路径上」。
   */
  it('Esc 关掉面板 —— 焦点在哪都得关得掉', () => {
    render(
      <>
        <FocusDispatchHarness />
        <WorkspacePalette />
      </>,
    )
    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(useWorkspacePalette.getState().open).toBe(false)
  })

  it('焦点在输入框里按 Esc 同样关得掉(真键会冒泡到 window)', () => {
    render(
      <>
        <FocusDispatchHarness />
        <WorkspacePalette />
      </>,
    )
    act(() => void fireEvent.keyDown(screen.getByTestId('workspace-palette-input'), { key: 'Escape' }))
    expect(useWorkspacePalette.getState().open).toBe(false)
  })
})

/**
 * hover ≠ active(09-01 用户裁定)。从前每一行挂着 `onMouseEnter={() => setCursor(i)}`,
 * 于是「鼠标停在列表上按 ↑↓」和「滚动之后补来的那发合成 mouseenter」两条路
 * 都能把键盘位拽走。反证:把那句 onMouseEnter 加回去,下面两条立刻红。
 */
describe('hover 不许影响 select', () => {
  it('鼠标经过第三行,键盘位一格不动 —— ↵ 落的还是键盘那一条', () => {
    render(<WorkspacePalette />)
    const input = screen.getByTestId('workspace-palette-input')
    act(() => void fireEvent.keyDown(input, { key: 'ArrowDown' }))
    act(() => void fireEvent.mouseEnter(screen.getByTestId('workspace-palette-row-ws-personal')))
    // 高亮仍在第 2 行(Lenovo),不是鼠标底下的第 3 行(个人)。
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    act(() => void fireEvent.keyDown(input, { key: 'Enter' }))
    expect(useWorkspaceStore.getState().currentId).toBe('ws-lenovo')
  })

  it('点击是显式意图 —— 它可以改键盘位,并当场切过去', () => {
    render(<WorkspacePalette />)
    act(() => void fireEvent.click(screen.getByTestId('workspace-palette-row-ws-personal')))
    expect(useWorkspaceStore.getState().currentId).toBe('ws-personal')
  })

  /* 限高(.list max-height: 44vh)必然带出来的另一半:键盘位走出视野要滚回来。 */
  it('↑↓ 换行时把那一行滚进视野(block: nearest)', () => {
    const original = Element.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      render(<WorkspacePalette />)
      scrollIntoView.mockClear()
      act(() =>
        void fireEvent.keyDown(screen.getByTestId('workspace-palette-input'), { key: 'ArrowDown' }),
      )
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})

describe('新建', () => {
  it('落在「新建」那一行上按 ↵ = 用当下这个词建一个', async () => {
    const create = vi.fn(async () => ({
      success: true,
      space: { id: 'ws-new', name: '新的', createdAt: 300 },
    }))
    configureSpacesPort({
      ready: async () => undefined,
      list: async () => ({ success: true, spaces: [DEFAULT] }),
      create,
      update: async () => ({ success: true }),
      remove: async () => ({ success: true }),
    })
    render(<WorkspacePalette />)
    type('新的')
    await act(async () => void fireEvent.click(screen.getByTestId('workspace-palette-create')))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: '新的' }))
  })
})

describe('关着的时候', () => {
  it('一个节点都不画 —— 面板是过路件,不该在场等着', () => {
    useWorkspacePalette.setState({ open: false })
    render(<WorkspacePalette />)
    expect(screen.queryByTestId('workspace-palette-scrim')).toBeNull()
  })
})
