// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createDefaultSettings } from '@shared/defaults/settings'
import type { AppSettings } from '@shared/ipc'

let systemThemeListener: ((theme: 'light' | 'dark') => void) | null = null

type SettingsPatch = Partial<Omit<AppSettings, 'general'>> & {
  general?: Partial<AppSettings['general']>
}

function makeSettings(patch: SettingsPatch = {}): AppSettings {
  const defaults = createDefaultSettings()
  return {
    ...defaults,
    ...patch,
    general: {
      ...defaults.general,
      ...patch.general,
    },
  }
}

async function settle() {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  await Promise.resolve()
}

function installElectronAPI(systemTheme: 'light' | 'dark' = 'dark') {
  const electronAPI = {
    onSystemThemeChanged: vi.fn((callback: (theme: 'light' | 'dark') => void) => {
      systemThemeListener = callback
      return () => {
        systemThemeListener = null
      }
    }),
    getSystemTheme: vi.fn().mockResolvedValue({ success: true, theme: systemTheme }),
    // P4c 第七批:主题走通用 RPC 通道。这个替身仍然只暴露一个 `applyTheme` 间谍
    // (断言逐字不变),它由本壳的 `rpcInvoke` 在 `themes.apply` 上转调 ——
    // 与真桌面上那条路径同形。
    applyTheme: vi.fn((themeId: string, mode: 'light' | 'dark') => Promise.resolve({
      success: true,
      cssVariables: {
        '--applied-theme': `${themeId}:${mode}`,
      },
    })),
    rpcInvoke: vi.fn(async (request: { domain: string; method: string; payload?: unknown }) => {
      if (request.domain === 'themes' && request.method === 'apply') {
        const payload = request.payload as { themeId: string; mode: 'light' | 'dark' }
        return { ok: true, data: await electronAPI.applyTheme(payload.themeId, payload.mode) }
      }
      return { ok: true, data: { success: true } }
    }),
    saveSettings: vi.fn().mockResolvedValue({ success: true }),
  }

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: electronAPI,
  })

  return electronAPI
}

function installLocalStorage() {
  const values = new Map<string, string>()
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, String(value))
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key)
    }),
    clear: vi.fn(() => {
      values.clear()
    }),
  }

  vi.stubGlobal('localStorage', storage)
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  })

  return storage
}

async function loadStores() {
  const settingsModule = await import('../settings')
  const themesModule = await import('../themes')
  return {
    useSettingsStore: settingsModule.useSettingsStore,
    useThemeStore: themesModule.useThemeStore,
  }
}

describe('appearance synchronization', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    systemThemeListener = null
    setActivePinia(createPinia())
    installLocalStorage()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-color-theme')
    document.documentElement.removeAttribute('data-base-theme')
    document.documentElement.removeAttribute('data-typography-density')
    document.documentElement.style.cssText = ''
  })

  it('resolves system mode through the main-process system theme before applying JSON theme variables', async () => {
    const electronAPI = installElectronAPI('light')
    const { useSettingsStore, useThemeStore } = await loadStores()
    const settingsStore = useSettingsStore()

    await settingsStore.applyAppearanceFromSettings(makeSettings({
      theme: 'system',
      general: {
        darkThemeId: 'one-dark',
        lightThemeId: 'github-light',
      },
    }), {
      refreshSystemTheme: true,
    })

    const themeStore = useThemeStore()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.getAttribute('data-typography-density')).toBe('compact')
    expect(themeStore.darkThemeId).toBe('one-dark')
    expect(themeStore.lightThemeId).toBe('github-light')
    expect(electronAPI.getSystemTheme).toHaveBeenCalledTimes(1)
    expect(electronAPI.applyTheme).toHaveBeenLastCalledWith('github-light', 'light')
    expect(document.documentElement.style.getPropertyValue('--applied-theme')).toBe('github-light:light')
  })

  it('re-applies the matching mode theme when Electron reports a system theme change', async () => {
    const electronAPI = installElectronAPI('dark')
    const { useSettingsStore } = await loadStores()
    const settingsStore = useSettingsStore()

    await settingsStore.applyAppearanceFromSettings(makeSettings({
      theme: 'system',
      general: {
        darkThemeId: 'one-dark',
        lightThemeId: 'github-light',
      },
    }), {
      refreshSystemTheme: true,
    })
    vi.mocked(electronAPI.applyTheme).mockClear()

    systemThemeListener?.('light')
    await settle()

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(electronAPI.applyTheme).toHaveBeenLastCalledWith('github-light', 'light')
    expect(document.documentElement.style.getPropertyValue('--applied-theme')).toBe('github-light:light')
  })

  it('treats dark/light theme id changes as appearance changes when saving settings', async () => {
    const electronAPI = installElectronAPI('dark')
    const { useSettingsStore } = await loadStores()
    const settingsStore = useSettingsStore()

    await settingsStore.applyAppearanceFromSettings(makeSettings({
      theme: 'dark',
      general: {
        darkThemeId: 'one-dark',
        lightThemeId: 'github-light',
      },
    }))
    vi.mocked(electronAPI.applyTheme).mockClear()

    await settingsStore.saveSettings(makeSettings({
      theme: 'dark',
      general: {
        darkThemeId: 'github-dark',
        lightThemeId: 'github-light',
      },
    }))

    expect(electronAPI.saveSettings).toHaveBeenCalledTimes(1)
    expect(electronAPI.applyTheme).toHaveBeenLastCalledWith('github-dark', 'dark')
    expect(document.documentElement.style.getPropertyValue('--applied-theme')).toBe('github-dark:dark')
  })

  it('applies typography density to the root element', async () => {
    const { useSettingsStore } = await loadStores()
    const settingsStore = useSettingsStore()

    await settingsStore.applyAppearanceFromSettings(makeSettings({
      general: {
        typographyDensity: 'comfortable',
      },
    }))

    expect(document.documentElement.getAttribute('data-typography-density')).toBe('comfortable')

    settingsStore.updateTypographyDensity('compact')

    expect(document.documentElement.getAttribute('data-typography-density')).toBe('compact')
  })

  it('re-applies appearance when saving typography density changes', async () => {
    const electronAPI = installElectronAPI('dark')
    const { useSettingsStore } = await loadStores()
    const settingsStore = useSettingsStore()

    await settingsStore.applyAppearanceFromSettings(makeSettings({
      general: {
        typographyDensity: 'compact',
      },
    }))
    vi.mocked(electronAPI.applyTheme).mockClear()

    await settingsStore.saveSettings(makeSettings({
      general: {
        typographyDensity: 'comfortable',
      },
    }))

    expect(document.documentElement.getAttribute('data-typography-density')).toBe('comfortable')
    expect(electronAPI.applyTheme).toHaveBeenCalledTimes(1)
  })

  it('uses normalized settings returned from saveSettings', async () => {
    const electronAPI = installElectronAPI('dark')
    const { useSettingsStore } = await loadStores()
    const settingsStore = useSettingsStore()
    const submitted = makeSettings()
    submitted.chat!.agentLoopStream = false
    const normalized = makeSettings()
    normalized.chat!.agentLoopStream = true

    vi.mocked(electronAPI.saveSettings).mockResolvedValueOnce({
      success: true,
      settings: normalized,
    })

    await settingsStore.saveSettings(submitted)

    expect(settingsStore.settings.chat?.agentLoopStream).toBe(true)
  })
})
