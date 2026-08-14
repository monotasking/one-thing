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

vi.mock('../../auth/auth-service.js', () => ({
  authService: {
    getToken: vi.fn(),
    refreshTokenIfNeeded: mocks.refreshTokenIfNeeded,
  },
}))

vi.mock('../../providers/model-registry.js', () => ({
  forceRefresh: vi.fn(),
  getAllModels: vi.fn(),
  getModelDisplayName: vi.fn(),
  getModelNameAliases: vi.fn(),
  getModelsForProvider: mocks.getModelsForProvider,
  saveProviderModels: mocks.saveProviderModels,
  searchModels: vi.fn(),
}))

vi.mock('../../providers/builtin/codex.js', () => ({
  fetchCodexModels: mocks.fetchCodexModels,
  getCodexFallbackModels: mocks.getCodexFallbackModels,
}))

vi.mock('../../providers/builtin/github-copilot.js', () => ({
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
})
