import { useMemo } from 'react'
import { create } from 'zustand'
import { isProviderEnabledIn } from '@renderer/stores/helpers/provider-model'
import type { OpenRouterModel, ProviderInfo, SpaceProviderSettings } from '@shared/ipc/providers'
import { modelsPort } from './models-port'
import { useSessionsSource } from './sessions-source'
import { findSession } from '../expose/projection'
import { notify } from '../services/notify'
import { t } from '../i18n'
import { currentSpaceId, subscribeCurrentSpace } from '../workspace/current'
import { resolveSpaceProviderSettings } from '../providers/space-settings'

/**
 * 模型目录与当前模型的**真数据源**(D2)。全应用一个:模型抽屉从这里取目录,
 * 模型药丸从这里读「此刻跑的是谁」,读数环从这里问「这个模型的窗口多大」。
 *
 * 分工与 `data/agents-source.ts` 逐条同构 —— 那是这个文件的模板,不是巧合:
 * 「选一个人」与「选一个模型」在壳里是同一件事的两个实例(会话上的一格绑定,
 * 有会话就上行、没会话就记账,建会话时兑现)。
 *
 * ── 当前模型是**推导**出来的,不是存下来的 ──────────────────────────────
 * 没有「初始化 store」这一步。`resolveModelSelection` 每次从三层事实里现算:
 *   刚选完还没被 listMeta 追认的那块牌(optimistic)
 *   → 会话事实(SessionSummary.provider / .model = SessionMeta.lastProvider / lastModel)
 *   → 当前空间的默认(该空间 providers.json 的 provider + providers[那家].model)
 * 存一份副本就会有第三种事实,而它一定会与前两种漂开(换会话、后端改了、
 * 上行失败)。**同一条判据只算一次**,与 `resolveAgentId` 同款。
 *
 * 三层都答不上来 = **不知道**,药丸上写「选择模型」——不拿目录里第一家第一型去顶。
 * 那是 `SessionSummary.model` 早就写死的口径(expose/types.ts):
 * 「不拿一个默认模型名去顶」。全局默认不算顶:那正是引擎在用户没选时会用的那一个。
 *
 * ── 取数时机:设置热,名册与目录都冷 ────────────────────────────────────
 * `start()`(连通后一次)只拉**设置**:它是本地文件的一次读,没有网络,而
 * 药丸开机第一眼要写的那个默认模型就在里面。
 *
 * `providers.list` **不在启动期**。它看着像一次便宜的内存读,实际上后端那一侧
 * (`getAvailableProviders` → `configureAppProviderRegistry`)会顺手把 models.dev
 * 的整份目录(实测 212 家 / 7494 条)拉回来 —— 真机日志里看得见。为一个也许
 * 永远不会被点开的抽屉在每次开机拉一次外网,代价与收益完全不成比例;
 * 更要紧的是它把一次外网往返塞进了开机路径,而这套壳的开机路径此前**不碰网**。
 *
 * 所以名册与目录都是懒的:抽屉打开时拉名册 + 可见那几家的目录
 * (`ensureVisibleCatalogs`),读数环要窗口时只拉当前那一家(`ensureCatalog`)。
 */

/** 一家 provider 在屏幕上的全部事实。产地 `providers.list` 的 `ProviderInfo`。 */
export interface ProviderOption {
  id: string
  /** 显示名。空串读作缺席 → 退回用 id 当名字(总比画一个空组头强)。 */
  name: string
}

/** 目录里一条模型:屏幕只用得着 id 与窗口,其余(定价 / 模态 / 分词器)不投。 */
export interface CatalogModel {
  id: string
  /** context_length,缺席回落 top_provider.context_length;两处都没有 = **不知道**。 */
  contextLength: number | null
}

/** 抽屉里的一行。`contextLength` 为 null = 这条不知道窗口,那一格不画。 */
export interface ModelOption {
  model: string
  contextLength: number | null
}

/** 抽屉里的一组。`id` 是 provider id(上行要它),`provider` 是显示名(组头写它)。 */
export interface ProviderGroup {
  id: string
  provider: string
  models: ModelOption[]
}

/** 一次选择 = 一对 (provider, model)。`provider` 空串 = 只知道模型名,不知道哪家。 */
export interface ModelSelection {
  provider: string
  model: string
}

/**
 * 设置里与模型选择有关的**窄投影**。整份 provider 设置不进 store:
 * 这里要的只有三格,存整份等于把一堆与屏幕无关的事实(密钥、端点、档位)
 * 拖进一个会被订阅的地方。
 */
export interface ProviderPrefs {
  /** 这个空间的默认那一家(`SpaceProviderSettings.provider`)。空串 = 还没选过。 */
  defaultProvider: string
  /** providerId → 这一家的三格。 */
  configs: Record<string, { enabled?: boolean; selectedModels: string[]; model: string }>
}

export type ModelsSourceStatus = 'idle' | 'loading' | 'ready' | 'error'
export type CatalogStatus = 'loading' | 'ready' | 'error'

/* ── 纯判据 ────────────────────────────────────────────────────────────── */

/** 线上形状 → 屏幕形状。名字空了退回 id:组头总得有个字。 */
export function toProviderOption(info: ProviderInfo): ProviderOption {
  const name = (info.name ?? '').trim()
  return { id: info.id, name: name || info.id }
}

/**
 * 窗口大小的单一产地。`context_length` 优先,缺席回落 `top_provider.context_length`
 * (勘察记的口径),两处都没有(0 / 非有限数)= null = **不知道**。
 * 0 不是一个窗口大小,它是「这一格没填」。
 */
export function contextLengthOf(model: OpenRouterModel): number | null {
  const direct = model.context_length
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct
  const fallback = model.top_provider?.context_length
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) return fallback
  return null
}

export function toCatalogModels(models: readonly OpenRouterModel[]): CatalogModel[] {
  return models.map((model) => ({ id: model.id, contextLength: contextLengthOf(model) }))
}

/**
 * **当前空间那份 provider 设置** → 三格窄投影。缺席(还没连上 / 后端答不上话 /
 * 这个空间还没配过)= 空投影 —— 三种情况在屏幕上是同一件事:一家都列不出来。
 *
 * **自定义 provider 的默认模型也算一条可列的模型**:它没有 models.dev 目录,
 * 用户在设置里填的那个 `model` 就是它全部的模型表(Vue 壳
 * `buildProviderModelOptions` 的同一手)。不折进来的话,一台只配了自定义
 * provider 的机器打开抽屉会是空的 —— 而它明明能发消息。
 */
export function toProviderPrefs(ai: SpaceProviderSettings | undefined): ProviderPrefs {
  const configs: ProviderPrefs['configs'] = {}
  for (const [id, config] of Object.entries(ai?.providers ?? {})) {
    configs[id] = {
      enabled: config?.enabled,
      selectedModels: Array.isArray(config?.selectedModels) ? config.selectedModels : [],
      model: (config?.model ?? '').trim(),
    }
  }
  for (const custom of ai?.customProviders ?? []) {
    const model = (custom.model ?? '').trim()
    const existing = configs[custom.id]
    const selectedModels = existing?.selectedModels.length
      ? existing.selectedModels
      : model
        ? [model]
        : []
    configs[custom.id] = { enabled: existing?.enabled, selectedModels, model }
  }
  return { defaultProvider: (ai?.provider ?? '').trim(), configs }
}

/**
 * 自定义 provider 也要出现在名册上 —— `providers.list` 只回内置的那些
 * (Vue 壳 `updateAvailableProviders` 把两边并起来,这里同判据)。
 */
export function customProviderOptionsOf(ai: SpaceProviderSettings | undefined): ProviderOption[] {
  return (ai?.customProviders ?? []).map((custom) => ({
    id: custom.id,
    name: (custom.name ?? '').trim() || custom.id,
  }))
}

/**
 * 这一家在抽屉里列哪几个模型 —— 就是用户在设置里勾过的那些
 * (`selectedModels`,与 Vue 壳 `selectedModelsOf` 同一格)。
 *
 * 当前模型即使没被勾过也**排在最前**:它正在跑,抽屉里找不到它会让人以为
 * 自己看错了(Vue 壳 `buildProviderModelOptions` 的同一手)。
 */
export function modelIdsOf(
  prefs: ProviderPrefs,
  providerId: string,
  current: ModelSelection | null,
): string[] {
  const ids = [...(prefs.configs[providerId]?.selectedModels ?? [])]
  if (current && current.provider === providerId && current.model && !ids.includes(current.model)) {
    ids.unshift(current.model)
  }
  return ids
}

/**
 * 抽屉里的分组表 —— **两道闸**,第三道(凭证)的留账写在 models-port.ts 顶部。
 *  ① 开关:`isProviderEnabledIn`(契约层的家族派生,不在这里重写一遍);
 *  ② 有模型可列:一条都列不出来的家不出组头(空组头等于让人点了个寂寞)。
 *
 * 目录还没拉到的家**照样出组**:它的模型 id 来自设置(那一份已经在手上),
 * 少的只是窗口那一格。为了一个次要读数把整组藏起来是更坏的谎。
 */
export function buildProviderGroups(
  providers: readonly ProviderOption[],
  prefs: ProviderPrefs,
  catalog: Readonly<Record<string, CatalogModel[]>>,
  current: ModelSelection | null,
): ProviderGroup[] {
  const groups: ProviderGroup[] = []
  for (const provider of providers) {
    if (!isProviderEnabledIn(prefs.configs, provider.id)) continue
    const ids = modelIdsOf(prefs, provider.id, current)
    if (ids.length === 0) continue
    const models = catalog[provider.id] ?? []
    groups.push({
      id: provider.id,
      provider: provider.name,
      models: ids.map((id) => ({
        model: id,
        contextLength: models.find((entry) => entry.id === id)?.contextLength ?? null,
      })),
    })
  }
  return groups
}

/**
 * 默认选择 = 引擎在用户没选过时会用的那一个(**当前空间**那份设置的 `provider` +
 * 那一家的 `model`)。两格缺一 = 没有默认,不编。
 */
export function defaultSelectionOf(prefs: ProviderPrefs): ModelSelection | null {
  const provider = prefs.defaultProvider
  if (!provider) return null
  const model = prefs.configs[provider]?.model ?? ''
  return model ? { provider, model } : null
}

/**
 * 此刻跑的是哪个模型 —— **屏幕唯一的判据**(三层,顺序即事实的新鲜度)。
 *
 * 会话事实那一层要求 `model` 有值;`provider` 允许缺席(老会话可能只有
 * `lastModel`)—— 那时候药丸照样写得出模型名,只是查不到窗口。
 */
export function resolveModelSelection(
  optimistic: Readonly<Record<string, ModelSelection>>,
  sessionId: string | null,
  session: { provider: string | null; model: string | null } | undefined,
  pending: ModelSelection | null,
  prefs: ProviderPrefs,
): ModelSelection | null {
  if (sessionId && optimistic[sessionId]) return optimistic[sessionId]
  if (session?.model) return { provider: session.provider ?? '', model: session.model }
  // 没有会话时,药丸上写的是「下一条新会话会用谁」——与 agent 徽同一条口径。
  if (!sessionId && pending) return pending
  return defaultSelectionOf(prefs)
}

/** 这个选择的上下文窗口。目录没拉到 / 这条不在目录里 / 目录没填 = null = 不知道。 */
export function contextWindowOf(
  catalog: Readonly<Record<string, CatalogModel[]>>,
  selection: ModelSelection | null,
): number | null {
  if (!selection?.provider || !selection.model) return null
  return catalog[selection.provider]?.find((m) => m.id === selection.model)?.contextLength ?? null
}

/* ── 组件侧的同一条判据 ─────────────────────────────────────────────────── */

/**
 * 此刻跑的是哪个模型 —— 组件侧唯一的读法(药丸、抽屉、读数环共用)。
 * 判据仍然只有 `resolveModelSelection` 一个产地,这里只是把它接到订阅上,
 * 与 `files-source.useSessionCwd` 逐条同构。
 *
 * `sessionId` 是**入参**而不是就地读总览 store:那会让这个模块 import
 * `expose/store`,而 `expose/store` 为了兑现草稿态的预选又要 import 这里 ——
 * 一个可以不长出来的环。调用现场本来就知道自己在哪条会话上。
 */
export function useCurrentModelSelection(sessionId: string): ModelSelection | null {
  const sessions = useSessionsSource((st) => st.sessions)
  const optimistic = useModelsSource((st) => st.optimistic)
  const pending = useModelsSource((st) => st.pending)
  const prefs = useModelsSource((st) => st.prefs)
  return useMemo(
    () =>
      resolveModelSelection(
        optimistic,
        sessionId || null,
        findSession(sessions, sessionId),
        pending,
        prefs,
      ),
    [optimistic, sessionId, sessions, pending, prefs],
  )
}

/* ── store ────────────────────────────────────────────────────────────── */

export interface ModelsSourceState {
  status: ModelsSourceStatus
  /** 失败时那句人话;成功后清空。 */
  error?: string
  providers: ProviderOption[]
  prefs: ProviderPrefs
  /** providerId → 这一家的目录(懒加载)。 */
  catalog: Record<string, CatalogModel[]>
  catalogStatus: Record<string, CatalogStatus>
  /**
   * 「还没进会话时选的那个模型」= 下一条新会话的模型。
   * 建会话的编排点(`expose/store.newSession`)建完就 `applyPendingModel` 兑现,
   * 与 `agents-source.pendingAgentId` 逐条同构。
   */
  pending: ModelSelection | null
  /**
   * 刚选完、还没被 `listMeta` 追认的那些。键 = 会话 id。
   * 写成功立牌、重拉之后撤牌;写失败当场撤牌 + notify(warn),**绝不留说谎的牌**。
   */
  optimistic: Record<string, ModelSelection>

  /** 连通后启动:**只**拉设置(不碰网)。幂等。 */
  start: () => Promise<void>
  /** 重新拉设置(设置在别处被改过之后要它)。 */
  refresh: () => Promise<void>
  /** 拉一次 provider 名册。懒的 —— 理由见文件头。已经拉过就直接返回。 */
  ensureProviders: () => Promise<void>
  /** 拉一家的目录进缓存。已经在拉 / 已经拉好的直接返回。 */
  ensureCatalog: (providerId: string) => Promise<void>
  /** 抽屉打开时:把此刻可见的那几家的目录一次拉齐。 */
  ensureVisibleCatalogs: (current: ModelSelection | null) => Promise<void>
  /**
   * 选一个模型。
   *  - 有会话:`sessions.updateModel` —— **从下一轮起生效,历史照留**;
   *  - 没有会话:只记 `pending`(建会话时兑现)。
   */
  selectModel: (sessionId: string | null, provider: string, model: string) => Promise<void>
  /** 把 `pending` 兑现到刚建出来的那条会话上,然后**无论成败都清空**。 */
  applyPendingModel: (sessionId: string) => Promise<void>
  /** 测试用:回到未启动的干净态。 */
  reset: () => void
}

const EMPTY_PREFS: ProviderPrefs = { defaultProvider: '', configs: {} }

/** 模块级的启动闸 —— 「这一个进程启动过没有」不是可渲染状态。 */
let started = false
/** 换空间那条订阅的句柄 —— 这一个进程的事实,不是可渲染状态。 */
let unsubscribeSpace: (() => void) | undefined

export const useModelsSource = create<ModelsSourceState>()((set, get) => {
  /** 每家目录一条在飞的承诺,防同一帧里两个消费者各拉一次。 */
  const inflight = new Map<string, Promise<void>>()

  /** 名册拉过没有 —— 「这一个进程问过一次没有」不是可渲染状态。 */
  let providersLoaded = false
  let providersInflight: Promise<void> | undefined

  /**
   * **当前空间那一份 provider 设置**。不碰网,所以它是启动期唯一的一发。
   *
   * 换工作区也走这一发(见 `start` 里那条订阅)—— 换空间就是换一份「哪一家可见、
   * 这一家列哪些型、默认是哪一家」,而**名册与模型目录一个都不重拉**:
   * 它们是机器级的事实,不跟空间走。
   */
  async function loadSettings(): Promise<void> {
    set({ status: 'loading' })
    const port = await modelsPort()
    const spaceId = currentSpaceId()
    try {
      /*
       * 两发:空间那份 + 全局那份。**全局那份不是回落用的**,它是拿来回答
       * 「这台机器迁移过没有」的(`storage.spaceProviderSettingsMigratedAt`)——
       * 判据与取舍全在 `resolveSpaceProviderSettings` 一处,09-01 报障 ① 的病历
       * 也写在那儿。各自失败各自认:全局那发拿不到就当没迁移过的证据不足,
       * 照旧以空间那份为准。
       */
      const [settings, global] = await Promise.all([
        port.readProviderSettings(spaceId),
        port.readSettings().catch(() => undefined),
      ])
      // 拉的过程中又切了空间:这一份已经不是当前空间的,丢掉 —— 那次切换自己
      // 会带来一发新的 loadSettings。
      if (currentSpaceId() !== spaceId) return
      const ai = settings.success
        ? resolveSpaceProviderSettings(settings.ai, global?.success ? global.settings : undefined)
        : undefined
      set({
        status: 'ready',
        error: undefined,
        // 设置没拿到不是致命的:空投影会让抽屉一家都不列,那正是
        // 「不知道谁可见」诚实的样子(不是列全部)。
        prefs: ai ? toProviderPrefs(ai) : EMPTY_PREFS,
      })
      // 自定义 provider 只住在设置里,`providers.list` 不认识它们 —— 所以它们
      // 跟着设置一起到,不必等名册那一发。
      if (ai) {
        const custom = customProviderOptionsOf(ai)
        set((st) => ({
          providers: [...st.providers, ...custom.filter((c) => !st.providers.some((p) => p.id === c.id))],
        }))
      }
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 名册。**会碰网**(见文件头),所以它只在抽屉打开时才发。 */
  async function loadProviders(): Promise<void> {
    const port = await modelsPort()
    try {
      const response = await port.listProviders()
      if (!response.success) return
      const builtin = (response.providers ?? []).map(toProviderOption)
      providersLoaded = true
      // 内置的在前、自定义的(设置那一发已经放进来了)在后。id 撞了以内置为准。
      set((st) => ({
        providers: [...builtin, ...st.providers.filter((p) => !builtin.some((b) => b.id === p.id))],
      }))
    } catch {
      // 名册拉不到 = 抽屉里只剩自定义那几家(或者空),不弹提示:人正在开抽屉。
    }
  }

  async function loadCatalog(providerId: string): Promise<void> {
    set((st) => ({ catalogStatus: { ...st.catalogStatus, [providerId]: 'loading' } }))
    const port = await modelsPort()
    try {
      const response = await port.listModels(providerId)
      if (!response.success) {
        set((st) => ({ catalogStatus: { ...st.catalogStatus, [providerId]: 'error' } }))
        return
      }
      set((st) => ({
        catalog: { ...st.catalog, [providerId]: toCatalogModels(response.models ?? []) },
        catalogStatus: { ...st.catalogStatus, [providerId]: 'ready' },
      }))
    } catch {
      // 目录拉不到只让窗口那一格空着 —— 不弹提示:它是次要读数,
      // 而人此刻正在开抽屉选模型,一条 toast 只会挡住他要点的那一行。
      set((st) => ({ catalogStatus: { ...st.catalogStatus, [providerId]: 'error' } }))
    }
  }

  return {
    status: 'idle',
    providers: [],
    prefs: EMPTY_PREFS,
    catalog: {},
    catalogStatus: {},
    pending: null,
    optimistic: {},

    start: async () => {
      if (started) return
      started = true
      // 换工作区 = 换一份 provider 设置。订在首发之前,理由与 sessions-source
      // 那条逐字相同:工作区列表是异步读的,首次读到时当前空间可能解析成别的。
      unsubscribeSpace?.()
      unsubscribeSpace = subscribeCurrentSpace(() => {
        void loadSettings()
      })
      const port = await modelsPort()
      await port.ready()
      await loadSettings()
    },

    refresh: async () => {
      await loadSettings()
    },

    ensureProviders: async () => {
      if (providersLoaded) return
      providersInflight ??= loadProviders().finally(() => {
        providersInflight = undefined
      })
      return providersInflight
    },

    ensureCatalog: async (providerId) => {
      if (!providerId) return
      const existing = inflight.get(providerId)
      if (existing) return existing
      if (get().catalogStatus[providerId] === 'ready') return
      const run = loadCatalog(providerId).finally(() => inflight.delete(providerId))
      inflight.set(providerId, run)
      return run
    },

    ensureVisibleCatalogs: async (current) => {
      // 名册先到位(它也是懒的),再按两道闸挑出可见的那几家去拉目录。
      await get().ensureProviders()
      const { providers, prefs, ensureCatalog } = get()
      const groups = buildProviderGroups(providers, prefs, {}, current)
      await Promise.all(groups.map((group) => ensureCatalog(group.id)))
    },

    selectModel: async (sessionId, provider, model) => {
      if (!provider || !model) return
      // 还没进会话:这次选择是「下一条新会话用谁」,不写盘也不发请求。
      if (!sessionId) {
        set({ pending: { provider, model } })
        return
      }

      const before = get().optimistic
      set({ optimistic: { ...before, [sessionId]: { provider, model } } })

      const rollback = () => {
        set((prev) => {
          const next = { ...prev.optimistic }
          if (sessionId in before) next[sessionId] = before[sessionId]
          else delete next[sessionId]
          return { optimistic: next }
        })
      }

      let failure: string | undefined
      try {
        const port = await modelsPort()
        const response = await port.updateSessionModel(sessionId, provider, model)
        if (!response.success) failure = response.error || t('model.switchFailed')
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }

      if (failure) {
        rollback()
        notify({
          level: 'warn',
          source: 'model.switch',
          title: t('model.switchFailed'),
          body: failure,
          detail: failure,
        })
        return
      }

      // 对齐:后端认了这件事之后,牌就该撤掉 —— 屏幕从此读 listMeta 的事实。
      // 撤牌**在重拉之后**,中间那一段仍由牌顶着,所以药丸不会闪回旧模型。
      await useSessionsSource.getState().refresh()
      set((prev) => {
        const next = { ...prev.optimistic }
        delete next[sessionId]
        return { optimistic: next }
      })
    },

    applyPendingModel: async (sessionId) => {
      const selection = get().pending
      if (!sessionId || !selection) return
      // 清空是无条件的,理由与 `applyPendingAgent` 逐字相同:这一格说的是
      // 「**下一条**新会话用谁」——下一条已经建出来了,这句话就用掉了。
      set({ pending: null })

      let failure: string | undefined
      try {
        const port = await modelsPort()
        const response = await port.updateSessionModel(
          sessionId,
          selection.provider,
          selection.model,
        )
        if (!response.success) failure = response.error || t('model.switchFailed')
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      if (!failure) return
      notify({
        level: 'warn',
        source: 'model.switch',
        title: t('model.switchFailed'),
        body: failure,
        detail: failure,
      })
    },

    reset: () => {
      started = false
      unsubscribeSpace?.()
      unsubscribeSpace = undefined
      providersLoaded = false
      providersInflight = undefined
      inflight.clear()
      set({
        status: 'idle',
        error: undefined,
        providers: [],
        prefs: EMPTY_PREFS,
        catalog: {},
        catalogStatus: {},
        pending: null,
        optimistic: {},
      })
    },
  }
})
