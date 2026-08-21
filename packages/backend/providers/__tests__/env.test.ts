import { afterEach, describe, expect, it } from 'vitest'
import { getProviderEnvStatus, resolveProviderApiKey } from '../env.js'

const touchedEnvVars = new Set<string>()

function setEnv(name: string, value: string | undefined) {
  touchedEnvVars.add(name)
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

afterEach(() => {
  for (const name of touchedEnvVars) {
    delete process.env[name]
  }
  touchedEnvVars.clear()
})

describe('provider environment API keys', () => {
  it('prefers a manual key when one is configured', () => {
    setEnv('OPENAI_API_KEY', 'env-key')

    expect(resolveProviderApiKey('openai', {
      apiKey: 'manual-key',
    })).toBe('manual-key')
  })

  it('strips pasted authorization prefixes from configured and env keys', () => {
    expect(resolveProviderApiKey('zhipu', {
      apiKey: 'Bearer manual-key',
    })).toBe('manual-key')

    setEnv('ZAI_API_KEY', 'Authorization: Bearer env-key')

    expect(resolveProviderApiKey('zhipu', {
      apiKey: '',
    })).toBe('env-key')
  })

  it('auto-detects a provider default env var when no manual key is configured', () => {
    setEnv('ANTHROPIC_API_KEY', 'anthropic-env-key')

    expect(resolveProviderApiKey('claude', {
      apiKey: '',
    })).toBe('anthropic-env-key')
  })

  it('auto-detects ZAI_API_KEY for Zhipu when older names are absent', () => {
    setEnv('ZAI_API_KEY', 'zai-env-key')

    expect(resolveProviderApiKey('zhipu', {
      apiKey: '',
    })).toBe('zai-env-key')

    expect(getProviderEnvStatus('zhipu')).toMatchObject({
      providerId: 'zhipu',
      detectedEnvVar: 'ZAI_API_KEY',
      resolvedEnvVar: 'ZAI_API_KEY',
    })
  })

  it('prefers ZAI_API_KEY over legacy Zhipu env var names', () => {
    setEnv('ZAI_API_KEY', 'zai-env-key')
    setEnv('ZHIPU_API_KEY', 'legacy-zhipu-key')

    expect(resolveProviderApiKey('zhipu', {
      apiKey: '',
    })).toBe('zai-env-key')

    expect(getProviderEnvStatus('zhipu')).toMatchObject({
      providerId: 'zhipu',
      detectedEnvVar: 'ZAI_API_KEY',
      resolvedEnvVar: 'ZAI_API_KEY',
    })
  })

  it('reports env status without exposing the key value', () => {
    setEnv('MY_PROVIDER_API_KEY', 'secret-value-1234')

    const status = getProviderEnvStatus('custom-my-provider')

    expect(status).toMatchObject({
      providerId: 'custom-my-provider',
      detectedEnvVar: 'MY_PROVIDER_API_KEY',
      resolvedEnvVar: 'MY_PROVIDER_API_KEY',
      keyPreview: 'secret••••1234',
    })
    expect(status.candidates).toContainEqual({
      name: 'MY_PROVIDER_API_KEY',
      isSet: true,
    })
    expect(JSON.stringify(status)).not.toContain('secret-value-1234')
  })
})
