import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AppSettings } from '@/types'
import { useModelLedger, STYLE_PRESET_TEMPERATURES } from '../useModelLedger'

const stores = vi.hoisted(() => ({
  cachedModels: {} as Record<string, any[]>,
  addCustomModelToCache: vi.fn(),
  preloadModels: vi.fn(async () => {}),
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    getCachedModels: (providerId: string) => stores.cachedModels[providerId] ?? [],
    getModelDisplayName: (modelId: string) => modelId,
    preloadModels: stores.preloadModels,
    addCustomModelToCache: stores.addCustomModelToCache,
    isCustomProvider: () => false,
  }),
}))

function model(id: string, maxCompletion = 16384) {
  return {
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
    top_provider: { context_length: 128000, max_completion_tokens: maxCompletion, is_moderated: false },
    supported_parameters: ['temperature', 'tools'],
  }
}

function createSettings(): AppSettings {
  return {
    ai: {
      provider: 'openai',
      temperature: 0.7,
      providers: {
        openai: {
          enabled: true,
          apiKey: 'sk-openai',
          baseUrl: '',
          selectedModels: ['gpt-4o', 'o4-mini'],
          model: 'gpt-4o',
          temperatureByModel: { 'o4-mini': 0.4 },
          maxOutputByModel: { 'o4-mini': 2048 },
        },
        deepseek: {
          enabled: true,
          apiKey: 'sk-deepseek',
          baseUrl: '',
          selectedModels: ['deepseek-chat'],
          model: 'deepseek-chat',
        },
        anthropic: {
          enabled: false,
          apiKey: '',
          baseUrl: '',
          selectedModels: ['claude-sonnet'],
          model: 'claude-sonnet',
        },
      },
      customProviders: [],
    },
  } as any
}

const providers = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'anthropic', name: 'Anthropic' },
] as any[]

function createLedger(settings = createSettings()) {
  const updates: AppSettings[] = []
  const ledger = useModelLedger(
    { settings, providers },
    (_event, value) => updates.push(value),
  )
  return { ledger, updates }
}

// 总账从批 B7 起经「当前空间的 provider 视图」取 selectedModels,那条路上有两个
// pinia store。C1 之后**「选了哪些 / 默认是哪个」一律写空间 overlay**,不再进
// settings —— 这份测试没有 mock `@/platform`,所以那条写路是哑的,它钉的是
// **还留在 settings 里的那一半**(逐模型 override 表)。overlay 那一半由
// `provider-defaults.space.test.ts` 与 `space-provider-view.test.ts` 钉。
beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useModelLedger', () => {
  it('aggregates rows across enabled providers only', () => {
    stores.cachedModels = { openai: [model('gpt-4o'), model('o4-mini')], deepseek: [] }
    const { ledger } = createLedger()

    expect(ledger.rows.value.map((row) => row.key)).toEqual([
      'openai::gpt-4o',
      'openai::o4-mini',
      'deepseek::deepseek-chat',
    ])
    // deepseek-chat is not in its catalog → treated as hand-added.
    expect(ledger.rows.value[2].isCustom).toBe(true)
    // Only the default provider's active model gets the star.
    expect(ledger.rows.value.filter((row) => row.isDefault).map((row) => row.key)).toEqual([
      'openai::gpt-4o',
    ])
  })

  it('setDefault no longer touches settings — the default lives in the space overlay (C1)', () => {
    stores.cachedModels = { openai: [model('gpt-4o'), model('o4-mini')], deepseek: [] }
    const { ledger, updates } = createLedger()

    ledger.setDefault(ledger.rows.value[2])

    expect(updates).toEqual([])
  })

  it('maps style presets onto temperatureByModel and clears on default', () => {
    stores.cachedModels = { openai: [model('gpt-4o'), model('o4-mini')], deepseek: [] }
    const { ledger, updates } = createLedger()
    const gpt4o = ledger.rows.value[0]
    const o4mini = ledger.rows.value[1]

    expect(ledger.styleState(gpt4o)).toBe('default')
    expect(ledger.effectiveTemperature(gpt4o)).toBe(0.7)
    expect(ledger.styleState(o4mini)).toBe('custom')
    expect(ledger.effectiveTemperature(o4mini)).toBe(0.4)

    ledger.setStylePreset(gpt4o, 'precise')
    expect(updates[0].ai.providers.openai.temperatureByModel!['gpt-4o']).toBe(
      STYLE_PRESET_TEMPERATURES.precise,
    )

    ledger.setStylePreset(o4mini, null)
    expect(updates[1].ai.providers.openai.temperatureByModel).toBeUndefined()
  })

  it('maps output presets onto maxOutputByModel with standard = no override', () => {
    stores.cachedModels = { openai: [model('gpt-4o'), model('o4-mini')], deepseek: [] }
    const { ledger, updates } = createLedger()
    const gpt4o = ledger.rows.value[0]
    const o4mini = ledger.rows.value[1]

    expect(ledger.outputState(gpt4o)).toBe('standard')
    expect(ledger.effectiveMaxOutput(gpt4o)).toBe(8192)
    expect(ledger.outputState(o4mini)).toBe('custom')

    ledger.setOutputPreset(gpt4o, 'max')
    expect(updates[0].ai.providers.openai.maxOutputByModel!['gpt-4o']).toBe(16384)

    ledger.setOutputPreset(o4mini, 'standard')
    expect(updates[1].ai.providers.openai.maxOutputByModel).toBeUndefined()
  })

  it('refuses to remove a provider’s last model; the removal itself goes to the space overlay (C1)', () => {
    stores.cachedModels = { openai: [model('gpt-4o'), model('o4-mini')], deepseek: [] }
    const { ledger, updates } = createLedger()

    expect(ledger.removeModel(ledger.rows.value[2])).toEqual({ ok: false, reason: 'last' })
    expect(updates).toHaveLength(0)

    expect(ledger.removeModel(ledger.rows.value[0]).ok).toBe(true)
    // id 清单按空间走,settings 一个字节都不动。
    expect(updates).toEqual([])
  })

  it('renames a hand-added model, migrating per-model override maps', () => {
    stores.cachedModels = { openai: [model('gpt-4o')], deepseek: [] }
    const settings = createSettings()
    const { ledger, updates } = createLedger(settings)
    const o4mini = ledger.rows.value[1]
    expect(o4mini.isCustom).toBe(true)

    expect(ledger.renameModel(o4mini, 'gpt-4o')).toEqual({ ok: false, reason: 'duplicate' })

    const result = ledger.renameModel(o4mini, 'o4-mini-2026')
    expect(result.ok).toBe(true)
    const next = updates[0].ai.providers.openai
    // C1:id 清单迁去空间 overlay;逐模型 override 表是全局共享的,留在 settings。
    expect(next.selectedModels).toEqual(['gpt-4o', 'o4-mini'])
    expect(next.temperatureByModel).toEqual({ 'o4-mini-2026': 0.4 })
    expect(next.maxOutputByModel).toEqual({ 'o4-mini-2026': 2048 })
    expect(stores.addCustomModelToCache).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ id: 'o4-mini-2026' }),
    )
  })
})
