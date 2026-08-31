import { vi } from 'vitest'
import type { ProviderSettingsPort } from '../../data/provider-settings-port'

/**
 * 假端口的**缺省那一半**。
 *
 * 批二把端口从 7 口长到 15 口,而用例真正关心的从来只有其中一两口 ——
 * 每个测试文件各抄一份 15 口的桩,下次加口就是每个文件各改一遍。所以这里放
 * 「不关心的那些口该怎么答」,用例只写它要断言的那一口。
 *
 * 缺省的答法有一条纪律:**答「没有」,不答「坏了」**。未登录、没有用量、
 * 池子是空的 —— 这些都是真机上最常见的答案,拿它们当缺省,用例才不必为了
 * 测别的事先按住一个错误。真要测失败路径的用例自己传一个失败的桩进来。
 */
export function fakeProviderPort(overrides: Partial<ProviderSettingsPort> = {}): ProviderSettingsPort {
  return {
    ready: async () => undefined,
    listProviders: vi.fn(async () => ({ success: true, providers: [] })),
    listModels: vi.fn(async () => ({ success: true, models: [] })),
    readSettings: vi.fn(async () => ({ success: false, error: 'not stubbed' })),
    saveSettings: vi.fn(async (next) => ({ success: true, settings: next })),
    // 「这个空间还是空的」是真机上最常见的答案 —— 与凭证池默认答空池同一手。
    readProviderSettings: vi.fn(async () => ({
      success: true,
      ai: { provider: '', providers: {}, customProviders: [] },
    })),
    writeProviderSettings: vi.fn(async (request) => ({ success: true, ai: request.ai })),
    readCredentials: vi.fn(async () => ({ success: true, credentials: { providers: {} } })),
    setCredential: vi.fn(async () => ({ success: true, credentials: { providers: {} } })),
    setCredentialPool: vi.fn(async () => ({ success: true, credentials: { providers: {} } })),
    clearCredential: vi.fn(async () => ({ success: true, credentials: { providers: {} } })),
    oauthStatus: vi.fn(async () => ({ success: true, isLoggedIn: false })),
    oauthStart: vi.fn(async () => ({ success: false, error: 'not stubbed' })),
    oauthDevicePoll: vi.fn(async () => ({ success: false, completed: false, error: 'not stubbed' })),
    oauthCallback: vi.fn(async () => ({ success: false, error: 'not stubbed' })),
    oauthLogout: vi.fn(async () => ({ success: true })),
    getProviderUsage: vi.fn(async (providerId: string) => ({
      success: true,
      providerId,
      unsupported: true,
    })),
    ...overrides,
  }
}
