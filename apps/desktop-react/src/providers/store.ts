import { create } from 'zustand'
import type {
  CustomProviderConfig,
  ProviderConfig,
  ProviderInfo,
  ProviderUsageResponse,
  SpaceProviderSettings,
} from '@shared/ipc/providers'
import type { OAuthStatusResponse } from '@shared/ipc/oauth'
import type { AppSettings } from '@shared/ipc/settings'
import type { SpaceCredentialsSummary, SpaceProviderCredentialSummary } from '@shared/ipc/spaces'
import { providerSettingsPort } from '../data/provider-settings-port'
import { createMutation } from '../data/kernel'
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
import {
  composeSpaceSettings,
  resolveSpaceProviderSettings,
  splitSpaceProviderSettings,
} from './space-settings'
import { currentSpaceId, subscribeCurrentSpace } from '../workspace/current'
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
 * 这块面不在开机路径上,`start()` 只在面板第一次挂上时调。四发并行:
 * 名册(会碰网,后端顺手拉 models.dev)、全局设置、**当前空间的 provider 设置**、
 * **当前空间的凭证摘要**(后三发都是本地文件一次读)。
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
 * **底本是 store 里那两份(`settings` / `spaceAi`)**,不是每次写前再读一次 ——
 * 再读一次会把「另一扇窗刚改的东西」和「我这次要改的东西」混成一次写,
 * 而谁覆盖了谁看不出来。写成功后用后端回的那一份(`setProviderSettings` 的 `ai`)
 * 换掉底本,底本永远是后端认下的最后一份。
 *
 * ── 空间:这块面**整只**跟着当前工作区走(09-01「真切换」批)────────────────
 * 凭证摘要、凭证池写口、provider 设置(开关 / 勾选 / 默认模型 / 自定义家 / 档位)、
 * 订阅用量 —— 六条口一律打在 `currentSpaceId()` 上,`default` 不再是硬编码的那一个,
 * 只是「用户此刻恰好站在它上面」时的取值。
 *
 * 换空间是**唯一的刷新点**(`subscribeCurrentSpace`,与 Vue 壳
 * `stores/spaceProviders.ts:229` 的那条 watch 同一个角色):重拉凭证与该空间的
 * provider 设置。**名册与模型目录不重拉** —— 它们是机器级的事实(有哪些 provider、
 * models.dev 那份目录),不跟空间走;重拉它们只会白碰一次网,还会让面板闪一下。
 *
 * 为什么必须跟着走,而不是「先都打在 default 上,以后再说」:引擎起流时读的是
 * **会话归属那个空间**的设置与凭证(`resolveSessionProviderCredential(sessionId, …)`
 * 与 `getSessionSettings(sessionId).ai`)。设置页写偏一格,用户看到的是「配好了」,
 * 引擎看到的是「这个空间什么都没有」—— 那是一颗静默的雷,不是一档降级。
 *
 * ── `settings` 这一格的含义变了(形状没变) ───────────────────────────────
 * 它现在是**当前空间的生效设置** = 全局那一份(目录缓存 + 非 ai 段)合上
 * `workspaces/<当前空间>/providers.json`(`providers/space-settings.ts` 的
 * `composeSpaceSettings`)。形状与 `settings.getSettings()` 交下来的逐字相同 ——
 * 后者本来就是「default 空间的生效设置」,所以下游一行都不用改。
 * 写回走 `spaces.setProviderSettings`,底本是 `spaceAi`(空间那一份的原样)。
 */

export type SourceStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 密钥那一格的三态。'saving' 期间输入框禁用,钮上转一颗 spinner。 */
export type KeySaveStatus = 'idle' | 'saving' | 'saved'

export interface ProviderSettingsState {
  status: SourceStatus
  error?: string
  /** 名册原样。家的表是从它算的,不存第二份。 */
  providers: ProviderInfo[]
  /**
   * **当前空间的生效设置** = 全局那一份合上这个空间的 `providers.json`。
   * 形状与 `settings.getSettings()` 交下来的逐字相同,见文件头。
   */
  settings: AppSettings | undefined
  /**
   * 这个空间盘上那一份 provider 设置的**原样** —— 写回的底本。
   *
   * 与 `settings` 是两格而不是一格:合过的那份里 `temperature` 永远有值
   * (合的时候拿全局顶上了),拿它去写等于替用户在这个空间按下一次
   * 「就用这个温度」。哪一格是「这个空间真的表达过的」,只有这一份说得清。
   *
   * `undefined` = **后端答不上话**(web 降级 / 这条路由不存在),不是「空的空间」——
   * 后者是一份 `{ provider:'', providers:{}, customProviders:[] }`。
   */
  spaceAi: SpaceProviderSettings | undefined
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

  /**
   * providerId → 凭证池正在写。池的写本来就是逐坑的。
   * (设置那一路的忙态不在 store 里 —— 它在 `settingsMutation` 上,逐格。)
   */
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
/** 换空间那条订阅的句柄。同理:它是这一个进程的事实,不是屏幕上的一格。 */
let unsubscribeSpace: (() => void) | undefined

/* ── 设置写路:一发 mutation,逐格记账(09-01 批 1)──────────────────────────
 *
 * 从前这里是 store 上的一颗 `saving: boolean`。它是**整面共享**的一颗,于是
 * 勾一个模型的那 200ms 里,整张目录的勾选框、每一行的「设为当前」、家头上的
 * 启用开关、自定义家的「编辑」全部禁灰 —— 用户报的「勾选闪烁」就是这个
 * (病型 B:全局忙布尔把整面禁灰,粒度病;叠 E:往返极快时闪一下又回来)。
 *
 * 交互稳定律③要的是**逐格** pending,而「哪一格」这件事只有发起方说得清。
 * 所以写路整只交给 `data/kernel` 的 `createMutation`:它把一次写拆成四件
 * 各有其位的事(乐观上屏 → 写 → 成了对账 / 砸了回滚 + 一条通知),并且按
 * `key(input)` 分格记账 —— 同一格连点两下也不会被第一发的收尾提前解禁。
 *
 * 语义与从前那段 `commitSettings` **逐字等价**,三处照抄不动:
 *  · 回滚是 `settings` 与 `spaceAi` **两格一起**回底本(只回一格,下一次写
 *    就会拿着一格没人认下过的事实去拆 delta);
 *  · 成功后用后端认下的那一份(`response.ai`)把两格重合一次 ——
 *    **底本永远是后端认下的最后一份**;
 *  · 失败原话原样进通知(`response.error`,没给才退到那句通用的)。
 */

/** 一次设置写要带的全部东西。 */
export interface SettingsCommit {
  /** 底本。失败时 `settings` / `spaceAi` 两格一起回到这里。 */
  base: AppSettings
  /** 乐观值:立刻上屏的那一份,也是拆给后端的那一份。 */
  next: AppSettings
  /**
   * 这个空间盘上那一份的**原样**,在发起写之前就捕获。
   * 拆 delta(`splitSpaceProviderSettings`)与回滚共用同一份 —— 写到一半
   * 再去读一次,拿到的可能已经是另一发写完之后的了。
   */
  baseSpaceAi: SpaceProviderSettings | undefined
  /** 这一发打在哪一格上。产地只有下面那张表。 */
  key: string
}

/**
 * 忙态格子的**唯一词表**。store 记账与组件读账共用它 —— 两头各拼一次字符串
 * 就是两处会漂开(而漂开的表现是「某个控件永远不转」,没人会发现)。
 */
export const settingsKey = {
  /** 一个模型一格:勾选 / 取消 / 设为当前 / 删手填,都打在被点的那一行上。 */
  model: (providerId: string, modelId: string) => `model:${providerId}:${modelId}`,
  /** 手填提交那颗钮 —— 它写的模型 id 此刻还不存在,挂不到任何一行上。 */
  manual: (providerId: string) => `manual:${providerId}`,
  /** 一家一格(家族一开全开,所以格子是家不是坑)。 */
  family: (family: ProviderFamilyView) => `family:${family.id || providerIdsOf(family)[0] || ''}`,
  /** 计费档位一坑一格。 */
  dials: (providerId: string) => `dials:${providerId}`,
  /** 自定义家的新建 / 保存 / 删除。 */
  custom: (providerId: string) => `custom:${providerId}`,
  /** 组件侧按前缀滤出「这一坑此刻在写的那些模型 id」。 */
  modelPrefix: (providerId: string) => `model:${providerId}:`,
} as const

export const settingsMutation = createMutation<SettingsCommit, SpaceProviderSettings | undefined>(
  'providers.settings',
  {
    key: (input) => input.key,
    optimistic: (input) => {
      useProviderSettings.setState({ settings: input.next })
      // 回滚**两格一起**回底本 —— 理由见上面那段。
      return () => {
        useProviderSettings.setState({ settings: input.base, spaceAi: input.baseSpaceAi })
      }
    },
    run: async (input) => {
      const port = await providerSettingsPort()
      // 写的是**这个空间那一份**,不是整份应用设置 —— 理由(以及 default 为什么
      // 不是特例)写在 `data/provider-settings-port.ts` 的 ③′。
      const response = await port.writeProviderSettings({
        id: currentSpaceId(),
        ai: splitSpaceProviderSettings(input.next, input.baseSpaceAi),
      })
      // 「后端说没成」与「这一发抛了」在这条原语里是同一件事:都得回滚。
      if (!response.success) throw new Error(response.error || t('providers.saveFailed'))
      return response.ai
    },
    settle: (ai, input) => {
      // 后端没回那一份就保持乐观值 —— 它已经被后端认下了,只是没把结果说回来。
      if (!ai) return
      // 底本永远是后端认下的最后一份 —— 连 `settings` 那一格也照它重合一次,
      // 免得屏幕上留着一份「我以为写成了什么」而盘上是另一份。
      useProviderSettings.setState({ spaceAi: ai, settings: composeSpaceSettings(input.next, ai) })
    },
    onError: (error) => {
      notify({
        level: 'warn',
        source: 'providers.save',
        title: t('providers.saveFailed'),
        body: error.message,
        detail: error.message,
      })
    },
  },
)

export const useProviderSettings = create<ProviderSettingsState>()((set, get) => {
  /**
   * providerId → 上一次用量答案。**不放进可渲染状态**:它是「这一口多久之内
   * 不必再问」这件事,不是屏幕上的任何一格(屏幕读的是 `usage`)。
   */
  const usageCache = new Map<string, CachedUsage>()

  /**
   * @param options.skipRoster 换空间那一发传 true —— 见下面那一段。
   */
  async function load(options?: { skipRoster?: boolean }): Promise<void> {
    set({ status: 'loading' })
    const port = await providerSettingsPort()
    // 并行且**各自失败各自认**:名册拉不到不该把设置也拖没。
    // 后两发认的是**同一个空间**(在这一刻取一次,别让四发各取各的 —— 中途换空间
    // 会拿到半新半旧的一屏)。
    const spaceId = currentSpaceId()
    const [providers, settings, spaceSettings, credentials] = await Promise.all([
      // **名册换空间时不重拉**:它是机器级的事实(这台机器认识哪些 provider),
      // 而且这一发**会碰网**(后端顺手拉 models.dev 的整份目录)。换一次空间白碰
      // 一次网不说,左栏还会跟着空一下再长回来 —— 而它从头到尾就没变过。
      options?.skipRoster ? undefined : port.listProviders().catch(() => undefined),
      port.readSettings().catch(() => undefined),
      port.readProviderSettings(spaceId).catch(() => undefined),
      port.readCredentials(spaceId).catch(() => undefined),
    ])
    // 拉的过程中用户又切了空间:这一屏已经不是「当前空间的」,丢掉 —— 那一次切换
    // 自己会带来一发新的 load(与 Vue 壳 `spaceProviders.refresh` 的同一道闸)。
    if (currentSpaceId() !== spaceId) return

    // 没重拉名册时,手上那一份仍然作数(`undefined` 才是「读不到」,空数组是
    // 「读到了,一家都没有」—— 两者在 status 上不是一回事)。
    const roster =
      (providers?.success ? (providers.providers ?? []) : undefined) ??
      (options?.skipRoster ? get().providers : undefined)
    const loaded = settings?.success ? settings.settings : undefined
    // 后端答不上话(web 降级 / 这条路由不存在)与「这个空间是空的」是两件事:
    // 前者 `spaceAi` 留 undefined(合出来就是一份空的 provider 表,与从前
    // 读不到设置时的样子一致),后者是一份真的空设置。两者都不去看别的空间。
    // 未迁移的机器盘上还没有 per-space 文件,那时全局那份就是所有空间的真相 ——
    // 判据与病历(09-01 报障 ①)在 `space-settings.resolveSpaceProviderSettings`。
    const spaceAi = spaceSettings?.success
      ? resolveSpaceProviderSettings(spaceSettings.ai, loaded)
      : undefined
    set({
      providers: roster ?? [],
      spaceAi,
      settings: composeSpaceSettings(loaded, spaceAi),
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
   * `key` 是这一发打在哪一格上(词表 `settingsKey`)—— 逐调用点定,因为
   * 「被点的是哪一个控件」只有调用点知道:同样一次 `writeProviders`,
   * 从模型行来的打在那一行上,从家头开关来的打在那一家上。
   */
  async function writeProviders(
    patch: Readonly<Record<string, Partial<ProviderConfig>>>,
    key: string,
  ): Promise<void> {
    const base = get().settings
    if (!base) return
    const nextProviders: Record<string, ProviderConfig> = { ...(base.ai?.providers ?? {}) }
    for (const [providerId, delta] of Object.entries(patch)) {
      nextProviders[providerId] = { ...EMPTY_CONFIG, ...nextProviders[providerId], ...delta }
    }
    const next = { ...base, ai: { ...base.ai, providers: nextProviders } } as AppSettings
    await commitSettings(base, next, key)
  }

  /**
   * 整份写回的**收尾那一半**,如今只剩「把底本摆好交给 `settingsMutation`」。
   * 乐观 / 写 / 对账 / 回滚四件事在那条原语里(见文件中段那段说明)。
   *
   * `spaceAi` 在**这一刻**取一次,而不是在 `run` 里再读:写到一半再读会拿到
   * 另一发写完之后的那一份,拆出来的 delta 就带着一格没人认下过的事实。
   */
  async function commitSettings(base: AppSettings, next: AppSettings, key: string): Promise<void> {
    await settingsMutation.run({ base, next, baseSpaceAi: get().spaceAi, key })
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
    const credentials = await port.readCredentials(currentSpaceId()).catch(() => undefined)
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
    spaceAi: undefined,
    credentials: {},
    credentialsKnown: false,
    selectedFamilyId: null,
    pickedMode: {},
    query: '',
    modelQuery: {},
    keyStatus: {},
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
      // 换空间是这块面**唯一**的刷新点(见文件头)。订在 `load()` 之前:
      // 工作区列表是异步读的,首次读到时当前空间可能从「persist 槽里那个」
      // 解析成别的(记着的那个被别的窗口删了),那一下也得重拉。
      unsubscribeSpace?.()
      unsubscribeSpace = subscribeCurrentSpace(() => {
        // 先把上一个空间的东西清干净再拉 —— 凭证摘要与 provider 设置是**这个空间
        // 的私产**,让它们在新空间的首屏上多留一帧,就是在屏幕上串一次空间的账。
        // (与列表面「旧内容留到新世界首屏」相反,那里旧内容是同一本账的另一投影,
        //  这里旧内容是**别人的密钥尾号**。)
        set({ spaceAi: undefined, settings: undefined, credentials: {}, credentialsKnown: false })
        usageCache.clear()
        void load({ skipRoster: true })
      })
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
      await writeProviders(patch, settingsKey.family(family))
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
      await writeProviders(
        { [providerId]: { selectedModels: next } },
        settingsKey.model(providerId, modelId),
      )
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
          id: currentSpaceId(),
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
      await writeProviders(
        {
          [providerId]: {
            model: modelId,
            selectedModels: selected.includes(modelId) ? selected : [...selected, modelId],
          },
        },
        settingsKey.model(providerId, modelId),
      )
    },

    addManualModel: (providerId, modelId) => {
      const id = modelId.trim()
      if (!id) return undefined
      const selected = get().settings?.ai?.providers?.[providerId]?.selectedModels ?? []
      // 重复是**用户看得见的事实**,不是错误 —— 当场说清,不发请求。
      if (selected.includes(id)) return t('providers.addModelDuplicate', { model: id })
      // 手填这一发挂在**提交钮**那一格上:它写的 id 此刻还不在表里,挂不到行上。
      void writeProviders(
        { [providerId]: { selectedModels: [...selected, id] } },
        settingsKey.manual(providerId),
      )
      return undefined
    },

    removeManualModel: async (providerId, modelId) => {
      const selected = get().settings?.ai?.providers?.[providerId]?.selectedModels ?? []
      if (!selected.includes(modelId)) return
      // 与生产 `toggleSpaceModelSelection` 同一条守则:不许摘掉最后一个。
      if (selected.length <= 1) return
      const next = selected.filter((id) => id !== modelId)
      const config = get().settings?.ai?.providers?.[providerId]
      await writeProviders(
        {
          [providerId]: {
            selectedModels: next,
            // 删掉的正好是当前模型时,当前顺位落到剩下的第一个 ——
            // 留一个指向已删 id 的 `model` 就是让聊天那边挑到一个不存在的模型。
            ...(config?.model === modelId ? { model: next[0] ?? '' } : {}),
          },
        },
        settingsKey.model(providerId, modelId),
      )
    },

    /* ── 凭证池 ───────────────────────────────────────────────────────── */

    addCredential: async (providerId, apiKey, label) => {
      const key = apiKey.trim()
      if (!key) return
      await writePool(
        providerId,
        (port) =>
          port.setCredential({
            id: currentSpaceId(),
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
        (port) => port.setCredential({ id: currentSpaceId(), providerId, entryId, apiKey: key }),
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
            id: currentSpaceId(),
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
        (port) => port.setCredentialPool({ id: currentSpaceId(), providerId, entryIds: next }),
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
          port.setCredentialPool({ id: currentSpaceId(), providerId, entryIds: ids, policy }),
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
      const credentials = await port.readCredentials(currentSpaceId()).catch(() => undefined)
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
        const response = await port.getProviderUsage(providerId, currentSpaceId())
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
      await commitSettings(base, next, settingsKey.custom(id))
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
      await commitSettings(base, next, settingsKey.custom(providerId))
      // 写没成就到此为止:那一家还在,它的钥匙当然不能动。
      // (commitSettings 失败时会把底本回滚回 `base`,所以这一句就是「成没成」。)
      if (get().settings === base) return

      /*
       * ── 连带把这一家的**凭证条目**清掉(09-01 勘察补的那一格)────────────
       * 设置与凭证是**两个文件**(`workspaces/<空间>/providers.json` 与
       * `credentials.json`),删前者不动后者 —— 于是从前删完一家自定义 provider,
       * 它的 API key 会以孤儿的身份留在盘上:界面上再也看不到它,而它还在。
       *
       * 更要紧的是那不只是「不整洁」:`isProviderSupported` 对任何 `custom-*`
       * 一律放行(`runtime/providers/registry.ts`),所以「这一家还在不在」全靠
       * `providers[id]` 与凭证两处都真的没了。少清一处,一条还绑着它的老会话
       * 就可能**照样发得出去** —— 用户以为删掉的东西还在花钱。
       *
       * ── 次序:先设置、后凭证 ─────────────────────────────────────────────
       * 反过来更坏:凭证先清、设置写失败,就等于**删掉了一把还在用的钥匙**,
       * 而渲染层手上从来没有密钥原文,补不回来。按这个次序,最坏的结果只是
       * 一条孤儿凭证 —— 而 `writePool` 失败时本来就会弹一条说出来。
       *
       * 走 `writePool` 而不是自己再拼一次端口调用:忙态、失败原话、摘要回填
       * 那一套它已经有了,复写一遍就是两处会漂(与「复用已有那一口拆卸」同理)。
       */
      await writePool(
        providerId,
        (port) => port.clearCredential({ id: currentSpaceId(), providerId }),
        t('providers.customDeleteKeyLeft'),
      )

      // 删掉的正好是选中的那一家:选择落空,右面回到「在左边选一家」。
      if (get().selectedFamilyId === providerId) set({ selectedFamilyId: null })
    },

    setDials: async (providerId, apiMode, region) => {
      const spec = providerDialsOf(providerId)
      if (!spec) return
      await writeProviders({ [providerId]: dialPatchOf(spec, apiMode, region) }, settingsKey.dials(providerId))
    },

    reset: () => {
      started = false
      unsubscribeSpace?.()
      unsubscribeSpace = undefined
      authEpoch.clear()
      usageCache.clear()
      // 目录不在这个 store 里了(K1 样板迁移),写路也不在了(批 1),
      // 但 reset 仍然管它们 —— 「这块面回到出厂」是一件事,
      // 不该因为搬了家就漏掉半边。这也是本模块**唯一的那一口拆卸**:
      // 下面的 HMR dispose 复用它,不另写一套。
      catalogQuery.reset()
      settingsMutation.reset()
      set({
        status: 'idle',
        error: undefined,
        providers: [],
        settings: undefined,
        spaceAi: undefined,
        credentials: {},
        credentialsKnown: false,
        selectedFamilyId: null,
        pickedMode: {},
        query: '',
        modelQuery: {},
        keyStatus: {},
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

/**
 * **HMR 退役**(09-01 批 1 立的纪律,起因是 chat-source 那一案:热更之后旧模块
 * 的模块级副作用没死,两个实例同时活着)。
 *
 * 这个文件的模块级副作用有三样:启动闸 `started`、换空间那条订阅
 * `unsubscribeSpace`、以及新加的 `settingsMutation`(它自带监听表与逐格计数)。
 * 三样的寿命都是「这个模块实例」,而热更换的正是模块实例 —— 不退役,旧实例的
 * 换空间订阅会继续往一个没人看的 store 里灌数据,旧 mutation 的监听表也会
 * 攥着已卸载组件的回调。
 *
 * 退役**复用这个模块已有的那一口拆卸**(`reset()`,它已经把三样连同
 * `catalogQuery` 一起收干净),不写第二套。它自身幂等;生产构建里
 * `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useProviderSettings.getState().reset()
  })
}

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
