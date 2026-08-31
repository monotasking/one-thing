import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { AppsPanel } from '../AppsPanel'
import { Dock } from '../../components/Dock'
import { useStageStore } from '../../stage/store'
import { initialStageState, initialStageSettings } from '../../stage/transitions'
import { APPS_ITEM_ID, STAGE_ITEMS } from '../../stage/items'

/**
 * 「所有应用」这块管理瓦。四件事,一件不多:
 *  ① 列全 —— 这台壳里能打开的每一块都在;
 *  ② 关掉一行,那块瓦从 Dock 上消失;
 *  ③ 藏起来的面**照样打得开**(藏的是入口不是这块面)—— 所以这不是「卸载」;
 *  ④ **留一个回家的门**:这块瓦自己藏不掉。
 */

beforeEach(() => {
  useStageStore.setState({ ...initialStageState, ...initialStageSettings, locale: 'zh' })
})

const row = (id: string) => screen.getByTestId(`apps-row-${id}`)
const switchIn = (id: string) => within(row(id)).getByRole('switch')

describe('所有应用', () => {
  it('列全每一块可打开的面', () => {
    render(<AppsPanel />)
    for (const item of STAGE_ITEMS) expect(row(item.id)).toBeTruthy()
  })

  it('开关的语义是「显示在 Dock」:默认全开', () => {
    render(<AppsPanel />)
    for (const item of STAGE_ITEMS) {
      expect(switchIn(item.id).getAttribute('aria-checked')).toBe('true')
    }
  })

  it('关掉一行 → 那块瓦从 Dock 上消失,别的瓦一个不少', () => {
    const { unmount } = render(<AppsPanel />)
    act(() => void switchIn('diff').click())
    expect(useStageStore.getState().hiddenItems).toEqual(['diff'])
    unmount()

    render(<Dock />)
    expect(screen.queryByTestId('dock-tile-diff')).toBeNull()
    expect(screen.getByTestId('dock-tile-files')).toBeTruthy()
    expect(screen.getByTestId(`dock-tile-${APPS_ITEM_ID}`)).toBeTruthy()
  })

  it('再打开就回来 —— 藏是可逆的,这正是这块面存在的理由', () => {
    render(<AppsPanel />)
    act(() => void switchIn('diff').click())
    act(() => void switchIn('diff').click())
    expect(useStageStore.getState().hiddenItems).toEqual([])
  })

  it('藏起来的面照样打得开(点清单里的名字 = 点那块瓦)', () => {
    render(<AppsPanel />)
    act(() => void switchIn('diff').click())
    act(() => void within(row('diff')).getByRole('button').click())
    expect(useStageStore.getState().placements.diff).toBeTruthy()
  })

  it('留一个回家的门:「所有应用」自己那颗开关按不动,而且判据挡得住绕路', () => {
    render(<AppsPanel />)
    const own = switchIn(APPS_ITEM_ID)
    expect(own.hasAttribute('disabled')).toBe(true)

    // UI 是绕得过去的(右键 / 快捷键 / 将来的命令面板),所以直接叫 action 再试一次。
    act(() => useStageStore.getState().setItemHidden(APPS_ITEM_ID, true))
    expect(useStageStore.getState().hiddenItems).toEqual([])
  })

  it('隐藏计数只在真有隐藏项时才说话(0 不是一条要说的消息)', () => {
    render(<AppsPanel />)
    expect(screen.queryByText(/已隐藏/)).toBeNull()
    act(() => void switchIn('diff').click())
    expect(screen.getByText(/已隐藏 1 块/)).toBeTruthy()
  })
})
