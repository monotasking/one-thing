import { create } from 'zustand'
import type {
  CustomProviderConfig,
  ProviderConfig,
  ProviderInfo,
  ProviderUsageResponse,
} from '@shared/ipc/providers'
import type { OAuthStatusResponse } from '@shared/ipc/oauth'
import type { AppSettings } from '@shared/ipc/settings'
import type { SpaceCredentialsSummary, SpaceProviderCredentialSummary } from '@shared/ipc/spaces'
import { providerSettingsPort } from '../data/provider-settings-port'
import { catalogQuery } from './catalog-query'
import { notify } from '../services/notify'
import { t } from '../i18n'
import { buildFamilies, providerIdsOf, resolveMode } from './families'
import { credentialFactsOf, isModeConfigured, poolViewOf, reorderPool } from './projection'
import {
  BROWSER_POLL_INTERVAL_MS,
  BROWSER_POLL_TIMEOUT_MS,
  DEVICE_POLL_INTERVAL_MS,
  DEVICE_POLL_MAX_ATTEMPTS,
  DEVICE_POLL_SLOW_DOWN_MS,
  IDLE_AUTH_FLOW,
  devicePollIsFatal,
  devicePollShouldContinue,
  devicePollShouldSlowDown,
  flowKindOf,
} from './auth'
import type { AuthFlowState } from './auth'
import { dialPatchOf, providerDialsOf } from './dials'
import type { CredentialFacts, ProviderFamilyView } from './types'

/** 新建自定义家的表单。字段名与 `CustomProviderConfig` 对齐,不另起一套。 */
export interface CustomProviderForm {
  name: string
  description: string
  apiType: 'openai' | 'anthropic'
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * 「模型服务」面的数据源。一个应用一个 —— 面板可以同时挂好几份实例(架子里的
 * 后台 tab、Dock 预览泡),但它们说的必须是同一件事。
 *
 * ── 取数时机:全都是懒的 ──────────────────────────────────────────────────
 * 这块面不在开机路径上,`start()` 只在面板第一次挂上时调。三发并行:
 * 名册(会碰网,后端顺手拉 models.dev)、设置(本地文件一次读)、凭证摘要
 * (本地文件一次读)。
 *
 * ── 模型目录不在这个 store 里(K1 样板迁移,08-31)──────────────────────
 * 它是 `providers/catalog-query.ts` 的一族 kernel query。从前这里有四张表
 * (`catalog` / `catalogStatus` / `catalogError` / `catalogFetchedAt`)+ 一个
 * `inflight: Map` + 一个 `ensureCatalog` —— 那是一台手写的异步状态机,而
 * 「首载 / 重拉不分家」正是用户报的那几处「闪」的病根(§8)。四张表整体退役,
 * **没有留转发的壳**:留一个 `ensureCatalog` 转发就是留第二份真相。
 * 组件侧改读 `useQuery(catalogQuery.get(pid))`,`reset()` 仍然连它一起清。
 *
 * ── 写:先读整份 → 合并一格 → 整份写回 ────────────────────────────────────
 * 判据与理由写在 `data/provider-settings-port.ts` 顶部。这里只多一条纪律:
 * **底本是 store 里那一份 `settings`**,不是每次写前再读一次 —— 再读一次会把
 * 「另一扇窗刚改的东西」和「我这次要改的东西」混成一次写,而谁覆盖了谁看不出来。
 * 写成功后用后端回的那一份(`saveSettings` 的 `settings`)换掉底本,底本永远
 * 是后端认下的最后一份。
 *
 * ── 空间 ────────────────────────────────────────────────────────────────
 * 这块壳没有「当前空间」这个事实,所以凭证读写打在 `default` 上 —— 它正是
 * `settings.getSettings()` 读的那一份(后端 `getSettings()` = `getSpaceSettings('default')`)。
 * per-space 的模型服务设置归批二。
 */

/** 与后端 `DEFAULT_SPACE_ID` 同一个值。这块壳今天只认它,理由见文件头。 */
export const DEFAULT_SPACE_ID = 'default'

export type SourceStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 密钥那一格的三态。'saving' 期间输入框禁用,钮上转一颗 spinner。 */
export type KeySaveStatus = 'idle' | 'saving' | 'saved'

export interface ProviderSettingsState {
  status: SourceStatus
  error?: string
  /** 名册原样。家的表是从它算的,不存第二份。 */
  providers: ProviderInfo[]
  /** 整份设置 —— 它同时是写回的底本。 */
  settings: AppSettings | undefined
  /** providerId → 凭证摘要。`credentialsKnown` 为 false 时这张表不算数。 */
  credentials: Record<string, SpaceProviderCredentialSummary>
  /** 凭证那一口读到了没有。读不到 = 全域「状态未知」,不说「未配置」。 */
  credentialsKnown: boolean

  /** 左栏选中的家。null = 还没选(右面画缺席态)。 */
  selectedFamilyId: string | null
  /** familyId → 用户点过的那一坑。没点过的家由 `resolveMode` 现算。 */
  pickedMode: Record<string, string>
  /** 左栏检索词。 */
  query: string
  /** providerId → 目录检索词。每一坑各记各的。 */
  modelQuery: Record<string, string>

  /** providerId → 密钥那一格的状态。 */
  keyStatus: Record<string, KeySaveStatus>
  /** 正在写设置(启用开关 / 勾选)。整面共享一颗 —— 写的是同一份设置。 */
  saving: boolean

  /** providerId → 凭证池正在写。池的写是逐坑的,不共享 `saving` 那一颗。 */
  poolBusy: Record<string, boolean>
  /** providerId → 池那一口失败时后端那句原话。 */
  poolError: Record<string, string>

  /** providerId → 登录态(后端答的)。缺席 = 还没问过。 */
  authStatus: Record<string, OAuthStatusResponse>
  /** providerId → 正在跑的登录流。`kind: null` = 没在登录。 */
  authFlow: Record<string, AuthFlowState>

  /** providerId → 订阅用量。`null` = 后端说这家没有用量(unsupported)。 */
  usage: Record<string, ProviderUsageResponse | null>
  usageStatus: Record<string, SourceStatus>
  usageError: Record<string, string>

  start: () => Promise<void>
  refresh: () => Promise<void>
  selectFamily: (familyId: string) => void
  selectMode: (familyId: string, providerId: string) => void
  setQuery: (query: string) => void
  setModelQuery: (providerId: string, query: string) => void
  /** 启用/停用一家。**家族一开全开**:一次把这一家的所有 provider id 写完。 */
  setFamilyEnabled: (family: ProviderFamilyView, enabled: boolean) => Promise<void>
  /** 勾选/取消一个模型(写 `selectedModels`)。 */
  toggleModel: (providerId: string, modelId: string, selected: boolean) => Promise<void>
  /** 保存一把 API 密钥。走凭证域,**不**走 saveSettings(理由见端口文件头)。 */
  saveApiKey: (providerId: string, apiKey: string) => Promise<void>

  /* ── 模型级 ─────────────────────────────────────────────────────────── */
  /** 设为这一坑的当前模型。写 `providers[pid].model`。 */
  setCurrentModel: (providerId: string, modelId: string) => Promise<void>
  /**
   * 手填一个目录里没有的模型 id。**同步**返回一句错误(已经在列表里),
   * 没错就返回 undefined —— 输入框要当场知道该不该清空,不能等一个 await。
   */
  addManualModel: (providerId: string, modelId: string) => string | undefined
  /** 删掉一个手填模型。最后一条不删(与生产 `toggleSpaceModelSelection` 同一守则)。 */
  removeManualModel: (providerId: string, modelId: string) => Promise<void>

  /* ── 凭证池 ─────────────────────────────────────────────────────────── */
  /** 追加一条密钥(**不带 entryId** = 追加)。 */
  addCredential: (providerId: string, apiKey: string, label: string) => Promise<void>
  /** 换一把 key 但**不换条目**(带 entryId = 改这一条),用量账才连得上。 */
  replaceCredential: (providerId: string, entryId: string, apiKey: string) => Promise<void>
  removeCredential: (providerId: string, entryId: string) => Promise<void>
  moveCredential: (providerId: string, entryId: string, delta: -1 | 1) => Promise<void>
  setRotation: (providerId: string, policy: string) => Promise<void>

  /* ── 订阅登录 ───────────────────────────────────────────────────────── */
  /** 问一次登录态。已登录的坑开面就问,未登录的也问 —— 「登没登」是它自己说了算。 */
  checkAuth: (providerId: string) => Promise<void>
  /** 起一次登录。流形由后端的答案定(见 auth.ts 文件头)。 */
  startAuth: (providerId: string) => Promise<void>
  /** 贴码框里改字。 */
  setAuthCode: (providerId: string, code: string) => void
  /** 提交贴回来的授权码。 */
  submitAuthCode: (providerId: string) => Promise<void>
  /** 取消登录。**后端没有这口** —— 取消就是这边不再问下去。 */
  cancelAuth: (providerId: string) => void
  /** 退出登录。带 entryId 时只退那一个账号。 */
  signOut: (providerId: string, entryId?: string) => Promise<void>

  /* ── 订阅用量 ───────────────────────────────────────────────────────── */
  /** 拉用量。`force` 绕过 60s 缓存 —— 「刷新」那颗钮走的就是它。 */
  loadUsage: (providerId: string, force?: boolean) => Promise<void>

  /* ── 自定义家 / 计费档位 ─────────────────────────────────────────────── */
  saveCustomProvider: (form: CustomProviderForm, editingId?: string) => Promise<void>
  deleteCustomProvider: (providerId: string) => Promise<void>
  /** 拨一次计费档位。**档位与 baseUrl 一起写**(理由见 dials.ts)。 */
  setDials: (providerId: string, apiMode: string, region: string) => Promise<void>

  reset: () => void
}

const EMPTY_CONFIG: ProviderConfig = { model: '', selectedModels: [] }

/**
 * 用量的缓存寿命。与 Vue 壳 `useProviderUsage.ts:6` 同值 —— 这一口是**真去问
 * 服务商**的,开一次面、切一次坑就问一遍会被限流。「刷新」那颗钮绕过它。
 */
const USAGE_CACHE_TTL_MS = 60_000

interface CachedUsage {
  expiresAt: number
  response: ProviderUsageResponse
}

/** 模块级启动闸 —— 「这一个进程启动过没有」不是可渲染状态。 */
let started = false

export const useProviderSettings = create<ProviderSettingsState>()((set, get) => {
  /**
   * providerId → 上一次用量答案。**不放进可渲染状态**:它是「这一口多久之内
   * 不必再问」这件事,不是屏幕上的任何一格(屏幕读的是 `usage`)。
   */
  const usageCache = new Map<string, CachedUsage>()

  async function load(): Promise<void> {
    set({ status: 'loading' })
    const port = await providerSettingsPort()
    // 三发并行且**各自失败各自认**:名册拉不到不该把设置也拖没。
    const [providers, settings, credentials] = await Promise.all([
      port.listProviders().catch(() => undefined),
      port.readSettings().catch(() => undefined),
      port.readCredentials(DEFAULT_SPACE_ID).catch(() => undefined),
    ])

    const roster = providers?.success ? (providers.providers ?? []) : undefined
    const loaded = settings?.success ? settings.settings : undefined
    set({
      providers: roster ?? [],
      settings: loaded,
      credentials: credentials?.success ? (credentials.credentials?.providers ?? {}) : {},
      credentialsKnown: credentials?.success === true,
      // 名册与设置都没有 = 这块面什么都说不出来,那就如实说「读不到」。
      status: roster || loaded ? 'ready' : 'error',
      error: roster || loaded ? undefined : (providers?.error ?? settings?.error ?? undefined),
    })
  }

  /**
   * 合并若干个 provider 的配置并整份写回。**唯一的设置写口**。
   *
   * 乐观更新 + 失败回滚 + 一条通知:与 `models-source.selectModel` 同一条纪律 ——
   * 绝不留说谎的牌。
   */
  async function writeProviders(
    patch: Readonly<Record<string, Partial<ProviderConfig>>>,
  ): Promise<void> {
    const base = get().settings
    if (!base) return
    const nextProviders: Record<string, ProviderConfig> = { ...(base.ai?.providers ?? {}) }
    for (const [providerId, delta] of Object.entries(patch)) {
      nextProviders[providerId] = { ...EMPTY_CONFIG, ...nextProviders[providerId], ...delta }
    }
    const next = { ...base, ai: { ...base.ai, providers: nextProviders } } as AppSettings
    await commitSettings(base, next)
  }

  /**
   * 整份写回的**收尾那一半**:乐观更新 → 写 → 成了就换底本、砸了就回滚 + 一条通知。
   * 单拆出来是因为写口不止「改几个 provider 配置」一种(自定义家还要动
   * `customProviders`),而这后半段对谁都一样 —— 两处各抄一遍就是两处会漂开。
   */
  async function commitSettings(base: AppSettings, next: AppSettings): Promise<void> {
    set({ settings: next, saving: true })
    let failure: string | undefined
    try {
      const port = await providerSettingsPort()
      const response = await port.saveSettings(next)
      if (!response.success) failure = response.error || t('providers.saveFailed')
      else if (response.settings) set({ settings: response.settings })
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    set({ saving: false })
    if (!failure) return
    // 回滚回底本。后端没认下的事,屏幕上就不该留着。
    set({ settings: base })
    notify({
      level: 'warn',
      source: 'providers.save',
      title: t('providers.saveFailed'),
      body: failure,
      detail: failure,
    })
  }

  /**
   * 凭证池的**唯一写口**。三件事(调序 / 删除 / 换策略)是同一口的三种用法 ——
   * `setCredentialPool` 吃的是「期望的最终顺序」,不在列表里的条目会被删掉。
   *
   * 与 `writeProviders` 的两点不同,都是被形状逼出来的:
   *  ① **不做乐观更新**:凭证摘要不是这块面算出来的,是后端算出来的
   *     (尾号、冷却、策略可用性)。先把屏幕改了再等后端,一旦失败就得凭空
   *     造一份「回滚后的摘要」—— 而那份东西没有产地。所以这里等后端回话,
   *     用它回的那份换掉这一格。
   *  ② 忙态是**逐坑**的:A 家在写不该把 B 家的钮也禁掉。
   */
  async function writePool(
    providerId: string,
    run: (port: Awaited<ReturnType<typeof providerSettingsPort>>) => Promise<{
      success: boolean
      credentials?: SpaceCredentialsSummary
      error?: string
    }>,
    failureTitle: string,
  ): Promise<boolean> {
    set((st) => ({
      poolBusy: { ...st.poolBusy, [providerId]: true },
      poolError: { ...st.poolError, [providerId]: '' },
    }))
    let failure: string | undefined
    let credentials: SpaceCredentialsSummary | undefined
    try {
      const port = await providerSettingsPort()
      const response = await run(port)
      if (!response.success) failure = response.error || failureTitle
      else credentials = response.credentials
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (failure) {
      set((st) => ({
        poolBusy: { ...st.poolBusy, [providerId]: false },
        poolError: { ...st.poolError, [providerId]: failure ?? '' },
      }))
      notify({
        level: 'warn',
        source: 'providers.credential',
        title: failureTitle,
        body: failure,
        detail: failure,
      })
      return false
    }

    set((st) => ({
      poolBusy: { ...st.poolBusy, [providerId]: false },
      credentials: credentials?.providers ? credentials.providers : st.credentials,
      credentialsKnown: credentials?.providers ? true : st.credentialsKnown,
    }))
    return true
  }

  /** 池里此刻的 id 序列。调序 / 删除都要先拿到它 —— 那一口吃的是整串。 */
  function entryIdsOf(providerId: string): string[] {
    return (get().credentials[providerId]?.entries ?? []).map((entry) => entry.id)
  }

  function patchFlow(providerId: string, delta: Partial<AuthFlowState>): void {
    set((st) => ({
      authFlow: {
        ...st.authFlow,
        [providerId]: { ...(st.authFlow[providerId] ?? IDLE_AUTH_FLOW), ...delta },
      },
    }))
  }

  /**
   * 「这一次登录还算不算数」。取消 / 换坑 / 重开都会让上一条流作废,而
   * 轮询是个跑在 await 里的循环 —— 它必须能问一句「我还是当下那一条吗」。
   * 用一个逐坑的世代号答:每起一次流 +1,循环每轮比一次。
   */
  const authEpoch = new Map<string, number>()
  function bumpEpoch(providerId: string): number {
    const next = (authEpoch.get(providerId) ?? 0) + 1
    authEpoch.set(providerId, next)
    return next
  }
  function epochIsStale(providerId: string, epoch: number): boolean {
    return authEpoch.get(providerId) !== epoch
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * 设备码轮询。60 次 × 5s,服务商喊 `slow_down` 就每次多等 5s ——
   * 节奏与 Vue 壳 `useProviderAuth.ts:161-205` 逐条相同(常量在 auth.ts)。
   *
   * 每一轮先问「我还是当下那条流吗」:取消 / 换坑 / 重开都会让世代号变,
   * 而这个循环可能还挂在一个 5 秒的 await 上。
   */
  async function pollDevice(
    providerId: string,
    epoch: number,
    flowId: string | undefined,
    intervalMs: number | undefined,
  ): Promise<void> {
    let wait = intervalMs ?? DEVICE_POLL_INTERVAL_MS
    const port = await providerSettingsPort()
    for (let attempt = 0; attempt < DEVICE_POLL_MAX_ATTEMPTS; attempt += 1) {
      await sleep(wait)
      if (epochIsStale(providerId, epoch)) return
      let response: Awaited<ReturnType<typeof port.oauthDevicePoll>>
      try {
        response = await port.oauthDevicePoll({ providerId, ...(flowId ? { flowId } : {}) })
      } catch (error) {
        patchFlow(providerId, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      if (epochIsStale(providerId, epoch)) return

      if (response.completed && response.success) {
        await settleAuth(providerId)
        return
      }
      if (devicePollShouldSlowDown(response.pollStatus, response.error)) {
        wait += DEVICE_POLL_SLOW_DOWN_MS
        continue
      }
      if (devicePollShouldContinue(response.pollStatus, response.error)) continue
      if (!response.success || devicePollIsFatal(response.error)) {
        // 失败要显示**错误原文**(交接稿 §4b)。没给原文才退到那句通用的。
        patchFlow(providerId, { error: response.error || t('providers.subFailed') })
        return
      }
    }
    patchFlow(providerId, { error: t('providers.subTimedOut') })
  }

  /**
   * 浏览器回调流。这一支后端不给可轮询的流 id,所以问的是**登录态本身** ——
   * 2s 一次,最多 5 分钟(与 Vue 壳 `pollBrowserCallback` 同一手)。
   */
  async function pollBrowser(providerId: string, epoch: number): Promise<void> {
    const deadline = Date.now() + BROWSER_POLL_TIMEOUT_MS
    const port = await providerSettingsPort()
    while (Date.now() < deadline) {
      await sleep(BROWSER_POLL_INTERVAL_MS)
      if (epochIsStale(providerId, epoch)) return
      try {
        const status = await port.oauthStatus({ providerId })
        if (epochIsStale(providerId, epoch)) return
        set((st) => ({ authStatus: { ...st.authStatus, [providerId]: status } }))
        if (status.isLoggedIn) {
          await settleAuth(providerId)
          return
        }
      } catch {
        // 问不到就下一轮再问 —— 浏览器还开着,一次网络抖动不该把流程判死。
      }
    }
    if (!epochIsStale(providerId, epoch)) patchFlow(providerId, { error: t('providers.subTimedOut') })
  }

  /** 登录成功的收尾:重问登录态、重拉凭证摘要、把流收掉。 */
  async function settleAuth(providerId: string): Promise<void> {
    authEpoch.set(providerId, (authEpoch.get(providerId) ?? 0) + 1)
    set((st) => ({ authFlow: { ...st.authFlow, [providerId]: IDLE_AUTH_FLOW } }))
    await get().checkAuth(providerId)
    const port = await providerSettingsPort()
    const credentials = await port.readCredentials(DEFAULT_SPACE_ID).catch(() => undefined)
    if (credentials?.success) {
      set({
        credentials: credentials.credentials?.providers ?? {},
        credentialsKnown: true,
      })
    }
  }

  return {
    status: 'idle',
    providers: [],
    settings: undefined,
    credentials: {},
    credentialsKnown: false,
    selectedFamilyId: null,
    pickedMode: {},
    query: '',
    modelQuery: {},
    keyStatus: {},
    saving: false,
    poolBusy: {},
    poolError: {},
    authStatus: {},
    authFlow: {},
    usage: {},
    usageStatus: {},
    usageError: {},

    start: async () => {
      if (started) return
      started = true
      const port = await providerSettingsPort()
      await port.ready()
      await load()
    },

    refresh: async () => {
      await load()
    },

    selectFamily: (familyId) => {
      set({ selectedFamilyId: familyId })
    },

    selectMode: (familyId, providerId) => {
      set((st) => ({ pickedMode: { ...st.pickedMode, [familyId]: providerId } }))
    },

    setQuery: (query) => set({ query }),

    setModelQuery: (providerId, query) =>
      set((st) => ({ modelQuery: { ...st.modelQuery, [providerId]: query } })),

    setFamilyEnabled: async (family, enabled) => {
      const patch: Record<string, Partial<ProviderConfig>> = {}
      for (const providerId of providerIdsOf(family)) patch[providerId] = { enabled }
      await writeProviders(patch)
    },

    toggleModel: async (providerId, modelId, selected) => {
      const config = get().settings?.ai?.providers?.[providerId]
      const current = config?.selectedModels ?? []
      const next = selected
        ? current.includes(modelId)
          ? current
          : [...current, modelId]
        : current.filter((id) => id !== modelId)
      if (next === current) return
      await writeProviders({ [providerId]: { selectedModels: next } })
    },

    saveApiKey: async (providerId, apiKey) => {
      const key = apiKey.trim()
      if (!key) return
      set((st) => ({ keyStatus: { ...st.keyStatus, [providerId]: 'saving' } }))
      let failure: string | undefined
      let credentials: SpaceProviderCredentialSummary | undefined
      try {
        const port = await providerSettingsPort()
        const response = await port.setCredential({
          id: DEFAULT_SPACE_ID,
          providerId,
          apiKey: key,
        })
        if (!response.success) failure = response.error || t('providers.keySaveFailed')
        else credentials = response.credentials?.providers?.[providerId]
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }

      if (failure) {
        set((st) => ({ keyStatus: { ...st.keyStatus, [providerId]: 'idle' } }))
        notify({
          level: 'warn',
          source: 'providers.credential',
          title: t('providers.keySaveFailed'),
          body: failure,
          detail: failure,
        })
        return
      }
      set((st) => ({
        keyStatus: { ...st.keyStatus, [providerId]: 'saved' },
        // 后端回的是**这一次之后**的摘要,拿它换掉这一格 —— 尾号当场就对。
        credentials: credentials
          ? { ...st.credentials, [providerId]: credentials }
          : st.credentials,
        credentialsKnown: true,
      }))
    },

    /* ── 模型级 ───────────────────────────────────────────────────────── */

    setCurrentModel: async (providerId, modelId) => {
      if (get().settings?.ai?.providers?.[providerId]?.model === modelId) return
      // 设为当前**顺带勾上**:当前模型不在选择器里,聊天那边就选不着它。
      const selected = get().settings?.ai?.providers?.[providerId]?.selectedModels ?? []
      await writeProviders({
        [providerId]: {
          model: modelId,
          selectedModels: selected.includes(modelId) ? selected : [...selected, modelId],
        },
      })
    },

    addManualModel: (providerId, modelId) => {
      const id = modelId.trim()
      if (!id) return undefined
      const selected = get().settings?.ai?.providers?.[providerId]?.selectedModels ?? []
      // 重复是**用户看得见的事实**,不是错误 —— 当场说清,不发请求。
      if (selected.includes(id)) return t('providers.addModelDuplicate', { model: id })
      void writeProviders({ [providerId]: { selectedModels: [...selected, id] } })
      return undefined
    },

    removeManualModel: async (providerId, modelId) => {
      const selected = get().settings?.ai?.providers?.[providerId]?.selectedModels ?? []
      if (!selected.includes(modelId)) return
      // 与生产 `toggleSpaceModelSelection` 同一条守则:不许摘掉最后一个。
      if (selected.length <= 1) return
      const next = selected.filter((id) => id !== modelId)
      const config = get().settings?.ai?.providers?.[providerId]
      await writeProviders({
        [providerId]: {
          selectedModels: next,
          // 删掉的正好是当前模型时,当前顺位落到剩下的第一个 ——
          // 留一个指向已删 id 的 `model` 就是让聊天那边挑到一个不存在的模型。
          ...(config?.model === modelId ? { model: next[0] ?? '' } : {}),
        },
      })
    },

    /* ── 凭证池 ───────────────────────────────────────────────────────── */

    addCredential: async (providerId, apiKey, label) => {
      const key = apiKey.trim()
      if (!key) return
      await writePool(
        providerId,
        (port) =>
          port.setCredential({
            id: DEFAULT_SPACE_ID,
            providerId,
            apiKey: key,
            ...(label.trim() ? { label: label.trim() } : {}),
          }),
        t('providers.keySaveFailed'),
      )
    },

    replaceCredential: async (providerId, entryId, apiKey) => {
      const key = apiKey.trim()
      if (!key) return
      await writePool(
        providerId,
        // **带 entryId** —— 这一条就是「换 key 不换条目」的全部实现。
        (port) => port.setCredential({ id: DEFAULT_SPACE_ID, providerId, entryId, apiKey: key }),
        t('providers.keySaveFailed'),
      )
    },

    removeCredential: async (providerId, entryId) => {
      const ids = entryIdsOf(providerId)
      // 最后一条不删:后端本来就拒空列表,这里先挡一道并说清理由。
      if (ids.length <= 1) return
      await writePool(
        providerId,
        (port) =>
          port.setCredentialPool({
            id: DEFAULT_SPACE_ID,
            providerId,
            entryIds: ids.filter((id) => id !== entryId),
          }),
        t('providers.poolFailed'),
      )
    },

    moveCredential: async (providerId, entryId, delta) => {
      const ids = entryIdsOf(providerId)
      const next = reorderPool(ids, entryId, delta)
      // 越界 = 没变。没变就不发 —— 一次空写会让屏幕闪一下忙态却什么都没做。
      if (next.every((id, index) => id === ids[index])) return
      await writePool(
        providerId,
        (port) => port.setCredentialPool({ id: DEFAULT_SPACE_ID, providerId, entryIds: next }),
        t('providers.poolFailed'),
      )
    },

    setRotation: async (providerId, policy) => {
      const ids = entryIdsOf(providerId)
      // 一条都没有时策略无处可挂 —— 那一口要求整串 id。
      if (ids.length === 0) return
      await writePool(
        providerId,
        (port) =>
          port.setCredentialPool({ id: DEFAULT_SPACE_ID, providerId, entryIds: ids, policy }),
        t('providers.poolFailed'),
      )
    },

    /* ── 订阅登录 ─────────────────────────────────────────────────────── */

    checkAuth: async (providerId) => {
      try {
        const port = await providerSettingsPort()
        const status = await port.oauthStatus({ providerId })
        set((st) => ({ authStatus: { ...st.authStatus, [providerId]: status } }))
      } catch {
        // 问不到就是不知道 —— 不写一份「未登录」进去冒充答案。
      }
    },

    startAuth: async (providerId) => {
      const epoch = bumpEpoch(providerId)
      patchFlow(providerId, { kind: null, busy: true, error: undefined, code: '' })

      let started: Awaited<ReturnType<typeof port.oauthStart>>
      const port = await providerSettingsPort()
      try {
        started = await port.oauthStart({ providerId })
      } catch (error) {
        patchFlow(providerId, {
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      if (epochIsStale(providerId, epoch)) return

      const kind = flowKindOf(started)
      if (!kind) {
        // 起步就失败:画错误原文,不画一个空流程。
        patchFlow(providerId, { kind: null, busy: false, error: started.error ?? '' })
        return
      }

      if (kind === 'device') {
        patchFlow(providerId, {
          kind: 'device',
          busy: false,
          device: {
            flowId: started.flowId,
            userCode: started.userCode ?? '',
            verificationUri: started.verificationUri ?? '',
            pollIntervalMs: started.pollIntervalMs,
          },
        })
        await pollDevice(providerId, epoch, started.flowId, started.pollIntervalMs)
        return
      }

      if (kind === 'paste') {
        // 贴码流**不锁面**:接下来要用户去浏览器里拿码,这边转个圈没有意义。
        patchFlow(providerId, {
          kind: 'paste',
          busy: false,
          paste: {
            flowId: started.flowId,
            state: started.state ?? '',
            instructions: started.instructions ?? '',
          },
        })
        return
      }

      patchFlow(providerId, { kind: 'browser', busy: false })
      await pollBrowser(providerId, epoch)
    },

    setAuthCode: (providerId, code) => patchFlow(providerId, { code, error: undefined }),

    submitAuthCode: async (providerId) => {
      const flow = get().authFlow[providerId]
      const code = (flow?.code ?? '').trim()
      if (!code || !flow?.paste) return
      patchFlow(providerId, { busy: true, error: undefined })
      try {
        const port = await providerSettingsPort()
        const response = await port.oauthCallback({
          providerId,
          code,
          state: flow.paste.state,
        })
        if (!response.success) {
          patchFlow(providerId, { busy: false, error: response.error ?? '' })
          return
        }
      } catch (error) {
        patchFlow(providerId, {
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      await settleAuth(providerId)
    },

    cancelAuth: (providerId) => {
      // 后端没有 cancel 这一口(端口文件头 ⑤)。取消 = 世代号 +1,
      // 于是还在飞的那个轮询循环下一轮自己认出「我过期了」并退出。
      bumpEpoch(providerId)
      set((st) => ({ authFlow: { ...st.authFlow, [providerId]: IDLE_AUTH_FLOW } }))
    },

    signOut: async (providerId, entryId) => {
      bumpEpoch(providerId)
      const ok = await writePool(
        providerId,
        (port) =>
          port
            .oauthLogout({ providerId, ...(entryId ? { entryId } : {}) })
            .then((response) => ({ success: response.success, error: response.error })),
        t('providers.signOutFailed'),
      )
      if (!ok) return
      set((st) => ({ authFlow: { ...st.authFlow, [providerId]: IDLE_AUTH_FLOW } }))
      await get().checkAuth(providerId)
      const port = await providerSettingsPort()
      const credentials = await port.readCredentials(DEFAULT_SPACE_ID).catch(() => undefined)
      if (credentials?.success) {
        set({ credentials: credentials.credentials?.providers ?? {}, credentialsKnown: true })
      }
    },

    /* ── 订阅用量 ─────────────────────────────────────────────────────── */

    loadUsage: async (providerId, force = false) => {
      const cached = usageCache.get(providerId)
      if (!force && cached && cached.expiresAt > Date.now()) {
        set((st) => ({
          usage: { ...st.usage, [providerId]: cached.response },
          usageStatus: { ...st.usageStatus, [providerId]: 'ready' },
          usageError: { ...st.usageError, [providerId]: '' },
        }))
        return
      }
      set((st) => ({ usageStatus: { ...st.usageStatus, [providerId]: 'loading' } }))
      try {
        const port = await providerSettingsPort()
        const response = await port.getProviderUsage(providerId, DEFAULT_SPACE_ID)
        if (response.unsupported) {
          // 「这家没有用量」是**后端说的**。存 null,组件据它整块不画。
          set((st) => ({
            usage: { ...st.usage, [providerId]: null },
            usageStatus: { ...st.usageStatus, [providerId]: 'ready' },
            usageError: { ...st.usageError, [providerId]: '' },
          }))
          return
        }
        if (!response.success) {
          set((st) => ({
            usageStatus: { ...st.usageStatus, [providerId]: 'error' },
            usageError: { ...st.usageError, [providerId]: response.error ?? '' },
          }))
          return
        }
        usageCache.set(providerId, { expiresAt: Date.now() + USAGE_CACHE_TTL_MS, response })
        set((st) => ({
          usage: { ...st.usage, [providerId]: response },
          usageStatus: { ...st.usageStatus, [providerId]: 'ready' },
          usageError: { ...st.usageError, [providerId]: '' },
        }))
      } catch (error) {
        set((st) => ({
          usageStatus: { ...st.usageStatus, [providerId]: 'error' },
          usageError: {
            ...st.usageError,
            [providerId]: error instanceof Error ? error.message : String(error),
          },
        }))
      }
    },

    /* ── 自定义家 ─────────────────────────────────────────────────────── */

    /**
     * 新建 / 改一家自定义 provider。**写两处**,与生产
     * (`SettingsPage.vue:706-762`)逐字同一条理由:`ai.customProviders[]` 是
     * 这一家的定义,而聊天的模型选择器读的是 `ai.providers[id]` 的
     * `selectedModels` / `enabled` —— 只写前者,新建出来的家在聊天里是隐形的。
     */
    saveCustomProvider: async (form, editingId) => {
      const base = get().settings
      if (!base) return
      const existing = (base.ai?.customProviders ?? []).find((item) => item.id === editingId)
      const id = existing?.id ?? `custom-${Date.now()}`
      const model = form.model.trim()
      const provider: CustomProviderConfig = {
        id,
        name: form.name.trim(),
        description: form.description.trim(),
        apiType: form.apiType,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey,
        model,
        selectedModels: existing?.selectedModels ?? (model ? [model] : []),
        enabled: existing?.enabled ?? true,
      }

      const list = base.ai?.customProviders ?? []
      const nextList = list.some((item) => item.id === id)
        ? list.map((item) => (item.id === id ? provider : item))
        : [...list, provider]

      const nextProviders: Record<string, ProviderConfig> = { ...(base.ai?.providers ?? {}) }
      const mirrored = nextProviders[id]
      nextProviders[id] = {
        ...mirrored,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model: provider.model,
        selectedModels:
          mirrored?.selectedModels && mirrored.selectedModels.length > 0
            ? mirrored.selectedModels
            : provider.selectedModels,
        enabled: mirrored?.enabled ?? provider.enabled ?? true,
      }

      const next = {
        ...base,
        ai: { ...base.ai, customProviders: nextList, providers: nextProviders },
      } as AppSettings
      await commitSettings(base, next)
      set({ selectedFamilyId: id })
    },

    deleteCustomProvider: async (providerId) => {
      const base = get().settings
      if (!base) return
      const nextProviders: Record<string, ProviderConfig> = { ...(base.ai?.providers ?? {}) }
      delete nextProviders[providerId]
      const next = {
        ...base,
        ai: {
          ...base.ai,
          customProviders: (base.ai?.customProviders ?? []).filter(
            (item) => item.id !== providerId,
          ),
          providers: nextProviders,
        },
      } as AppSettings
      await commitSettings(base, next)
      // 删掉的正好是选中的那一家:选择落空,右面回到「在左边选一家」。
      if (get().selectedFamilyId === providerId) set({ selectedFamilyId: null })
    },

    setDials: async (providerId, apiMode, region) => {
      const spec = providerDialsOf(providerId)
      if (!spec) return
      await writeProviders({ [providerId]: dialPatchOf(spec, apiMode, region) })
    },

    reset: () => {
      started = false
      authEpoch.clear()
      usageCache.clear()
      // 目录不在这个 store 里了(K1 样板迁移),但 reset 仍然管它 ——
      // 「这块面回到出厂」是一件事,不该因为搬了家就漏掉半边。
      catalogQuery.reset()
      set({
        status: 'idle',
        error: undefined,
        providers: [],
        settings: undefined,
        credentials: {},
        credentialsKnown: false,
        selectedFamilyId: null,
        pickedMode: {},
        query: '',
        modelQuery: {},
        keyStatus: {},
        saving: false,
        poolBusy: {},
        poolError: {},
        authStatus: {},
        authFlow: {},
        usage: {},
        usageStatus: {},
        usageError: {},
      })
    },
  }
})

/* ── 组件侧的同一条判据 ─────────────────────────────────────────────────── */

/** 家的表。名册与自定义表都变了才重算 —— 它是每一次渲染都要的东西。 */
export function familiesOf(state: ProviderSettingsState): ProviderFamilyView[] {
  return buildFamilies(state.providers, state.settings?.ai?.customProviders ?? [])
}

/** 一坑的凭证现状。`credentialsKnown` 是全域的闸,单坑不另设一个。 */
export function credentialsOf(state: ProviderSettingsState, providerId: string): CredentialFacts {
  return credentialFactsOf(state.credentials[providerId], state.credentialsKnown)
}

/** 一坑的凭证池视图(多钥列表 / 策略 / 删得动吗)。 */
export function poolOf(state: ProviderSettingsState, providerId: string) {
  return poolViewOf(state.credentials[providerId])
}

/** 一坑此刻的登录流。缺席 = 没在登录。 */
export function authFlowOf(state: ProviderSettingsState, providerId: string): AuthFlowState {
  return state.authFlow[providerId] ?? IDLE_AUTH_FLOW
}

/** 这一家此刻显示哪一坑 —— 组件与门共用的唯一读法。 */
export function activeModeOf(state: ProviderSettingsState, family: ProviderFamilyView) {
  return resolveMode(family, state.pickedMode[family.id], (providerId) => {
    const mode = family.modes.find((m) => m.providerId === providerId)
    return mode ? isModeConfigured(mode, credentialsOf(state, providerId)) : false
  })
}
