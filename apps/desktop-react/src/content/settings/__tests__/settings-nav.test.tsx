import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SettingsMock } from '../../SettingsMock'
import { DEFAULT_SETTINGS_PAGE, SETTINGS_PAGES } from '../pages'
import { openSettingsPage, useSettingsNav } from '../store'
import { useStageStore } from '../../../stage/store'

/**
 * **设置页的导航**(2026-09-13 分页)。
 *
 * 三件事:导航与内容读同一张表、`aria-current` 只在一颗钮上、以及那两条
 * 「存档是不可信输入」/「深链口只开不收」的判据。
 */

beforeEach(() => {
  act(() => useSettingsNav.setState({ page: DEFAULT_SETTINGS_PAGE }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('设置页导航', () => {
  it('出厂停在通用页;导航行数 = 页表行数', () => {
    render(<SettingsMock />)
    expect(screen.getByTestId(`settings-page-${DEFAULT_SETTINGS_PAGE}`)).toBeTruthy()
    for (const page of SETTINGS_PAGES) {
      expect(screen.getByTestId(`settings-nav-${page.id}`)).toBeTruthy()
    }
  })

  it('点「模型服务」那一行 → 那一页出现,而且 `aria-current` **只在一颗钮上**', async () => {
    render(<SettingsMock />)
    // 模型服务那一页挂上去就自己发取数,`await act` 把那几拍冲干净 ——
    // 否则 React 会抱怨「有一次更新没包在 act 里」(那是噪音不是失败,但噪音会
    // 盖住真的警告)。
    await act(async () => void fireEvent.click(screen.getByTestId('settings-nav-models')))

    expect(screen.getByTestId('settings-page-models')).toBeTruthy()
    // 只渲染当前页:上一页卸载了。
    expect(screen.queryByTestId(`settings-page-${DEFAULT_SETTINGS_PAGE}`)).toBeNull()

    const current = SETTINGS_PAGES.filter(
      (page) => screen.getByTestId(`settings-nav-${page.id}`).getAttribute('aria-current') === 'page',
    )
    expect(current.map((p) => p.id)).toEqual(['models'])
  })

  it('`fill` 那一页不套 `.form` 外壳 —— 版式由页自述的那一格说了算', async () => {
    render(<SettingsMock />)
    await act(async () => void fireEvent.click(screen.getByTestId('settings-nav-models')))
    expect(screen.getByTestId('settings-page-models').getAttribute('data-layout')).toBe('fill')
    await act(async () => void fireEvent.click(screen.getByTestId('settings-nav-dock')))
    expect(screen.getByTestId('settings-page-dock').getAttribute('data-layout')).toBe('form')
  })

  it('**存档是不可信输入**:水合一份 `page: "nope"` 的存档 → 落回通用页', () => {
    window.localStorage.setItem(
      'onething.settings-nav',
      JSON.stringify({ state: { page: 'nope' }, version: 0 }),
    )
    act(() => void useSettingsNav.persist.rehydrate())
    expect(useSettingsNav.getState().page).toBe(DEFAULT_SETTINGS_PAGE)
    window.localStorage.removeItem('onething.settings-nav')
  })

  it('存档里是认得出的页名就照它水合(归一不是把人存的东西抹掉)', () => {
    window.localStorage.setItem(
      'onething.settings-nav',
      JSON.stringify({ state: { page: 'keymap' }, version: 0 }),
    )
    act(() => void useSettingsNav.persist.rehydrate())
    expect(useSettingsNav.getState().page).toBe('keymap')
    window.localStorage.removeItem('onething.settings-nav')
  })
})

describe('深链口 `openSettingsPage`', () => {
  it('换页 + 把设置召唤出来', () => {
    const summonRef = vi.fn(() => null)
    const summonItem = vi.fn()
    const spy = vi
      .spyOn(useStageStore, 'getState')
      .mockReturnValue({ summonRef, summonItem } as never)

    openSettingsPage('keymap')

    expect(useSettingsNav.getState().page).toBe('keymap')
    // 哪棵树上都没有它(`summonRef` 答 null)→ 退回 `summonItem` 把它开出来。
    expect(summonItem).toHaveBeenCalledWith('settings')
    spy.mockRestore()
  })

  it('**已经开着时只去不收**:`reveal` 答得出住处就不再 `summonItem`', () => {
    const summonRef = vi.fn(() => 'shelf' as const)
    const summonItem = vi.fn()
    const spy = vi
      .spyOn(useStageStore, 'getState')
      .mockReturnValue({ summonRef, summonItem } as never)

    openSettingsPage('models')

    expect(useSettingsNav.getState().page).toBe('models')
    expect(summonRef).toHaveBeenCalledWith({ kind: 'panel', key: 'settings' }, 'reveal')
    // `toggle` 的第四态是「收起来」,而这只口没有反面 —— 所以这一句一次都不许发。
    expect(summonItem).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
