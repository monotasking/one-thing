import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AppShell } from '../../components/AppShell'
import { SESSIONS_ITEM_ID } from '../../stage/items'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { useKeymapStore } from '../../keymap/store'
import { initialKeymapState } from '../../keymap/transitions'
import { useSessionsSource } from '../../data/sessions-source'
import { GROUPS, SESSIONS, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { useExposeStore } from '../store'
import { findSession } from '../projection'
import { initialExposeState, visibleCardIds } from '../transitions'

/**
 * 会话总览去接管化(08-29 拍板)之后要钉住的四件事:
 * 它按 Placement 开(不再是盖满一屏的覆盖层)、两个入口是同一条路、
 * 开场永远从总览起步,以及 **Esc 的让位契约**:
 * 内层(quicklook / list)先消费,消费不了才轮到宿主关这块面。
 */
beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh', defaultOpen: 'stage' })
  // 数据先在场,再挂壳 —— 会话侧从此吃真数据源(D1),没有 mock 兜底。
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, currentSessionId: SESSIONS[0].id })
  useKeymapStore.setState({ ...initialKeymapState })
})

const placementOfSessions = () => useStageStore.getState().placements[SESSIONS_ITEM_ID]
const esc = () => act(() => void fireEvent.keyDown(document.body, { key: 'Escape' }))
const cmdE = () => act(() => void fireEvent.keyDown(document.body, { key: 'e', metaKey: true }))

/** 展开组里第二张卡:既看得见,又不是当前会话 —— 「进入」要能真的换一个。 */
const other = SESSIONS.find((s) => s.id === visibleCardIds(initialExposeState, GROUPS)[1])!

describe('会话总览是一块普通的面', () => {
  it('⌘E 按打开方式把它开出来,内容住在面里', () => {
    render(<AppShell />)
    cmdE()
    expect(placementOfSessions()).toEqual({ kind: 'stage' })
    expect(screen.getByLabelText('搜索会话')).toBeTruthy()
  })

  it('顶栏标题与 Dock 那块瓦是同一条路:点它 = 按它的打开方式开', () => {
    render(<AppShell />)
    const current = findSession(
      useSessionsSource.getState().sessions,
      useExposeStore.getState().currentSessionId,
    )!
    fireEvent.click(screen.getByText(current.title))
    expect(placementOfSessions()).toEqual({ kind: 'stage' })
  })

  it('开场归位:上次停在 Quick Look,再开还是从总览起步', () => {
    render(<AppShell />)
    cmdE()
    act(() => useExposeStore.getState().openQuickLook(other.id))
    cmdE()
    cmdE()
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
  })

  it('进入会话 = 换当前会话,并顺手把这块面收回 Dock', () => {
    render(<AppShell />)
    cmdE()
    fireEvent.click(screen.getByText(other.title))
    expect(useExposeStore.getState().currentSessionId).toBe(other.id)
    expect(SESSIONS_ITEM_ID in useStageStore.getState().placements).toBe(false)
  })
})

describe('Esc 的让位契约', () => {
  it('内层先消费:Quick Look 上的 Esc 退回总览,面板一动不动', () => {
    render(<AppShell />)
    cmdE()
    act(() => useExposeStore.getState().openQuickLook(other.id))
    esc()
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
    expect(placementOfSessions()).toEqual({ kind: 'stage' })
  })

  it('组列表同理:先退回总览,不是直接关面板', () => {
    render(<AppShell />)
    cmdE()
    act(() => useExposeStore.getState().enterList(GROUPS[0].id))
    esc()
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
    expect(placementOfSessions()).toEqual({ kind: 'stage' })
  })

  it('内层消费不了才轮到宿主:总览上的 Esc 关掉这块面', () => {
    render(<AppShell />)
    cmdE()
    esc()
    expect(SESSIONS_ITEM_ID in useStageStore.getState().placements).toBe(false)
  })

  it('搜索词是 Esc 的第 0 层:先清词,面板与视图都不动', () => {
    render(<AppShell />)
    cmdE()
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'provider' } })
    esc()
    expect(useExposeStore.getState().query).toBe('')
    expect(placementOfSessions()).toEqual({ kind: 'stage' })
  })
})
