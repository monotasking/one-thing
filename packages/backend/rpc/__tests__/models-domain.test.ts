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
    /** 认亲索引要的 models.dev 快照(批 3 §6.3)。缺省没有 = 不出建议。 */
    modelsDevSnapshot: undefined as undefined | { data: Record<string, unknown>; fetchedAt: number },
    /** 按空间 id 的生效设置(覆盖表 per-space);缺席回落 `settings`。 */
    spaceSettings: {} as Record<string, AppSettings>,
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
  getModelsDevSnapshot: async () => mocks.modelsDevSnapshot,
}))

// Codex 的列表口与兜底表随这家搬回 `runtime/providers/vendors/codex/`(服务商自述试点 P2 第 4 批),
// handler 经名册拿到的拉取器调的是那一家模块里的取数与兜底函数 —— mock 落在那里。取数函数多了一个
// fetch 参数(宿主的 app fetch 经依赖交进去),这里只把 token 转给 mock,断言照旧。
vi.mock('@onething/runtime/providers/vendors/codex/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@onething/runtime/providers/vendors/codex/models')>()),
  fetchOnethingCodexModels: (token: unknown) => mocks.fetchCodexModels(token),
  getOnethingCodexFallbackModels: (ids?: string[]) => mocks.getCodexFallbackModels(ids),
}))

vi.mock('@onething/runtime/providers/vendors/github-copilot/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@onething/runtime/providers/vendors/github-copilot/models')>()),
  fetchCopilotModels: vi.fn(),
}))

vi.mock('../../stores/settings.js', () => ({
  getSettings: () => mocks.settings,
  getSpaceSettings: (id: string) => mocks.spaceSettings[id] ?? mocks.settings,
  saveSettings: vi.fn(),
}))

// 手填折叠会按全机器的空间收孤儿;这一组只有「默认空间的生效设置」那一份。
vi.mock('@onething/runtime/spaces/store', () => ({
  getSpacesStore: () => ({ list: () => [] }),
}))
vi.mock('@onething/runtime/spaces/provider-settings', () => ({
  readSpaceProviderSettings: () => null,
  createEmptySpaceProviderSettings: () => ({ provider: '', providers: {}, customProviders: [] }),
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

    expect(mocks.refreshProviderModels).toHaveBeenCalledWith('kimi', { spaceId: undefined })
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
    expect(response.models?.[0].source).toBeUndefined()
    expect(response.models?.[1]).toMatchObject({ source: 'manual', thinkingLevels: ['low', 'high'], thinkingDefaultLevel: 'low', thinkingLevelLabels: { low: '快速' } })
    expect(response.models?.[2]).toMatchObject({ source: 'manual', thinkingLevels: ['medium'], thinkingDefaultLevel: 'medium' })
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
      id: 'local-model', source: 'manual', thinkingLevels: ['low', 'high'], thinkingDefaultLevel: 'high',
    })])
  })

  it('随后目录收录该模型时改回正式目录项,不保留手填标记', async () => {
    mocks.settings = { ai: { providers: { grok: { selectedModels: ['new-model'], model: 'new-model' } } } } as unknown as AppSettings
    mocks.getModelsForProvider.mockResolvedValue([model('new-model')])
    const response = await modelsRpcHandlers.getWithCapabilities({ providerId: 'grok' })
    expect(response.models).toHaveLength(1)
    expect(response.models?.[0].source).toBeUndefined()
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

/**
 * §5.5:「覆盖 > 接口 / 目录 > 不知道」只在后端折一次,每行带 `effective`。
 * 09-10 事故的形状:手填模型只在覆盖表里有窗口 —— 壳从前自己折、漏读就是 unknown。
 */
describe('models RPC domain — 每行的 effective(§5.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.spaceSettings = {}
    mocks.modelsDevSnapshot = undefined
  })

  it('手填 foo-1 + 覆盖上下文 200000 → effective 200000,出处 override;其余不知道', async () => {
    mocks.settings = { ai: { providers: { deepseek: {
      selectedModels: ['foo-1'], model: 'foo-1',
      models: { 'foo-1': { id: 'foo-1', name: 'foo-1', provider: 'deepseek', source: 'manual' } },
      contextLengthByModel: { 'foo-1': 200_000 },
    } } } } as unknown as AppSettings
    mocks.getModelsForProvider.mockResolvedValue([{ id: 'foo-1', name: 'foo-1', source: 'manual' } as OpenRouterModel])
    const response = await modelsRpcHandlers.getWithCapabilities({ providerId: 'deepseek' })
    const row = response.models?.find(m => m.id === 'foo-1')
    expect(row?.effective).toMatchObject({
      contextLength: 200_000,
      maxOutput: null,
      capabilities: { tools: null, vision: null, reasoning: null, imageOutput: null, fileInput: null },
      source: { contextLength: 'override', maxOutput: 'unknown' },
    })
    // 没有 models.dev 快照 = 认不了亲 = 没有建议(目录照常出)。
    expect(row?.suggestion).toBeUndefined()
  })

  it('目录行:目录说的就是 catalog;覆盖逐格盖上并标 override;旧信封仍是目录原值', async () => {
    mocks.settings = { ai: { providers: { deepseek: {
      selectedModels: ['listed'],
      contextLengthByModel: { listed: 64_000 },
      modelCapabilitiesByModel: { listed: { tools: false } },
    } } } } as unknown as AppSettings
    mocks.getModelsForProvider.mockResolvedValue([model('listed')])
    const response = await modelsRpcHandlers.getWithCapabilities({ providerId: 'deepseek' })
    const row = response.models?.[0]
    expect(row?.context_length).toBe(192000)
    expect(row?.effective).toMatchObject({
      contextLength: 64_000,
      maxOutput: 65536,
      capabilities: { tools: false, vision: true, reasoning: true, imageOutput: false, fileInput: false },
      source: {
        contextLength: 'override',
        maxOutput: 'catalog',
        capabilities: { tools: 'override', vision: 'catalog' },
      },
    })
  })

  it('接口拉来的行(source endpoint)标 endpoint', async () => {
    mocks.settings = { ai: { providers: { codex: {} } } } as unknown as AppSettings
    mocks.getModelsForProvider.mockResolvedValue([{ ...model('ep'), source: 'endpoint' } as OpenRouterModel])
    const response = await modelsRpcHandlers.getWithCapabilities({ providerId: 'grok' })
    expect(response.models?.[0].effective?.source.contextLength).toBe('endpoint')
  })

  it('覆盖读请求里那个空间的;缺席 = 默认空间', async () => {
    mocks.settings = { ai: { providers: { deepseek: { contextLengthByModel: { listed: 1_000 } } } } } as unknown as AppSettings
    mocks.spaceSettings.work = { ai: { providers: { deepseek: { contextLengthByModel: { listed: 2_000 } } } } } as unknown as AppSettings
    mocks.getModelsForProvider.mockResolvedValue([model('listed')])
    const byDefault = await modelsRpcHandlers.getWithCapabilities({ providerId: 'deepseek' })
    const bySpace = await modelsRpcHandlers.getWithCapabilities({ providerId: 'deepseek', spaceId: 'work' })
    expect(byDefault.models?.[0].effective?.contextLength).toBe(1_000)
    expect(bySpace.models?.[0].effective?.contextLength).toBe(2_000)
  })
})

/**
 * 批 3 §6.3:接口不报参数时从 models.dev 认亲,只在 unknown 的格上给建议;
 * 用户一旦覆盖那一格,那一格的建议就没了。
 */
describe('models RPC domain — 参数建议(§6.3)', () => {
  const SNAPSHOT = {
    fetchedAt: 42,
    data: {
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5.5': {
            id: 'gpt-5.5',
            name: 'GPT-5.5',
            limit: { context: 400000, output: 128000 },
            tool_call: true,
            reasoning: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        },
      },
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.spaceSettings = {}
    mocks.modelsDevSnapshot = SNAPSHOT
  })

  function manualGpt(extra: Record<string, unknown> = {}) {
    mocks.settings = { ai: { providers: { 'custom-relay': {
      selectedModels: ['gpt-5.5'], model: 'gpt-5.5',
      models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'gpt-5.5', provider: 'custom-relay', source: 'manual' } },
      ...extra,
    } } } } as unknown as AppSettings
    mocks.getModelsForProvider.mockResolvedValue([{ id: 'gpt-5.5', name: 'gpt-5.5', source: 'manual' } as OpenRouterModel])
  }

  it('手填 gpt-5.5:四格都不知道 → 按 OpenAI gpt-5.5 给上下文 / 输出 / 支持的能力', async () => {
    manualGpt()
    const response = await modelsRpcHandlers.getWithCapabilities({ providerId: 'custom-relay' })
    const row = response.models?.find(m => m.id === 'gpt-5.5')
    expect(row?.suggestion).toMatchObject({
      from: { provider: 'openai', id: 'gpt-5.5', providerName: 'OpenAI' },
      contextLength: 400000,
      maxOutput: 128000,
      capabilities: { tools: true, vision: true, reasoning: true },
    })
    // 不支持的不建议(建议一个 false 会画成「人说不支持」)。
    expect(row?.suggestion?.capabilities?.imageOutput).toBeUndefined()
  })

  it('用户覆盖过的格不再建议;全覆盖了就没有建议', async () => {
    manualGpt({ contextLengthByModel: { 'gpt-5.5': 1000 } })
    const partial = await modelsRpcHandlers.getWithCapabilities({ providerId: 'custom-relay' })
    expect(partial.models?.[0].suggestion?.contextLength).toBeUndefined()
    expect(partial.models?.[0].suggestion?.maxOutput).toBe(128000)

    manualGpt({
      contextLengthByModel: { 'gpt-5.5': 1000 },
      maxOutputByModel: { 'gpt-5.5': 1000 },
      modelCapabilitiesByModel: {
        'gpt-5.5': { tools: true, vision: true, reasoning: true, imageOutput: false, fileInput: false },
      },
    })
    const full = await modelsRpcHandlers.getWithCapabilities({ providerId: 'custom-relay' })
    expect(full.models?.[0].suggestion).toBeUndefined()
  })

  it('目录行(models.dev 说全了)不认亲,也不读快照', async () => {
    mocks.settings = { ai: { providers: { deepseek: { selectedModels: ['listed'] } } } } as unknown as AppSettings
    mocks.getModelsForProvider.mockResolvedValue([model('gpt-5.5')])
    const response = await modelsRpcHandlers.getWithCapabilities({ providerId: 'deepseek' })
    expect(response.models?.[0].suggestion).toBeUndefined()
  })
})
