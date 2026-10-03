import { describe, expect, it, vi } from 'vitest'
import {
  inspectOnethingProviderEnvStatus,
  inspectOnethingProviderEnvStatusForIpc,
  listOnethingProviders,
  listOnethingProvidersForIpc,
} from '../provider-presentation.js'

describe('provider presentation runtime', () => {
  it('lists available providers through the supplied adapter', async () => {
    const providers = [{ id: 'openai' }, { id: 'codex' }]
    const getAvailableProviders = vi.fn(() => providers)

    await expect(listOnethingProviders({
      getAvailableProviders,
    })).resolves.toEqual({
      success: true,
      providers,
    })

    expect(getAvailableProviders).toHaveBeenCalledTimes(1)
  })

  it('returns provider environment status through the supplied adapter', async () => {
    const status = { configured: true, source: 'env' }
    const getProviderEnvStatus = vi.fn(() => status)

    await expect(inspectOnethingProviderEnvStatus({
      providerId: 'openai',
      getProviderEnvStatus,
    })).resolves.toEqual({
      success: true,
      status,
    })

    expect(getProviderEnvStatus).toHaveBeenCalledWith('openai')
  })

  it('normalizes provider presentation adapter failures for IPC wrappers', async () => {
    const logger = { error: vi.fn() }

    await expect(listOnethingProvidersForIpc({
      getAvailableProviders: () => {
        throw new Error('providers failed')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'providers failed',
    })

    await expect(inspectOnethingProviderEnvStatusForIpc({
      providerId: 'openai',
      getProviderEnvStatus: () => {
        throw new Error('env failed')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'env failed',
    })

    expect(logger.error).toHaveBeenCalledTimes(2)
  })
})
