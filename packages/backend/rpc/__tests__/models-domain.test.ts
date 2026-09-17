/**
 * models 域(主线 T1 第二批),搬自 `apps/electron/src/main/ipc/__tests__/models.test.ts`。
 *
 * 钉的是 Codex 缓存那条路的等价:有新鲜缓存就不刷 token 也不打后端、显式
 * forceRefresh 才去取、取失败退回缓存 + 兜底表。mock 的路径必须解析到 handler
 * 自己 import 的那些模块(`../../providers/...`、`../../stores/settings.js`)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, OpenRouterModel } from '@shared/ipc.js'

const mocks = vi.hoisted(() => {
  const makeModel = (id: string): OpenRouterModel => ({
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
  })

  return {
    forceRefresh: vi.fn(),
    refreshProviderModels: vi.fn(),
    fetchCodexModels: vi.fn(),
    getCodexFallbackModels: vi.fn((ids?: string[]) => {
      const modelIds = ids && ids.length > 0 ? ids : ['fallback-codex']
      return modelIds.map(makeModel)
    }),
    getModelsForProvider: vi.fn(),
    refreshTokenIfNeeded: vi.fn(),
    saveProviderModels: vi.fn(),
    settings: {} as AppSettings,
  }
})

vi.mock('../../wiring/auth/auth-service.js', () => ({
  authService: {
    getToken: vi.fn(),
    refreshTokenIfNeeded: mocks.refreshTokenIfNeeded,
  },
}))

vi.mock('../../wiring/providers/model-registry.js', () => ({
  forceRefresh: mocks.forceRefresh,
  refreshProviderModels: mocks.refreshProviderModels,
  getAllModels: vi.fn(),
  getModelDisplayName: vi.fn(),
  getModelNameAliases: vi.fn(),
  getModelsForProvider: mocks.getModelsForProvider,
  saveProviderModels: mocks.saveProviderModels,
  searchModels: vi.fn(),
}))

vi.mock('../../wiring/providers/builtin/codex.js', () => ({
  fetchCodexModels: mocks.fetchCodexModels,
  getCodexFallbackModels: mocks.getCodexFallbackModels,
}))

vi.mock('../../wiring/providers/builtin/github-copilot.js', () => ({
  detectModelCapabilities: vi.fn(() => ({
    contextLength: 128000,
    hasImageGeneration: false,
    hasReasoning: false,
    hasVision: false,
    hasTools: true,
  })),
  fetchCopilotModels: vi.fn(),
}))

vi.mock('../../stores/settings.js', () => ({
  getSettings: () => mocks.settings,
}))

const { modelsRpcHandlers } = await import('../domains/models.js')

function model(id: string): OpenRouterModel {
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

describe('models RPC domain — Codex cache handling', () => {
  const now = Date.now()
  const token = {
    accessToken: 'access-token',
    expiresAt: now + 60_000,
    tokenType: 'Bearer',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.settings = {
      ai: {
        provider: 'codex',
        temperature: 0.7,
        providers: {
          codex: {
            model: 'cached-codex',
            selectedModels: ['cached-codex'],
          },
        },
      },
    } as unknown as AppSettings
    mocks.getModelsForProvider.mockResolvedValue([model('cached-codex')])
    mocks.refreshTokenIfNeeded.mockResolvedValue(token)
    mocks.fetchCodexModels.mockResolvedValue([model('live-codex')])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns fresh cached Codex models without refreshing auth or fetching the backend', async () => {
    const response = await modelsRpcHandlers.getWithCapabilities({ providerId: 'codex' })

    expect(response.success).toBe(true)
    expect(response.models?.map(m => m.id)).toEqual(['cached-codex'])
    expect(mocks.refreshTokenIfNeeded).not.toHaveBeenCalled()
    expect(mocks.fetchCodexModels).not.toHaveBeenCalled()
    expect(mocks.saveProviderModels).not.toHaveBeenCalled()
  })

  it('fetches Codex models when the caller requests a manual refresh', async () => {
    const response = await modelsRpcHandlers.getWithCapabilities({
      providerId: 'codex',
      forceRefresh: true,
    })

    expect(mocks.refreshTokenIfNeeded).toHaveBeenCalledWith('codex')
    expect(mocks.fetchCodexModels).toHaveBeenCalledWith(token)
    expect(mocks.saveProviderModels).toHaveBeenCalledWith('codex', [expect.objectContaining({ id: 'live-codex' })])
    expect(response.models?.map(m => m.id)).toEqual(['live-codex', 'cached-codex'])
  })

  it('does not refresh Codex models automatically when the cached list is old', async () => {
    const response = await modelsRpcHandlers.getWithCapabilities({ providerId: 'codex' })

    expect(response.success).toBe(true)
    expect(response.models?.map(m => m.id)).toEqual(['cached-codex'])
    expect(mocks.refreshTokenIfNeeded).not.toHaveBeenCalled()
    expect(mocks.fetchCodexModels).not.toHaveBeenCalled()
  })

  it('returns Codex fallback models without fetching when there is no cache', async () => {
    mocks.getModelsForProvider.mockResolvedValue([model('fallback-codex')])
    mocks.settings.ai.providers.codex.model = ''
    mocks.settings.ai.providers.codex.selectedModels = []

    const response = await modelsRpcHandlers.getWithCapabilities({ providerId: 'codex' })

    expect(response.success).toBe(true)
    expect(response.models?.map(m => m.id)).toEqual(['fallback-codex'])
    expect(mocks.refreshTokenIfNeeded).not.toHaveBeenCalled()
    expect(mocks.fetchCodexModels).not.toHaveBeenCalled()
  })

  it('falls back to cached and default Codex models when a manual refresh fails', async () => {
    mocks.fetchCodexModels.mockRejectedValue(new Error('timeout'))

    const response = await modelsRpcHandlers.getWithCapabilities({
      providerId: 'codex',
      forceRefresh: true,
    })

    expect(response.success).toBe(true)
    expect(response.models?.map(m => m.id)).toEqual(['cached-codex', 'fallback-codex'])
    expect(mocks.saveProviderModels).not.toHaveBeenCalled()
  })

  it('getWithCapabilities on a generic provider really reaches refreshProviderModels', async () => {
    // 装配级:壳的刷新钮走的是 `getWithCapabilities({forceRefresh:true})`,
    // 不是 `refreshRegistry` —— 这条口必须接到真的重拉(2026-09-11)。
    mocks.refreshProviderModels.mockResolvedValue(undefined)
    mocks.getModelsForProvider.mockResolvedValue([model('fresh-kimi')])

    const response = await modelsRpcHandlers.getWithCapabilities({
      providerId: 'kimi',
      forceRefresh: true,
    })

    expect(mocks.refreshProviderModels).toHaveBeenCalledWith('kimi')
    expect(mocks.refreshProviderModels).toHaveBeenCalledTimes(1)
    expect(response.models?.map(m => m.id)).toEqual(['fresh-kimi'])

    // 只是打开抽屉时不重拉。
    mocks.refreshProviderModels.mockClear()
    await modelsRpcHandlers.getWithCapabilities({ providerId: 'kimi' })
    expect(mocks.refreshProviderModels).not.toHaveBeenCalled()
  })

  it('refreshRegistry: no providerId = every provider, providerId = only that one', async () => {
    mocks.forceRefresh.mockResolvedValue(undefined)
    mocks.refreshProviderModels.mockResolvedValue(undefined)

    await modelsRpcHandlers.refreshRegistry({})
    expect(mocks.forceRefresh).toHaveBeenCalledTimes(1)
    expect(mocks.refreshProviderModels).not.toHaveBeenCalled()

    await modelsRpcHandlers.refreshRegistry({ providerId: 'kimi' })
    expect(mocks.refreshProviderModels).toHaveBeenCalledWith('kimi')
    expect(mocks.forceRefresh).toHaveBeenCalledTimes(1)
  })
})

/**
 * P4-7:渲染层的「文件能力」诚实口。
 *
 * 这一组**不 mock** provider 工厂 —— 要测的正是「账本 ∧ 传输声明」这条真链:
 * mock 掉它就只剩一句 JSON 转发,那不是这条通道存在的理由。
 */
describe('models RPC domain — getModelCapabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.settings = { ai: { provider: 'openai', temperature: 0.7, providers: {} } } as unknown as AppSettings
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects an incomplete request instead of guessing', async () => {
    expect(await modelsRpcHandlers.getModelCapabilities({ providerId: '', model: 'gpt-5.5' }))
      .toMatchObject({ success: false })
    expect(await modelsRpcHandlers.getModelCapabilities({ providerId: 'openai', model: '' }))
      .toMatchObject({ success: false })
  })

  it('openai gpt-5.5 takes files (transport declares them, the ledger has nothing against it)', async () => {
    const response = await modelsRpcHandlers.getModelCapabilities({
      providerId: 'openai',
      model: 'gpt-5.5',
    })

    expect(response.success).toBe(true)
    expect(response.capabilities).toMatchObject({ supportsVision: true, supportsFiles: true })
  })

  it('deepseek vision-exp reads images and takes no file — the two are not one switch', async () => {
    mocks.settings = {
      ai: {
        provider: 'deepseek',
        temperature: 0.7,
        providers: { deepseek: { apiKey: 'k' } },
      },
    } as unknown as AppSettings

    const response = await modelsRpcHandlers.getModelCapabilities({
      providerId: 'deepseek',
      model: 'deepseek-vl2-vision-exp',
    })

    expect(response.success).toBe(true)
    expect(response.capabilities?.supportsVision).toBe(true)
    expect(response.capabilities?.supportsFiles).toBe(false)
  })

  it('reports the failure instead of throwing when a provider cannot be constructed', async () => {
    const response = await modelsRpcHandlers.getModelCapabilities({
      providerId: 'definitely-not-a-provider',
      model: 'whatever',
    })

    expect(response.success).toBe(false)
    expect(response.error).toBeTruthy()
  })
})

/**
 * 思考档位随目录行走(2026-09-05,输入框的模型选择器)。
 *
 * 读数一格都不是这条用例编的:全部照 `providers/model-capability.ts` 的
 * `PROVIDER_MODEL_RULES` 常量抄。这一组要钉的是**投影本身**——
 *  ① `'none'` 是线协议标记不是档,必须滤掉(gpt-5.5 的 efforts 里真有它);
 *  ② `toggleable:false` 的型不许长出「关」;
 *  ③ `efforts: []` 是「能开关但没有档」,不是「不思考」;
 *  ④ 不思考的型四格全按不思考答(`thinkingLevels: null`),不编一个档出来。
 *
 * 反证:把 `projectOnethingThinkingLevels` 里那句 `effort !== 'none'` 摘掉 →
 * gpt-5.5 那一行当场红。
 */
describe('models RPC domain — 手填模型思考投影', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('补齐已选和当前模型、去重,缺席的目录元数据保持缺席', async () => {
    mocks.settings = { ai: { providers: { grok: {
      selectedModels: ['listed', 'my-grok', 'my-grok'], model: 'current-only',
      modelCapabilitiesByModel: {
        'my-grok': { reasoningProfile: { efforts: ['low', 'high'], defaultEffort: 'low', effortLabels: { low: '快速' } } },
        'current-only': { reasoningProfile: { efforts: ['medium'], defaultEffort: 'medium' } },
      },
    } } } } as unknown as AppSettings
    const listed = model('listed')
    mocks.getModelsForProvider.mockResolvedValue([listed])
    const response = await modelsRpcHandlers.getWithCapabilities({ providerId: 'grok' })
    expect(response.success).toBe(true)
    expect(response.models?.map(row => row.id)).toEqual(['listed', 'my-grok', 'current-only'])
    expect(response.models?.[0]).toMatchObject(listed)
    expect(response.models?.[0].configuredOnly).toBeUndefined()
    expect(response.models?.[1]).toMatchObject({ configuredOnly: true, thinkingLevels: ['low', 'high'], thinkingDefaultLevel: 'low', thinkingLevelLabels: { low: '快速' } })
    expect(response.models?.[2]).toMatchObject({ configuredOnly: true, thinkingLevels: ['medium'], thinkingDefaultLevel: 'medium' })
    for (const row of response.models!.slice(1)) {
      for (const field of ['pricing', 'architecture', 'context_length', 'top_provider', 'supported_parameters']) {
        expect(row).not.toHaveProperty(field)
      }
    }
    expect(mocks.saveProviderModels).not.toHaveBeenCalled()
  })

  it('空目录也返回自定义 provider 默认模型,并应用它的思考配置', async () => {
    mocks.settings = { ai: {
      providers: {},
      customProviders: [{ id: 'custom-local', model: 'local-model', apiType: 'openai',
        providerOptions: { reasoningProfile: { efforts: ['low', 'high'], defaultEffort: 'high', toggleable: false } },
      }],
    } } as unknown as AppSettings
    mocks.getModelsForProvider.mockResolvedValue([])
    const response = await modelsRpcHandlers.getWithCapabilities({ providerId: 'custom-local' })
    expect(response.models).toEqual([expect.objectContaining({
      id: 'local-model', configuredOnly: true, thinkingLevels: ['low', 'high'], thinkingDefaultLevel: 'high',
    })])
  })

  it('随后目录收录该模型时改回正式目录项,不保留手填标记', async () => {
    mocks.settings = { ai: { providers: { grok: { selectedModels: ['new-model'], model: 'new-model' } } } } as unknown as AppSettings
    mocks.getModelsForProvider.mockResolvedValue([model('new-model')])
    const response = await modelsRpcHandlers.getWithCapabilities({ providerId: 'grok' })
    expect(response.models).toHaveLength(1)
    expect(response.models?.[0].configuredOnly).toBeUndefined()
    expect(response.models?.[0].context_length).toBe(192000)
  })
})

describe('models RPC domain — 目录行带上思考档位', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.settings = {
      ai: { provider: 'openai', temperature: 0.7, providers: {} },
    } as unknown as AppSettings
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function levelsOf(providerId: string, modelId: string) {
    mocks.getModelsForProvider.mockResolvedValue([model(modelId)])
    const response = await modelsRpcHandlers.getWithCapabilities({ providerId })
    const row = response.models?.[0]
    return {
      thinkingLevels: row?.thinkingLevels,
      thinkingToggleable: row?.thinkingToggleable,
      thinkingDefaultOn: row?.thinkingDefaultOn,
      thinkingDefaultLevel: row?.thinkingDefaultLevel,
    }
  }

  it('claude:四档可选、可关,缺省不开', async () => {
    expect(await levelsOf('claude', 'claude-opus-4-5')).toEqual({
      thinkingLevels: ['low', 'medium', 'high', 'max'],
      thinkingToggleable: true,
      thinkingDefaultOn: false,
      thinkingDefaultLevel: 'high',
    })
  })

  it('gpt-5:四档、**不可关**(o 系 / gpt-5 系永远思考)', async () => {
    expect(await levelsOf('openai', 'gpt-5')).toEqual({
      thinkingLevels: ['minimal', 'low', 'medium', 'high'],
      thinkingToggleable: false,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'medium',
    })
  })

  it("gpt-5.5:efforts 里那个 `'none'` 是线协议标记,不上屏", async () => {
    expect((await levelsOf('openai', 'gpt-5.5')).thinkingLevels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  it('deepseek v4:两档 + 可关 = 屏幕上「关 / 高 / 最大」', async () => {
    expect(await levelsOf('deepseek', 'deepseek-v4-pro')).toEqual({
      thinkingLevels: ['high', 'max'],
      thinkingToggleable: true,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'high',
    })
  })

  it('kimi k3:一档 + 可关 = 屏幕上「关 / 最大」', async () => {
    expect(await levelsOf('kimi', 'kimi-k3')).toEqual({
      thinkingLevels: ['max'],
      thinkingToggleable: true,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'max',
    })
  })

  it('qwen3.5:能开关但一档都没有 —— `[]` 不是 `null`', async () => {
    expect(await levelsOf('qwen', 'qwen3.5-max')).toEqual({
      thinkingLevels: [],
      thinkingToggleable: true,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'high',
    })
  })

  it('不思考的型:四格全按不思考答,不编档', async () => {
    expect(await levelsOf('deepseek', 'deepseek-chat')).toEqual({
      thinkingLevels: null,
      thinkingToggleable: false,
      thinkingDefaultOn: false,
      thinkingDefaultLevel: null,
    })
  })

  it('getModelCapabilities 那一口与目录口同一份投影', async () => {
    const response = await modelsRpcHandlers.getModelCapabilities({
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
    })
    expect(response.capabilities).toMatchObject({
      thinkingLevels: ['high', 'max'],
      thinkingToggleable: true,
    })
  })
})
