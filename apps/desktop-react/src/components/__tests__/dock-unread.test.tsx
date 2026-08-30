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

  it('silent 一个字都不弹,但它照样把点点亮 —— 存档里的东西就是未读的东西', () => {
    render(<AppShell />)
    act(() => void notify({ level: 'silent', title: '长帧 120ms', source: 'perf.longFrame' }))
    expect(useToastHub.getState().toasts).toEqual([])
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
