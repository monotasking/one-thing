import { describe, expect, it, vi } from 'vitest'
import {
  getAllOnethingModelRegistryModels,
  getAllOnethingModelRegistryModelsForIpc,
  getOnethingModelRegistryDisplayName,
  getOnethingModelRegistryDisplayNameForIpc,
  getOnethingModelRegistryNameAliases,
  getOnethingModelRegistryNameAliasesForIpc,
  refreshOnethingModelRegistry,
  refreshOnethingModelRegistryForIpc,
  searchOnethingModelRegistry,
  searchOnethingModelRegistryForIpc,
} from '../model-query-presentation.js'

describe('model query presentation runtime', () => {
  it('wraps all-model and search adapters in model list results', async () => {
    const models = [{ id: 'gpt-4.1' }]
    const getAllModels = vi.fn(() => models)
    const searchModels = vi.fn(async () => models)

    await expect(getAllOnethingModelRegistryModels({
      getAllModels,
    })).resolves.toEqual({
      success: true,
      models,
    })

    await expect(searchOnethingModelRegistry({
      query: 'gpt',
      providerId: 'openai',
      searchModels,
    })).resolves.toEqual({
      success: true,
      models,
    })

    expect(getAllModels).toHaveBeenCalledTimes(1)
    expect(searchModels).toHaveBeenCalledWith('gpt', 'openai')
  })

  it('wraps refresh, aliases, and display-name model registry adapters', async () => {
    const forceRefresh = vi.fn(async () => undefined)
    const getModelNameAliases = vi.fn(() => ({ nano: 'Nano Banana' }))
    const getModelDisplayName = vi.fn(() => 'GPT 4.1')

    await expect(refreshOnethingModelRegistry({
      forceRefresh,
    })).resolves.toEqual({ success: true })

    expect(getOnethingModelRegistryNameAliases({
      getModelNameAliases,
    })).toEqual({
      success: true,
      aliases: { nano: 'Nano Banana' },
    })

    expect(getOnethingModelRegistryDisplayName({
      modelId: 'gpt-4.1',
      getModelDisplayName,
    })).toEqual({
      success: true,
      displayName: 'GPT 4.1',
    })

    expect(forceRefresh).toHaveBeenCalledTimes(1)
    expect(getModelNameAliases).toHaveBeenCalledTimes(1)
    expect(getModelDisplayName).toHaveBeenCalledWith('gpt-4.1')
  })

  it('normalizes model registry adapter failures for IPC wrappers', async () => {
    const logger = { error: vi.fn() }

    await expect(getAllOnethingModelRegistryModelsForIpc({
      getAllModels: () => {
        throw new Error('all failed')
      },
      logger,
    })).resolves.toEqual({ success: false, error: 'all failed' })

    await expect(searchOnethingModelRegistryForIpc({
      query: 'gpt',
      searchModels: () => {
        throw new Error('search failed')
      },
      logger,
    })).resolves.toEqual({ success: false, error: 'search failed' })

    await expect(refreshOnethingModelRegistryForIpc({
      forceRefresh: () => {
        throw new Error('refresh failed')
      },
      logger,
    })).resolves.toEqual({ success: false, error: 'refresh failed' })

    expect(getOnethingModelRegistryNameAliasesForIpc({
      getModelNameAliases: () => {
        throw new Error('aliases failed')
      },
      logger,
    })).toEqual({ success: false, error: 'aliases failed' })

    expect(getOnethingModelRegistryDisplayNameForIpc({
      modelId: 'gpt-4.1',
      getModelDisplayName: () => {
        throw new Error('display failed')
      },
      logger,
    })).toEqual({ success: false, error: 'display failed' })

    expect(logger.error).toHaveBeenCalledTimes(5)
  })
})
