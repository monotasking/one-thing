/**
 * 千问 model refresh. The catalog is the part most likely to rot silently: the
 * provider id is `qwen` but models.dev keys the same vendor four ways, so a
 * refresh that ignores region/plan writes a plausible-looking but wrong model
 * list (e.g. no qwen3.8-max, or Beijing-only models for an 海外版 account).
 */
import { describe, expect, it } from 'vitest'
import {
  getRefreshableOnethingProviderIds,
  refreshAllOnethingProviderModels,
  refreshOnethingProviderModels,
  type OnethingModelsDevResponse,
} from '../model-registry.js'

/** Four catalogs, each with a marker model that exists in it and nowhere else. */
const MODELS_DEV: OnethingModelsDevResponse = {
  'alibaba-cn': {
    id: 'alibaba-cn',
    name: 'Alibaba (China)',
    models: {
      'qwen3.7-plus': {
        id: 'qwen3.7-plus',
        name: 'Qwen3.7 Plus',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000000, output: 32768 },
      },
      'glm-5.2': { id: 'glm-5.2', name: 'GLM-5.2', reasoning: true, tool_call: true },
    },
  },
  alibaba: {
    id: 'alibaba',
    name: 'Alibaba',
    models: {
      'qwen3.7-plus': { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', reasoning: true, tool_call: true },
    },
  },
  'alibaba-token-plan-cn': {
    id: 'alibaba-token-plan-cn',
    name: 'Alibaba Token Plan (China)',
    models: {
      'qwen3.8-max': { id: 'qwen3.8-max', name: 'Qwen3.8 Max', reasoning: true, tool_call: true },
    },
  },
  'alibaba-token-plan': {
    id: 'alibaba-token-plan',
    name: 'Alibaba Token Plan',
    models: {
      'qwen3.8-max': { id: 'qwen3.8-max', name: 'Qwen3.8 Max', reasoning: true, tool_call: true },
    },
  },
  'alibaba-coding-plan-cn': {
    id: 'alibaba-coding-plan-cn',
    name: 'Alibaba Coding Plan (China)',
    models: {
      'qwen3-coder-plus': { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', tool_call: true },
    },
  },
  'alibaba-coding-plan': {
    id: 'alibaba-coding-plan',
    name: 'Alibaba Coding Plan',
    models: {
      'qwen3-coder-plus': { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', tool_call: true },
    },
  },
  anthropic: { id: 'anthropic', name: 'Anthropic', models: {} },
}

function settingsWith(qwen: Record<string, unknown>) {
  return { ai: { providers: { qwen, claude: {} } } }
}

function adaptersFor(settings: ReturnType<typeof settingsWith>) {
  return {
    getSettings: () => settings,
    saveSettings: () => {},
    fetchModelsDevData: async () => MODELS_DEV,
    now: () => 1_700_000_000_000,
  }
}

async function refreshedModelIds(qwen: Record<string, unknown>): Promise<string[]> {
  const settings = settingsWith(qwen)
  await refreshOnethingProviderModels('qwen', adaptersFor(settings))
  return Object.keys(settings.ai.providers.qwen.models ?? {}).sort()
}

describe('qwen model refresh follows region + plan', () => {
  it('defaults to the 国内版 pay-as-you-go catalog', async () => {
    // Catalog rows + the Qwen3.8 backfill (see the dedicated cases below).
    expect(await refreshedModelIds({})).toEqual([
      'glm-5.2',
      'qwen3.7-plus',
      'qwen3.8-max',
      'qwen3.8-max-preview',
    ])
  })

  it('switches catalog with the region', async () => {
    // 海外版 does not resell GLM — the marker model must disappear.
    expect(await refreshedModelIds({ qwenRegion: 'intl' })).toEqual([
      'qwen3.7-plus',
      'qwen3.8-max',
      'qwen3.8-max-preview',
    ])
  })

  it('switches catalog with the plan', async () => {
    // qwen3.8-max only exists under Token Plan.
    expect(await refreshedModelIds({ qwenApiMode: 'token-plan' })).toEqual(['qwen3.8-max'])
    expect(
      await refreshedModelIds({ qwenApiMode: 'token-plan', qwenRegion: 'intl' }),
    ).toEqual(['qwen3.8-max'])

    // Coding Plan is a third, much narrower catalog.
    expect(await refreshedModelIds({ qwenApiMode: 'coding-plan' })).toEqual([
      'qwen3-coder-plus',
    ])
    expect(
      await refreshedModelIds({ qwenApiMode: 'coding-plan', qwenRegion: 'intl' }),
    ).toEqual(['qwen3-coder-plus'])
  })

  it('carries capabilities and stamps the fetch time', async () => {
    const settings = settingsWith({})
    await refreshOnethingProviderModels('qwen', adaptersFor(settings))
    const config = settings.ai.providers.qwen as Record<string, any>
    expect(config.models['qwen3.7-plus']).toMatchObject({
      provider: 'qwen',
      supportsReasoning: true,
      supportsTools: true,
      supportsVision: true,
      contextLength: 1000000,
    })
    expect(config.modelsLastFetched).toBe(1_700_000_000_000)
  })

  it('backfills the Qwen3.8 flagship the pay-as-you-go catalogs still lack', async () => {
    // alibaba-cn / alibaba have no qwen3.8-* rows in MODELS_DEV above, matching
    // the real upstream gap.
    const cn = await refreshedModelIds({})
    expect(cn).toContain('qwen3.8-max')
    expect(cn).toContain('qwen3.8-max-preview')
    expect(await refreshedModelIds({ qwenRegion: 'intl' })).toContain('qwen3.8-max')
  })

  it('carries real capabilities and pay-as-you-go pricing on the backfill', async () => {
    const settings = settingsWith({})
    await refreshOnethingProviderModels('qwen', adaptersFor(settings))
    expect((settings.ai.providers.qwen as any).models['qwen3.8-max']).toMatchObject({
      provider: 'qwen',
      name: 'Qwen3.8 Max',
      supportsReasoning: true,
      supportsVision: true,
      supportsTools: true,
      supportsTemperature: true,
      contextLength: 1000000,
      maxOutputTokens: 131072,
      // Vendor USD list price. Zero here would mean we silently borrowed the
      // Token Plan row, which prices a subscription at nothing.
      pricing: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
    })
  })

  it('never backfills into a subscription catalog', async () => {
    // Both plans ship their own allowlist; a model the plan does not cover
    // would show in the picker and then 4xx.
    for (const qwenApiMode of ['token-plan', 'coding-plan'] as const) {
      for (const qwenRegion of ['cn', 'intl'] as const) {
        expect(await refreshedModelIds({ qwenApiMode, qwenRegion }))
          .not.toContain('qwen3.8-max-preview')
      }
    }
    expect(await refreshedModelIds({ qwenApiMode: 'coding-plan' }))
      .not.toContain('qwen3.8-max')
  })

  it('lets a real catalog entry outrank the backfill', async () => {
    const data = JSON.parse(JSON.stringify(MODELS_DEV))
    data['alibaba-cn'].models['qwen3.8-max'] = {
      id: 'qwen3.8-max',
      name: 'Qwen3.8 Max (upstream)',
      reasoning: true,
      tool_call: true,
      cost: { input: 9, output: 9 },
    }
    const settings = settingsWith({})
    await refreshOnethingProviderModels('qwen', {
      ...adaptersFor(settings),
      fetchModelsDevData: async () => data,
    })
    const entry = (settings.ai.providers.qwen as any).models['qwen3.8-max']
    expect(entry.name).toBe('Qwen3.8 Max (upstream)')
    expect(entry.pricing.input).toBe(9)
  })

  it('is included in the refresh-all sweep the settings UI triggers', async () => {
    const settings = settingsWith({ qwenApiMode: 'token-plan' })
    expect(getRefreshableOnethingProviderIds(settings.ai.providers)).toContain('qwen')

    await refreshAllOnethingProviderModels(adaptersFor(settings))
    expect(Object.keys(settings.ai.providers.qwen.models ?? {})).toEqual(['qwen3.8-max'])
  })
})
