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
  getOnethingModelsForProvider,
  mergeOnethingModelsById,
  onethingModelServesImageOutputInLoop,
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
    // 2026-09-09:宽松的那只(末尾 `|| 4096`)已删除,不再有第二个答案可选。
  })

  it('用户在 maxOutputByModel 里填的数就是「知道」(2026-09-09,目录里没有的模型全靠这一格)', () => {
    const overridden: OnethingProviderModelConfigs = {
      custom: { maxOutputByModel: { 'never-heard-of': 3000 }, models: {} },
    }
    expect(getOnethingKnownModelMaxOutputTokens(overridden, 'never-heard-of', 'custom')).toBe(3000)
    // 覆盖压过目录:与 contextLengthByModel 同一手。
    const both: OnethingProviderModelConfigs = {
      custom: {
        maxOutputByModel: { 'shared-model': 1234 },
        models: { 'shared-model': entry('shared-model', 'custom', 64000, 8192) },
      },
    }
    expect(getOnethingKnownModelMaxOutputTokens(both, 'shared-model', 'custom')).toBe(1234)
    // 非正数不算填过。
    const zero: OnethingProviderModelConfigs = {
      custom: { maxOutputByModel: { 'never-heard-of': 0 }, models: {} },
    }
    expect(getOnethingKnownModelMaxOutputTokens(zero, 'never-heard-of', 'custom')).toBeUndefined()
  })

  it('keeps provider-scoped lookups isolated when model IDs collide', () => {
    expect(getOnethingModelContextLength(providers, 'shared-model', 'custom')).toBe(64000)
    expect(getOnethingKnownModelMaxOutputTokens(providers, 'shared-model', 'custom')).toBe(8192)
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

  it('never routes an in-loop image generator to the dedicated image stream', () => {
    // onethingModelSupportsImageGeneration answers "换不换通路", not "能不能出图".
    // Codex's gpt-5.5 makes images with a native tool INSIDE the agent loop, so
    // the dedicated image stream (prompt-only, no tools) must never claim it —
    // otherwise every ordinary message gets answered by the image API.
    const codexNativeEntry: OnethingModelCapabilityEntry = {
      ...entry('gpt-5.5', 'codex', 192000, 65536),
      supportsImageOutput: true,
      outputModalities: ['text', 'image'],
      providerMetadata: {
        codex: { nativeTools: ['image_generation'] },
      },
    }

    expect(
      onethingModelSupportsImageGeneration(
        { codex: { models: { 'gpt-5.5': codexNativeEntry } } },
        'gpt-5.5',
        'codex',
      ),
    ).toBe(false)

    // A user override says "this model can output images" — it does not ask for
    // a different transport, so the exclusion still wins.
    expect(
      onethingModelSupportsImageGeneration(
        {
          codex: {
            models: { 'gpt-5.5': codexNativeEntry },
            modelCapabilitiesByModel: { 'gpt-5.5': { imageOutput: true } },
          },
        },
        'gpt-5.5',
        'codex',
      ),
    ).toBe(false)
  })

  it('no longer routes a Google-endpoint gemini image model to the image stream', () => {
    // P4-8:`gemini` + `image` 的名字兜底退役。目录缺席时账本仍答得出
    // imageOutput=true(gemini 规则表的 `/image/` 行)⇒ servedBy='in-loop'
    // ⇒ 不换通路;它走 GeminiWire 的普通流。
    expect(onethingModelSupportsImageGeneration(undefined, 'gemini-2.5-flash-image', 'gemini')).toBe(false)
    expect(onethingModelSupportsImageGeneration({}, 'gemini-3-pro-image', 'gemini')).toBe(false)

    // 目录**在**、并且说它能出图 —— 结论一样(servedBy 判在 override 之前)。
    const geminiEntry: OnethingModelCapabilityEntry = {
      ...entry('gemini-3-pro-image', 'gemini', 1048576, 65536),
      supportsImageOutput: true,
      outputModalities: ['text', 'image'],
    }
    expect(
      onethingModelSupportsImageGeneration(
        { gemini: { models: { 'gemini-3-pro-image': geminiEntry } } },
        'gemini-3-pro-image',
        'gemini',
      ),
    ).toBe(false)
  })

  it('openai 直连的原生出图模型不换通路,但答「回合内出图」(#13)', () => {
    // 两支互斥:`onethingModelSupportsImageGeneration` = 换不换通路,
    // `onethingModelServesImageOutputInLoop` = 图在不在回合里出。
    expect(onethingModelSupportsImageGeneration(undefined, 'gpt-5.5', 'openai')).toBe(false)
    expect(onethingModelServesImageOutputInLoop(undefined, 'gpt-5.5', 'openai')).toBe(true)
    expect(onethingModelServesImageOutputInLoop(undefined, 'o3', 'openai')).toBe(true)

    // 表外的模型两边都是 false。
    expect(onethingModelSupportsImageGeneration(undefined, 'gpt-5.4', 'openai')).toBe(false)
    expect(onethingModelServesImageOutputInLoop(undefined, 'gpt-5.4', 'openai')).toBe(false)

    // 专用生图端点仍旧换通路,且不是回合内。
    expect(onethingModelSupportsImageGeneration(undefined, 'gpt-image-1', 'openai')).toBe(true)
    expect(onethingModelServesImageOutputInLoop(undefined, 'gpt-image-1', 'openai')).toBe(false)

    // 用户 override「别出图」一票否决闸门。
    expect(
      onethingModelServesImageOutputInLoop(
        { openai: { modelCapabilitiesByModel: { 'gpt-5.5': { imageOutput: false } } } },
        'gpt-5.5',
        'openai',
      ),
    ).toBe(false)

    // codex / gemini / openrouter 的 in-loop 模型走的是同一句话。
    expect(
      onethingModelServesImageOutputInLoop(
        {
          codex: {
            models: {
              'gpt-5.5': {
                ...entry('gpt-5.5', 'codex', 192000, 65536),
                supportsImageOutput: false,
                providerMetadata: { codex: { nativeTools: ['image_generation'] } },
              },
            },
          },
        },
        'gpt-5.5',
        'codex',
      ),
    ).toBe(true)
    expect(onethingModelServesImageOutputInLoop(undefined, 'gemini-3-pro-image', 'gemini')).toBe(true)
  })

  it('keeps the dedicated-endpoint name fallbacks', () => {
    // dall-e / gpt-image / imagen / flux / stable-diffusion / midjourney 那一族
    // 的名字兜底保留:那条通路确实不在回合里。
    for (const modelId of [
      'dall-e-3',
      'gpt-image-1',
      'imagen-4.0-generate-001',
      'flux-1.1-pro',
      'stable-diffusion-xl',
      'midjourney-v6',
    ]) {
      expect(onethingModelSupportsImageGeneration(undefined, modelId, 'openai')).toBe(true)
    }
  })

  it('still routes a real dedicated image model to the image stream', () => {
    const imageEntry: OnethingModelCapabilityEntry = {
      ...entry('some-image-model', 'openai', 128000, 4096),
      supportsImageOutput: true,
      outputModalities: ['image'],
    }

    expect(
      onethingModelSupportsImageGeneration(
        { openai: { models: { 'some-image-model': imageEntry } } },
        'some-image-model',
        'openai',
      ),
    ).toBe(true)
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
