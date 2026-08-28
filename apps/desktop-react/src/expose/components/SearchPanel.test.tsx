import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppShell } from '../../components/AppShell'
import { SearchPanel } from './SearchPanel'
import { useStageStore } from '../../stage/store'
import { useExposeStore } from '../store'
import { initialStageState } from '../../stage/transitions'
import { SESSIONS } from '../data'

/**
 * ⌘P 的语义(08-29 拍板):它开的是 Dock 上那块「检索」瓦,与点图标是同一件事,
 * 不再是"盖一层会话总览"。所以这里钉三条:开、聚焦、再按一次收回。
 */
beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh', defaultOpen: 'stage' })
  useExposeStore.setState({ view: { mode: 'closed' }, query: '' })
})

const cmdP = () => fireEvent.keyDown(window, { key: 'p', metaKey: true })

describe('⌘P = 开关检索面板', () => {
  it('按一下:检索面板按打开方式开出来,输入框当场拿到焦点', () => {
    render(<AppShell />)
    cmdP()
    const input = screen.getByLabelText('搜索会话')
    expect(useStageStore.getState().placements.search).toEqual({ kind: 'stage' })
    expect(document.activeElement).toBe(input)
  })

  it('再按一下:收回 Dock,总览一直没被叫起来', async () => {
    render(<AppShell />)
    cmdP()
    cmdP()
    expect('search' in useStageStore.getState().placements).toBe(false)
    expect(useExposeStore.getState().view.mode).toBe('closed')
    // 形态当场就变了,DOM 还要多活一帧走出场动画(StageOverlay 的 held),所以这条要等。
    await waitFor(() => expect(screen.queryByLabelText('搜索会话')).toBeNull())
  })
})

describe('检索面板', () => {
  it('空词是「还没开始找」的提示,不是「没找到」', () => {
    render(<SearchPanel />)
    expect(screen.getByText('输入关键词,搜会话、章节与消息')).toBeTruthy()
  })

  it('点一条结果 = 进那个会话,并把这块面板收回 Dock', () => {
    useStageStore.setState({ placements: { search: { kind: 'stage' } } })
    render(<SearchPanel />)
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: SESSIONS[0].title } })
    fireEvent.click(screen.getByText(SESSIONS[0].title))
    expect(useExposeStore.getState().currentSessionId).toBe(SESSIONS[0].id)
    expect('search' in useStageStore.getState().placements).toBe(false)
  })
})
