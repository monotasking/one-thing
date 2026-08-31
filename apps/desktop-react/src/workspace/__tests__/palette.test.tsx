import { beforeEach, describe, expect, it, vi } from 'vitest'
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
   * Esc 听在 window 上(与 ui/Menu、ui/Dialog 同一手),所以这条用例**从 window 打** ——
   * 08-31 真机上就是这条露的馅:从前它挂在面板的 onKeyDown 上,焦点一旦不在面板里
   * 就关不掉。浮层的逃生口必须与焦点在哪无关。
   */
  it('Esc 关掉面板 —— 焦点在哪都得关得掉', () => {
    render(<WorkspacePalette />)
    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(useWorkspacePalette.getState().open).toBe(false)
  })

  it('焦点在输入框里按 Esc 同样关得掉(真键会冒泡到 window)', () => {
    render(<WorkspacePalette />)
    act(() => void fireEvent.keyDown(screen.getByTestId('workspace-palette-input'), { key: 'Escape' }))
    expect(useWorkspacePalette.getState().open).toBe(false)
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
