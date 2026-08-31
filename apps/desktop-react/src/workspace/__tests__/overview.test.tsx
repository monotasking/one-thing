import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SpaceRecord } from '@shared/ipc/spaces'
import { renderContent } from '../../content'
import { configureSpacesPort } from '../../data/spaces-port'
import type { SpacesPort } from '../../data/spaces-port'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { WORKSPACE_ITEM_ID } from '../../stage/items'
import { ConfirmHost } from '../../ui/Dialog'
import { useWorkspaceStore } from '../store'
import { DEFAULT_SPACE_ID } from '../types'

/**
 * 工作区总览 —— 它是一块**普通的 Dock 内容**,所以这一份用例从 `renderContent`
 * 进(与 files-panel 那一份同一手):走的是舞台 / 浮窗 / 架子共用的那条路。
 *
 * 钉的是三条硬规矩(08-31 拍板):当前卡描边、当前卡不给删、删除走两段确认。
 */

const DEFAULT: SpaceRecord = { id: DEFAULT_SPACE_ID, name: '默认', createdAt: 0, color: 'violet' }
const LENOVO: SpaceRecord = { id: 'ws-lenovo', name: 'Lenovo 工作', createdAt: 100, color: 'blue' }
const PERSONAL: SpaceRecord = { id: 'ws-personal', name: '个人', createdAt: 200, color: 'green' }

function installPort(overrides: Partial<SpacesPort> = {}): SpacesPort {
  const port: SpacesPort = {
    ready: async () => undefined,
    list: vi.fn(async () => ({ success: true, spaces: [DEFAULT, LENOVO, PERSONAL] })),
    create: vi.fn(async () => ({ success: false, error: 'not stubbed' })),
    update: vi.fn(async () => ({ success: true })),
    remove: vi.fn(async () => ({ success: true, removed: true })),
    ...overrides,
  }
  configureSpacesPort(port)
  return port
}

beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  useWorkspaceStore.getState().reset()
  installPort()
})

async function renderOverview() {
  render(
    <>
      {renderContent(WORKSPACE_ITEM_ID)}
      <ConfirmHost />
    </>,
  )
  await act(async () => undefined)
}

describe('卡的状态', () => {
  it('每个工作区一张卡,当前那张标出来', async () => {
    await renderOverview()
    expect(screen.getByTestId(`workspace-card-${DEFAULT_SPACE_ID}`).dataset.current).toBe('true')
    expect(screen.getByTestId('workspace-card-ws-lenovo').dataset.current).toBeUndefined()
  })

  it('当前卡不给「删除…」—— 删掉脚下这块地会让「当前」变成幽灵', async () => {
    await renderOverview()
    act(() => useWorkspaceStore.getState().switchTo('ws-lenovo'))
    expect(screen.queryByTestId('workspace-remove-ws-lenovo')).toBeNull()
    expect(screen.getByTestId('workspace-remove-ws-personal')).toBeTruthy()
  })

  it('默认空间也不给「删除…」—— 后端会拒,不让人点一下再被拒', async () => {
    await renderOverview()
    expect(screen.queryByTestId(`workspace-remove-${DEFAULT_SPACE_ID}`)).toBeNull()
  })

  it('当前那张卡的名字不是可按的 —— 按下去什么都不会变', async () => {
    await renderOverview()
    // jest-dom 不在这台的依赖里,所以问的是原生属性而不是 toBeDisabled()。
    expect((screen.getByTestId(`workspace-switch-${DEFAULT_SPACE_ID}`) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('workspace-switch-ws-lenovo') as HTMLButtonElement).disabled).toBe(false)
  })

  it('点别的卡就切过去', async () => {
    await renderOverview()
    act(() => void fireEvent.click(screen.getByTestId('workspace-switch-ws-lenovo')))
    expect(useWorkspaceStore.getState().currentId).toBe('ws-lenovo')
  })

  it('那句注脚在场 —— 切换换的是什么,全靠它说清', async () => {
    await renderOverview()
    expect(screen.getByText(/每个工作区各有一套会话、模型服务与凭证/)).toBeTruthy()
  })
})

describe('改名与换色', () => {
  it('改名:点「改名」出输入框,↵ 落定并落到端口上', async () => {
    const port = installPort()
    await renderOverview()
    act(() => void fireEvent.click(screen.getByTestId('workspace-rename-ws-lenovo')))
    const input = screen.getByTestId('workspace-name-input')
    act(() => void fireEvent.change(input, { target: { value: 'Lenovo' } }))
    await act(async () => void fireEvent.keyDown(input, { key: 'Enter' }))
    expect(port.update).toHaveBeenCalledWith({ id: 'ws-lenovo', name: 'Lenovo' })
  })

  it('改名:Esc 收回,一个字都不写出去', async () => {
    const port = installPort()
    await renderOverview()
    act(() => void fireEvent.click(screen.getByTestId('workspace-rename-ws-lenovo')))
    act(() => void fireEvent.keyDown(screen.getByTestId('workspace-name-input'), { key: 'Escape' }))
    expect(screen.queryByTestId('workspace-name-input')).toBeNull()
    expect(port.update).not.toHaveBeenCalled()
  })

  it('换色:摊开六格,点一格落到端口上', async () => {
    const port = installPort()
    await renderOverview()
    act(() => void fireEvent.click(screen.getByTestId('workspace-recolor-ws-lenovo')))
    await act(async () => void fireEvent.click(screen.getByTestId('workspace-swatch-ws-lenovo-teal')))
    expect(port.update).toHaveBeenCalledWith({ id: 'ws-lenovo', color: 'teal' })
  })
})

describe('删除的两段确认', () => {
  it('第一段就取消 = 端口一次都不打', async () => {
    const port = installPort()
    await renderOverview()
    act(() => void fireEvent.click(screen.getByTestId('workspace-remove-ws-personal')))
    await waitFor(() => expect(screen.getByText('删除「个人」?')).toBeTruthy())
    await act(async () => void fireEvent.click(screen.getByText('取消')))
    expect(port.remove).not.toHaveBeenCalled()
  })

  it('第二段才真删 —— 两段不是仪式,是给「我是不是点错了」留的一拍', async () => {
    const port = installPort()
    await renderOverview()
    act(() => void fireEvent.click(screen.getByTestId('workspace-remove-ws-personal')))

    await waitFor(() => expect(screen.getByText('继续')).toBeTruthy())
    await act(async () => void fireEvent.click(screen.getByText('继续')))
    // 第一段点完还没删。
    expect(port.remove).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.getByText('真的删掉「个人」?')).toBeTruthy())
    await act(async () => void fireEvent.click(screen.getByText('删除')))
    expect(port.remove).toHaveBeenCalledWith('ws-personal')
  })
})

describe('新建', () => {
  it('虚线卡点开收名字,↵ 落定', async () => {
    const port = installPort({
      create: vi.fn(async () => ({
        success: true,
        space: { id: 'ws-new', name: '新的', createdAt: 300 },
      })),
    })
    await renderOverview()
    act(() => void fireEvent.click(screen.getByTestId('workspace-create')))
    const input = screen.getByTestId('workspace-name-input')
    act(() => void fireEvent.change(input, { target: { value: '新的' } }))
    await act(async () => void fireEvent.keyDown(input, { key: 'Enter' }))
    expect(port.create).toHaveBeenCalledWith(expect.objectContaining({ name: '新的' }))
  })
})

describe('读不到列表', () => {
  it('如实说读不到,并把后端原话摆出来', async () => {
    installPort({ list: async () => ({ success: false, error: 'core unreachable' }) })
    await renderOverview()
    expect(screen.getByText('core unreachable')).toBeTruthy()
  })
})
