import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isProviderEnabledIn } from '@onething/client/model/provider-model'
import type {
  OpenRouterModel,
  ProviderInfo,
  SpaceProviderSettings,
  ThinkingEffort,
} from '@shared/ipc/providers'
import { configureModelsPort } from './models-port'
import { configureProviderSettingsPort } from './provider-settings-port'
import { configureSpacesPort } from './spaces-port'
import {
  catalogModel,
  modelOption,
  openRouterModel as model,
  providerModelPrefs,
} from './__fixtures__/models'
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
  EMPTY_PREFS,
  ensureCatalog,
  ensureVisibleCatalogs,
  mergeProviderOptions,
  modelIdsOf,
  modelMutation,
  overrideContextLengthOf,
  prefsQuery,
  readingsOf,
  providersQuery,
  resolveModelSelection,
  selectKey,
  thinkingStateOf,
  toCatalogModels,
  toProviderPrefs,
  UNKNOWN_MODEL_READINGS,
  useModelsSource,
} from './models-source'
import { useSessionsSource } from './sessions-source'
import { useProviderSettings } from '../providers/store'
import { buildFamilies, findFamily } from '../providers/families'
import { DEFAULT_SPACE_ID } from '../workspace/types'

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
  providers: Record<
    string,
    {
      enabled?: boolean
      selectedModels?: string[]
      model?: string
      /** 用户在浮层里填的窗口覆盖(`contextLengthByModel`)—— 09-10 报障那一格。 */
      contextLengthByModel?: Record<string, number>
      maxOutputByModel?: Record<string, number>
    }
  >,
  defaultProvider = '',
): SpaceProviderSettings {
  return {
    provider: defaultProvider,
    providers: Object.fromEntries(
      Object.entries(providers).map(([id, config]) => [
        id,
        {
          model: config.model ?? '',
          selectedModels: config.selectedModels ?? [],
          enabled: config.enabled,
          ...(config.contextLengthByModel
            ? { contextLengthByModel: config.contextLengthByModel }
            : {}),
          ...(config.maxOutputByModel ? { maxOutputByModel: config.maxOutputByModel } : {}),
        },
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
    ).toEqual([modelOption('qwen-max', null)])
  })

  /*
   * 09-10:两张**按模型的数字表**一起投进来。窗口那张有三个消费者(读数环 /
   * 分组列表 / 右栏卡);最大输出那张今天**零消费者** —— 一次投影带齐是因为
   * 它们同源同尺、同一发设置里回来的,不画的不消费。
   */
  it('两张按模型的数字表都投进来;自定义家同手(自己的优先,退回既有,再退空表)', () => {
    const prefs = toProviderPrefs(
      settingsWith({
        xai: {
          selectedModels: ['grok-4'],
          contextLengthByModel: { 'grok-4': 200_000 },
          maxOutputByModel: { 'grok-4': 32_000 },
        },
        deepseek: { selectedModels: ['deepseek-chat'] },
      }),
    )
    expect(prefs.configs.xai.contextLength).toEqual({ 'grok-4': 200_000 })
    expect(prefs.configs.xai.maxOutput).toEqual({ 'grok-4': 32_000 })
    // 没设过 = 空表,不是 undefined(消费者不必先判一次在不在)。
    expect(prefs.configs.deepseek.contextLength).toEqual({})
    expect(prefs.configs.deepseek.maxOutput).toEqual({})

    const withCustom = {
      provider: '',
      providers: {
        'my-llm': {
          model: '',
          selectedModels: [],
          contextLengthByModel: { 'qwen-max': 111 },
          maxOutputByModel: { 'qwen-max': 222 },
        },
      },
      customProviders: [
        { id: 'my-llm', name: '自建', model: 'qwen-max', selectedModels: [] },
        {
          id: 'my-other',
          name: '另一台',
          model: 'yi-max',
          selectedModels: [],
          contextLengthByModel: { 'yi-max': 262_144 },
        },
      ],
    } as unknown as SpaceProviderSettings
    const custom = toProviderPrefs(withCustom)
    // 自定义那一半自己没带表 → 退回 `providers[id]` 里已经投好的那一份。
    expect(custom.configs['my-llm'].contextLength).toEqual({ 'qwen-max': 111 })
    expect(custom.configs['my-llm'].maxOutput).toEqual({ 'qwen-max': 222 })
    // 自己带了就用自己的;另一张没带、也没有既有的 → 空表。
    expect(custom.configs['my-other'].contextLength).toEqual({ 'yi-max': 262_144 })
    expect(custom.configs['my-other'].maxOutput).toEqual({})
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

  /*
   * 09-17 报障:设置里 Claude Code 关了,抽屉里 `claude-opus-4-20250514` 还在。
   * 那个空间的 providers 里根本没有 `claude` 这一格 —— API 成员的「开着」只是缺省,
   * 不能拿来把关着的订阅成员捞出来。卡上那个开关此时也读订阅成员自己那一格。
   */
  it('家族派生:API 成员从没配过时,不替关着的订阅成员开门', () => {
    const prefs = toProviderPrefs(
      settingsWith({ 'claude-code': { selectedModels: ['claude-opus-4-20250514'], enabled: false } }),
    )
    const members = [provider('claude', 'Claude'), provider('claude-code', 'Claude Code')]
    expect(buildProviderGroups(members, prefs, {}, null)).toEqual([])
    expect(isProviderEnabledIn(prefs.configs, 'claude')).toBe(false)
    const on = toProviderPrefs(
      settingsWith({ 'claude-code': { selectedModels: ['claude-opus-4-20250514'] } }),
    )
    expect(buildProviderGroups(members, on, {}, null).map((g) => g.id)).toEqual(['claude-code'])
  })

  it('目录没到照样出组,只是窗口那一格是 null', () => {
    const prefs = toProviderPrefs(settingsWith({ xai: { selectedModels: ['grok-4'] } }))
    expect(buildProviderGroups(providers, prefs, {}, null)[0].models).toEqual([
      modelOption('grok-4', null),
    ])
    const withCatalog = buildProviderGroups(
      providers,
      prefs,
      { xai: [catalogModel('grok-4', 500_000)] },
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
    const catalog = { xai: [catalogModel('grok-4', 500_000)] }
    expect(contextWindowOf(catalog, { provider: 'xai', model: 'grok-4' }, EMPTY_PREFS)).toBe(500_000)
    expect(contextWindowOf(catalog, { provider: '', model: 'grok-4' }, EMPTY_PREFS)).toBeNull()
    expect(contextWindowOf(catalog, { provider: 'xai', model: '别的' }, EMPTY_PREFS)).toBeNull()
    expect(contextWindowOf(catalog, null, EMPTY_PREFS)).toBeNull()
  })

  /*
   * 09-10 报障:用户在模型覆盖浮层里填了 context window,读数环仍写「未知」。
   * 病根是壳里三处读数只查目录,而引擎 `getOnethingModelContextLength` 从第一天
   * 就是「覆盖优先」。这两条钉的正是那个序。
   */
  it('用户覆盖压过目录 —— 与引擎 getOnethingModelContextLength 同序', () => {
    const catalog = { xai: [catalogModel('grok-4', 500_000)] }
    const prefs = toProviderPrefs(
      settingsWith({ xai: { selectedModels: ['grok-4'], contextLengthByModel: { 'grok-4': 200_000 } } }),
    )
    expect(contextWindowOf(catalog, { provider: 'xai', model: 'grok-4' }, prefs)).toBe(200_000)
    // 覆盖只管被点名的那一型;同一家的别的型照旧读目录。
    const other = { xai: [catalogModel('grok-4-fast', 128_000)] }
    expect(contextWindowOf(other, { provider: 'xai', model: 'grok-4-fast' }, prefs)).toBe(128_000)
  })

  it('目录里根本没有这一条,但用户说过窗口 → 就是那个数(手填模型的常态)', () => {
    const prefs = toProviderPrefs(
      settingsWith({ 'my-llm': { selectedModels: ['qwen-max'], contextLengthByModel: { 'qwen-max': 262_144 } } }),
    )
    expect(contextWindowOf({}, { provider: 'my-llm', model: 'qwen-max' }, prefs)).toBe(262_144)
  })

  it('覆盖那把尺:0 / 负数 / 非有限数 = 这一格没填(与 projection.positive 同义)', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const prefs = toProviderPrefs(
        settingsWith({ xai: { selectedModels: ['grok-4'], contextLengthByModel: { 'grok-4': bad } } }),
      )
      expect(overrideContextLengthOf(prefs, 'xai', 'grok-4')).toBeNull()
      // 尺不合格 = 没覆盖 → 照旧读目录,不是「盖成不知道」。
      expect(
        contextWindowOf({ xai: [catalogModel('grok-4', 500_000)] }, { provider: 'xai', model: 'grok-4' }, prefs),
      ).toBe(500_000)
    }
  })
})

/*
 * 读数一份(窗口 / 价格 / 思考四格)。覆盖只碰窗口那一格 —— 「有人说过窗口」
 * 不等于「有人说过价格和思考档」,别的格照旧是不知道。
 */
describe('一份读数与窗口覆盖', () => {
  it('目录条目缺席 + 有覆盖 → 只有窗口有值,别的格仍是不知道', () => {
    expect(readingsOf(undefined, 262_144)).toEqual({
      ...UNKNOWN_MODEL_READINGS,
      contextLength: 262_144,
    })
    // 覆盖也没有 → **交回那个恒等常量本体**(身份不换,律④)。
    expect(readingsOf(undefined)).toBe(UNKNOWN_MODEL_READINGS)
    expect(readingsOf(undefined, null)).toBe(UNKNOWN_MODEL_READINGS)
  })

  it('目录条目在场 + 有覆盖 → 窗口换成覆盖,价格与思考四格一格不动', () => {
    const entry = catalogModel('grok-4', 500_000, {
      pricing: { input: 3, output: 15 },
      thinkingLevels: ['low', 'high'],
      thinkingToggleable: true,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'low',
    })
    expect(readingsOf(entry, 200_000)).toEqual({
      contextLength: 200_000,
      pricing: { input: 3, output: 15 },
      thinkingLevels: ['low', 'high'],
      thinkingToggleable: true,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'low',
    })
    // 没覆盖时逐字还是目录那一份。
    expect(readingsOf(entry).contextLength).toBe(500_000)
  })

  it('抽屉分组列表:手填 id 带覆盖时,行尾那一格「窗口」有数', () => {
    const prefs = toProviderPrefs(
      settingsWith({
        'my-llm': { selectedModels: ['qwen-max'], contextLengthByModel: { 'qwen-max': 262_144 } },
      }),
    )
    // 目录是空的(手填模型永远不在目录里)—— 从前这一行的窗口是 null。
    const models = buildProviderGroups([{ id: 'my-llm', name: '自建' }], prefs, {}, null)[0].models
    expect(models).toEqual([modelOption('qwen-max', 262_144)])
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
      catalogModel('grok-4', 500_000),
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

/* ── 思考档位:投影 + 「屏幕上写什么」的判据(09-05 庚)────────────────────── */

describe('目录投影:价格与思考四格', () => {
  it('价格走 priceOf 的单位口径(目录给的就是每百万,一次换算都不做);两格缺一即 null', () => {
    const paid = model('m', 1000, {
      pricing: { prompt: '2.5', completion: '10', request: '0', image: '0' },
    })
    expect(toCatalogModels([paid])[0].pricing).toEqual({ input: 2.5, output: 10 })
    expect(toCatalogModels([model('m', 1000)])[0].pricing).toBeNull()
  })

  it('后端投过的四格原样带上来', () => {
    const row = model('deepseek-v4-pro', 128_000, {
      thinkingLevels: ['high', 'max'],
      thinkingToggleable: true,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'high',
    })
    expect(toCatalogModels([row])[0]).toMatchObject({
      thinkingLevels: ['high', 'max'],
      thinkingToggleable: true,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'high',
    })
  })

  it('**没投过**(旧缓存 / 别的产地)与「这一型不思考」在屏幕上是同一件事:不写档', () => {
    expect(toCatalogModels([model('m', 1000)])[0]).toMatchObject({
      thinkingLevels: null,
      thinkingToggleable: false,
      thinkingDefaultOn: false,
      thinkingDefaultLevel: null,
    })
  })

  it('设置的窄投影带上两张思考表(药丸要靠它答「此刻是哪一档」)', () => {
    const ai = {
      provider: 'xai',
      providers: {
        xai: {
          model: 'grok-4',
          selectedModels: ['grok-4'],
          thinkingByModel: { 'grok-4': true },
          thinkingEffortByModel: { 'grok-4': 'max' },
        },
      },
      customProviders: [],
    } as unknown as SpaceProviderSettings
    const config = toProviderPrefs(ai).configs.xai
    expect(config.thinking).toEqual({ 'grok-4': true })
    expect(config.thinkingEffort).toEqual({ 'grok-4': 'max' })
  })
})

/**
 * 「屏幕上写什么」的判据。它**照抄发送链**
 * (`agent-loop/providers/thinking-options.getGenericThinkingOptions`):
 * 明确 false = 关;明确 true = 开 + 那一档(没设就是服务端缺省档);
 * 缺席 = 一个参数都不发 = 开不开与用哪一档全由服务端缺省决定。
 *
 * 反证:把 `thinkingStateOf` 里那句 `chosen ?? readings.thinkingDefaultOn` 换成
 * `chosen ?? true` → 「可关、没设过、缺省不想」那一条当场红。
 */
describe('思考态:屏幕与发送链是同一句话', () => {
  const claude = {
    thinkingLevels: ['low', 'medium', 'high', 'max'] as ThinkingEffort[],
    thinkingToggleable: true,
    thinkingDefaultOn: false,
    thinkingDefaultLevel: 'high' as ThinkingEffort,
  }
  const gpt5 = {
    thinkingLevels: ['minimal', 'low', 'medium', 'high'] as ThinkingEffort[],
    thinkingToggleable: false,
    thinkingDefaultOn: true,
    thinkingDefaultLevel: 'medium' as ThinkingEffort,
  }
  const qwen = {
    thinkingLevels: [] as ThinkingEffort[],
    thinkingToggleable: true,
    thinkingDefaultOn: true,
    thinkingDefaultLevel: 'high' as ThinkingEffort,
  }

  it('不思考的型:四格全按不思考答,不编档', () => {
    expect(thinkingStateOf(UNKNOWN_MODEL_READINGS, undefined, 'm')).toMatchObject({
      supported: false,
      on: false,
      level: null,
    })
  })

  it('明确关掉 → 关,而且**不写一个档**(关着的时候没有深浅)', () => {
    const state = thinkingStateOf(
      claude,
      providerModelPrefs({ thinking: { m: false }, thinkingEffort: { m: 'max' } }),
      'm',
    )
    expect(state).toMatchObject({ supported: true, on: false, level: null, explicit: true })
  })

  it('明确开着 + 明确档 → 那一档', () => {
    const state = thinkingStateOf(
      claude,
      providerModelPrefs({ thinking: { m: true }, thinkingEffort: { m: 'max' } }),
      'm',
    )
    expect(state).toMatchObject({ on: true, level: 'max', explicit: true })
  })

  it('不可关闭模型显示声明的兼容等级，旧档按发送层规则映射到邻近档', () => {
    const grok = {
      thinkingLevels: ['low', 'medium', 'high', 'xhigh'] as ThinkingEffort[],
      thinkingToggleable: false,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'high' as ThinkingEffort,
      thinkingDisabledLevel: 'low' as ThinkingEffort,
      thinkingLevelLabels: { low: '快速' },
    }
    expect(thinkingStateOf(grok, providerModelPrefs({ thinking: { m: false } }), 'm'))
      .toMatchObject({ on: true, level: 'low', toggleable: false, levelLabels: { low: '快速' } })
    expect(thinkingStateOf(grok, providerModelPrefs({ thinking: { m: true }, thinkingEffort: { m: 'max' } }), 'm'))
      .toMatchObject({ on: true, level: 'xhigh' })
  })

  it('没设过 → 读 profile 的缺省:claude 缺省不想,gpt-5 缺省想「中」', () => {
    expect(thinkingStateOf(claude, undefined, 'm')).toMatchObject({ on: false, explicit: false })
    expect(thinkingStateOf(gpt5, undefined, 'm')).toMatchObject({ on: true, level: 'medium' })
  })

  it('一档都没有的型:开着也没有档 —— 屏幕不写一个这一型根本不接受的字', () => {
    const state = thinkingStateOf(
      qwen,
      providerModelPrefs({ thinking: { m: true }, thinkingEffort: { m: 'max' } }),
      'm',
    )
    expect(state).toMatchObject({ on: true, level: null, levels: [] })
  })
})

/* ── 合并守卫(批 7b):目录在这个进程里只有一格 ─────────────────────────── */

describe('目录只有一个产地', () => {
  it('同模型只改变思考等级或名称，目录也发布新读数', async () => {
    let levels: ThinkingEffort[] = ['high']
    installCatalogPort(async () => ({ success: true, models: [{
      ...model('grok-4.6', 500_000), thinkingLevels: levels,
      thinkingToggleable: false, thinkingDefaultOn: true, thinkingDefaultLevel: 'high',
      thinkingLevelLabels: { low: '快速' }, thinkingDisabledLevel: 'low',
    }] }))
    const q = catalogQuery.get('xai')
    await q.ensure()
    const rev = q.get().dataRev
    levels = ['low', 'high']
    await q.refetch()
    expect(q.get().dataRev).toBeGreaterThan(rev)
    expect(toCatalogModels(q.get().data ?? [])[0]).toMatchObject({
      thinkingLevels: ['low', 'high'], thinkingLevelLabels: { low: '快速' }, thinkingDisabledLevel: 'low',
    })
  })

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

/* ── 设置面写完 → 抽屉的名册作废(09-02 报障)───────────────────────────── */

/**
 * 报障原话:「provider service disable 模型后,输入框模型选择仍能看到其 provider
 * 的模型」。
 *
 * 病根不在两道闸(`buildProviderGroups` 一直是对的),而在**两侧从来没对过账**:
 * 设置面把 `enabled:false` 写进了盘,而抽屉读的这一格 `prefsQuery` 没人告诉它
 * 「你手上那份旧了」。于是要等换个空间再换回来、或者整个重开,抽屉才看得见。
 * 修法是 `providers/store.ts` 的 `settingsMutation.settle` 里
 * `prefsQuery.invalidate(那一发写去的空间)`。
 *
 * 这一组用**同一份盘**喂两个端口(设置面写它、抽屉读它)—— 真机上本来就是一份
 * 文件两个读者,分两份假货就测不出「对没对上账」这件事本身。
 */
describe('设置面写完 provider 设置 → 名册这一格作废', () => {
  /** 盘上那一份。设置面写进它,模型抽屉从它读。 */
  let disk: SpaceProviderSettings
  /** 抽屉那一族的名册(内置两家)—— 与两个端口交出去的是同一张表。 */
  const ROSTER = [provider('xai', 'xAI'), provider('deepseek', 'DeepSeek')]
  const XAI = findFamily(buildFamilies(ROSTER), 'xai')!

  /** 抽屉此刻列得出哪几组 —— 判据只有 `buildProviderGroups` 一处。 */
  function drawerGroups(current: { provider: string; model: string } | null = null) {
    const prefs = prefsQuery.get(DEFAULT_SPACE_ID).get().data?.prefs
    return buildProviderGroups(
      ROSTER.map((info) => ({ id: info.id, name: info.name })),
      prefs ?? { defaultProvider: '', configs: {} },
      {},
      current,
    )
  }

  beforeEach(() => {
    disk = settingsWith(
      {
        xai: { selectedModels: ['grok-4', 'grok-4-fast'] },
        deepseek: { selectedModels: ['deepseek-chat'] },
      },
      'xai',
    )
    useProviderSettings.getState().reset()
    // 抽屉那一侧:每次都现读盘。
    installPort({
      readProviderSettings: async () => {
        calls.settings += 1
        return { success: true, ai: disk }
      },
    })
    // 设置面那一侧:读同一份盘,写也真的落进去(不落盘就测不出重读读到了什么)。
    configureProviderSettingsPort(
      fakeProviderPort({
        listProviders: async () => ({ success: true, providers: ROSTER }),
        listModels: async (providerId: string) => {
          calls.models.push(providerId)
          return { success: true, models: [] }
        },
        readSettings: async () => ({
          success: true,
          settings: { ai: {}, storage: { spaceProviderSettingsMigratedAt: 1 } } as never,
        }),
        readProviderSettings: async () => ({ success: true, ai: disk }),
        writeProviderSettings: async (request) => {
          disk = request.ai as SpaceProviderSettings
          return { success: true, ai: disk }
        },
      }),
    )
  })

  afterEach(() => {
    useProviderSettings.getState().reset()
  })

  it('禁用一家 → 抽屉开着时后台补拉,那一组整个消失', async () => {
    await useModelsSource.getState().start()
    expect(drawerGroups().map((group) => group.id)).toEqual(['xai', 'deepseek'])

    // 抽屉开着 = 这一格有人在看。kernel 的 invalidate 在这一档才后台补拉。
    const off = prefsQuery.get(DEFAULT_SPACE_ID).subscribe(() => {})
    try {
      await useProviderSettings.getState().start()
      await useProviderSettings.getState().setFamilyEnabled(XAI, false)

      await vi.waitFor(() =>
        expect(prefsQuery.get(DEFAULT_SPACE_ID).get().data?.prefs.configs.xai?.enabled).toBe(false),
      )
      expect(drawerGroups().map((group) => group.id)).toEqual(['deepseek'])
    } finally {
      off()
    }
  })

  it('作废是标脏不是重拉:没人在看时一发都不发,下一次 ensure 才问', async () => {
    await useModelsSource.getState().start()
    const before = calls.settings

    await useProviderSettings.getState().start()
    await useProviderSettings.getState().setFamilyEnabled(XAI, false)
    // 抽屉没开过 —— 屏幕上没有一处在读这一格,那就一发都不该发(律②的另一半)。
    expect(calls.settings).toBe(before)
    // 手上那份还是旧的,但它已经被标脏了。
    expect(prefsQuery.get(DEFAULT_SPACE_ID).get().data?.prefs.configs.xai?.enabled).toBeUndefined()

    // 下一次有人问(抽屉打开)才去问盘 —— 而这一次问到的是新的。
    await prefsQuery.get(DEFAULT_SPACE_ID).ensure()
    expect(calls.settings).toBe(before + 1)
    expect(drawerGroups().map((group) => group.id)).toEqual(['deepseek'])
  })

  it('取消勾选一个模型 → 抽屉里那一行消失;正在用的那一个例外,仍然置顶', async () => {
    await useModelsSource.getState().start()
    const off = prefsQuery.get(DEFAULT_SPACE_ID).subscribe(() => {})
    try {
      await useProviderSettings.getState().start()
      await useProviderSettings.getState().toggleModel('xai', 'grok-4-fast', false)
      await vi.waitFor(() =>
        expect(
          prefsQuery.get(DEFAULT_SPACE_ID).get().data?.prefs.configs.xai?.selectedModels,
        ).toEqual(['grok-4']),
      )

      expect(drawerGroups()[0].models.map((entry) => entry.model)).toEqual(['grok-4'])
      // 正在跑的那一个即使被取消勾选也照样列出来,而且**排在最前**
      // (`modelIdsOf` 的那一手:抽屉里找不到自己正在用的模型会让人以为看错了)。
      const withCurrent = drawerGroups({ provider: 'xai', model: 'grok-4-fast' })
      expect(withCurrent[0].models.map((entry) => entry.model)).toEqual(['grok-4-fast', 'grok-4'])
    } finally {
      off()
    }
  })
})
