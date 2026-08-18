/**
 * 「当前空间的 provider 视图」—— 批 B7。
 *
 * 一个入口回答几个问题:**这个 provider 在当前空间配没配好、凭证长什么样、
 * 这个空间选了哪些模型、默认用哪个、这个 provider 在这个空间开着没有**。
 *
 * **C1 起只有一条数据路**:每个空间(含 default)都是
 * `credentials.json` 凭证池 + 自己的 provider 设置。批 B7 时这里分了两支
 * (default → 全局 `settings.ai`),而那正是「开关不独立 → 默认模型不独立 →
 * 切空间外观变」这一串问题的同一个病根:两套形状,每个消费者都要分一次支,
 * 每一片都会漏一个。迁移把 default 也变成普通空间之后,分支撤掉。
 *
 * **C2 起 provider 设置整套 per-space**(`workspaces/<id>/providers.json`),
 * B7/B9 的 overlay 三格并了进去,**不再回落全局** —— 这个空间没表达过的就是没有。
 *
 * `isDefaultSpace` 仍然导出,但它只回答**产品问题**(能不能删这个空间、要不要
 * 画「从别的空间导入」),**不再决定读哪儿**。
 *
 * ## settings 还是**传进来**的
 *
 * C2 之后它只剩一个用途:**后端答不上话时的降级源**(web 端没有 spaces 路由,
 * `providerSettings === null`)。那台宿主只有一个空间,`/api/settings` 那一份
 * 就是它的生效设置。桌面端永远走空间那一份。
 */

import { computed, getCurrentInstance, onMounted, type ComputedRef } from 'vue'
import type { AppSettings, ProviderInfo } from '@/types'
import type {
  ProviderConfig,
  SpaceCredentialEntrySummary,
  SpaceProviderCredentialSummary,
} from '@shared/ipc'
import {
  isProviderEnabledIn,
  type SpaceDefaultSelectionLike,
} from '@/stores/helpers/provider-model'
import { useSpaceProvidersStore } from '@/stores/spaceProviders'
import { useSpacesStore } from '@/stores/spaces'

interface SpaceDefaultSelection {
  provider: string
  model?: string
}

/** 一行人话的凭证摘要,连接区与任何「配没配」的地方共用同一句。 */
export interface SpaceProviderCredentialView {
  providerId: string
  /** 当前空间下这个 provider 能不能用。凭证严格隔离,空间之间不回落。 */
  configured: boolean
  /** 掩码预览 / OAuth 账号 / 「Env XXX」/ 「未配置」—— 一行,给行摘要用。 */
  summary: string
  /** 本空间的池条目(C1 起 default 也有)。 */
  entries: SpaceCredentialEntrySummary[]
  entryCount: number
  policy: string
  /** 该 provider 是否 OAuth / 订阅型(决定画「登录」还是画 key 输入框)。 */
  oauth: boolean
}

export interface SpaceProviderViewOptions {
  /** 全局共享那一份的数据源。设置页传草稿 settings,聊天侧传 store 的。 */
  settings: () => AppSettings | null | undefined
  /** provider 名录,用来判 OAuth 型 / 无凭证的本地 agent。 */
  providers?: () => ProviderInfo[]
  /**
   * 「这个 provider 的 key 来自环境变量」的判据(连接区已经有一份 env 探测,
   * 视图不重复探测 —— 它没有 IPC,也不该有)。
   *
   * C1 拍板 1:**env 是机器级的,所有空间可见** —— 它从没写进任何一个空间的
   * 文件,谈不上隔离被破坏;而挡掉它只会让一台配了 `OPENAI_API_KEY` 的机器在
   * 新空间里莫名起不了流。所以这一格对每个空间都参与判定,并画 Env 徽章。
   */
  usesEnvApiKey?: (providerId: string) => boolean
  /** 缺省 true:挂载时确保当前空间那一侧已经拉过。 */
  autoLoad?: boolean
}

function describeOAuthEntry(entry: SpaceCredentialEntrySummary, now: number): string {
  if (!entry.hasOAuthToken) return '未登录'
  const account = entry.oauthAccount ? `${entry.oauthAccount} · ` : ''
  if (typeof entry.oauthExpiresAt !== 'number') return `${account}已登录`
  return entry.oauthExpiresAt <= now ? `${account}已过期` : `${account}已登录`
}

/**
 * 一条 entry 算不算「能用」——与后端 `isSpaceCredentialEntryUsable` 同一句话
 * (B6 勘误 2:有凭证材料就算,材料可以是 key 也可以是 token)。判据分家的第一天
 * 没人发现,第一百天没人解释得清为什么界面说配好了、起流却说未配置。
 */
export function isSpaceCredentialEntryUsable(entry: SpaceCredentialEntrySummary): boolean {
  return entry.authType === 'oauth' ? entry.hasOAuthToken === true : entry.hasApiKey === true
}

/** 一条池摘要 → 视图。纯函数,单测直接打这里。 */
export function buildSpacePoolCredentialView(input: {
  providerId: string
  pool: SpaceProviderCredentialSummary | undefined
  oauth: boolean
  /** 机器环境里有这把钥匙(C1 拍板 1):池空时它顶上,并画 Env 徽章。 */
  envApiKey?: boolean
  now?: number
}): SpaceProviderCredentialView {
  const now = input.now ?? Date.now()
  const entries = input.pool?.entries ?? []
  const usable = entries.filter(isSpaceCredentialEntryUsable)
  const first = usable[0]
  let summary: string
  if (!first && !input.oauth && input.envApiKey) {
    // 与后端 `resolveSpaceProviderCredential` 的 `kind:'env'` 同一句话:
    // 池里没有可用 entry 且不是 OAuth 型时,env 兜底 —— 一串环境变量不算登录。
    return {
      providerId: input.providerId,
      configured: true,
      summary: 'Env',
      entries,
      entryCount: entries.length,
      policy: input.pool?.policy || 'single',
      oauth: input.oauth,
    }
  }
  if (!first) {
    summary = input.oauth ? '本空间未登录' : '本空间未配置'
  } else if (input.oauth) {
    summary = usable.length > 1
      ? `${usable.length} 个账号 · ${describeOAuthEntry(first, now)}`
      : describeOAuthEntry(first, now)
  } else {
    summary = usable.length > 1
      ? `${usable.length} 把密钥 · ${first.apiKeyPreview || '已保存'}`
      : (first.apiKeyPreview || '已保存')
  }
  return {
    providerId: input.providerId,
    configured: usable.length > 0,
    summary,
    entries,
    entryCount: entries.length,
    policy: input.pool?.policy || 'single',
    oauth: input.oauth,
  }
}

export interface SpaceProviderView {
  spaceId: ComputedRef<string>
  spaceName: ComputedRef<string>
  /** **只回答产品问题**(能不能删这个空间 / 要不要画「从别的空间导入」),不决定读哪儿。 */
  isDefaultSpace: ComputedRef<boolean>
  spaceAvailable: ComputedRef<boolean>
  loading: ComputedRef<boolean>
  lastError: ComputedRef<string | null>
  poolOf: (providerId: string) => SpaceProviderCredentialSummary | undefined
  credentialOf: (providerId: string) => SpaceProviderCredentialView
  isConfigured: (providerId: string) => boolean
  selectedModelsOf: (providerId: string) => string[]
  setSelectedModels: (providerId: string, ids: string[]) => Promise<boolean>
  /**
   * 当前空间的**生效**默认选择(批 B9)。C2 起没有「落回全局」这一档 ——
   * 空间没表达过就是空。给「哪一行打★」这类展示用。
   */
  defaultSelection: ComputedRef<{ provider: string; model: string }>
  /**
   * 解析链要的那一格:**只有空间自己表达过的**默认(没表达过 = `undefined`)。
   * 原样递给 `resolveProviderModelSelection({ spaceDefault })` —— 缺席时解析链
   * 自己落到全局那一支,不需要这里替它兜。
   */
  spaceDefault: ComputedRef<SpaceDefaultSelectionLike | undefined>
  /** 写空间默认。C1 起每个空间都写自己的 overlay,default 不再例外。 */
  setDefaultSelection: (provider: string, model: string) => Promise<boolean>
  /**
   * 「这个 provider 在当前空间开着没有」(批 B9)。家族(API + 订阅)的派生仍由
   * `isProviderEnabledIn` 统一做,这里只负责把空间覆盖作为读取源接进去。
   */
  isProviderEnabled: (providerId: string) => boolean
  /** 写空间层开关(家族两个成员一次写)。 */
  setProvidersEnabled: (providerIds: string[], enabled: boolean) => Promise<boolean>
  refresh: () => Promise<void>
}

export function useSpaceProviderView(options: SpaceProviderViewOptions): SpaceProviderView {
  const spacesStore = useSpacesStore()
  const store = useSpaceProvidersStore()

  const spaceId = computed(() => store.spaceId)
  const isDefaultSpace = computed(() => store.isDefaultSpace)
  const spaceAvailable = computed(() => store.spaceAvailable)
  const loading = computed(() => store.loading)
  const lastError = computed(() => store.lastError)
  const spaceName = computed(() => spacesStore.currentSpace.name)

  function providerInfo(providerId: string): ProviderInfo | undefined {
    return options.providers?.().find(provider => provider.id === providerId)
  }

  function isOAuthProvider(providerId: string): boolean {
    return providerInfo(providerId)?.requiresOAuth === true
  }

  /** 自带 CLI 登录的本地 agent(claude-code-agent…):它从来不问密钥,两种空间下都算配好。 */
  function isCredentialFreeProvider(providerId: string): boolean {
    if (providerId === 'acp') return true
    const provider = providerInfo(providerId)
    return Boolean(provider && provider.requiresApiKey === false && !provider.requiresOAuth)
  }

  function credentialOf(providerId: string): SpaceProviderCredentialView {
    if (isCredentialFreeProvider(providerId)) {
      return {
        providerId,
        configured: true,
        summary: 'Local agent',
        entries: [],
        entryCount: 0,
        policy: 'single',
        oauth: false,
      }
    }
    return buildSpacePoolCredentialView({
      providerId,
      pool: store.poolOf(providerId),
      oauth: isOAuthProvider(providerId),
      envApiKey: options.usesEnvApiKey?.(providerId) === true,
    })
  }

  function isConfigured(providerId: string): boolean {
    return credentialOf(providerId).configured
  }

  /** 这个 provider 在当前空间的配置(后端答不上话时落回传进来的 settings)。 */
  function configOf(providerId: string): ProviderConfig | undefined {
    const space = store.providerSettings
    if (space) return space.providers?.[providerId]
    return options.settings()?.ai?.providers?.[providerId]
  }

  /**
   * 这个空间选了哪些模型。
   *
   * **C2 起不回落**:空间没表达过 = 空。回落是 B7 的设计,而它带来的是
   * 「我在这个空间明明没选过这个模型,它怎么在选择器里」。唯一的降级是
   * `providerSettings === null`(web 端后端答不上话),那时读传进来的 settings。
   */
  function selectedModelsOf(providerId: string): string[] {
    return configOf(providerId)?.selectedModels ?? []
  }

  async function setSelectedModels(providerId: string, ids: string[]): Promise<boolean> {
    return store.writeSelectedModels(providerId, ids)
  }

  /**
   * 空间自己表达过的默认(批 B9;C2 起源头是 `providers.json` 的 `provider` +
   * `providers[provider].model`)。没表达过 = `undefined`,解析链自己落到
   * 「没有默认」那一支。
   */
  const spaceDefault = computed<SpaceDefaultSelection | undefined>(() => {
    const space = store.providerSettings
    const provider = space ? space.provider : options.settings()?.ai?.provider
    if (!provider) return undefined
    const model = space
      ? space.providers?.[provider]?.model
      : options.settings()?.ai?.providers?.[provider]?.model
    return model ? { provider, model } : { provider }
  })

  /** 生效默认 = 空间表达过就是它;没表达过就是「还没选」(不回落)。 */
  const defaultSelection = computed<{ provider: string; model: string }>(() => {
    const selection = spaceDefault.value
    return { provider: selection?.provider || '', model: selection?.model || '' }
  })

  async function setDefaultSelection(provider: string, model: string): Promise<boolean> {
    return store.writeDefaultSelection(provider, model)
  }

  /**
   * 「这个 provider 在当前空间开着没有」。家族(API + 订阅)的派生仍由
   * `isProviderEnabledIn` 统一做 —— C2 之后它的第一个入参**就是**这个空间的
   * providers 表,不再需要第三个「空间覆盖」入参。
   */
  function isProviderEnabled(providerId: string): boolean {
    const space = store.providerSettings
    return isProviderEnabledIn(
      space ? space.providers : options.settings()?.ai?.providers,
      providerId,
    )
  }

  async function setProvidersEnabled(providerIds: string[], enabled: boolean): Promise<boolean> {
    return store.writeProvidersEnabled(providerIds, enabled)
  }

  // 组件外调用(纯逻辑单测、非组件 composable)不注册生命周期钩子 —— 注册了也
  // 不会触发,只会在控制台留一条噪音警告。
  if (options.autoLoad !== false && getCurrentInstance()) {
    onMounted(() => {
      // 设置窗/主窗都是独立 window,空间列表得各自拉一次(B2/B3 同一条注释)。
      void spacesStore.load()
      void store.ensureLoaded()
    })
  }

  return {
    spaceId,
    spaceName,
    isDefaultSpace,
    spaceAvailable,
    loading,
    lastError,
    poolOf: (providerId: string) => store.poolOf(providerId),
    credentialOf,
    isConfigured,
    selectedModelsOf,
    setSelectedModels,
    defaultSelection,
    spaceDefault,
    setDefaultSelection,
    isProviderEnabled,
    setProvidersEnabled,
    refresh: () => store.refresh(),
  }
}
