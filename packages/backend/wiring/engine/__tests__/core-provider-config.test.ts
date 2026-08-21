import { describe, expect, it, vi } from 'vitest'
import {
  extractErrorDetails,
  formatProviderCredentialsError,
  getProviderApiKeyWithAdapters,
  getEffectiveProviderConfig,
  getProviderApiType,
  getProviderConfig,
  resolveProviderAuthWithAdapters,
  resolveProviderConfigForChat,
} from '@onething/runtime/providers/provider-config'

describe('onething runtime provider config helpers', () => {
  const settings = {
    ai: {
      provider: 'deepseek',
      temperature: 0.7,
      providers: {
        deepseek: {
          model: 'deepseek-chat',
          selectedModels: ['deepseek-chat'],
          apiKey: 'configured',
        },
        openai: {
          model: 'gpt-4.1',
          selectedModels: ['gpt-4.1'],
          baseUrl: 'https://api.openai.com/v1',
        },
        'custom-local': {
          model: 'claude-compatible',
          selectedModels: ['claude-compatible'],
        },
      },
      customProviders: [{
        id: 'custom-local',
        name: 'Local',
        apiType: 'anthropic' as const,
        model: 'claude-compatible',
        selectedModels: ['claude-compatible'],
      }],
    },
  }

  it('selects global and session-level provider configs without store access', () => {
    expect(getProviderConfig(settings)).toMatchObject({
      model: 'deepseek-chat',
    })

    expect(getEffectiveProviderConfig(settings, {
      lastProvider: 'openai',
      lastModel: 'gpt-4.1-mini',
    })).toEqual({
      providerId: 'openai',
      model: 'gpt-4.1-mini',
      providerConfig: {
        model: 'gpt-4.1-mini',
        selectedModels: ['gpt-4.1'],
        baseUrl: 'https://api.openai.com/v1',
      },
    })

    expect(getEffectiveProviderConfig(settings, {
      lastProvider: 'missing',
      lastModel: 'ignored',
    })).toMatchObject({
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })
  })

  it('mirrors the renderer resolver on partial session selections', () => {
    // Rule shared with src/renderer/stores/helpers/provider-model.ts: a
    // session provider without a model uses that provider's configured
    // default; a model without a provider is ignored (no inference). Any
    // divergence between the two resolvers shows one provider in the picker
    // while requests go to another.
    expect(getEffectiveProviderConfig(settings, {
      lastProvider: 'openai',
    })).toMatchObject({
      providerId: 'openai',
      model: 'gpt-4.1',
    })

    expect(getEffectiveProviderConfig(settings, {
      lastModel: 'gpt-4.1',
    })).toMatchObject({
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })
  })

  it('lets an explicit override win outright over session and global', () => {
    // The send path (packages/core/engine/core-stream-engine.ts resolveProvider)
    // passes the renderer's already-resolved selection here as `override` —
    // when it's present and points at a configured provider, it's returned
    // directly with no re-derivation, so there is no second independent
    // computation of "what should this session use" to diverge from what
    // the picker showed.
    expect(getEffectiveProviderConfig(settings, {
      lastProvider: 'deepseek',
      lastModel: 'deepseek-chat',
    }, {
      providerId: 'openai',
      model: 'gpt-4.1',
    })).toEqual({
      providerId: 'openai',
      model: 'gpt-4.1',
      providerConfig: {
        model: 'gpt-4.1',
        selectedModels: ['gpt-4.1'],
        baseUrl: 'https://api.openai.com/v1',
      },
    })
  })

  it('falls back to the provider default model when the override omits a model', () => {
    expect(getEffectiveProviderConfig(settings, null, {
      providerId: 'openai',
    })).toMatchObject({
      providerId: 'openai',
      model: 'gpt-4.1',
    })
  })

  it('ignores an override pointing at an unconfigured provider and falls back to session/global', () => {
    // A dangling override (e.g. the provider's config was deleted after the
    // picker rendered) must not be trusted — same invariant as a stale
    // session.lastProvider.
    expect(getEffectiveProviderConfig(settings, {
      lastProvider: 'openai',
      lastModel: 'gpt-4.1-mini',
    }, {
      providerId: 'missing',
      model: 'whatever',
    })).toMatchObject({
      providerId: 'openai',
      model: 'gpt-4.1-mini',
    })

    expect(getEffectiveProviderConfig(settings, null, {
      providerId: 'missing',
    })).toMatchObject({
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })
  })

  it('resolves custom provider API type from settings only', () => {
    expect(getProviderApiType(settings, 'custom-local')).toBe('anthropic')
    expect(getProviderApiType(settings, 'deepseek')).toBeUndefined()
  })

  it('formats provider credential errors without provider registry access', () => {
    expect(formatProviderCredentialsError('codex', true)).toBe('Not logged in to codex. Please login in settings.')
    expect(formatProviderCredentialsError('deepseek', false)).toBe('API Key not configured. Please configure your AI settings.')
  })

  it('resolves provider API keys through injected OAuth and environment adapters', async () => {
    await expect(getProviderApiKeyWithAdapters({
      providerId: 'acp',
      providerConfig: undefined,
      isOAuthProvider: () => false,
      refreshOAuthToken: vi.fn(),
      resolveApiKey: vi.fn(),
    })).resolves.toBe('')

    await expect(getProviderApiKeyWithAdapters({
      providerId: 'codex',
      providerConfig: undefined,
      isOAuthProvider: id => id === 'codex',
      refreshOAuthToken: vi.fn(async () => ({ accessToken: 'oauth-token' })),
      resolveApiKey: vi.fn(),
    })).resolves.toBe('oauth-token')

    const logger = { error: vi.fn() }
    await expect(getProviderApiKeyWithAdapters({
      providerId: 'codex',
      providerConfig: undefined,
      isOAuthProvider: () => true,
      refreshOAuthToken: vi.fn(async () => {
        throw new Error('expired')
      }),
      resolveApiKey: vi.fn(),
      logger,
    })).resolves.toBeNull()
    expect(logger.error).toHaveBeenCalled()

    await expect(getProviderApiKeyWithAdapters({
      providerId: 'deepseek',
      providerConfig: { model: 'deepseek-chat' },
      isOAuthProvider: () => false,
      refreshOAuthToken: vi.fn(),
      resolveApiKey: vi.fn(() => 'env-key'),
    })).resolves.toBe('env-key')
  })

  it('resolves provider auth context through injected adapters', async () => {
    await expect(resolveProviderAuthWithAdapters({
      providerId: 'acp',
      providerConfig: undefined,
      isOAuthProvider: () => false,
      resolveApiKey: vi.fn(),
      resolveOAuthAuth: vi.fn(),
    })).resolves.toEqual({ kind: 'api-key', apiKey: '' })

    await expect(resolveProviderAuthWithAdapters({
      providerId: 'codex',
      providerConfig: { model: 'codex' },
      isOAuthProvider: id => id === 'codex',
      resolveApiKey: vi.fn(() => 'fallback-key'),
      resolveOAuthAuth: vi.fn(async (_id, apiKey) => ({ kind: 'oauth', apiKey })),
    })).resolves.toEqual({ kind: 'oauth', apiKey: 'fallback-key' })

    await expect(resolveProviderAuthWithAdapters({
      providerId: 'deepseek',
      providerConfig: { model: 'deepseek-chat' },
      isOAuthProvider: () => false,
      resolveApiKey: vi.fn(() => 'manual-key'),
      resolveOAuthAuth: vi.fn(),
    })).resolves.toEqual({ kind: 'api-key', apiKey: 'manual-key' })

    await expect(resolveProviderAuthWithAdapters({
      providerId: 'deepseek',
      providerConfig: { model: 'deepseek-chat' },
      isOAuthProvider: () => false,
      resolveApiKey: vi.fn(() => null),
      resolveOAuthAuth: vi.fn(),
    })).resolves.toBeNull()
  })

  it('resolves chat provider config with injected auth and session fallback', async () => {
    await expect(resolveProviderConfigForChat({
      settings,
      session: {
        lastProvider: 'openai',
        lastModel: 'gpt-4.1-mini',
      },
      resolveAuth: async (providerId) => ({ kind: 'api-key', apiKey: `${providerId}-key` }),
    })).resolves.toMatchObject({
      providerId: 'openai',
      model: 'gpt-4.1-mini',
      apiKey: 'openai-key',
      baseUrl: 'https://api.openai.com/v1',
      temperature: 0.7,
    })

    await expect(resolveProviderConfigForChat({
      settings,
      session: {
        lastProvider: 'openai',
        lastModel: 'gpt-4.1-mini',
      },
      resolveAuth: async (providerId) => providerId === 'openai'
        ? null
        : { kind: 'api-key', apiKey: `${providerId}-key` },
    })).resolves.toMatchObject({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'deepseek-key',
      temperature: 0.7,
    })
  })

  it('extracts compact provider error details without leaking request snapshots', () => {
    expect(extractErrorDetails({
      responseBody: JSON.stringify({ error: { message: 'invalid key', type: 'auth', code: '401' } }),
    })).toBe('invalid key')

    expect(extractErrorDetails({
      responseBody: JSON.stringify({ error: { code: '1000', message: '身份验证失败。' } }),
    })).toContain('普通 API Key 请使用 Standard 模式')

    expect(extractErrorDetails({
      data: {
        statusCode: 429,
        requestBodyValues: { apiKey: 'secret' },
      },
    })).toBe('Provider API request failed (429)')

    expect(extractErrorDetails({
      cause: {
        data: {
          error: {
            message: 'nested fail',
            type: 'bad_request',
            code: 'x',
          },
        },
      },
    })).toBe('nested fail (type: bad_request) (code: x)')
  })
})
