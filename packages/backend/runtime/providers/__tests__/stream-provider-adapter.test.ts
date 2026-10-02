import { describe, expect, it, vi } from 'vitest'
import { createOnethingStreamProviderAdapter } from '../stream-provider-adapter.js'

interface TestProviderConfig {
  model?: string
  apiKey?: string
  baseUrl?: string
  temperature?: number
}

type TestAuth =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'oauth'; token: string }

const settings = {
  ai: {
    provider: 'deepseek',
    providers: {
      deepseek: {
        model: 'deepseek-chat',
        apiKey: 'deepseek-key',
      },
      codex: {
        model: 'codex-mini',
      },
      'custom-openai': {
        model: 'gpt-test',
      },
    } satisfies Record<string, TestProviderConfig>,
    customProviders: [
      {
        id: 'custom-openai',
        name: 'Custom OpenAI',
        apiType: 'openai' as const,
      },
    ],
  },
}

describe('createOnethingStreamProviderAdapter', () => {
  it('wraps onething provider resolution for stream engine runtimes', async () => {
    const resolveOAuthAuth = vi.fn(async () => ({ kind: 'oauth', token: 'codex-token' }) satisfies TestAuth)
    const generateTitle = vi.fn(async () => 'Gateway Title')

    const adapter = createOnethingStreamProviderAdapter<
      TestProviderConfig,
      typeof settings,
      TestAuth
    >({
      getSession: () => ({
        lastProvider: 'codex',
        lastModel: 'codex-max',
      }),
      isProviderSupported: providerId => providerId === 'deepseek' || providerId === 'codex',
      isOAuthProvider: providerId => providerId === 'codex',
      resolveApiKey: (_providerId, providerConfig) => providerConfig?.apiKey,
      resolveOAuthAuth,
      createApiKeyAuth: apiKey => ({ kind: 'api-key', apiKey }),
      generateTitle,
    })

    expect(adapter.getEffectiveConfig(settings, 'session-1')).toEqual({
      providerId: 'codex',
      model: 'codex-max',
      providerConfig: {
        model: 'codex-max',
      },
    })
    expect(adapter.getApiType(settings, 'custom-openai')).toBe('openai')
    expect(adapter.isSupported('codex')).toBe(true)
    expect(adapter.requiresOAuth('codex')).toBe(true)

    await expect(adapter.resolveAuth('deepseek', settings.ai.providers.deepseek)).resolves.toEqual({
      kind: 'api-key',
      apiKey: 'deepseek-key',
    })
    await expect(adapter.resolveAuth('codex', settings.ai.providers.codex)).resolves.toEqual({
      kind: 'oauth',
      token: 'codex-token',
    })
    // 末位是 per-space 凭证标记(批 B6):默认空间没有标记 = undefined。
    expect(resolveOAuthAuth).toHaveBeenCalledWith('codex', undefined, undefined)

    await expect(adapter.generateTitle('deepseek', settings.ai.providers.deepseek, 'hello', {
      debugPurpose: 'chat-title',
    })).resolves.toBe('Gateway Title')
    expect(generateTitle).toHaveBeenCalledWith('deepseek', settings.ai.providers.deepseek, 'hello', {
      debugPurpose: 'chat-title',
    })
  })
})
