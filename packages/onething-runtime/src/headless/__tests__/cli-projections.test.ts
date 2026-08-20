import { describe, expect, it } from 'vitest'
import {
  listOnethingHeadlessProviderModels,
  listOnethingHeadlessProviderSummaries,
  listOnethingHeadlessSessionSummaries,
  listOnethingHeadlessToolSummaries,
  setOnethingHeadlessPermissionMode,
  updateOnethingHeadlessToolSetting,
  upsertOnethingHeadlessProviderConfig,
  useOnethingHeadlessProvider,
} from '../cli-projections.js'
import {
  composeEffectiveAISettings,
  createEmptySpaceProviderSettings,
  splitEffectiveAISettings,
} from '@shared/defaults/ai-settings.js'

describe('headless CLI projections', () => {
  it('projects session summaries for daemon clients', () => {
    expect(listOnethingHeadlessSessionSummaries([{
      id: 's1',
      name: 'Chat',
      createdAt: 1,
      updatedAt: 2,
      previewText: 'hello',
      messageCount: 3,
      isPinned: true,
      isArchived: false,
      lastProvider: 'openai',
      lastModel: 'gpt',
    }])).toEqual([{
      id: 's1',
      name: 'Chat',
      createdAt: 1,
      updatedAt: 2,
      previewText: 'hello',
      messageCount: 3,
      isPinned: true,
      isArchived: false,
      lastProvider: 'openai',
      lastModel: 'gpt',
    }])
  })

  it('owns provider summaries, selection, upsert, and model ordering', () => {
    const settings = {
      ai: {
        provider: 'openai',
        providers: {
          openai: {
            enabled: true,
            model: 'gpt-4.1',
            selectedModels: ['gpt-4.1-mini'],
            models: {
              'gpt-4.1': {},
              'gpt-5': {},
            },
          },
        },
      },
      tools: { permissionMode: 'normal', tools: {} },
    }

    expect(listOnethingHeadlessProviderSummaries(settings)).toEqual([{
      id: 'openai',
      model: 'gpt-4.1',
      enabled: true,
      selectedModels: ['gpt-4.1-mini'],
      isDefault: true,
    }])

    expect(listOnethingHeadlessProviderModels(settings, 'openai')).toEqual([
      'gpt-4.1-mini',
      'gpt-4.1',
      'gpt-5',
    ])

    expect(useOnethingHeadlessProvider(settings, 'openai', 'gpt-5')).toMatchObject({
      id: 'openai',
      model: 'gpt-5',
      isDefault: true,
    })

    expect(upsertOnethingHeadlessProviderConfig(
      settings,
      'custom',
      { enabled: true, model: 'local' },
      () => ({ model: '', selectedModels: [] }),
    )).toEqual({
      id: 'custom',
      enabled: true,
      model: 'local',
      selectedModels: [],
      isDefault: false,
    })
  })

  it('拒绝选一个没开的 provider —— 不翻默认、不往 providers.json 里种壳', () => {
    // 空间只配了一个自定义 provider。`claude-code-agent` 只是「目录里认识」,
    // 合成给它补了一条全灭壳 —— 有名字,不代表这个空间配过它。
    const effectiveAi = composeEffectiveAISettings(
      {
        temperature: 0.7,
        modelCatalog: { 'claude-code-agent': { modelsLastFetched: 1 } },
      },
      {
        ...createEmptySpaceProviderSettings(),
        provider: 'custom',
        providers: {
          custom: { model: 'my-model', selectedModels: ['my-model'], enabled: true },
        },
      },
    )
    expect(effectiveAi.providers['claude-code-agent']).toMatchObject({ enabled: false })

    const settings = { ai: effectiveAi, tools: { permissionMode: 'normal', tools: {} } }
    expect(() => useOnethingHeadlessProvider(settings, 'claude-code-agent', 'claude-sonnet'))
      .toThrow(/not enabled/)

    // ① 默认 provider 没被翻掉。
    expect(effectiveAi.provider).toBe('custom')
    // ② 展示壳没被盖上 model —— 一旦盖上就骗过 `isBlankProviderRecord`,
    //    整条壳会跟着落盘,真机上表现为「用的模型 ≠ 界面显示的模型」。
    expect(effectiveAi.providers['claude-code-agent'].model).toBe('')

    const { space } = splitEffectiveAISettings(effectiveAi)
    expect(space.provider).toBe('custom')
    expect(space.providers['claude-code-agent']).toBeUndefined()
    expect(Object.keys(space.providers)).toEqual(['custom'])
  })

  it('owns tool summaries, tool setting updates, and permission mode mutation', () => {
    const settings = {
      ai: { providers: {} },
      tools: {
        permissionMode: 'normal',
        tools: {
          bash: { enabled: true, autoExecute: false },
        },
      },
    }

    expect(listOnethingHeadlessToolSummaries([{
      id: 'bash',
      name: 'Bash',
      enabled: true,
      autoExecute: false,
      category: 'builtin',
    }])).toEqual([{
      id: 'bash',
      name: 'Bash',
      enabled: true,
      autoExecute: false,
      category: 'builtin',
    }])

    updateOnethingHeadlessToolSetting(settings, 'bash', { autoExecute: true })
    expect(settings.tools.tools.bash).toEqual({ enabled: true, autoExecute: true })

    expect(setOnethingHeadlessPermissionMode(settings, 'auto').tools.permissionMode).toBe('auto')
  })
})
