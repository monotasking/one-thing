import { describe, expect, it } from 'vitest'
import {
  acpAgentsToOnethingOpenRouterModels,
  copilotModelInfoToOnethingOpenRouterModel,
  createOnethingModelEntriesFromModelsDev,
  fetchOnethingGitHubCopilotModelsWithAuth,
  fetchOnethingModelsDevData,
  getConfiguredOnethingFallbackModels,
  getConfiguredOnethingModelIds,
  getOnethingModelsWithCapabilities,
  getRefreshableOnethingProviderIds,
  getOnethingModelById,
  getOnethingModelContextLength,
  getOnethingKnownModelMaxOutputTokens,
  getOnethingModelMaxOutputTokens,
  getOnethingModelsForProvider,
  mergeOnethingModelsById,
  onethingModelSupportsImageGeneration,
  refreshAllOnethingProviderModels,
  refreshOnethingProviderModels,
  saveOnethingProviderModels,
  searchOnethingModels,
  type OnethingModelCapabilityEntry,
  type OnethingModelRegistrySettingsLike,
  type OnethingOpenRouterModel,
  type OnethingProviderModelConfigs,
} from '../model-registry.js'

function entry(
  id: string,
  provider: string,
  contextLength: number,
  maxOutputTokens: number,
): OnethingModelCapabilityEntry {
  return {
    id,
    name: id,
    provider,
    contextLength,
    maxOutputTokens,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsImageOutput: false,
    supportsTemperature: true,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  }
}

function openRouterModel(id: string): OnethingOpenRouterModel {
  return {
    id,
    name: id,
    description: '',
    context_length: 192000,
    architecture: {
      modality: 'multimodal',
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      tokenizer: 'unknown',
    },
    pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    top_provider: { context_length: 192000, max_completion_tokens: 65536, is_moderated: false },
    supported_parameters: ['tools', 'reasoning'],
  }
}

describe('onething model registry helpers', () => {
  const providers: OnethingProviderModelConfigs = {
    openai: {
      models: {
        'shared-model': entry('shared-model', 'openai', 32000, 4096),
        'openai-only': entry('openai-only', 'openai', 1050000, 128000),
      },
    },
    custom: {
      models: {
        'shared-model': entry('shared-model', 'custom', 64000, 8192),
      },
    },
  }

  it('strict max-output lookup never invents 4096: known → number, unknown → undefined', () => {
    expect(getOnethingKnownModelMaxOutputTokens(providers, 'shared-model', 'custom')).toBe(8192)
    expect(getOnethingKnownModelMaxOutputTokens(providers, 'never-heard-of', 'custom')).toBeUndefined()
    // an entry built from a catalog row that had no output limit is stored as 0 = unknown
    const withUnknown: OnethingProviderModelConfigs = {
      custom: { models: { 'no-limit': entry('no-limit', 'custom', 64000, 0) } },
    }
    expect(getOnethingKnownModelMaxOutputTokens(withUnknown, 'no-limit', 'custom')).toBeUndefined()
    // the lenient getter keeps its historic 4096 for the chat path — the two are
    // deliberately different functions so a caller must choose.
    expect(getOnethingModelMaxOutputTokens(withUnknown, 'no-limit', 'custom')).toBe(4096)
  })

  it('keeps provider-scoped lookups isolated when model IDs collide', () => {
    expect(getOnethingModelContextLength(providers, 'shared-model', 'custom')).toBe(64000)
    expect(getOnethingModelMaxOutputTokens(providers, 'shared-model', 'custom')).toBe(8192)
    expect(getOnethingModelContextLength(providers, 'shared-model', 'openai')).toBe(32000)
    expect(getOnethingModelById(providers, 'openai-only', 'custom')).toBeUndefined()
  })

  it('uses provider-scoped capability metadata and overrides', () => {
    const scopedProviders: OnethingProviderModelConfigs = {
      custom: {
        models: {
          'shared-model': {
            ...entry('shared-model', 'custom', 64000, 8192),
            supportsImageOutput: false,
            supportsReasoning: false,
          },
        },
        modelCapabilitiesByModel: {
          'shared-model': {
            reasoning: true,
            imageOutput: true,
          },
        },
      },
    }

    // Reasoning override scoping is covered by model-capability.test.ts now.
    expect(onethingModelSupportsImageGeneration(scopedProviders, 'shared-model', 'custom')).toBe(true)
  })

  it('converts models.dev provider data and sorts newest first', () => {
    const entries = createOnethingModelEntriesFromModelsDev('claude', {
      anthropic: {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          old: {
            id: 'old',
            name: 'Old',
            last_updated: '2024-01-01',
            modalities: { input: ['text'], output: ['text'] },
          },
          new: {
            id: 'new',
            name: 'New',
            last_updated: '2025-01-01',
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        },
      },
    })

    expect(entries?.new).toMatchObject({
      provider: 'claude',
      supportsTools: true,
      supportsVision: true,
    })
    expect(getOnethingModelsForProvider({ claude: { models: entries } }, 'claude').map(model => model.id)).toEqual([
      'new',
      'old',
    ])
  })

  it('searches provider-scoped model names', () => {
    expect(searchOnethingModels(providers, 'shared', 'custom').map(model => model.id)).toEqual(['shared-model'])
  })

  it('owns model list presentation helpers used by host IPC adapters', () => {
    expect(mergeOnethingModelsById(
      [{ id: 'a', value: 1 }, { id: 'b', value: 1 }],
      [{ id: 'a', value: 2 }, { id: 'c', value: 2 }],
    )).toEqual([
      { id: 'a', value: 1 },
      { id: 'b', value: 1 },
      { id: 'c', value: 2 },
    ])

    const config = {
      model: 'selected-a',
      selectedModels: ['selected-b', 'selected-a'],
    }
    expect(getConfiguredOnethingModelIds(config)).toEqual(['selected-b', 'selected-a'])
    expect(getConfiguredOnethingFallbackModels(config, ids =>
      (ids ?? []).map(id => ({
        id,
        name: id,
        context_length: 128000,
        architecture: {
          modality: 'text',
          input_modalities: ['text'],
          output_modalities: ['text'],
          tokenizer: 'unknown',
        },
        pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
        top_provider: { context_length: 128000, max_completion_tokens: 4096, is_moderated: false },
        supported_parameters: [],
      })),
    ).map(model => model.id)).toEqual(['selected-b', 'selected-a'])
  })

  it('maps Copilot and ACP model sources to OpenRouter-compatible models in runtime', () => {
    expect(copilotModelInfoToOnethingOpenRouterModel({
      id: 'gpt-4.1',
      name: 'GPT 4.1',
    })).toMatchObject({
      id: 'gpt-4.1',
      context_length: 1000000,
      architecture: {
        input_modalities: ['text', 'image'],
      },
      supported_parameters: ['tools'],
    })

    expect(acpAgentsToOnethingOpenRouterModels([{
      id: 'agent-1',
      command: 'codex',
      args: ['--fast'],
      enabled: true,
    }])).toEqual([expect.objectContaining({
      id: 'agent-1',
      name: 'agent-1',
      description: 'ACP agent command: codex --fast',
      providerMetadata: {
        acp: {
          command: 'codex',
          enabled: true,
          status: 'local-agent',
        },
      },
    })])
  })

  it('fetches GitHub Copilot models through an auth adapter', async () => {
    const providers: string[] = []
    const tokens: string[] = []

    await expect(fetchOnethingGitHubCopilotModelsWithAuth({
      getToken: providerId => {
        providers.push(providerId)
        return { accessToken: 'token-1' }
      },
      fetchCopilotModels: accessToken => {
        tokens.push(accessToken)
        return [{ id: 'gpt-4.1' }]
      },
    })).resolves.toEqual([{ id: 'gpt-4.1' }])

    expect(providers).toEqual(['github-copilot'])
    expect(tokens).toEqual(['token-1'])

    await expect(fetchOnethingGitHubCopilotModelsWithAuth({
      getToken: () => null,
      fetchCopilotModels: () => [],
    })).rejects.toThrow('Not logged in to GitHub Copilot')
  })

  it('owns get-models-with-capabilities orchestration for special and default providers', async () => {
    const saved: unknown[] = []
    const warnCalls: unknown[][] = []
    const adapters = {
      getModelsForProvider: async (providerId: string) => providerId === 'codex'
        ? [openRouterModel('cached-codex')]
        : providerId === 'github-copilot'
          ? [openRouterModel('cached-copilot')]
          : [openRouterModel(`${providerId}-cached`)],
      fetchCopilotModels: async () => [{ id: 'gpt-4.1', name: 'GPT 4.1' }],
      fetchCodexModels: async () => [openRouterModel('live-codex')],
      saveProviderModels: (providerId: string, models: OnethingOpenRouterModel[]) => {
        saved.push({ providerId, models })
      },
      getCodexFallbackModels: (ids?: string[]) => (ids?.length ? ids : ['fallback-codex']).map(openRouterModel),
      getConfiguredCodexModelSelection: () => ({
        model: 'configured-codex',
        selectedModels: ['configured-codex'],
      }),
      getACPAgents: () => [{
        id: 'agent-1',
        command: 'codex',
        enabled: true,
      }],
      logger: {
        warn: (...args: unknown[]) => warnCalls.push(args),
      },
    }

    await expect(getOnethingModelsWithCapabilities({
      providerId: 'github-copilot',
    }, adapters)).resolves.toMatchObject({
      success: true,
      models: [expect.objectContaining({ id: 'gpt-4.1' })],
    })

    await expect(getOnethingModelsWithCapabilities({
      providerId: 'codex',
      forceRefresh: true,
    }, adapters)).resolves.toMatchObject({
      success: true,
      models: [
        expect.objectContaining({ id: 'live-codex' }),
        expect.objectContaining({ id: 'configured-codex' }),
      ],
    })
    expect(saved).toEqual([{
      providerId: 'codex',
      models: [expect.objectContaining({ id: 'live-codex' })],
    }])

    await expect(getOnethingModelsWithCapabilities({
      providerId: 'acp',
    }, adapters)).resolves.toMatchObject({
      success: true,
      models: [expect.objectContaining({ id: 'agent-1' })],
    })

    await expect(getOnethingModelsWithCapabilities({
      providerId: 'openai',
    }, adapters)).resolves.toMatchObject({
      success: true,
      models: [expect.objectContaining({ id: 'openai-cached' })],
    })
  })

  it('falls back from live Copilot and Codex failures inside runtime orchestration', async () => {
    const adapters = {
      getModelsForProvider: async (providerId: string) => providerId === 'github-copilot'
        ? [openRouterModel('cached-copilot')]
        : [openRouterModel('cached-codex')],
      fetchCopilotModels: async () => {
        throw new Error('copilot timeout')
      },
      fetchCodexModels: async () => {
        throw new Error('codex timeout')
      },
      saveProviderModels: () => {},
      getCodexFallbackModels: (ids?: string[]) => (ids?.length ? ids : ['fallback-codex']).map(openRouterModel),
      getConfiguredCodexModelSelection: () => undefined,
      getACPAgents: () => [],
      logger: {
        warn: () => {},
      },
    }

    await expect(getOnethingModelsWithCapabilities({
      providerId: 'github-copilot',
    }, adapters)).resolves.toMatchObject({
      success: true,
      models: [expect.objectContaining({ id: 'cached-copilot' })],
    })

    await expect(getOnethingModelsWithCapabilities({
      providerId: 'codex',
      forceRefresh: true,
    }, adapters)).resolves.toMatchObject({
      success: true,
      models: [
        expect.objectContaining({ id: 'cached-codex' }),
        expect.objectContaining({ id: 'fallback-codex' }),
      ],
    })
  })

  it('fetches models.dev data through an injected fetch adapter', async () => {
    const fetchCalls: unknown[] = []
    const data = {
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: {},
      },
    }
    const fetchImpl = async (...args: Parameters<typeof globalThis.fetch>) => {
      fetchCalls.push(args)
      return {
        ok: true,
        status: 200,
        json: async () => data,
      } as Response
    }

    await expect(fetchOnethingModelsDevData(fetchImpl, {
      headers: { 'User-Agent': 'test-agent' },
      signal: undefined,
    })).resolves.toBe(data)
    expect(fetchCalls[0]).toMatchObject([
      'https://models.dev/api.json',
      { headers: { 'Accept': 'application/json', 'User-Agent': 'test-agent' } },
    ])
  })

  it('owns provider model save orchestration with injected settings adapters', () => {
    const settings: OnethingModelRegistrySettingsLike = {
      ai: { providers: {} },
    }
    const saved: OnethingModelRegistrySettingsLike[] = []
    const models: OnethingOpenRouterModel[] = [{
      id: 'live-model',
      name: 'Live Model',
      context_length: 128000,
      architecture: {
        modality: 'text',
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: 'unknown',
      },
      pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
      top_provider: { context_length: 128000, max_completion_tokens: 4096, is_moderated: false },
      supported_parameters: ['tools'],
    }]

    saveOnethingProviderModels('codex', models, {
      getSettings: () => settings,
      saveSettings: next => saved.push(next),
      now: () => 1234,
    })

    expect(settings.ai.providers.codex?.models?.['live-model']).toMatchObject({
      id: 'live-model',
      provider: 'codex',
      supportsTools: true,
    })
    expect(settings.ai.providers.codex?.modelsLastFetched).toBe(1234)
    expect(saved).toEqual([settings])
  })

  it('refreshes one provider from models.dev data and skips Codex refreshes', async () => {
    const settings: OnethingModelRegistrySettingsLike = {
      ai: {
        providers: {
          claude: {},
          codex: {},
        },
      },
    }
    const saved: OnethingModelRegistrySettingsLike[] = []
    const logger = { log: () => {}, warn: () => {} }
    const adapters = {
      getSettings: () => settings,
      saveSettings: (next: OnethingModelRegistrySettingsLike) => saved.push(next),
      fetchModelsDevData: async () => ({
        anthropic: {
          id: 'anthropic',
          name: 'Anthropic',
          models: {
            'claude-live': {
              id: 'claude-live',
              name: 'Claude Live',
              last_updated: '2026-01-01',
              tool_call: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
            },
          },
        },
      }),
      now: () => 4321,
      logger,
    }

    await refreshOnethingProviderModels('claude', adapters)
    await refreshOnethingProviderModels('codex', adapters)

    expect(settings.ai.providers.claude?.models?.['claude-live']).toMatchObject({
      provider: 'claude',
      supportsTools: true,
      supportsVision: true,
    })
    expect(settings.ai.providers.claude?.modelsLastFetched).toBe(4321)
    expect(settings.ai.providers.codex?.models).toBeUndefined()
    expect(saved).toEqual([settings])
  })

  it('refreshes all configured non-custom non-codex providers', async () => {
    const settings: OnethingModelRegistrySettingsLike = {
      ai: {
        providers: {
          claude: {},
          deepseek: {},
          codex: {},
          custom: {},
        },
      },
    }
    const warnings: unknown[][] = []

    expect(getRefreshableOnethingProviderIds(settings.ai.providers)).toEqual(['claude', 'deepseek'])

    await refreshAllOnethingProviderModels({
      getSettings: () => settings,
      saveSettings: () => {},
      fetchModelsDevData: async () => ({
        anthropic: {
          id: 'anthropic',
          name: 'Anthropic',
          models: {
            'claude-live': {
              id: 'claude-live',
              name: 'Claude Live',
            },
          },
        },
      }),
      now: () => 5678,
      logger: {
        warn: (...args) => warnings.push(args),
      },
    })

    expect(settings.ai.providers.claude?.models?.['claude-live']).toBeDefined()
    expect(settings.ai.providers.claude?.modelsLastFetched).toBe(5678)
    expect(settings.ai.providers.deepseek?.models).toBeUndefined()
    expect(settings.ai.providers.codex?.models).toBeUndefined()
    expect(warnings.flat().join('\n')).toContain('No models.dev data for provider: deepseek')
  })
})
