import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenRouterModel, ProviderInfo, SpaceProviderSettings } from '@shared/ipc/providers'
import { configureModelsPort } from './models-port'
import { configureProviderSettingsPort } from './provider-settings-port'
import { configureSpacesPort } from './spaces-port'
import { openRouterModel as model } from './__fixtures__/models'
import { fakeProviderPort } from '../providers/__tests__/fake-port'
import { catalogQuery } from '../providers/catalog-query'
import { useNotifyStore } from '../services/notify-store'
import { useWorkspaceStore } from '../workspace/store'
import type { ModelsPort } from './models-port'
import {
  buildProviderGroups,
  contextLengthOf,
  contextWindowOf,
  customProviderOptionsOf,
  defaultSelectionOf,
  ensureCatalog,
  ensureVisibleCatalogs,
  mergeProviderOptions,
  modelIdsOf,
  modelMutation,
  prefsQuery,
  providersQuery,
  resolveModelSelection,
  selectKey,
  toCatalogModels,
  toProviderPrefs,
  useModelsSource,
} from './models-source'
import { useSessionsSource } from './sessions-source'

/**
 * 模型目录与切换(D2 波一,批 7b 迁 kernel 原语)。四块各自钉死:
 *  ① **两道闸**(开关 + 有模型可列)—— 谁出现在抽屉里是纯判据,一台 core 都不用起;
 *  ② **懒加载与键控** —— 设置一空间一格、名册一格、目录一家一格,各拉各的;
 *  ③ **目录只有一格** —— 设置面与模型抽屉共用 `providers/catalog-query.ts`,
 *     一边拉过另一边就不再发(批 7b 的合并守卫);
 *  ④ **写路三态** —— 有会话上行 / 上行失败回滚 + notify / 草稿态暂存后补发,
 *     外加律③那两条(settle 排在重拉之后、在飞不接第二发)。
 *
 * 端口用 `configureModelsPort` / `configureProviderSettingsPort` 换成假的
 * (与 files-source.test 同一手),并且**记账每一次调用** ——
 * 「拉了几次」正是这批要验的东西之一。
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
    readSettings: async () => ({
      success: true,
      settings: { storage: { spaceProviderSettingsMigratedAt: 1 } } as never,
    }),
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

/**
 * 目录那一格走的是**设置面那条端口**(批 7b 合并之后只有这一个产地)。
 * 记账同一本 `calls.models` —— 「一共发了几发目录」这件事不该有两本账。
 */
function installCatalogPort(listModels?: ProviderSettingsPortListModels): void {
  configureProviderSettingsPort(
    fakeProviderPort({
      listModels:
        listModels ??
        (async (providerId: string) => {
          calls.models.push(providerId)
          return { success: true, models: [model('grok-4', 500_000)] }
        }),
    }),
  )
}

type ProviderSettingsPortListModels = (
  providerId: string,
  forceRefresh?: boolean,
) => Promise<{ success: boolean; models?: OpenRouterModel[]; error?: string }>

/** 一个手动决定何时落地的承诺 —— 「在飞」那几条断言全靠它。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  calls = { providers: 0, settings: 0, models: [], updates: [] }
  updateOk = true
  useModelsSource.getState().reset()
  // 目录那一族有自己的家(providers/catalog-query.ts),models-source 的 reset
  // 不收它 —— 两个 reset 收同一格就是两个主人。所以用例自己收。
  catalogQuery.reset()
  useSessionsSource.setState({ sessions: [] })
  useNotifyStore.setState({ items: [] })
  installPort()
  installCatalogPort()
})

afterEach(() => {
  configureModelsPort(undefined)
  configureProviderSettingsPort(undefined)
  useModelsSource.getState().reset()
  catalogQuery.reset()
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

describe('名册两半合流', () => {
  const builtin = [{ id: 'xai', name: 'xAI' }]

  it('没有自定义那一半时**原样交回**内置那张表(身份不换,律④)', () => {
    expect(mergeProviderOptions(builtin, [])).toBe(builtin)
    expect(mergeProviderOptions(builtin, [{ id: 'xai', name: '撞名的' }])).toBe(builtin)
  })

  it('内置在前、自定义在后;id 撞了以内置为准', () => {
    expect(mergeProviderOptions(builtin, [{ id: 'my-llm', name: '自建' }])).toEqual([
      { id: 'xai', name: 'xAI' },
      { id: 'my-llm', name: '自建' },
    ])
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

  it('名册在 ensure 之后才发第一发,而且只发一次', async () => {
    await useModelsSource.getState().start()
    expect(calls.providers).toBe(0)
    await Promise.all([providersQuery.ensure(), providersQuery.ensure()])
    await providersQuery.ensure()
    expect(calls.providers).toBe(1)
    expect((providersQuery.get().data ?? []).map((p) => p.id)).toEqual(['xai', 'deepseek'])
  })

  it('同一家的目录只拉一次(键控缓存 + 并发折叠)', async () => {
    await useModelsSource.getState().start()
    await Promise.all([ensureCatalog('xai'), ensureCatalog('xai')])
    await ensureCatalog('xai')
    expect(calls.models).toEqual(['xai'])
    expect(toCatalogModels(catalogQuery.get('xai').get().data ?? [])).toEqual([
      { id: 'grok-4', contextLength: 500_000 },
    ])
  })

  it('目录重拉期间**旧目录还在屏上**(律②:keep-previous)', async () => {
    await ensureCatalog('xai')
    const hold = deferred<{ success: boolean; models?: OpenRouterModel[] }>()
    installCatalogPort(async (providerId) => {
      calls.models.push(providerId)
      return hold.promise
    })
    const q = catalogQuery.get('xai')
    const running = q.refetch()
    expect(q.get().inflight).toBe(true)
    expect(q.get().phase).toBe('ready')
    expect((q.get().data ?? []).map((m) => m.id)).toEqual(['grok-4'])
    hold.resolve({ success: true, models: [model('grok-4-fast', 128_000)] })
    await running
    expect((q.get().data ?? []).map((m) => m.id)).toEqual(['grok-4-fast'])
  })

  it('抽屉打开:名册 + **可见**那几家的目录一起到位', async () => {
    await useModelsSource.getState().start()
    // deepseek 关掉:它不该被拉。
    prefsQuery.get('default').patch({
      prefs: toProviderPrefs(
        settingsWith({
          xai: { selectedModels: ['grok-4'] },
          deepseek: { selectedModels: ['deepseek-chat'], enabled: false },
        }),
      ),
      custom: [],
    })
    await ensureVisibleCatalogs(null)
    expect(calls.providers).toBe(1)
    expect(calls.models).toEqual(['xai'])
  })

  it('设置拿不到 = 空投影(抽屉一家都不列),不是「列全部」', async () => {
    installPort({ readProviderSettings: async () => ({ success: false, error: '答不上话' }) })
    await useModelsSource.getState().start()
    expect(prefsQuery.get('default').get().data?.prefs).toEqual({ defaultProvider: '', configs: {} })
  })
})

/* ── 合并守卫(批 7b):目录在这个进程里只有一格 ─────────────────────────── */

describe('目录只有一个产地', () => {
  it('设置面拉过之后,模型侧**不再发第二发**;两边读到的 id 集合逐字相同', async () => {
    // 设置面那一路(ProviderSettingsPanel 走的就是这一句)。
    await catalogQuery.get('xai').ensure()
    expect(calls.models).toEqual(['xai'])

    // 模型侧那一路。两族各一份的话这里会多出一发。
    await ensureCatalog('xai')
    expect(calls.models).toEqual(['xai'])

    const raw = catalogQuery.get('xai').get().data ?? []
    expect(toCatalogModels(raw).map((m) => m.id)).toEqual(raw.map((m) => m.id))
    expect(raw.map((m) => m.id)).toEqual(['grok-4'])
  })
})

describe('选中一个模型:三态', () => {
  it('有会话 → 上行,并立牌顶着直到 listMeta 追认', async () => {
    await useModelsSource.getState().selectModel('s1', 'xai', 'grok-4')
    expect(calls.updates).toEqual([{ sessionId: 's1', provider: 'xai', model: 'grok-4' }])
    // 成功之后牌撤掉 —— 屏幕从此读会话事实那一份。
    expect(useModelsSource.getState().optimistic).toEqual({})
  })

  it('上行失败 → 撤牌 + notify(warn) 带后端原话,本地不动', async () => {
    updateOk = false
    await useModelsSource.getState().selectModel('s1', 'xai', 'grok-4')
    expect(calls.updates).toHaveLength(1)
    expect(useModelsSource.getState().optimistic).toEqual({})
    expect(useModelsSource.getState().pending).toBeNull()
    const items = useNotifyStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].level).toBe('warn')
    expect(items[0].body).toBe('后端拒绝了')
  })

  it('撤牌排在**重拉之后** —— 中间那一段仍由牌顶着,药丸不闪回旧模型', async () => {
    const seen: Array<Record<string, unknown>> = []
    const original = useSessionsSource.getState().refresh
    useSessionsSource.setState({
      refresh: async () => {
        seen.push({ ...useModelsSource.getState().optimistic })
      },
    })
    try {
      await useModelsSource.getState().selectModel('s1', 'xai', 'grok-4')
    } finally {
      useSessionsSource.setState({ refresh: original })
    }
    expect(seen).toEqual([{ s1: { provider: 'xai', model: 'grok-4' } }])
    expect(useModelsSource.getState().optimistic).toEqual({})
  })

  it('同一条会话上已经有一发在飞:第二下**不发**(律③的另一半)', async () => {
    const hold = deferred<{ success: boolean }>()
    installPort({
      updateSessionModel: async (sessionId, providerId, model) => {
        calls.updates.push({ sessionId, provider: providerId, model })
        return hold.promise
      },
    })
    const first = useModelsSource.getState().selectModel('s1', 'xai', 'grok-4')
    expect(modelMutation.isPending(selectKey('s1'))).toBe(true)
    await useModelsSource.getState().selectModel('s1', 'deepseek', 'deepseek-chat')
    expect(calls.updates).toHaveLength(1)
    hold.resolve({ success: true })
    await first
    expect(modelMutation.isPending(selectKey('s1'))).toBe(false)
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
    // 兑现那一路**不立牌**,所以失败也没有牌要撤;只剩一句 warn。
    expect(useModelsSource.getState().optimistic).toEqual({})
    expect(useNotifyStore.getState().items).toHaveLength(1)
  })

  it('没有预选时兑现是恒等,不发请求', async () => {
    await useModelsSource.getState().applyPendingModel('new-1')
    expect(calls.updates).toEqual([])
  })
})

/* ── 工作区(09-01「真切换」批;批 7b 起由键控 query 承担)──────────────── */

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
    const prefs = prefsQuery.get('ws-work').get().data?.prefs
    expect(prefs?.defaultProvider).toBe('deepseek')
    expect(prefs?.configs.deepseek.selectedModels).toEqual(['deepseek-chat'])
    // 别的空间勾的那一型在这里根本不存在 —— 这就是「两套完整独立的设置」。
    expect(prefs?.configs.xai).toBeUndefined()
  })

  it('切过去**当场真发一发**换一格;**名册不重拉**(它是机器级的事实)', async () => {
    await seedSpaces()
    await useModelsSource.getState().start()
    await providersQuery.ensure()
    expect(prefsQuery.get('default').get().data?.prefs.defaultProvider).toBe('xai')
    expect(calls.settings).toBe(1)
    expect(calls.providers).toBe(1)

    useWorkspaceStore.getState().switchTo('ws-work')
    await vi.waitFor(() =>
      expect(prefsQuery.get('ws-work').get().data?.prefs.defaultProvider).toBe('deepseek'),
    )
    // **换空间必重读**(迁移前那条往返时机原样保留):新那一格真去问了一次。
    expect(calls.settings).toBe(2)
    expect(calls.providers).toBe(1)
  })

  it('**换键不串**:两格各存各的;回去那一格重读,而重读期间旧答案在屏上(律②)', async () => {
    await seedSpaces()
    await useModelsSource.getState().start()
    useWorkspaceStore.getState().switchTo('ws-work')
    await vi.waitFor(() => expect(prefsQuery.keys()).toContain('ws-work'))
    await vi.waitFor(() =>
      expect(prefsQuery.get('ws-work').get().data?.prefs.defaultProvider).toBe('deepseek'),
    )
    expect(calls.settings).toBe(2)

    // 两格并存,谁也没串到谁头上。
    expect(prefsQuery.get('default').get().data?.prefs.defaultProvider).toBe('xai')
    expect(prefsQuery.get('ws-work').get().data?.prefs.defaultProvider).toBe('deepseek')

    /*
     * 回去那一格:换空间照旧**必重读**(与迁移前逐字同一条时机)。
     * 挂住这一发,断言重读**不清屏** —— 旧答案还在,phase 也没退回 initial。
     */
    const hold = deferred<{ success: boolean; ai: SpaceProviderSettings }>()
    installPort({
      readProviderSettings: async (spaceId: string) => {
        calls.settings += 1
        return spaceId === 'default' ? hold.promise : { success: true, ai: BY_SPACE[spaceId] }
      },
    })
    useWorkspaceStore.getState().switchTo('default')
    await vi.waitFor(() => expect(prefsQuery.get('default').get().inflight).toBe(true))
    expect(calls.settings).toBe(3)
    expect(prefsQuery.get('default').get().phase).toBe('ready')
    expect(prefsQuery.get('default').get().data?.prefs.defaultProvider).toBe('xai')

    hold.resolve({ success: true, ai: BY_SPACE.default })
    await vi.waitFor(() => expect(prefsQuery.get('default').get().inflight).toBe(false))
    expect(prefsQuery.get('default').get().data?.prefs.defaultProvider).toBe('xai')
  })
})
