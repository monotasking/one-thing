import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeSettings } from '../ThemeSettings'
import { configureThemeSettingsPort, type ThemeSettingsPort } from '../../../data/theme-settings-port'
import {
  resetThemeSettingsSourceForTest,
  themeSettingsQuery,
} from '../../../data/theme-settings-source'
import type { AppSettings } from '@shared/ipc/settings'
import type { ThemeMeta } from '@shared/ipc/themes'

vi.mock('../../../theme/theme-source', async () => {
  const actual = await vi.importActual<typeof import('../../../theme/theme-source')>(
    '../../../theme/theme-source',
  )
  return { ...actual, refreshThemeFromSettings: vi.fn(async () => ({ applied: true, count: 1 })) }
})

/**
 * 「主题」那一节的**屏幕半边**:三行画得出来、选一项发一次写、以及那两格
 * 「还没问到就禁着」「当前 id 不在名册上仍然选得中」。
 */

const THEMES: ThemeMeta[] = [
  { id: 'flexoki', name: 'Flexoki', type: 'full', source: 'builtin', colorScheme: 'both' },
  { id: 'daylight', name: 'Daylight', type: 'full', source: 'builtin', colorScheme: 'light' },
  { id: 'midnight', name: 'Midnight', type: 'full', source: 'user', colorScheme: 'dark' },
]

function settings(over: Partial<AppSettings['general']> = {}): AppSettings {
  return {
    ai: {} as AppSettings['ai'],
    theme: 'system',
    general: {
      animationSpeed: 0.25,
      sendShortcut: 'enter',
      colorTheme: 'purple',
      lightThemeId: 'daylight',
      darkThemeId: 'midnight',
      ...over,
    } as AppSettings['general'],
    tools: {} as AppSettings['tools'],
  }
}

let saved: AppSettings[] = []

function installPort(over: Partial<ThemeSettingsPort> = {}): void {
  configureThemeSettingsPort({
    ready: async () => undefined,
    readSettings: async () => ({ success: true, settings: settings() }),
    saveSettings: async (next) => {
      saved.push(next)
      return { success: true }
    },
    listThemes: async () => ({ success: true, themes: THEMES }),
    onSettingsChanged: () => () => {},
    ...over,
  })
}

beforeEach(() => {
  saved = []
  resetThemeSettingsSourceForTest()
  installPort()
})

afterEach(() => {
  cleanup()
  configureThemeSettingsPort(undefined)
  resetThemeSettingsSourceForTest()
})

/** 打开一格 `ui/Select` 并点里面那一项。 */
async function pick(rowTestId: string, label: string): Promise<void> {
  const trigger = within(screen.getByTestId(rowTestId)).getByRole('combobox')
  await act(async () => void fireEvent.click(trigger))
  const option = await screen.findByRole('option', { name: label })
  await act(async () => void fireEvent.click(option))
}

describe('主题这一节', () => {
  it('三行都画出来了', async () => {
    render(<ThemeSettings />)
    await waitFor(() => expect(themeSettingsQuery.get().data).toBeTruthy())
    expect(screen.getByTestId('theme-mode-row')).toBeTruthy()
    expect(screen.getByTestId('theme-light-row')).toBeTruthy()
    expect(screen.getByTestId('theme-dark-row')).toBeTruthy()
  })

  it('**还没问到就禁着**:一行禁着的控件说的是「还不知道」,不是「你没选过」', () => {
    // 端口永远不答 —— 这就是「首载还在飞」那一帧。
    installPort({ readSettings: () => new Promise(() => {}) })
    render(<ThemeSettings />)
    const mode = within(screen.getByTestId('theme-mode-row')).getAllByRole('radio')
    expect(mode.every((el) => (el as HTMLButtonElement).disabled)).toBe(true)
    expect(
      (within(screen.getByTestId('theme-light-row')).getByRole('combobox') as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('点「深色」发**一次**写,写回去的整份里只有 `theme` 变了', async () => {
    render(<ThemeSettings />)
    await waitFor(() => expect(themeSettingsQuery.get().data).toBeTruthy())

    const group = screen.getByTestId('theme-mode-row')
    await act(async () => void fireEvent.click(within(group).getByRole('radio', { name: 'Dark' })))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toEqual({ ...settings(), theme: 'dark' })
  })

  it('浅色主题那一格:只列浅色档的(含 both),选一项写 `general.lightThemeId`', async () => {
    render(<ThemeSettings />)
    await waitFor(() => expect(themeSettingsQuery.get().data).toBeTruthy())

    const trigger = within(screen.getByTestId('theme-light-row')).getByRole('combobox')
    await act(async () => void fireEvent.click(trigger))
    expect(screen.getAllByRole('option').map((el) => el.textContent)).toEqual([
      'Flexoki',
      'Daylight',
    ])
    await act(async () => void fireEvent.click(screen.getByRole('option', { name: 'Flexoki' })))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]?.general.lightThemeId).toBe('flexoki')
    expect(saved[0]?.general.darkThemeId).toBe('midnight')
  })

  it('深色主题那一格同理', async () => {
    render(<ThemeSettings />)
    await waitFor(() => expect(themeSettingsQuery.get().data).toBeTruthy())
    await pick('theme-dark-row', 'Flexoki')
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]?.general.darkThemeId).toBe('flexoki')
  })

  it('**当前 id 不在这一档的名册上**(主题卸载了 / 指着另一档)→ 它补在末尾,选得中', async () => {
    installPort({
      readSettings: async () => ({ success: true, settings: settings({ lightThemeId: 'gone' }) }),
    })
    render(<ThemeSettings />)
    await waitFor(() => expect(themeSettingsQuery.get().data).toBeTruthy())

    const trigger = within(screen.getByTestId('theme-light-row')).getByRole('combobox')
    // 触发器上显示的就是那一项 —— 一格空白的选择器会说「你没选过主题」,那是假话。
    expect(trigger.textContent).toContain('gone')
    await act(async () => void fireEvent.click(trigger))
    expect(screen.getAllByRole('option').map((el) => el.textContent)).toEqual([
      'Flexoki',
      'Daylight',
      'gone',
    ])
  })

  it('读失败:错话与旧值**并陈**,三行不抹掉', async () => {
    render(<ThemeSettings />)
    await waitFor(() => expect(themeSettingsQuery.get().data).toBeTruthy())
    installPort({ readSettings: async () => ({ success: false, error: '后端说不行' }) })
    await act(async () => void (await themeSettingsQuery.refetch()))

    expect(screen.getByText(/后端说不行/)).toBeTruthy()
    expect(screen.getByTestId('theme-mode-row')).toBeTruthy()
    expect(
      within(screen.getByTestId('theme-light-row')).getByRole('combobox').textContent,
    ).toContain('Daylight')
  })
})
