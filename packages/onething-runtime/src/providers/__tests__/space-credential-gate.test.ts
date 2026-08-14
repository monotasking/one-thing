import { describe, expect, it, vi } from 'vitest'
import {
  getProviderApiKeyWithAdapters,
  resolveProviderAuthWithAdapters,
  type CoreProviderConfigLike,
} from '../provider-config.js'
import { getEffectiveOnethingProviderConfig } from '../provider-runtime.js'
import { createOnethingStreamProviderAdapter } from '../stream-provider-adapter.js'

/**
 * 严格隔离的**执行**面(批 B3):判定盖在 config 上,阻断发生在鉴权里。
 * 判定归 spaces/provider-credentials.ts 管(那里另有测试),这里只验一件事 ——
 * 盖了「未配置」标记的 config,任何一条路都拿不到钥匙。
 */

interface TestProvider extends CoreProviderConfigLike {
  apiKey?: string
}

const unavailable = {
  spaceCredential: {
    spaceId: 'work',
    unavailable: { reason: 'no-entry' as const, message: '当前空间「工作」未配置 DeepSeek 的凭证。' },
  },
}

describe('unavailable marker blocks every credential path', () => {
  it('resolveProviderAuthWithAdapters returns null before OAuth and before env fallback', async () => {
    const resolveApiKey = vi.fn(() => 'sk-should-never-be-used')
    const resolveOAuthAuth = vi.fn(async () => ({ kind: 'oauth' }))
    const auth = await resolveProviderAuthWithAdapters<TestProvider, { kind: string; apiKey?: string }>({
      providerId: 'deepseek',
      providerConfig: { ...unavailable },
      isOAuthProvider: () => true,
      resolveApiKey,
      resolveOAuthAuth,
    })
    expect(auth).toBeNull()
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(resolveOAuthAuth).not.toHaveBeenCalled()
  })

  it('getProviderApiKeyWithAdapters returns null too (the other credential door)', async () => {
    const resolveApiKey = vi.fn(() => 'sk-nope')
    const key = await getProviderApiKeyWithAdapters<TestProvider>({
      providerId: 'deepseek',
      providerConfig: { ...unavailable },
      isOAuthProvider: () => false,
      refreshOAuthToken: async () => ({ accessToken: 'nope' }),
      resolveApiKey,
    })
    expect(key).toBeNull()
    expect(resolveApiKey).not.toHaveBeenCalled()
  })

  it('an external-agent provider does NOT get a free pass through the gate', async () => {
    // 外部 agent 走自己的 CLI 登录,引擎侧凭证故意为空 —— 但那条豁免在
    // 隔离闸之后,否则一个空间没配的 provider 只要改个 id 就绕过去了。
    const auth = await resolveProviderAuthWithAdapters<TestProvider, { kind: string }>({
      providerId: 'acp',
      providerConfig: { ...unavailable },
      isOAuthProvider: () => false,
      resolveApiKey: () => null,
      resolveOAuthAuth: async () => null,
    })
    expect(auth).toBeNull()
  })

  it('leaves untouched configs alone (default space = unchanged behaviour)', async () => {
    const auth = await resolveProviderAuthWithAdapters<TestProvider, { kind: string; apiKey?: string }>({
      providerId: 'deepseek',
      providerConfig: { apiKey: 'sk-real' },
      isOAuthProvider: () => false,
      resolveApiKey: (_id, config) => config?.apiKey,
      resolveOAuthAuth: async () => null,
    })
    expect(auth).toEqual({ kind: 'api-key', apiKey: 'sk-real' })
  })
})

describe('injection point: getEffectiveOnethingProviderConfig', () => {
  const settings = {
    ai: {
      provider: 'deepseek',
      providers: { deepseek: { model: 'deepseek-chat', apiKey: 'sk-global' } as TestProvider },
    },
  }

  it('is the single seam both resolution chains share', () => {
    const applySpaceCredentials = vi.fn((_sessionId, _providerId, config) => ({
      ...(config ?? {}),
      apiKey: 'sk-space',
    }))
    const resolved = getEffectiveOnethingProviderConfig<TestProvider>(settings, 's1', {
      getSession: () => null,
      applySpaceCredentials,
    })
    expect(applySpaceCredentials).toHaveBeenCalledWith('s1', 'deepseek', expect.anything())
    expect(resolved.providerConfig?.apiKey).toBe('sk-space')
  })

  it('is optional — omitting it reproduces today\'s behaviour byte for byte', () => {
    const resolved = getEffectiveOnethingProviderConfig<TestProvider>(settings, 's1', {
      getSession: () => null,
    })
    expect(resolved.providerConfig?.apiKey).toBe('sk-global')
    expect(resolved.providerConfig?.spaceCredential).toBeUndefined()
  })
})

describe('describeMissingCredentials', () => {
  const adapter = createOnethingStreamProviderAdapter<TestProvider>({
    getSession: () => null,
    isProviderSupported: () => true,
    isOAuthProvider: () => false,
    resolveApiKey: () => null,
    resolveOAuthAuth: async () => null,
    generateTitle: async () => '',
  })

  it('surfaces the space-specific reason so the engine can say it out loud', () => {
    expect(adapter.describeMissingCredentials?.('deepseek', { ...unavailable }, 's1'))
      .toContain('当前空间')
  })

  it('says nothing when the config carries no marker (generic message wins)', () => {
    expect(adapter.describeMissingCredentials?.('deepseek', { apiKey: '' }, 's1')).toBeUndefined()
  })
})

describe('title generation gets the same scoping', () => {
  it('re-applies the injection on the config it resolved off settings itself', () => {
    const applySpaceCredentials = vi.fn((_s, _p, config) => ({ ...(config ?? {}), apiKey: 'sk-space' }))
    const adapter = createOnethingStreamProviderAdapter<TestProvider>({
      getSession: () => null,
      applySpaceCredentials,
      isProviderSupported: () => true,
      isOAuthProvider: () => false,
      resolveApiKey: () => null,
      resolveOAuthAuth: async () => null,
      generateTitle: async () => '',
    })
    expect(adapter.applySpaceCredentials?.('s1', 'deepseek', { apiKey: 'sk-global' }))
      .toEqual({ apiKey: 'sk-space' })
  })

  it('is identity when the host does not inject (default space)', () => {
    const bare = createOnethingStreamProviderAdapter<TestProvider>({
      getSession: () => null,
      isProviderSupported: () => true,
      isOAuthProvider: () => false,
      resolveApiKey: () => null,
      resolveOAuthAuth: async () => null,
      generateTitle: async () => '',
    })
    const config = { apiKey: 'sk-global' }
    expect(bare.applySpaceCredentials?.('s1', 'deepseek', config)).toBe(config)
  })
})
