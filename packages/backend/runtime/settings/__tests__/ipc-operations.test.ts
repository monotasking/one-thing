import { describe, expect, it, vi } from 'vitest'
import {
  getOnethingSettingsForIpc,
  getOnethingSystemThemeForIpc,
  saveOnethingSettingsWithRuntimeEffectsForIpc,
} from '../ipc-operations.js'
import { preserveOnethingRegistryOwnedProviderFields } from '../settings-save.js'

interface TestSettings {
  network?: {
    proxy?: { host: string }
  }
  mcp?: { enabled: boolean; servers: string[] }
  acp?: { enabled: boolean; agents: string[] }
}

describe('settings IPC operations', () => {
  it('returns renderer-facing settings from the settings adapter', async () => {
    await expect(getOnethingSettingsForIpc({
      getSettings: () => ({ network: { proxy: { host: '127.0.0.1' } } }),
    })).resolves.toEqual({
      success: true,
      settings: { network: { proxy: { host: '127.0.0.1' } } },
    })
  })

  it('normalizes settings read adapter failures for IPC callers', async () => {
    const logger = { error: vi.fn() }

    await expect(getOnethingSettingsForIpc({
      getSettings: () => {
        throw new Error('read failed')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'read failed',
    })

    expect(logger.error).toHaveBeenCalled()
  })

  it('saves settings with runtime effects and returns normalized settings', async () => {
    const normalizedSettings: TestSettings = {
      network: { proxy: { host: '127.0.0.1' } },
      mcp: { enabled: true, servers: ['mcp-1'] },
      acp: { enabled: true, agents: ['agent-1'] },
    }
    const saveSettings = vi.fn()

    await expect(saveOnethingSettingsWithRuntimeEffectsForIpc<TestSettings, Partial<TestSettings>>({
      settings: { network: {} },
      saveSettings,
      getSettings: () => normalizedSettings,
      invalidateProviderCache: vi.fn(),
      applyNetworkProxySettings: vi.fn(),
      registerGlobalWindowShortcuts: vi.fn(),
      updateMCPSettings: vi.fn(),
      registerMCPTools: vi.fn(),
      updateACPSettings: vi.fn(),
      defaultMCPSettings: { enabled: true, servers: [] },
      defaultACPSettings: { enabled: true, agents: [] },
    })).resolves.toEqual({
      success: true,
      settings: normalizedSettings,
    })
    expect(saveSettings).toHaveBeenCalledWith({ network: {} })
  })

  it('normalizes settings save failures for IPC callers', async () => {
    const logger = { error: vi.fn() }

    await expect(saveOnethingSettingsWithRuntimeEffectsForIpc<TestSettings, Partial<TestSettings>>({
      settings: {},
      saveSettings: () => {
        throw new Error('save failed')
      },
      getSettings: () => ({}),
      invalidateProviderCache: vi.fn(),
      applyNetworkProxySettings: vi.fn(),
      registerGlobalWindowShortcuts: vi.fn(),
      updateMCPSettings: vi.fn(),
      registerMCPTools: vi.fn(),
      updateACPSettings: vi.fn(),
      defaultMCPSettings: { enabled: true, servers: [] },
      defaultACPSettings: { enabled: true, agents: [] },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'save failed',
    })

    expect(logger.error).toHaveBeenCalled()
  })

  it('keeps registry-owned provider models from current settings when saving a stale snapshot', async () => {
    const freshModels = { 'kimi-k3': { id: 'kimi-k3' } }
    const staleModels = { 'kimi-k2.6': { id: 'kimi-k2.6' } }
    const current = {
      network: {} as { proxy?: unknown },
      ai: {
        providers: {
          kimi: { apiKey: 'old-key', model: 'kimi-k2.6', models: freshModels, modelsLastFetched: 2000 },
        },
      },
    }
    const incoming = {
      ai: {
        providers: {
          kimi: { apiKey: 'new-key', model: 'kimi-k3', models: staleModels, modelsLastFetched: 1000 },
        },
      },
    }
    const saveSettings = vi.fn()

    await saveOnethingSettingsWithRuntimeEffectsForIpc({
      settings: incoming,
      saveSettings,
      getSettings: () => current,
      invalidateProviderCache: vi.fn(),
      applyNetworkProxySettings: vi.fn(),
      registerGlobalWindowShortcuts: vi.fn(),
      updateMCPSettings: vi.fn(),
      registerMCPTools: vi.fn(),
      updateACPSettings: vi.fn(),
      defaultMCPSettings: { enabled: true, servers: [] },
      defaultACPSettings: { enabled: true, agents: [] },
    })

    expect(saveSettings).toHaveBeenCalledWith({
      ai: {
        providers: {
          kimi: { apiKey: 'new-key', model: 'kimi-k3', models: freshModels, modelsLastFetched: 2000 },
        },
      },
    })
  })

  it('formats system theme for IPC callers', () => {
    expect(getOnethingSystemThemeForIpc(true)).toEqual({
      success: true,
      theme: 'dark',
    })
    expect(getOnethingSystemThemeForIpc(false)).toEqual({
      success: true,
      theme: 'light',
    })
  })
})

describe('preserveOnethingRegistryOwnedProviderFields', () => {
  it('returns the incoming object untouched when nothing needs preserving', () => {
    const incoming = { ai: { providers: { kimi: { model: 'kimi-k3' } } } }
    expect(preserveOnethingRegistryOwnedProviderFields(incoming, {})).toBe(incoming)
    expect(preserveOnethingRegistryOwnedProviderFields(incoming, {
      ai: { providers: { kimi: { model: 'kimi-k2.6' } } },
    })).toBe(incoming)
    expect(preserveOnethingRegistryOwnedProviderFields({ chat: {} }, {
      ai: { providers: { kimi: { models: {} } } },
    })).toEqual({ chat: {} })
  })

  it('keeps providers absent from the incoming snapshot absent', () => {
    const incoming = { ai: { providers: { openai: { model: 'gpt-4o' } } } }
    const current = { ai: { providers: { kimi: { models: { 'kimi-k3': {} } } } } }
    expect(preserveOnethingRegistryOwnedProviderFields(incoming, current)).toBe(incoming)
  })

  it('overlays models and modelsLastFetched per provider without touching other fields', () => {
    const incoming = {
      theme: 'dark',
      ai: {
        defaultProvider: 'kimi',
        providers: {
          kimi: { model: 'kimi-k3', models: {}, modelsLastFetched: 1 },
          deepseek: { model: 'deepseek-chat', models: {}, modelsLastFetched: 1 },
        },
      },
    }
    const kimiModels = { 'kimi-k3': {} }
    const current = {
      ai: {
        providers: {
          kimi: { model: 'kimi-k2.6', models: kimiModels, modelsLastFetched: 9 },
          deepseek: { model: 'deepseek-chat', models: {}, modelsLastFetched: 5 },
        },
      },
    }

    const result = preserveOnethingRegistryOwnedProviderFields(incoming, current)
    expect(result).toEqual({
      theme: 'dark',
      ai: {
        defaultProvider: 'kimi',
        providers: {
          kimi: { model: 'kimi-k3', models: kimiModels, modelsLastFetched: 9 },
          deepseek: { model: 'deepseek-chat', models: {}, modelsLastFetched: 5 },
        },
      },
    })
  })
})
