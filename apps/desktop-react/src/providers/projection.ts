import { isProviderEnabledIn } from '@renderer/stores/helpers/provider-model'
import type { OpenRouterModel, ProviderConfig } from '@shared/ipc/providers'
import type {
  SpaceCredentialEntrySummary,
  SpaceProviderCredentialSummary,
} from '@shared/ipc/spaces'
import { UNKNOWN_CREDENTIALS } from './types'
import type {
  CatalogRow,
  CredentialFacts,
  Fact,
  ModeTab,
  ModelCap,
  ProviderFamilyView,
  ProviderMode,
  ProviderModeKind,
  RailRow,
  StatusTone,
} from './types'

/**
 * 「模型服务」面的**全部判据**。纯函数,不认识 React、不认识 store,也**不翻译**
 * —— 交出去的是 `Fact`(说哪句话 + 带哪些数),组件用 useT 把它变成字。
 *
 * 这样分不是洁癖:副行那句「订阅 · 已登录 · 3 型」是三条事实拼的,而三条事实各自
 * 从哪儿来(凭证摘要 / 设置 / 目录)是这块面最容易说谎的地方。把它们做成可断言的
 * 数据,门就守得住;做成拼好的字符串,门只能守住字面。
 *
 * ── 一条纪律:拿不到 ≠ 没有 ────────────────────────────────────────────────
 * 凭证摘要那一口失败时,`CredentialFacts.known === false`,副行说的是「状态未知」
 * 而不是「未配置」。两者在屏幕上长得像,在事实上差得远。
 */

/* ── 凭证 ──────────────────────────────────────────────────────────────── */

function isCooling(entry: SpaceCredentialEntrySummary, now: number): boolean {
  return typeof entry.cooldownUntil === 'number' && entry.cooldownUntil > now
}

/**
 * 一家一模式的凭证现状。`summary` 缺席但 `known` 为真 = 这个 provider 在池子里
 * 一条都没有 = 真的未配置。
 */
export function credentialFactsOf(
  summary: SpaceProviderCredentialSummary | undefined,
  known: boolean,
  now: number = Date.now(),
): CredentialFacts {
  if (!known) return UNKNOWN_CREDENTIALS
  const entries = summary?.entries ?? []
  const withKey = entries.filter((e) => e.hasApiKey)
  const withOAuth = entries.filter((e) => e.hasOAuthToken)
  return {
    known: true,
    hasApiKey: withKey.length > 0,
    apiKeyPreview: withKey[0]?.apiKeyPreview,
    hasOAuth: withOAuth.length > 0,
    oauthAccount: withOAuth[0]?.oauthAccount,
    entries: entries.length,
    cooling: entries.some((e) => isCooling(e, now)),
  }
}

/**
 * 这一坑**配好了没有**。本地两坑与自定义坑零凭证 —— 它们不需要配,所以恒真:
 * 说一台本机进程「未配置」是没有意义的。
 */
export function isModeConfigured(mode: ProviderMode, creds: CredentialFacts): boolean {
  if (mode.kind === 'localCli' || mode.kind === 'acp' || mode.kind === 'custom') return true
  if (!creds.known) return false
  return mode.kind === 'subscription' ? creds.hasOAuth : creds.hasApiKey
}

/* ── 事实句 ────────────────────────────────────────────────────────────── */

const MODE_LABEL: Record<ProviderModeKind, Fact['key']> = {
  api: 'providers.modeApi',
  subscription: 'providers.modeSub',
  localCli: 'providers.modeLocalCli',
  acp: 'providers.modeAcp',
  custom: 'providers.modeCustom',
}

export function modeLabelFact(mode: ProviderMode): Fact {
  return { key: MODE_LABEL[mode.kind] }
}

/**
 * 一坑的现状读数(分段器那一格的第二行 / 副行的第二段)。
 * 顺序即优先级:不知道 → 冷却 → 已配 → 未配。
 */
export function modeStateFact(mode: ProviderMode, creds: CredentialFacts): Fact {
  if (mode.kind === 'localCli' || mode.kind === 'acp') return { key: 'providers.factLocal' }
  if (mode.kind === 'custom') return { key: 'providers.factCustom' }
  if (!creds.known) return { key: 'providers.factUnknown' }
  if (creds.cooling) return { key: 'providers.factCooling' }
  if (mode.kind === 'subscription') {
    return creds.hasOAuth ? { key: 'providers.factSignedIn' } : { key: 'providers.factSignedOut' }
  }
  if (!creds.hasApiKey) return { key: 'providers.factUnconfigured' }
  return creds.entries > 1
    ? { key: 'providers.factKeys', vars: { count: creds.entries } }
    : { key: 'providers.factConfigured' }
}

export function modeTabsOf(
  family: ProviderFamilyView,
  credsOf: (providerId: string) => CredentialFacts,
): ModeTab[] {
  return family.modes.map((mode) => ({
    providerId: mode.providerId,
    kind: mode.kind,
    label: modeLabelFact(mode),
    state: modeStateFact(mode, credsOf(mode.providerId)),
  }))
}

/* ── 左栏一行 ──────────────────────────────────────────────────────────── */

/**
 * 副行的信息密度照 ProviderRail 结构摘录的样例:
 * 「订阅 · 已登录 · 3 型」/「API · 未配置」/「本地 · 已选 1 型」。
 *
 * 三段的产地各不相同,所以每段都可能缺席:
 *  ① 坑名  —— 家里每一坑各一段(一家两模式就是两段);
 *  ② 现状  —— 凭证摘要(拿不到就是「状态未知」);
 *  ③ 已选  —— 设置里的 `selectedModels` 合计。零就不说 —— 「已选 0 型」是废话。
 */
export function railFactsOf(
  family: ProviderFamilyView,
  enabled: boolean,
  configs: Readonly<Record<string, Pick<ProviderConfig, 'selectedModels'> | undefined>>,
  credsOf: (providerId: string) => CredentialFacts,
): Fact[] {
  if (!enabled) return [{ key: 'providers.factDisabled' }]
  const facts: Fact[] = []
  for (const mode of family.modes) {
    facts.push(modeLabelFact(mode))
    facts.push(modeStateFact(mode, credsOf(mode.providerId)))
  }
  const selected = family.modes.reduce(
    (sum, mode) => sum + (configs[mode.providerId]?.selectedModels?.length ?? 0),
    0,
  )
  if (selected > 0) facts.push({ key: 'providers.factSelected', vars: { count: selected } })
  return facts
}

/**
 * 状态点的 tone。**只有点上色**(纪律:状态色不上文字、不上底),
 * 所以这一档判据只服务那 6px。
 */
export function railToneOf(
  family: ProviderFamilyView,
  enabled: boolean,
  credsOf: (providerId: string) => CredentialFacts,
): StatusTone {
  if (!enabled) return 'off'
  const all = family.modes.map((m) => ({ mode: m, creds: credsOf(m.providerId) }))
  if (all.some((x) => x.creds.cooling)) return 'bad'
  if (all.some((x) => isModeConfigured(x.mode, x.creds))) return 'ok'
  // 一坑都没配好:凭证口本身拿不到 = 不知道(warn),真的一条都没有 = 还没配(idle)。
  return all.every((x) => !x.creds.known) ? 'warn' : 'idle'
}

/** 方图标里那个 mono 首字母。名字为空退回 '·' —— 总得有个字。 */
export function initialOf(label: string): string {
  const trimmed = label.trim()
  return trimmed ? [...trimmed][0].toUpperCase() : '·'
}

export function buildRailRows(
  families: readonly ProviderFamilyView[],
  configs: Readonly<Record<string, ProviderConfig | undefined>>,
  credsOf: (providerId: string) => CredentialFacts,
): RailRow[] {
  return families.map((family) => {
    const enabled = isProviderEnabledIn(configs, family.id)
    return {
      familyId: family.id,
      label: family.label,
      initial: initialOf(family.label),
      facts: railFactsOf(family, enabled, configs, credsOf),
      tone: railToneOf(family, enabled, credsOf),
      group: family.group,
      custom: family.custom,
    }
  })
}

/**
 * 「N 家已接入」的 N。**接入 ≠ 名册长度** —— 名册上十几家,配过的往往两三家,
 * 拿名册长度当读数是这块面最容易犯的那种谎。
 *
 * 判据是「这一家有没有一坑是配好的」,与**启用与否无关**:停用是用户此刻的选择,
 * 不是「没接上」。出错的(余额不足、冷却中)也算接上了 —— 那是「接上了但这会儿
 * 用不了」。凭证口读不到时一家都数不出来,那时读数是 0,而副行会说「状态未知」。
 */
export function connectedCountOf(
  families: readonly ProviderFamilyView[],
  credsOf: (providerId: string) => CredentialFacts,
): number {
  return families.filter((family) =>
    family.modes.some((mode) => isModeConfigured(mode, credsOf(mode.providerId))),
  ).length
}

/**
 * 左栏检索。**只按名字与 provider id 筛** —— 副行是算出来的事实句,
 * 拿翻译过的字去匹配用户打的字,换一门语言就换一套结果。
 */
export function filterRailRows(
  rows: readonly RailRow[],
  families: readonly ProviderFamilyView[],
  query: string,
): RailRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return rows.slice()
  return rows.filter((row) => {
    if (row.label.toLowerCase().includes(needle)) return true
    const family = families.find((f) => f.id === row.familyId)
    return family?.modes.some((m) => m.providerId.toLowerCase().includes(needle)) ?? false
  })
}

/* ── 模型目录 ──────────────────────────────────────────────────────────── */

/** 五格能力的判据。全部来自目录记录本身,一格都不猜。 */
export function capsOf(model: OpenRouterModel): ModelCap[] {
  const input = model.architecture?.input_modalities ?? []
  const output = model.architecture?.output_modalities ?? []
  const params = model.supported_parameters ?? []
  const caps: ModelCap[] = []
  if (input.includes('image')) caps.push('vision')
  if (params.includes('tools')) caps.push('tools')
  if (params.includes('reasoning')) caps.push('reasoning')
  if (output.includes('image')) caps.push('imageOut')
  if (input.includes('audio')) caps.push('audioIn')
  return caps
}

/** 正数才算数。0 / 负数 / 非有限数 = 这一格没填 = **不知道**。 */
function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function contextOf(model: OpenRouterModel): number | null {
  return positive(model.context_length) ?? positive(model.top_provider?.context_length)
}

export function maxOutputOf(model: OpenRouterModel): number | null {
  return positive(model.top_provider?.max_completion_tokens)
}

/**
 * 单价。目录给的是**每 token** 的美元字符串,屏幕上写的是每百万 token ——
 * 换算在这一处做一次。两格缺一即 null:半个价格不如不写。
 */
export function priceOf(model: OpenRouterModel): { input: number; output: number } | null {
  const input = Number(model.pricing?.prompt)
  const output = Number(model.pricing?.completion)
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null
  if (input <= 0 && output <= 0) return null
  return { input: input * 1_000_000, output: output * 1_000_000 }
}

/** 200000 → 「200K」;1_200_000 → 「1.2M」。null 由调用方决定画什么。 */
export function formatTokens(value: number | null): string | null {
  if (value === null) return null
  if (value >= 1_000_000) {
    const m = value / 1_000_000
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`
  }
  if (value >= 1000) return `${Math.round(value / 1000)}K`
  return String(value)
}

/** $3 → 「$3」;$0.55 → 「$0.55」。整数不拖两位小数。 */
export function formatPrice(value: number): string {
  if (Number.isInteger(value)) return `$${value}`
  return `$${value < 1 ? value.toFixed(2) : value.toFixed(1)}`
}

/**
 * 目录 → 行。
 *
 * **勾过但目录里没有的模型照样出现**(排在最前):它正在被聊天用着,列表里找不到
 * 它会让人以为自己看错了 —— 与 `models-source.modelIdsOf` 同一手。
 */
export function buildCatalogRows(
  models: readonly OpenRouterModel[],
  config: ProviderConfig | undefined,
  query = '',
): CatalogRow[] {
  const selected = new Set(config?.selectedModels ?? [])
  const current = (config?.model ?? '').trim()
  const rows: CatalogRow[] = models.map((model) => ({
    id: model.id,
    name: (model.name ?? '').trim() || model.id,
    selected: selected.has(model.id),
    current: current === model.id,
    contextLength: contextOf(model),
    maxOutput: maxOutputOf(model),
    caps: capsOf(model),
    price: priceOf(model),
  }))

  const known = new Set(rows.map((r) => r.id))
  const orphans: CatalogRow[] = [...selected]
    .filter((id) => !known.has(id))
    .map((id) => ({
      id,
      name: id,
      selected: true,
      current: current === id,
      contextLength: null,
      maxOutput: null,
      caps: [],
      price: null,
    }))

  const all = [...orphans, ...rows]
  const needle = query.trim().toLowerCase()
  if (!needle) return all
  return all.filter(
    (row) => row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle),
  )
}

/**
 * 「上次拉取」的时刻。**本地时区的 MM-DD HH:mm** —— 目录刷新是一件当天的事,
 * 年份与秒都是噪音。0 / 缺席 = 还没拉过,由调用方换成那句话。
 *
 * 手写而不是 `toLocaleString`:那个方法在不同 locale 下给出的字段顺序都不一样,
 * 而这一格是要和别的读数对齐着扫的,长度必须恒定。
 */
export function formatFetchedAt(ms: number | undefined): string | null {
  if (!ms) return null
  const at = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`
}

/** 订阅坑的模型不按 token 计价(交接稿 §1)—— 价格那一格写「订阅内」。 */
export function priceIsIncluded(kind: ProviderModeKind): boolean {
  return kind === 'subscription'
}
