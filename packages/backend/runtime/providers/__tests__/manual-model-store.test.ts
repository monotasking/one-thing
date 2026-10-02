import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc.js'

/**
 * 批 2 手填模型的装配半边:`models.addManual` / `removeManual` 两半一发写完,
 * 以及 `spaces.setProviderSettings` 随手落盘(写前 ∪ 写后)。设置仓换成内存里的一份:
 * 这一组钉的是「写什么、写几发」,拆分落盘本身由 `stores/settings.ts` 的测试管。
 */
const state = vi.hoisted(() => ({
  settings: {} as AppSettings,
  saves: [] as Array<{ settings: AppSettings; spaceId?: string }>,
}))

vi.mock('@onething/backend/stores/settings.js', () => ({
  getSettings: () => state.settings,
  getSpaceSettings: () => state.settings,
  saveSettings: (settings: AppSettings, options?: { spaceId?: string }) => {
    state.saves.push({ settings, spaceId: options?.spaceId })
    state.settings = settings
  },
}))
vi.mock('@onething/backend/runtime/spaces/store', () => ({
  getSpacesStore: () => ({ list: () => [{ id: 'work' }] }),
}))
vi.mock('@onething/backend/runtime/spaces/provider-settings', () => ({
  readSpaceProviderSettings: () => null,
  createEmptySpaceProviderSettings: () => ({ provider: '', providers: {}, customProviders: [] }),
}))

const { addManualModel, foldedCatalogFor, persistManualOrphans, removeManualModel } = await import(
  '../manual-model-store.js'
)

function seed(providers: Record<string, unknown>): void {
  state.settings = { ai: { provider: 'openai', temperature: 0.7, providers, customProviders: [], modelCatalog: {} } } as unknown as AppSettings
  state.saves = []
}

const catalogA = {
  id: 'a', name: 'a', provider: 'openai', contextLength: 1, maxOutputTokens: 1,
  supportsTools: true, supportsVision: false, supportsReasoning: false, supportsImageOutput: false,
  supportsTemperature: true, inputModalities: ['text'], outputModalities: ['text'],
  pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

describe('models.addManual / removeManual(装配半边)', () => {
  beforeEach(() => seed({ openai: { model: 'a', selectedModels: ['a'], models: { a: catalogA } } }))

  it('手填 foo-1:一发写完 —— 目录多一条手填条目,这个空间勾上', () => {
    const response = addManualModel({ providerId: 'openai', modelId: 'foo-1', spaceId: 'work' })
    expect(response.success).toBe(true)
    expect(state.saves).toHaveLength(1)
    expect(state.saves[0].spaceId).toBe('work')
    const config = state.settings.ai.providers.openai
    expect(config.selectedModels).toEqual(['a', 'foo-1'])
    expect(config.models?.['foo-1']).toEqual({ id: 'foo-1', name: 'foo-1', provider: 'openai', source: 'manual' })
    expect(config.models?.a).toEqual(catalogA)
  })

  it('未知空间 / 重复:结构化拒绝,一发都不写', () => {
    expect(addManualModel({ providerId: 'openai', modelId: 'x', spaceId: 'nope' })).toMatchObject({ success: false, reason: 'unknown-space' })
    expect(addManualModel({ providerId: 'openai', modelId: 'a' })).toMatchObject({ success: false, reason: 'duplicate' })
    expect(state.saves).toHaveLength(0)
  })

  it('✕:条目删掉、当前模型换人;勾着的最后一个被拒', () => {
    addManualModel({ providerId: 'openai', modelId: 'foo-1' })
    state.settings.ai.providers.openai = { ...state.settings.ai.providers.openai, model: 'foo-1' }
    const removed = removeManualModel({ providerId: 'openai', modelId: 'foo-1' })
    expect(removed.success).toBe(true)
    const config = state.settings.ai.providers.openai
    expect(config.models).not.toHaveProperty('foo-1')
    expect(config.selectedModels).toEqual(['a'])
    expect(config.model).toBe('a')

    seed({ openai: { model: 'solo', selectedModels: ['solo'], models: {} } })
    expect(removeManualModel({ providerId: 'openai', modelId: 'solo' })).toMatchObject({ success: false, reason: 'last-selected' })
  })
})

describe('老孤儿:读时折、写时随手落盘', () => {
  it('foldedCatalogFor 在内存里折,不写盘', () => {
    seed({ openai: { model: 'a', selectedModels: ['a', 'ghost'], models: { a: catalogA } } })
    expect(foldedCatalogFor('openai').ghost).toMatchObject({ source: 'manual' })
    expect(state.saves).toHaveLength(0)
  })

  it('取消勾选一个老孤儿:按写前 ∪ 写后折,条目落盘,行不丢', () => {
    seed({ openai: { model: 'a', selectedModels: ['a'], models: { a: catalogA } } })
    const previous = { providers: { openai: { model: 'a', selectedModels: ['a', 'ghost'] } } }
    const next = { providers: { openai: { model: 'a', selectedModels: ['a'] } } }
    persistManualOrphans(previous, next)
    expect(state.saves).toHaveLength(1)
    expect(state.settings.ai.providers.openai.models?.ghost).toMatchObject({ source: 'manual' })
    expect(state.settings.ai.providers.openai.selectedModels).toEqual(['a'])
  })

  it('没有可折的就一发都不写', () => {
    seed({ openai: { model: 'a', selectedModels: ['a'], models: { a: catalogA } } })
    persistManualOrphans({ providers: { openai: { selectedModels: ['a'] } } }, { providers: { openai: { selectedModels: [] } } })
    expect(state.saves).toHaveLength(0)
  })
})
