// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

describe('settings store', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    })
  })

  it('creates a placeholder provider config when updating a model for an unknown provider', async () => {
    const { useSettingsStore } = await import('../settings')
    const settingsStore = useSettingsStore()

    expect(() => {
      settingsStore.updateAIProvider('local')
      settingsStore.updateModel('local-echo', 'local')
    }).not.toThrow()

    expect(settingsStore.settings.ai.providers.local).toEqual(expect.objectContaining({
      apiKey: '',
      baseUrl: '',
      model: 'local-echo',
      selectedModels: [],
    }))
  })

  it('saveAIProviderDefault persists the new global default via saveSettings (not just an in-memory mutation)', async () => {
    const saveSettings = vi.fn((settings: unknown) =>
      Promise.resolve({ success: true, settings }),
    )
    // P4c 第十一批:`saveSettings` 走通用 RPC 通道。间谍保留,断言逐字不变。
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onSystemThemeChanged: vi.fn(() => () => {}),
        rpcInvoke: vi.fn(async (request: { domain: string; method: string; payload?: unknown }) => {
          if (request.domain === 'settings' && request.method === 'saveSettings') {
            return { ok: true, data: await saveSettings(request.payload) }
          }
          if (request.domain === 'settings' && request.method === 'getSystemTheme') {
            return { ok: true, data: { success: true, theme: 'light' } }
          }
          return { ok: true, data: { success: true } }
        }),
      },
    })

    const { useSettingsStore } = await import('../settings')
    const settingsStore = useSettingsStore()

    await settingsStore.saveAIProviderDefault('local', 'local-echo')

    expect(saveSettings).toHaveBeenCalledTimes(1)
    const [savedSettings] = saveSettings.mock.calls[0] as [
      { ai: { provider: string; providers: Record<string, { model: string }> } },
    ]
    expect(savedSettings.ai.provider).toBe('local')
    expect(savedSettings.ai.providers.local.model).toBe('local-echo')
    expect(settingsStore.settings.ai.provider).toBe('local')
    expect(settingsStore.settings.ai.providers.local.model).toBe('local-echo')
  })

  it('re-pulls a provider\'s catalog after a save that moved its models.dev key (Kimi 计费方式)', async () => {
    const saveSettings = vi.fn((settings: unknown) =>
      Promise.resolve({ success: true, settings }),
    )
    const rpcInvoke = vi.fn(async (request: { domain: string; method: string; payload: unknown }) => {
      if (request.method === 'refreshRegistry') return { ok: true, data: { success: true } }
      if (request.method === 'getWithCapabilities') return { ok: true, data: { success: true, models: [] } }
      if (request.domain === 'settings' && request.method === 'saveSettings') {
        return { ok: true, data: await saveSettings(request.payload) }
      }
      if (request.domain === 'settings' && request.method === 'getSystemTheme') {
        return { ok: true, data: { success: true, theme: 'light' } }
      }
      return { ok: true, data: { success: true } }
    })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        rpcInvoke,
        onSystemThemeChanged: vi.fn(() => () => {}),
      },
    })

    const { useSettingsStore } = await import('../settings')
    const settingsStore = useSettingsStore()
    settingsStore.settings.ai.providers.kimi = {
      ...settingsStore.settings.ai.providers.kimi,
      kimiApiMode: 'standard',
      kimiRegion: 'cn',
    }

    // 按量 → 编程套餐 is a different models.dev book (moonshotai-cn → kimi-for-coding).
    const next = JSON.parse(JSON.stringify(settingsStore.settings))
    next.ai.providers.kimi.kimiApiMode = 'coding-plan'
    // Unrelated edit on a provider whose key does not depend on config: no re-pull.
    next.ai.providers.deepseek = { ...next.ai.providers.deepseek, apiKey: 'sk-x' }
    await settingsStore.saveSettings(next)
    await new Promise(resolve => setTimeout(resolve, 0))

    const refreshCalls = rpcInvoke.mock.calls
      .map(([request]) => request)
      .filter(request => request.domain === 'models' && request.method === 'refreshRegistry')
    expect(refreshCalls).toEqual([
      expect.objectContaining({ payload: { providerId: 'kimi' } }),
    ])

    // Same mode saved again: nothing moved, nothing re-pulled.
    rpcInvoke.mockClear()
    await settingsStore.saveSettings(JSON.parse(JSON.stringify(settingsStore.settings)))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(rpcInvoke.mock.calls.some(([request]) => request.method === 'refreshRegistry')).toBe(false)
  })
})
