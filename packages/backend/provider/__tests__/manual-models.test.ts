import { describe, expect, it } from 'vitest'
import {
  applyAddManualModel,
  applyRemoveManualModel,
  catalogFactsOf,
  createOnethingManualModelEntry,
  foldOrphansIntoManual,
  mergeRefreshedCatalog,
} from '../manual-models.js'
import {
  getOnethingModelContextLength,
  getOnethingModelsForProvider,
  onethingModelSupportsTools,
  refreshAllOnethingProviderModels,
  refreshOnethingProviderModels,
  saveOnethingProviderModels,
  type OnethingCatalogModelEntry,
  type OnethingModelCapabilityEntry,
  type OnethingModelRegistrySettingsLike,
} from '../model-registry.js'

/**
 * 批 2 · 手填模型 = 目录条目(`docs/design/provider-settings-rework-2026-09.md` §4)。
 *
 * 钉四件事:老孤儿怎么折、刷新不替人删手填、取消勾选不删行(= 条目留在目录)、✕ 的守卫。
 * 反证:把 `mergeRefreshedCatalog` 换回整体赋值 → 「刷新保留手填」三条当场红;
 * 把 `getModelEntry` 里的 `catalogFactsOf` 摘掉 → 「手填条目不编参数」红(上下文会读成 undefined 而不是 128000 兜底)。
 */

function catalogEntry(id: string, provider = 'openai'): OnethingModelCapabilityEntry {
  return {
    id,
    name: id,
    provider,
    contextLength: 200000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsImageOutput: false,
    supportsTemperature: true,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  }
}

describe('foldOrphansIntoManual', () => {
  it('纯目录(勾的全在目录里):原样交回同一个对象,不折', () => {
    const config = {
      models: { a: catalogEntry('a'), b: catalogEntry('b') } as Record<string, OnethingCatalogModelEntry>,
      selectedModels: ['a'],
      model: 'b',
    }
    expect(foldOrphansIntoManual(config, 'openai')).toBe(config)
  })

  it('有孤儿:勾了但目录没有的 id 折成参数全空的手填条目,目录原条目不动', () => {
    const models = { a: catalogEntry('a') } as Record<string, OnethingCatalogModelEntry>
    const config = { models, selectedModels: ['a', 'foo-1'], model: 'a' }
    const folded = foldOrphansIntoManual(config, 'openai')
    expect(folded).not.toBe(config)
    expect(folded.models).not.toBe(models) // 不就地改
    expect(models).not.toHaveProperty('foo-1')
    expect(folded.models?.['foo-1']).toEqual({ id: 'foo-1', name: 'foo-1', provider: 'openai', source: 'manual' })
    expect(folded.models?.a).toBe(models.a)
    expect(folded.selectedModels).toEqual(['a', 'foo-1'])
  })

  it('孤儿是当前模型(没勾):照样折;目录缺席也能折', () => {
    const folded = foldOrphansIntoManual({ selectedModels: [], model: ' my-local ' }, 'custom-1')
    expect(folded.models).toEqual({
      'my-local': { id: 'my-local', name: 'my-local', provider: 'custom-1', source: 'manual' },
    })
  })
})

describe('手填条目不编参数(能力读者读作「目录里没有」)', () => {
  it('catalogFactsOf:手填 → undefined,目录条目原样', () => {
    const e = catalogEntry('a')
    expect(catalogFactsOf(e)).toBe(e)
    expect(catalogFactsOf(createOnethingManualModelEntry('openai', 'x'))).toBeUndefined()
  })

  it('上下文走兜底 / 工具走名字规则 / 列表行只有 id 与名字', () => {
    const providers = {
      openai: { models: { 'foo-1': createOnethingManualModelEntry('openai', 'foo-1') } },
    }
    expect(getOnethingModelContextLength(providers, 'foo-1', 'openai')).toBe(128000)
    expect(onethingModelSupportsTools(providers, 'foo-1', 'openai')).toBe(true)
    const [row] = getOnethingModelsForProvider(providers, 'openai')
    expect(row).toEqual({ id: 'foo-1', name: 'foo-1', source: 'manual' })
  })
})

describe('刷新目录只替换非手填条目', () => {
  const manual = createOnethingManualModelEntry('claude', 'foo-1')

  it('mergeRefreshedCatalog:手填留下,旧目录条目被替换,同 id 时手填那条留下', () => {
    const merged = mergeRefreshedCatalog(
      { 'foo-1': manual, old: catalogEntry('old', 'claude'), clash: createOnethingManualModelEntry('claude', 'clash') },
      { fresh: catalogEntry('fresh', 'claude'), clash: catalogEntry('clash', 'claude') },
    )
    expect(Object.keys(merged).sort()).toEqual(['clash', 'foo-1', 'fresh'])
    expect(merged['foo-1']).toBe(manual)
    expect(merged.clash).toMatchObject({ source: 'manual' })
  })

  it('refreshOnethingProviderModels(models.dev)保留手填', async () => {
    const settings: OnethingModelRegistrySettingsLike = {
      ai: { providers: { claude: { models: { 'foo-1': manual, stale: catalogEntry('stale', 'claude') } } } },
    }
    await refreshOnethingProviderModels('claude', {
      getSettings: () => settings,
      saveSettings: () => {},
      fetchModelsDevData: async () => ({
        anthropic: { id: 'anthropic', name: 'Anthropic', models: { live: { id: 'live', name: 'Live' } } },
      }),
    })
    expect(Object.keys(settings.ai.providers.claude?.models ?? {}).sort()).toEqual(['foo-1', 'live'])
    expect(settings.ai.providers.claude?.models?.['foo-1']).toBe(manual)
  })

  it('refreshAll 与接口直存(saveOnethingProviderModels)同样保留手填', async () => {
    const settings: OnethingModelRegistrySettingsLike = {
      ai: { providers: {
        claude: { models: { 'foo-1': manual } },
        codex: { models: { 'bar-2': createOnethingManualModelEntry('codex', 'bar-2') } },
      } },
    }
    await refreshAllOnethingProviderModels({
      getSettings: () => settings,
      saveSettings: () => {},
      fetchModelsDevData: async () => ({
        anthropic: { id: 'anthropic', name: 'Anthropic', models: { live: { id: 'live', name: 'Live' } } },
      }),
    })
    expect(settings.ai.providers.claude?.models?.['foo-1']).toBe(manual)
    saveOnethingProviderModels('codex', [], { getSettings: () => settings, saveSettings: () => {} })
    expect(settings.ai.providers.codex?.models?.['bar-2']).toMatchObject({ source: 'manual' })
  })

  it('接口直存的条目标 source:endpoint', () => {
    const settings: OnethingModelRegistrySettingsLike = { ai: { providers: {} } }
    saveOnethingProviderModels('codex', [{
      id: 'live', name: 'Live', context_length: 1000,
      architecture: { modality: 'text', input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'x' },
      pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
      top_provider: { context_length: 1000, max_completion_tokens: 10, is_moderated: false },
      supported_parameters: [],
    }], { getSettings: () => settings, saveSettings: () => {} })
    expect(settings.ai.providers.codex?.models?.live).toMatchObject({ source: 'endpoint' })
  })
})

describe('applyAddManualModel', () => {
  it('目录里没有:写一条手填条目并勾上', () => {
    const r = applyAddManualModel({ models: {} as Record<string, OnethingCatalogModelEntry>, selectedModels: ['a'], model: 'a' }, 'openai', ' foo-1 ')
    expect(r).toMatchObject({ ok: true })
    if (!r.ok) return
    expect(r.config.selectedModels).toEqual(['a', 'foo-1'])
    expect(r.config.models?.['foo-1']).toMatchObject({ source: 'manual' })
  })

  it('已经勾着 = duplicate;空 id = empty;目录里有但没勾 = 只勾,不另造一条', () => {
    expect(applyAddManualModel({ selectedModels: ['a'] }, 'openai', 'a')).toEqual({ ok: false, reason: 'duplicate' })
    expect(applyAddManualModel({ selectedModels: [] }, 'openai', '  ')).toEqual({ ok: false, reason: 'empty' })
    const b = catalogEntry('b')
    const r = applyAddManualModel({ models: { b }, selectedModels: [] }, 'openai', 'b')
    expect(r.ok && r.config.models?.b).toBe(b)
  })
})

describe('取消勾选不删条目 / ✕ 的守卫', () => {
  it('取消勾选只动 selectedModels:条目仍在目录(再折一次也不会丢)', () => {
    const added = applyAddManualModel({ models: {} as Record<string, OnethingCatalogModelEntry>, selectedModels: ['a'], model: 'a' }, 'openai', 'foo-1')
    if (!added.ok) throw new Error('add failed')
    const unticked = { ...added.config, selectedModels: added.config.selectedModels.filter((id) => id !== 'foo-1') }
    expect(foldOrphansIntoManual(unticked, 'openai').models?.['foo-1']).toMatchObject({ source: 'manual' })
  })

  it('删手填:条目删掉、从勾选去掉;是当前模型时换到第一个勾选的', () => {
    const r = applyRemoveManualModel({
      models: { 'foo-1': createOnethingManualModelEntry('openai', 'foo-1'), a: catalogEntry('a') },
      selectedModels: ['foo-1', 'a'],
      model: 'foo-1',
    }, 'openai', 'foo-1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.models).not.toHaveProperty('foo-1')
    expect(r.config.selectedModels).toEqual(['a'])
    expect(r.config.model).toBe('a')
  })

  it('勾着的最后一个不许删;没勾的手填随时能删;目录条目不许经这一口删', () => {
    const manual = createOnethingManualModelEntry('openai', 'foo-1')
    expect(applyRemoveManualModel({ models: { 'foo-1': manual }, selectedModels: ['foo-1'], model: 'foo-1' }, 'openai', 'foo-1'))
      .toEqual({ ok: false, reason: 'last-selected' })
    expect(applyRemoveManualModel({ models: { 'foo-1': manual }, selectedModels: [], model: '' }, 'openai', 'foo-1').ok)
      .toBe(true)
    expect(applyRemoveManualModel({ models: { a: catalogEntry('a') }, selectedModels: ['a', 'b'] }, 'openai', 'a'))
      .toEqual({ ok: false, reason: 'not-manual' })
  })

  it('老孤儿(盘上没有条目)也能被 ✕ 删掉 —— 先折再删', () => {
    const r = applyRemoveManualModel({ models: {}, selectedModels: ['a', 'ghost'], model: 'a' }, 'openai', 'ghost')
    expect(r.ok && r.config.selectedModels).toEqual(['a'])
  })
})
