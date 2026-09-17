import { describe, expect, it, vi } from 'vitest'
import { saveOnethingSettingsWithRuntimeEffects } from '../settings-save.js'

interface TestSettings {
  network?: {
    proxy?: { host: string }
  }
  mcp?: { enabled: boolean; servers: string[] }
  acp?: { enabled: boolean; agents: string[] }
  voice?: { enabled: boolean }
}

describe('saveOnethingSettingsWithRuntimeEffects', () => {
  it('rejects malformed reasoning configuration before persistence and runtime effects', async () => {
    const persist = vi.fn()
    const invalidate = vi.fn()
    await expect(saveOnethingSettingsWithRuntimeEffects({
      settings: { ai: { providers: { grok: { providerOptions: { reasoningProfile: { wire: 'custom' } } } } } },
      saveSettings: persist,
      getSettings: () => ({}),
      invalidateProviderCache: invalidate,
      applyNetworkProxySettings: vi.fn(),
      registerGlobalWindowShortcuts: vi.fn(),
      updateMCPSettings: vi.fn(),
      registerMCPTools: vi.fn(),
      updateACPSettings: vi.fn(),
      defaultMCPSettings: {},
      defaultACPSettings: {},
    })).rejects.toThrow('Invalid reasoning profile at grok.providerOptions.reasoningProfile')
    expect(persist).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('saves input settings, reads normalized settings, applies runtime effects, and returns normalized settings', async () => {
    const calls: string[] = []
    const normalizedSettings: TestSettings = {
      network: { proxy: { host: '127.0.0.1' } },
      mcp: { enabled: true, servers: ['mcp-1'] },
      acp: { enabled: true, agents: ['agent-1'] },
      voice: { enabled: true },
    }

    const result = await saveOnethingSettingsWithRuntimeEffects({
      settings: { voice: { enabled: false } } satisfies TestSettings,
      saveSettings: settings => {
        calls.push(`save:${settings.voice?.enabled}`)
      },
      getSettings: () => {
        calls.push('get')
        return normalizedSettings
      },
      invalidateProviderCache: () => {
        calls.push('provider')
      },
      applyNetworkProxySettings: proxy => {
        calls.push(`network:${proxy?.host}`)
      },
      registerGlobalWindowShortcuts: () => {
        calls.push('shortcuts')
      },
      applyVoiceSettings: settings => {
        calls.push(`voice:${settings.voice?.enabled}`)
      },
      updateMCPSettings: settings => {
        calls.push(`mcp:${settings.servers.join(',')}`)
      },
      registerMCPTools: () => {
        calls.push('mcp-tools')
      },
      updateACPSettings: settings => {
        calls.push(`acp:${settings.agents.join(',')}`)
      },
      defaultMCPSettings: { enabled: true, servers: [] },
      defaultACPSettings: { enabled: true, agents: [] },
    })

    expect(result).toEqual({
      success: true,
      settings: normalizedSettings,
    })
    expect(calls).toEqual([
      // First 'get' feeds the registry-owned-field merge before persisting.
      'get',
      'save:false',
      'get',
      'provider',
      'network:127.0.0.1',
      'shortcuts',
      'voice:true',
      'mcp:mcp-1',
      'mcp-tools',
      'acp:agent-1',
    ])
  })

  it('uses default MCP and ACP settings when normalized settings omit them', async () => {
    const updateMCPSettings = vi.fn()
    const updateACPSettings = vi.fn()

    await saveOnethingSettingsWithRuntimeEffects<TestSettings, TestSettings>({
      settings: {},
      saveSettings: vi.fn(),
      getSettings: () => ({}),
      invalidateProviderCache: vi.fn(),
      applyNetworkProxySettings: vi.fn(),
      registerGlobalWindowShortcuts: vi.fn(),
      updateMCPSettings,
      registerMCPTools: vi.fn(),
      updateACPSettings,
      defaultMCPSettings: { enabled: true, servers: [] },
      defaultACPSettings: { enabled: true, agents: [] },
    })

    expect(updateMCPSettings).toHaveBeenCalledWith({ enabled: true, servers: [] })
    expect(updateACPSettings).toHaveBeenCalledWith({ enabled: true, agents: [] })
  })
})
