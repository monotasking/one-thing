import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppShell } from '../../components/AppShell'
import { SearchPanel } from './SearchPanel'
import { useStageStore } from '../../stage/store'
import { useExposeStore } from '../../expose/store'
import { initialStageState } from '../../stage/transitions'
import { useToastHub } from '../../ui/Toast'
import { SESSIONS } from '../../expose/data'
import { RECENT_LIMIT } from '../transitions'

/**
 * 面板的键盘住在面板自己身上,所以这里全部走真组件、真按键 ——
 * 不去戳 keymap 注册表(那是「面板关着时也要能触发」的那一类,与这里无关)。
 */
beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh', defaultOpen: 'stage' })
  useExposeStore.setState({ view: { mode: 'overview' }, query: '' })
  useToastHub.setState({ toasts: [] })
})

const input = () => screen.getByLabelText('搜索')
const type = (value: string) => fireEvent.change(input(), { target: { value } })
const press = (key: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(input(), { key, ...init })
const options = () => screen.getAllByRole('option')
const selected = () => options().find((el) => el.getAttribute('aria-selected') === 'true')

/** ⌘P 的语义(08-29 拍板):它开的是 Dock 上那块「检索」瓦,与点图标是同一件事。 */
describe('⌘P = 开关检索面板', () => {
  const cmdP = () => fireEvent.keyDown(window, { key: 'p', metaKey: true })

  it('按一下:检索面板按打开方式开出来,输入框当场拿到焦点', () => {
    render(<AppShell />)
    cmdP()
    expect(useStageStore.getState().placements.search).toEqual({ kind: 'stage' })
    expect(document.activeElement).toBe(input())
  })

  it('再按一下:收回 Dock,总览那块面一直没被叫起来', async () => {
    render(<AppShell />)
    cmdP()
    cmdP()
    expect('search' in useStageStore.getState().placements).toBe(false)
    expect('sessions' in useStageStore.getState().placements).toBe(false)
    // 形态当场就变了,DOM 还要多活一帧走出场动画(StageOverlay 的 held),所以这条要等。
    await waitFor(() => expect(screen.queryByLabelText('搜索')).toBeNull())
  })
})

describe('搜索行:scope 分段器', () => {
  it('Tab 轮转:所有 → 会话 → 文件 → 所有', () => {
    render(<SearchPanel />)
    expect(screen.getByRole('radio', { name: '所有' }).getAttribute('aria-checked')).toBe('true')
    press('Tab')
    expect(screen.getByRole('radio', { name: '会话' }).getAttribute('aria-checked')).toBe('true')
    press('Tab')
    expect(screen.getByRole('radio', { name: '文件' }).getAttribute('aria-checked')).toBe('true')
    press('Tab')
    expect(screen.getByRole('radio', { name: '所有' }).getAttribute('aria-checked')).toBe('true')
  })

  it('⇧Tab 反向轮转', () => {
    render(<SearchPanel />)
    press('Tab', { shiftKey: true })
    expect(screen.getByRole('radio', { name: '文件' }).getAttribute('aria-checked')).toBe('true')
    press('Tab', { shiftKey: true })
    expect(screen.getByRole('radio', { name: '会话' }).getAttribute('aria-checked')).toBe('true')
  })

  it('换范围会换掉这张列表:文件档一行会话都没有', () => {
    render(<SearchPanel />)
    type('provider')
    press('Tab')
    press('Tab')
    // 徽上只剩文件类型,「会话」「消息」两种徽一颗不剩。
    expect(screen.queryByText('消息')).toBeNull()
    expect(options().length).toBeGreaterThan(0)
  })
})

describe('命中列表:走行与跳转', () => {
  it('↑↓ 走行,选中停在两端不回卷', () => {
    render(<SearchPanel />)
    expect(selected()).toBe(options()[0])
    press('ArrowUp')
    expect(selected()).toBe(options()[0])
    press('ArrowDown')
    expect(selected()).toBe(options()[1])
    press('ArrowUp')
    expect(selected()).toBe(options()[0])
  })

  it('⏎ 进会话:换当前会话并把这块面板收回 Dock', () => {
    useStageStore.setState({ placements: { search: { kind: 'stage' } } })
    render(<SearchPanel />)
    type(SESSIONS[0].title)
    press('Enter')
    expect(useExposeStore.getState().currentSessionId).toBe(SESSIONS[0].id)
    expect('search' in useStageStore.getState().placements).toBe(false)
  })

  it('点一行 = 按 ⏎', () => {
    useStageStore.setState({ placements: { search: { kind: 'stage' } } })
    render(<SearchPanel />)
    type(SESSIONS[1].title)
    fireEvent.click(options()[0])
    expect(useExposeStore.getState().currentSessionId).toBe(SESSIONS[1].id)
    expect('search' in useStageStore.getState().placements).toBe(false)
  })

  it('文件行:壳里还没有真打开能力,所以报出落点并同样收回 Dock', () => {
    useStageStore.setState({ placements: { search: { kind: 'stage' } } })
    render(<SearchPanel />)
    type('catalogCache')
    press('Enter')
    expect(useToastHub.getState().toasts.map((x) => x.message)).toEqual([
      '已打开 model-registry.ts:96',
    ])
    expect('search' in useStageStore.getState().placements).toBe(false)
  })
})

describe('两种空', () => {
  it('词为空 = 最近打开(不是「没找到」),清掉词就回到它', () => {
    render(<SearchPanel />)
    expect(options().length).toBe(RECENT_LIMIT)
    type('provider')
    expect(options().length).not.toBe(RECENT_LIMIT)
    type('')
    expect(options().length).toBe(RECENT_LIMIT)
    expect(screen.queryByText('无结果')).toBeNull()
  })

  it('搜不到就是居中一行灰字', () => {
    render(<SearchPanel />)
    type('zzzzzz')
    expect(screen.getByText('无结果')).toBeTruthy()
    expect(screen.queryAllByRole('option').length).toBe(0)
  })
})
