import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderInfo, SpaceProviderSettings } from '@shared/ipc/providers'
import { configureModelsPort } from './models-port'
import { configureSpacesPort } from './spaces-port'
import { useWorkspaceStore } from '../workspace/store'
import type { ModelsPort } from './models-port'
import {
  buildProviderGroups,
  contextLengthOf,
  contextWindowOf,
  customProviderOptionsOf,
  defaultSelectionOf,
  modelIdsOf,
  resolveModelSelection,
  toProviderPrefs,
  useModelsSource,
} from './models-source'
import { useSessionsSource } from './sessions-source'

/**
 * 模型目录与切换(D2 波一)。三块各自钉死:
 *  ① **两道闸**(开关 + 有模型可列)—— 谁出现在抽屉里是纯判据,一台 core 都不用起;
 *  ② **懒加载** —— 目录是每家一次 RPC 的东西,同一家不许拉第二遍;
 *  ③ **选中的三态** —— 有会话上行 / 上行失败不动本地 / 草稿态暂存后补发。
 *
 * 端口用 `configureModelsPort` 换成假的(与 files-source.test 同一手),
 * 并且**记账每一次调用** —— 「拉了几次」正是这批要验的东西之一。
 */

function provider(id: string, name = id): ProviderInfo {
  return {
    id,
    name,
    description: '',
    defaultBaseUrl: '',
    defaultModel: '',
    icon: '',
    supportsCustomBaseUrl: false,
    requiresApiKey: true,
  }
}

/**
 * 只造这批判据要用的那几格;其余走 `as`。
 * 造的是**当前空间那一份** provider 设置(`workspaces/<id>/providers.json`)——
 * 09-01 起数据源读的就是它,不再是整份 AppSettings。
 */
function settingsWith(
  providers: Record<string, { enabled?: boolean; selectedModels?: string[]; model?: string }>,
  defaultProvider = '',
): SpaceProviderSettings {
  return {
    provider: defaultProvider,
    providers: Object.fromEntries(
      Object.entries(providers).map(([id, config]) => [
        id,
        { model: config.model ?? '', selectedModels: config.selectedModels ?? [], enabled: config.enabled },
      ]),
    ),
    customProviders: [],
  } as unknown as SpaceProviderSettings
}

interface FakeCalls {
  providers: number
  settings: number
  models: string[]
  updates: { sessionId: string; provider: string; model: string }[]
}

let calls: FakeCalls
let updateOk = true

function installPort(over: Partial<ModelsPort> = {}): void {
  configureModelsPort({
    ready: async () => undefined,
    listProviders: async () => {
      calls.providers += 1
      return { success: true, providers: [provider('xai', 'xAI'), provider('deepseek', 'DeepSeek')] }
    },
    listModels: async (providerId) => {
      calls.models.push(providerId)
      return {
        success: true,
        models: [
          {
            id: 'grok-4',
            name: 'Grok 4',
            context_length: 500_000,
            architecture: { modality: '', input_modalities: [], output_modalities: [], tokenizer: '' },
            pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
            top_provider: { context_length: 0, max_completion_tokens: 0, is_moderated: false },
            supported_parameters: [],
          },
        ],
      }
    },
    readProviderSettings: async () => {
      calls.settings += 1
      return {
        success: true,
        ai: settingsWith({
          xai: { selectedModels: ['grok-4'] },
          deepseek: { selectedModels: ['deepseek-chat'] },
        }),
      }
    },
    updateSessionModel: async (sessionId, providerId, model) => {
      calls.updates.push({ sessionId, provider: providerId, model })
      return updateOk ? { success: true } : { success: false, error: '后端拒绝了' }
    },
    ...over,
  })
}

beforeEach(() => {
  calls = { providers: 0, settings: 0, models: [], updates: [] }
  updateOk = true
  useModelsSource.getState().reset()
  useSessionsSource.setState({ sessions: [] })
  installPort()
})

afterEach(() => {
  configureModelsPort(undefined)
  useModelsSource.getState().reset()
})

describe('设置的窄投影', () => {
  it('只投三格;ai 缺席 = 空投影(不是「全都可见」)', () => {
    const prefs = toProviderPrefs(settingsWith({ xai: { selectedModels: ['grok-4'] } }, 'xai'))
    expect(prefs.defaultProvider).toBe('xai')
    expect(prefs.configs.xai.selectedModels).toEqual(['grok-4'])
    expect(toProviderPrefs(undefined)).toEqual({ defaultProvider: '', configs: {} })
  })

  it('自定义 provider:名册与「那一个默认模型」都要认 —— 否则抽屉是空的', () => {
    const settings = {
      provider: '',
      providers: {},
      customProviders: [{ id: 'my-llm', name: '自建', model: 'qwen-max', selectedModels: [] }],
    } as unknown as SpaceProviderSettings
    expect(customProviderOptionsOf(settings)).toEqual([{ id: 'my-llm', name: '自建' }])
    const prefs = toProviderPrefs(settings)
    expect(prefs.configs['my-llm'].selectedModels).toEqual(['qwen-max'])
    expect(
      buildProviderGroups([{ id: 'my-llm', name: '自建' }], prefs, {}, null)[0].models,
    ).toEqual([{ model: 'qwen-max', contextLength: null }])
  })
})

describe('可见的家:两道闸', () => {
  const providers = [provider('xai', 'xAI'), provider('deepseek', 'DeepSeek')]

  it('关掉的家不出现', () => {
    const prefs = toProviderPrefs(
      settingsWith({
        xai: { selectedModels: ['grok-4'] },
        deepseek: { selectedModels: ['deepseek-chat'], enabled: false },
      }),
    )
    expect(buildProviderGroups(providers, prefs, {}, null).map((g) => g.id)).toEqual(['xai'])
  })

  it('一条模型都没勾的家不出现 —— 空组头等于让人点了个寂寞', () => {
    const prefs = toProviderPrefs(
      settingsWith({ xai: { selectedModels: [] }, deepseek: { selectedModels: ['deepseek-chat'] } }),
    )
    expect(buildProviderGroups(providers, prefs, {}, null).map((g) => g.id)).toEqual(['deepseek'])
  })

  it('开关缺席 = 开着(判据在契约层的 isProviderEnabledIn,这里只是套用)', () => {
    const prefs = toProviderPrefs(settingsWith({ xai: { selectedModels: ['grok-4'] } }))
    expect(buildProviderGroups(providers, prefs, {}, null)).toHaveLength(1)
  })

  it('家族派生:订阅成员自己关着,但 API 成员开着 → 仍然可见', () => {
    const prefs = toProviderPrefs(
      settingsWith({
        kimi: { selectedModels: [], enabled: true },
        'kimi-code': { selectedModels: ['kimi-k2'], enabled: false },
      }),
    )
    const groups = buildProviderGroups([provider('kimi-code', 'Kimi Code')], prefs, {}, null)
    expect(groups.map((g) => g.id)).toEqual(['kimi-code'])
  })

  it('目录没到照样出组,只是窗口那一格是 null', () => {
    const prefs = toProviderPrefs(settingsWith({ xai: { selectedModels: ['grok-4'] } }))
    expect(buildProviderGroups(providers, prefs, {}, null)[0].models).toEqual([
      { model: 'grok-4', contextLength: null },
    ])
    const withCatalog = buildProviderGroups(
      providers,
      prefs,
      { xai: [{ id: 'grok-4', contextLength: 500_000 }] },
      null,
    )
    expect(withCatalog[0].models[0].contextLength).toBe(500_000)
  })

  it('当前模型没被勾过也排在最前 —— 正在跑的那个不该在抽屉里找不到', () => {
    const prefs = toProviderPrefs(settingsWith({ xai: { selectedModels: ['grok-4'] } }))
    expect(modelIdsOf(prefs, 'xai', { provider: 'xai', model: 'grok-4-fast' })).toEqual([
      'grok-4-fast',
      'grok-4',
    ])
  })
})

describe('窗口大小', () => {
  it('context_length 优先,缺席回落 top_provider,两处都没有 = 不知道', () => {
    const base = {
      id: 'm',
      name: 'm',
      architecture: { modality: '', input_modalities: [], output_modalities: [], tokenizer: '' },
      pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
      supported_parameters: [],
    }
    expect(
      contextLengthOf({
        ...base,
        context_length: 128_000,
        top_provider: { context_length: 64_000, max_completion_tokens: 0, is_moderated: false },
      }),
    ).toBe(128_000)
    expect(
      contextLengthOf({
        ...base,
        context_length: 0,
        top_provider: { context_length: 64_000, max_completion_tokens: 0, is_moderated: false },
      }),
    ).toBe(64_000)
    expect(
      contextLengthOf({
        ...base,
        context_length: 0,
        top_provider: { context_length: 0, max_completion_tokens: 0, is_moderated: false },
      }),
    ).toBeNull()
  })

  it('查不到的选择读作不知道(不知道是哪家 / 目录里没有这一条)', () => {
    const catalog = { xai: [{ id: 'grok-4', contextLength: 500_000 }] }
    expect(contextWindowOf(catalog, { provider: 'xai', model: 'grok-4' })).toBe(500_000)
    expect(contextWindowOf(catalog, { provider: '', model: 'grok-4' })).toBeNull()
    expect(contextWindowOf(catalog, { provider: 'xai', model: '别的' })).toBeNull()
    expect(contextWindowOf(catalog, null)).toBeNull()
  })
})

describe('当前模型:三层事实', () => {
  const prefs = toProviderPrefs(settingsWith({ xai: { model: 'grok-4', selectedModels: [] } }, 'xai'))

  it('刚选完那块牌盖过会话事实', () => {
    expect(
      resolveModelSelection(
        { s1: { provider: 'deepseek', model: 'deepseek-chat' } },
        's1',
        { provider: 'xai', model: 'grok-4' },
        null,
        prefs,
      ),
    ).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('会话事实盖过全局默认;provider 缺席也认(只是查不到窗口)', () => {
    expect(resolveModelSelection({}, 's1', { provider: null, model: 'claude-opus-5' }, null, prefs)).toEqual(
      { provider: '', model: 'claude-opus-5' },
    )
  })

  it('没有会话时读草稿态那一格', () => {
    expect(
      resolveModelSelection({}, null, undefined, { provider: 'deepseek', model: 'deepseek-chat' }, prefs),
    ).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('三层都答不上来 = null —— 不拿目录第一条去顶', () => {
    expect(defaultSelectionOf(prefs)).toEqual({ provider: 'xai', model: 'grok-4' })
    const blank = toProviderPrefs(settingsWith({}))
    expect(resolveModelSelection({}, 's1', undefined, null, blank)).toBeNull()
  })
})

describe('取数:设置热,名册与目录都冷', () => {
  it('start 只拉设置 —— **名册一发都不发**(它在后端那侧会连 models.dev)', async () => {
    await useModelsSource.getState().start()
    expect(calls.settings).toBe(1)
    expect(calls.providers).toBe(0)
    expect(calls.models).toEqual([])
  })

  it('名册在抽屉打开时才拉,而且只拉一次', async () => {
    await useModelsSource.getState().start()
    await Promise.all([
      useModelsSource.getState().ensureProviders(),
      useModelsSource.getState().ensureProviders(),
    ])
    await useModelsSource.getState().ensureProviders()
    expect(calls.providers).toBe(1)
    expect(useModelsSource.getState().providers.map((p) => p.id)).toEqual(['xai', 'deepseek'])
  })

  it('同一家的目录只拉一次(缓存 + 在飞去重)', async () => {
    await useModelsSource.getState().start()
    await Promise.all([
      useModelsSource.getState().ensureCatalog('xai'),
      useModelsSource.getState().ensureCatalog('xai'),
    ])
    await useModelsSource.getState().ensureCatalog('xai')
    expect(calls.models).toEqual(['xai'])
    expect(useModelsSource.getState().catalog.xai).toEqual([{ id: 'grok-4', contextLength: 500_000 }])
  })

  it('抽屉打开:名册 + **可见**那几家的目录一起到位', async () => {
    await useModelsSource.getState().start()
    // deepseek 关掉:它不该被拉。
    useModelsSource.setState({
      prefs: toProviderPrefs(
        settingsWith({
          xai: { selectedModels: ['grok-4'] },
          deepseek: { selectedModels: ['deepseek-chat'], enabled: false },
        }),
      ),
    })
    await useModelsSource.getState().ensureVisibleCatalogs(null)
    expect(calls.providers).toBe(1)
    expect(calls.models).toEqual(['xai'])
  })

  it('设置拿不到 = 空投影(抽屉一家都不列),不是「列全部」', async () => {
    installPort({ readProviderSettings: async () => ({ success: false, error: '答不上话' }) })
    await useModelsSource.getState().start()
    expect(useModelsSource.getState().prefs).toEqual({ defaultProvider: '', configs: {} })
  })
})

describe('选中一个模型:三态', () => {
  it('有会话 → 上行,并立牌顶着直到 listMeta 追认', async () => {
    await useModelsSource.getState().selectModel('s1', 'xai', 'grok-4')
    expect(calls.updates).toEqual([{ sessionId: 's1', provider: 'xai', model: 'grok-4' }])
    // 成功之后牌撤掉 —— 屏幕从此读会话事实那一份。
    expect(useModelsSource.getState().optimistic).toEqual({})
  })

  it('上行失败 → 撤牌,本地不动(绝不留一块后端没认下的牌)', async () => {
    updateOk = false
    await useModelsSource.getState().selectModel('s1', 'xai', 'grok-4')
    expect(calls.updates).toHaveLength(1)
    expect(useModelsSource.getState().optimistic).toEqual({})
    expect(useModelsSource.getState().pending).toBeNull()
  })

  it('草稿态 → 只记账不发请求;建会话时兑现一次并清空', async () => {
    await useModelsSource.getState().selectModel(null, 'xai', 'grok-4')
    expect(calls.updates).toEqual([])
    expect(useModelsSource.getState().pending).toEqual({ provider: 'xai', model: 'grok-4' })

    await useModelsSource.getState().applyPendingModel('new-1')
    expect(calls.updates).toEqual([{ sessionId: 'new-1', provider: 'xai', model: 'grok-4' }])
    expect(useModelsSource.getState().pending).toBeNull()
  })

  it('兑现失败也清账 —— 下下条会话不该莫名其妙地也用那个模型', async () => {
    updateOk = false
    await useModelsSource.getState().selectModel(null, 'xai', 'grok-4')
    await useModelsSource.getState().applyPendingModel('new-1')
    expect(useModelsSource.getState().pending).toBeNull()
  })

  it('没有预选时兑现是恒等,不发请求', async () => {
    await useModelsSource.getState().applyPendingModel('new-1')
    expect(calls.updates).toEqual([])
  })
})

/* ── 工作区(09-01「真切换」批)──────────────────────────────────────────── */

describe('模型表跟着当前工作区走', () => {
  /** 两个空间各一份 provider 设置 —— 可见的家与可列的型都不一样。 */
  const BY_SPACE: Record<string, SpaceProviderSettings> = {
    default: settingsWith({ xai: { selectedModels: ['grok-4'] } }, 'xai'),
    'ws-work': settingsWith({ deepseek: { selectedModels: ['deepseek-chat'] } }, 'deepseek'),
  }

  async function seedSpaces(): Promise<void> {
    configureSpacesPort({
      ready: async () => undefined,
      list: async () => ({
        success: true,
        spaces: [
          { id: 'default', name: '默认', createdAt: 0 },
          { id: 'ws-work', name: '工作', createdAt: 100 },
        ],
      }),
      create: async () => ({ success: false, error: 'not stubbed' }),
      update: async () => ({ success: true }),
      remove: async () => ({ success: true, removed: true }),
    })
    await useWorkspaceStore.getState().load()
  }

  beforeEach(() => {
    useWorkspaceStore.getState().reset()
    installPort({
      readProviderSettings: async (spaceId: string) => {
        calls.settings += 1
        return { success: true, ai: BY_SPACE[spaceId] ?? BY_SPACE.default }
      },
    })
  })

  afterEach(() => {
    useWorkspaceStore.getState().reset()
  })

  it('读的是当前空间那一份 —— 两个空间的默认模型不是同一个', async () => {
    await seedSpaces()
    useWorkspaceStore.getState().switchTo('ws-work')
    await useModelsSource.getState().start()
    expect(useModelsSource.getState().prefs.defaultProvider).toBe('deepseek')
    expect(useModelsSource.getState().prefs.configs.deepseek.selectedModels).toEqual([
      'deepseek-chat',
    ])
    // 别的空间勾的那一型在这里根本不存在 —— 这就是「两套完整独立的设置」。
    expect(useModelsSource.getState().prefs.configs.xai).toBeUndefined()
  })

  it('切过去当场换一份;**名册不重拉**(它是机器级的事实)', async () => {
    await seedSpaces()
    await useModelsSource.getState().start()
    await useModelsSource.getState().ensureProviders()
    expect(useModelsSource.getState().prefs.defaultProvider).toBe('xai')
    expect(calls.providers).toBe(1)

    useWorkspaceStore.getState().switchTo('ws-work')
    await vi.waitFor(() =>
      expect(useModelsSource.getState().prefs.defaultProvider).toBe('deepseek'),
    )
    expect(calls.providers).toBe(1)
  })
})
