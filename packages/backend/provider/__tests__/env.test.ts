import { describe, expect, it } from 'vitest'
import {
  getOnethingProviderApiKeyEnvCandidates,
  getOnethingProviderEnvStatus,
  resolveOnethingProviderApiKey,
  withResolvedOnethingProviderApiKey,
} from '../env.js'

describe('onething provider environment resolution', () => {
  it('prefers configured API keys over environment keys', () => {
    expect(resolveOnethingProviderApiKey('openai', { apiKey: ' manual ' }, {
      OPENAI_API_KEY: 'env-key',
    })).toBe('manual')
  })

  it('accepts pasted authorization header values as API keys', () => {
    expect(resolveOnethingProviderApiKey('zhipu', {
      apiKey: 'Bearer manual-key',
    })).toBe('manual-key')

    expect(resolveOnethingProviderApiKey('zhipu', { apiKey: '' }, {
      ZAI_API_KEY: 'Authorization: Bearer env-key',
    })).toBe('env-key')
  })

  it('detects provider default env vars and custom provider names', () => {
    expect(resolveOnethingProviderApiKey('claude', { apiKey: '' }, {
      ANTHROPIC_API_KEY: 'anthropic-env-key',
    })).toBe('anthropic-env-key')

    expect(getOnethingProviderApiKeyEnvCandidates('custom-my-provider')).toEqual([
      'MY_PROVIDER_API_KEY',
    ])
  })

  it('reports env status without exposing secret values', () => {
    const status = getOnethingProviderEnvStatus('zhipu', {
      ZAI_API_KEY: 'secret-value-1234',
    })

    expect(status).toMatchObject({
      providerId: 'zhipu',
      detectedEnvVar: 'ZAI_API_KEY',
      resolvedEnvVar: 'ZAI_API_KEY',
      keyPreview: 'secret••••1234',
    })
    expect(status.candidates).toContainEqual({ name: 'ZAI_API_KEY', isSet: true })
    expect(JSON.stringify(status)).not.toContain('secret-value-1234')
  })

  it('prefers the current ZAI_API_KEY name for Zhipu over legacy names', () => {
    expect(resolveOnethingProviderApiKey('zhipu', { apiKey: '' }, {
      ZAI_API_KEY: 'zai-env-key',
      ZHIPU_API_KEY: 'legacy-zhipu-key',
      ZHIPUAI_API_KEY: 'legacy-zhipuai-key',
    })).toBe('zai-env-key')

    expect(getOnethingProviderEnvStatus('zhipu', {
      ZAI_API_KEY: 'zai-env-key',
      ZHIPU_API_KEY: 'legacy-zhipu-key',
    }).resolvedEnvVar).toBe('ZAI_API_KEY')
  })

  it('returns a copy with an environment key when available', () => {
    const original = { apiKey: '', model: 'deepseek-chat' }
    const resolved = withResolvedOnethingProviderApiKey('deepseek', original, {
      DEEPSEEK_API_KEY: 'deepseek-key',
    })

    expect(resolved).toEqual({ apiKey: 'deepseek-key', model: 'deepseek-chat' })
    expect(original).toEqual({ apiKey: '', model: 'deepseek-chat' })
  })
})
