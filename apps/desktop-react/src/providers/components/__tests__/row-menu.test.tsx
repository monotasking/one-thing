import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ProviderRowMenu } from '../ProviderRowMenu'
import { useStageStore } from '../../../stage/store'

/**
 * provider 行的右键菜单(09-01 报障「custom provider 没有删除选项」的落点)。
 *
 * 守四件:
 *  ① **自定义家有删除**,而且是 danger + 两段就地确认(不弹对话框);
 *  ② **内置家没有删除**,只给停用 —— 用户裁定;
 *  ③ 确认那句话把**级联说全**(模型勾选 + 这个空间里的密钥);
 *  ④ 启/停那一行说的是**此刻**的状态,不是写死一句。
 */

// 断言写的是中文那一份文案,所以语言钉死(jsdom 的 navigator.language 是 en-US,
// 'system' 档会解析成英文 —— 与 batch2-ui 用例同一手)。
beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

function menu(over: Partial<Parameters<typeof ProviderRowMenu>[0]> = {}) {
  const props = {
    familyId: 'custom-1',
    label: 'vLLM',
    custom: true,
    enabled: true,
    x: 0,
    y: 0,
    onClose: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onToggleEnabled: vi.fn(),
    ...over,
  }
  render(<ProviderRowMenu {...props} />)
  return props
}

describe('自定义家', () => {
  it('① 有删除,第一下只换字、第二下才删', () => {
    const props = menu()
    fireEvent.click(screen.getByRole('menuitem', { name: /删除这一家/ }))
    expect(props.onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: /真删/ }))
    expect(props.onDelete).toHaveBeenCalledTimes(1)
  })

  it('③ 确认那句话把级联说全:模型勾选 + 这个空间里的密钥', () => {
    menu()
    fireEvent.click(screen.getByRole('menuitem', { name: /删除这一家/ }))
    const confirm = screen.getByRole('menuitem', { name: /真删/ }).textContent ?? ''
    expect(confirm).toMatch(/模型勾选/)
    expect(confirm).toMatch(/密钥/)
  })

  it('有编辑,点了就交出去并关掉菜单', () => {
    const props = menu()
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑这一家' }))
    expect(props.onEdit).toHaveBeenCalledTimes(1)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})

describe('内置家', () => {
  it('② **没有删除** —— 内置的删不掉(用户裁定)', () => {
    menu({ custom: false, familyId: 'claude', label: 'Claude' })
    expect(screen.queryByRole('menuitem', { name: /删除/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /编辑/ })).toBeNull()
  })

  it('② 但给得出停用,并就地说清为什么没有删除', () => {
    const props = menu({ custom: false, familyId: 'claude', label: 'Claude' })
    fireEvent.click(screen.getByRole('menuitem', { name: '停用这一家' }))
    expect(props.onToggleEnabled).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/内置的这一家删不掉/)).toBeTruthy()
  })
})

describe('启 / 停那一行', () => {
  it('④ 说的是此刻的状态:开着的说「停用」,停着的说「启用」', () => {
    menu({ enabled: true })
    expect(screen.getByRole('menuitem', { name: '停用这一家' })).toBeTruthy()
  })

  it('④ 停着的那一家说「启用」', () => {
    menu({ enabled: false, familyId: 'claude', label: 'Claude', custom: false })
    expect(screen.getByRole('menuitem', { name: '启用这一家' })).toBeTruthy()
  })
})
