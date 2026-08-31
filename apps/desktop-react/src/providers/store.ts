import { create } from 'zustand'
import type { OpenRouterModel, ProviderConfig, ProviderInfo } from '@shared/ipc/providers'
import type { AppSettings } from '@shared/ipc/settings'
import type { SpaceProviderCredentialSummary } from '@shared/ipc/spaces'
import { providerSettingsPort } from '../data/provider-settings-port'
import { notify } from '../services/notify'
import { t } from '../i18n'
import { buildFamilies, providerIdsOf, resolveMode } from './families'
import { credentialFactsOf, isModeConfigured } from './projection'
import type { CredentialFacts, ProviderFamilyView } from './types'

/**
 * 「模型服务」面的数据源。一个应用一个 —— 面板可以同时挂好几份实例(架子里的
 * 后台 tab、Dock 预览泡),但它们说的必须是同一件事。
 *
 * ── 取数时机:全都是懒的 ──────────────────────────────────────────────────
 * 这块面不在开机路径上,`start()` 只在面板第一次挂上时调。三发并行:
 * 名册(会碰网,后端顺手拉 models.dev)、设置(本地文件一次读)、凭证摘要
 * (本地文件一次读)。模型目录再懒一层:选中哪一坑才拉哪一坑。
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
export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error'

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

  catalog: Record<string, OpenRouterModel[]>
  catalogStatus: Record<string, CatalogStatus>
  /** providerId → 目录拉不到时后端那句原话。 */
  catalogError: Record<string, string>
  /** providerId → 上次拉取时刻(ms)。0 / 缺席 = 这一坑还没拉过。 */
  catalogFetchedAt: Record<string, number>

  /** providerId → 密钥那一格的状态。 */
  keyStatus: Record<string, KeySaveStatus>
  /** 正在写设置(启用开关 / 勾选)。整面共享一颗 —— 写的是同一份设置。 */
  saving: boolean

  start: () => Promise<void>
  refresh: () => Promise<void>
  selectFamily: (familyId: string) => void
  selectMode: (familyId: string, providerId: string) => void
  setQuery: (query: string) => void
  setModelQuery: (providerId: string, query: string) => void
  ensureCatalog: (providerId: string, forceRefresh?: boolean) => Promise<void>
  /** 启用/停用一家。**家族一开全开**:一次把这一家的所有 provider id 写完。 */
  setFamilyEnabled: (family: ProviderFamilyView, enabled: boolean) => Promise<void>
  /** 勾选/取消一个模型(写 `selectedModels`)。 */
  toggleModel: (providerId: string, modelId: string, selected: boolean) => Promise<void>
  /** 保存一把 API 密钥。走凭证域,**不**走 saveSettings(理由见端口文件头)。 */
  saveApiKey: (providerId: string, apiKey: string) => Promise<void>
  reset: () => void
}

const EMPTY_CONFIG: ProviderConfig = { model: '', selectedModels: [] }

/** 模块级启动闸 —— 「这一个进程启动过没有」不是可渲染状态。 */
let started = false

export const useProviderSettings = create<ProviderSettingsState>()((set, get) => {
  /** 每坑一条在飞的承诺,防同一帧里两个消费者各拉一次。 */
  const inflight = new Map<string, Promise<void>>()

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

  async function loadCatalog(providerId: string, forceRefresh: boolean): Promise<void> {
    set((st) => ({ catalogStatus: { ...st.catalogStatus, [providerId]: 'loading' } }))
    const port = await providerSettingsPort()
    try {
      const response = await port.listModels(providerId, forceRefresh)
      if (!response.success) {
        set((st) => ({
          catalogStatus: { ...st.catalogStatus, [providerId]: 'error' },
          catalogError: { ...st.catalogError, [providerId]: response.error ?? '' },
        }))
        return
      }
      set((st) => ({
        catalog: { ...st.catalog, [providerId]: response.models ?? [] },
        catalogStatus: { ...st.catalogStatus, [providerId]: 'ready' },
        catalogError: { ...st.catalogError, [providerId]: '' },
        catalogFetchedAt: { ...st.catalogFetchedAt, [providerId]: Date.now() },
      }))
    } catch (error) {
      set((st) => ({
        catalogStatus: { ...st.catalogStatus, [providerId]: 'error' },
        catalogError: {
          ...st.catalogError,
          [providerId]: error instanceof Error ? error.message : String(error),
        },
      }))
    }
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
    catalog: {},
    catalogStatus: {},
    catalogError: {},
    catalogFetchedAt: {},
    keyStatus: {},
    saving: false,

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

    ensureCatalog: async (providerId, forceRefresh = false) => {
      if (!providerId) return
      const existing = inflight.get(providerId)
      if (existing) return existing
      if (!forceRefresh && get().catalogStatus[providerId] === 'ready') return
      const run = loadCatalog(providerId, forceRefresh).finally(() => inflight.delete(providerId))
      inflight.set(providerId, run)
      return run
    },

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

    reset: () => {
      started = false
      inflight.clear()
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
        catalog: {},
        catalogStatus: {},
        catalogError: {},
        catalogFetchedAt: {},
        keyStatus: {},
        saving: false,
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

/** 这一家此刻显示哪一坑 —— 组件与门共用的唯一读法。 */
export function activeModeOf(state: ProviderSettingsState, family: ProviderFamilyView) {
  return resolveMode(family, state.pickedMode[family.id], (providerId) => {
    const mode = family.modes.find((m) => m.providerId === providerId)
    return mode ? isModeConfigured(mode, credentialsOf(state, providerId)) : false
  })
}
