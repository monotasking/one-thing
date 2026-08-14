// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createDefaultSettings } from '@shared/defaults/settings'
import type { AppSettings } from '@shared/ipc'

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...createDefaultSettings(), ...overrides }
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

function installElectronAPI() {
  const api = {
    getSettings: vi.fn().mockResolvedValue({ success: true, settings: null as AppSettings | null }),
    // providers / models 走通用 RPC 通道(主线 T1 第二批):打的是那一条通道,
    // 再按 domain.method 分发 —— 与生产链路同形。
    rpcInvoke: vi.fn(async (request: { domain: string; method: string }) => {
      if (request.domain === 'providers' && request.method === 'list') {
        return { ok: true, data: { success: true, providers: [] } }
      }
      if (request.domain === 'models' && request.method === 'getNameAliases') {
        return { ok: true, data: { success: true, aliases: {} } }
      }
      return { ok: false, error: { message: `unstubbed RPC ${request.domain}.${request.method}` } }
    }),
    saveSettings: vi.fn().mockImplementation((s: AppSettings) =>
      Promise.resolve({ success: true, settings: s }),
    ),
    getSystemTheme: vi.fn().mockResolvedValue({ success: true, theme: 'dark' }),
    onSystemThemeChanged: vi.fn(),
    applyTheme: vi.fn().mockResolvedValue({ success: true, cssVariables: {} }),
  }

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: api,
  })

  return api
}

async function loadStore() {
  const mod = await import('../settings')
  return mod.useSettingsStore
}

describe('chat font cache', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    setActivePinia(createPinia())
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-color-theme')
    document.documentElement.removeAttribute('data-base-theme')
  })

  it('writes cached-chat-fonts to localStorage after loadSettings', async () => {
    const storage = installLocalStorage()
    const electronAPI = installElectronAPI()

    electronAPI.getSettings.mockResolvedValue({
      success: true,
      settings: makeSettings({
        chat: { chatFontEn: 'lora', chatFontZh: 'lxgw-wenkai', temperature: 0.7, maxTokens: 4096 },
      }),
    })

    const useSettingsStore = await loadStore()
    const store = useSettingsStore()
    await store.loadSettings()

    expect(storage.setItem).toHaveBeenCalledWith(
      'cached-chat-fonts',
      JSON.stringify({ en: 'lora', zh: 'lxgw-wenkai' }),
    )
  })

  it('writes null values when no chat fonts are configured', async () => {
    const storage = installLocalStorage()
    const electronAPI = installElectronAPI()

    electronAPI.getSettings.mockResolvedValue({
      success: true,
      settings: makeSettings({ chat: { temperature: 0.7, maxTokens: 4096 } }),
    })

    const useSettingsStore = await loadStore()
    const store = useSettingsStore()
    await store.loadSettings()

    expect(storage.setItem).toHaveBeenCalledWith(
      'cached-chat-fonts',
      JSON.stringify({ en: null, zh: null }),
    )
  })

  it('writes cached-chat-fonts to localStorage after saveSettings', async () => {
    const storage = installLocalStorage()
    const electronAPI = installElectronAPI()

    electronAPI.getSettings.mockResolvedValue({
      success: true,
      settings: makeSettings(),
    })

    const useSettingsStore = await loadStore()
    const store = useSettingsStore()
    await store.loadSettings()

    // Clear the setItem call count from loadSettings
    storage.setItem.mockClear()

    await store.saveSettings(makeSettings({
      chat: { chatFontEn: 'georgia', chatFontZh: 'lxgw-wenkai-screen', temperature: 0.7, maxTokens: 4096 },
    }))

    expect(storage.setItem).toHaveBeenCalledWith(
      'cached-chat-fonts',
      JSON.stringify({ en: 'georgia', zh: 'lxgw-wenkai-screen' }),
    )
  })

  it('survives localStorage errors gracefully', async () => {
    const electronAPI = installElectronAPI()

    // Install working localStorage first (needed for module init / getInitialTheme)
    installLocalStorage()

    // Now break setItem to simulate quota exceeded during cache write
    const origSetItem = localStorage.setItem
    localStorage.setItem = vi.fn((key: string, _value: string) => {
      if (key === 'cached-chat-fonts') {
        throw new Error('quota exceeded')
      }
      return origSetItem(key, _value)
    })

    electronAPI.getSettings.mockResolvedValue({
      success: true,
      settings: makeSettings({ chat: { chatFontEn: 'lora', chatFontZh: 'noto-serif-sc', temperature: 0.7, maxTokens: 4096 } }),
    })

    const useSettingsStore = await loadStore()
    const store = useSettingsStore()

    // Should not throw
    await expect(store.loadSettings()).resolves.toBeUndefined()
  })
})
