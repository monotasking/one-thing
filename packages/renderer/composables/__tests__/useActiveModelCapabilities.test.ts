// @vitest-environment happy-dom
import { nextTick, reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useActiveModelCapabilities } from '../useActiveModelCapabilities'

const mocks = vi.hoisted(() => ({
  settingsStore: null as any,
  getModelCapabilities: vi.fn(),
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => mocks.settingsStore,
}))

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({ getSessionItem: () => null }),
}))

vi.mock('@/stores/agents', () => ({
  useAgentsStore: () => ({ getAgent: () => null }),
}))

vi.mock('@/platform/models-client', () => ({
  modelsApi: {
    getModelCapabilities: (providerId: string, model: string) =>
      mocks.getModelCapabilities(providerId, model),
  },
}))

/** probe 缓存是模块级的(同一条 provider+model 只问一次),用例之间换模型名。 */
let modelCounter = 0
function nextModelId(): string {
  modelCounter += 1
  return `probe-model-${modelCounter}`
}

function mountWith(modelId: string) {
  mocks.settingsStore = reactive({
    settings: {
      ai: {
        provider: 'openai',
        providers: { openai: { model: modelId } },
      },
    },
    // 目录说「认图」——`supportsVision` 与从前一样只读账本。
    getCachedModels: vi.fn(() => [{
      id: modelId,
      architecture: { input_modalities: ['text', 'image'] },
    }]),
  })
  return useActiveModelCapabilities(() => undefined)
}

describe('useActiveModelCapabilities.supportsFiles', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('takes the transport answer over the vision alias', async () => {
    const modelId = nextModelId()
    mocks.getModelCapabilities.mockResolvedValue({
      success: true,
      capabilities: { supportsVision: true, supportsFiles: false, supportsImageOutput: false },
    })

    const capabilities = mountWith(modelId)
    // 问到之前:退回旧的 vision 别名(不因为还在飞就把文件口关掉)。
    expect(capabilities.supportsVision.value).toBe(true)
    expect(capabilities.supportsFiles.value).toBe(true)

    await vi.waitFor(async () => {
      await nextTick()
      expect(capabilities.supportsFiles.value).toBe(false)
    })
    expect(mocks.getModelCapabilities).toHaveBeenCalledWith('openai', modelId)
    // 认不认图仍然是账本的答案,这条通道不改它。
    expect(capabilities.supportsVision.value).toBe(true)
  })

  it('falls back to the vision alias when the channel has no answer', async () => {
    const modelId = nextModelId()
    mocks.getModelCapabilities.mockRejectedValue(new Error('no rpc here'))

    const capabilities = mountWith(modelId)
    await vi.waitFor(async () => {
      await nextTick()
      expect(mocks.getModelCapabilities).toHaveBeenCalled()
    })
    await nextTick()

    expect(capabilities.supportsFiles.value).toBe(true)
  })

  it('honours a positive transport answer the catalog would have denied', async () => {
    const modelId = nextModelId()
    mocks.getModelCapabilities.mockResolvedValue({
      success: true,
      capabilities: { supportsVision: false, supportsFiles: true, supportsImageOutput: false },
    })

    mocks.settingsStore = reactive({
      settings: { ai: { provider: 'openai', providers: { openai: { model: modelId } } } },
      // 目录说「不认图」——从前 supportsFiles 会跟着变成 false。
      getCachedModels: vi.fn(() => [{
        id: modelId,
        architecture: { input_modalities: ['text'] },
      }]),
    })
    const capabilities = useActiveModelCapabilities(() => undefined)

    await vi.waitFor(async () => {
      await nextTick()
      expect(capabilities.supportsFiles.value).toBe(true)
    })
    expect(capabilities.supportsVision.value).toBe(false)
  })
})
