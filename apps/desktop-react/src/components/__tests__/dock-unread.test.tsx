import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { useNotifyStore } from '../../services/notify-store'
import { useToastHub } from '../../ui/Toast'
import { NOTIFICATIONS_ITEM_ID } from '../../stage/items'
import { notify } from '../../services/notify'

/**
 * 未读点的合同:**有未读就亮一颗点,打开面板就灭**。
 *
 * 它刻意不是一枚计数徽 —— 「有没有」用点,「有几个」才用数(tab / 列表禁计数徽
 * 那条判例在 Dock 瓦上同样成立)。所以这里断言的是那颗点在不在,
 * 一个数字都不去查。
 */
beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  useNotifyStore.setState({ items: [] })
  useToastHub.setState({ toasts: [], folded: 0 })
})

const dot = () => screen.queryByTestId('dock-unread')
const tile = () => screen.getByTestId(`dock-tile-${NOTIFICATIONS_ITEM_ID}`)

describe('Dock 上的未读点', () => {
  it('没有通知时不画点', () => {
    render(<AppShell />)
    expect(dot()).toBe(null)
  })

  it('来一条就亮;点开那块瓦(面板到场)就灭', () => {
    render(<AppShell />)
    act(() => void notify({ level: 'warn', title: '没连上 core', source: 'platform.connection' }))
    expect(dot()).toBeTruthy()

    fireEvent.click(tile())
    // 点开 = 按它自己的打开方式落定(08-30 拍板统一浮窗),面板到场即清未读
    expect(useStageStore.getState().placements[NOTIFICATIONS_ITEM_ID]).toEqual({ kind: 'float' })
    expect(dot()).toBe(null)
  })

  /*
   * 09-01 审计 A2 **推翻**了这一格从前的裁定(「存档里的东西就是未读的东西」)。
   * 那条裁定把「记下」和「打扰」当成了一件事,于是命运表里说好「一个字都不弹」的
   * silent,从铃铛这个口把话说了出来:一台全新的 store 什么都没干,几条 perf 读数
   * 进环就把点点亮,用户点开只看到「keypress took 80ms」。
   *
   * 现在的口径:点和 toast 是同一件事的两种强度 —— 一档说了不打扰,两个口都不打扰。
   * 记录照旧在存档里(下面第二条断言就是这句话的检验点)。
   */
  it('silent 一个字都不弹,那颗点也不亮 —— 但它照样进存档', () => {
    render(<AppShell />)
    act(() => void notify({ level: 'silent', title: '长帧 120ms', source: 'perf.longFrame' }))
    expect(useToastHub.getState().toasts).toEqual([])
    expect(dot()).toBe(null)
    expect(useNotifyStore.getState().items.length).toBe(1)
  })

  it('silent 与会打扰的那几档同屏时,点为后者而亮(不数 silent ≠ 不亮)', () => {
    render(<AppShell />)
    act(() => {
      notify({ level: 'silent', title: '长帧 120ms', source: 'perf.longFrame' })
      notify({ level: 'warn', title: '没连上 core', source: 'platform.connection' })
    })
    expect(dot()).toBeTruthy()
  })

  it('「全部已读」之后点灭,记录还在', () => {
    render(<AppShell />)
    act(() => void notify({ level: 'info', title: 'a', source: 's' }))
    expect(dot()).toBeTruthy()
    act(() => void useNotifyStore.getState().markAllRead())
    expect(dot()).toBe(null)
    expect(useNotifyStore.getState().items.length).toBe(1)
  })
})
