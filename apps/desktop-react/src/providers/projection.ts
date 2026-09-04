import { isProviderEnabledIn } from '@onething/client/model/provider-model'
import { frozenFlagOf } from '../ui/list-placement'
import type { OpenRouterModel, ProviderConfig } from '@shared/ipc/providers'
import type {
  SpaceCredentialEntrySummary,
  SpaceProviderCredentialSummary,
} from '@shared/ipc/spaces'
import { OTHER_GROUP, UNKNOWN_CREDENTIALS } from './types'
import type {
  CatalogGroup,
  CatalogRow,
  CredentialFacts,
  Fact,
  GroupedCatalog,
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

/* ── 凭证池(多钥 / 顺序 / 策略)──────────────────────────────────────────── */

/**
 * 三档内置轮换策略。取值与语义句**逐字**照生产
 * (`packages/renderer/components/settings/provider/SpaceCredentialPool.vue:367-377`)——
 * 「按序接力」这些名字是用户已经认识的字,这块壳没有资格另起一套。
 *
 * `policy` 在契约上是 `string` 而不是联合类型,因为插件可以注册策略
 * (`plugin:<id>:<name>`)。不认识的取值按 `single` 解析,但**字段本身不改写** ——
 * 插件回来它自动生效,替用户把选择抹掉才是真的错。
 */
export const ROTATION_POLICIES = ['single', 'priority-failover', 'round-robin'] as const
export type RotationPolicy = (typeof ROTATION_POLICIES)[number]

const POLICY_LABEL: Record<RotationPolicy, Fact['key']> = {
  single: 'providers.rotationSingle',
  'priority-failover': 'providers.rotationFailover',
  'round-robin': 'providers.rotationRoundRobin',
}

const POLICY_HINT: Record<RotationPolicy, Fact['key']> = {
  single: 'providers.rotationSingleHint',
  'priority-failover': 'providers.rotationFailoverHint',
  'round-robin': 'providers.rotationRoundRobinHint',
}

export function rotationLabelFact(policy: string): Fact {
  return isRotationPolicy(policy)
    ? { key: POLICY_LABEL[policy] }
    : { key: 'providers.rotationUnknown', vars: { policy } }
}

/** 选择器下面那句语义说明。不认识的策略没有话可说 —— 不编一句。 */
export function rotationHintFact(policy: string): Fact | null {
  return isRotationPolicy(policy) ? { key: POLICY_HINT[policy] } : null
}

export function isRotationPolicy(policy: string): policy is RotationPolicy {
  return (ROTATION_POLICIES as readonly string[]).includes(policy)
}

/** 池子里的一行。序号 = 优先级,所以它是**算出来的**,不是存的。 */
export interface PoolRow {
  id: string
  /** 1 起。这就是优先级 —— 「第 1 条」和「最先用的那条」是同一件事。 */
  ordinal: number
  label: string
  authType: 'apiKey' | 'oauth'
  preview?: string
  oauthAccount?: string
  /** 产地。后端今天只写 `'user'`,别的取值原样透出去,不替它编一个名字。 */
  source: string
  cooldownUntil?: number
  cooling: boolean
}

/**
 * ── `canDelete` 已退役(09-02 批 11)────────────────────────────────────
 * 从前这里有一格 `canDelete: entries.length > 1`,理由写的是「后端本来就拒空列表」。
 * 那句话只对了一半:后端拒的是**用一次排序请求顺手清空一个 provider**
 * (`runtime/spaces/ipc-operations.ts:378`),而不是「这一家不许回到未配置」——
 * 它自己那句错误话就指着正路:「要清空整段请用『清除』」。删最后一条改走
 * `spaces.clearCredential` 之后,**每一条都删得动**,这一格恒等于「有没有行」,
 * 一个恒真的字段只会让人以为它在判什么。所以删掉,不留恒真尸体。
 */
export interface PoolView {
  rows: PoolRow[]
  policy: string
  /** 策略是插件给的、而此刻那个插件不在。字段不改,画灰 + 一句说明。 */
  policyUnavailable: boolean
}

export function poolViewOf(
  summary: SpaceProviderCredentialSummary | undefined,
  now: number = Date.now(),
): PoolView {
  const entries = summary?.entries ?? []
  return {
    rows: entries.map((entry, index) => ({
      id: entry.id,
      ordinal: index + 1,
      label: entry.label ?? '',
      authType: entry.authType,
      preview: entry.apiKeyPreview,
      oauthAccount: entry.oauthAccount,
      source: entry.source,
      cooldownUntil: entry.cooldownUntil,
      cooling: isCooling(entry, now),
    })),
    policy: summary?.policy || 'single',
    policyUnavailable: summary?.policyUnavailable === true,
  }
}

/**
 * 冷却还剩多久。**分钟 / 小时 / 天三档**,与生产
 * (`SpaceCredentialPool.vue:570-577` 的 `describeRemaining`)逐字同一套判据 ——
 * 「剩 4 分钟」比「剩 251 秒」有用,而秒级读数还会让这一格每秒重画一次。
 */
export function cooldownFact(untilMs: number | undefined, now: number = Date.now()): Fact | null {
  if (typeof untilMs !== 'number') return null
  const remain = untilMs - now
  if (remain <= 0) return { key: 'providers.coolSoon' }
  const minutes = Math.ceil(remain / 60_000)
  if (minutes < 60) return { key: 'providers.coolMinutes', vars: { count: minutes } }
  const hours = Math.ceil(remain / 3_600_000)
  if (hours < 24) return { key: 'providers.coolHours', vars: { count: hours } }
  return { key: 'providers.coolDays', vars: { count: Math.ceil(remain / 86_400_000) } }
}

/**
 * 调序后的 id 序列。`setCredentialPool` 吃的是**期望的最终顺序**,
 * 所以「上移一格」在这一层就是一次交换,不是一条指令。
 * 越界(第一条上移 / 最后一条下移)原样返回 —— 调用方据「没变」决定不发请求。
 */
export function reorderPool(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= ids.length) return ids.slice()
  const next = ids.slice()
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
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
 * 单价。**目录给的已经是每百万 token 的美元数**,屏幕上写的也是每百万 ——
 * 所以这里一次换算都不做。两格缺一即 null:半个价格不如不写。
 *
 * ── 这里曾经乘过 1e6,真机上把 gpt-5.6 画成了 $5000000 ──────────────────────
 * 病根是把 `OpenRouterModel` 这个**名字**当成了产地。它只是个遗留信封:全仓
 * 只有一个序列化口会产出目录行 ——
 * `packages/onething-runtime/src/providers/model-registry.ts:719`
 * (`onethingCapabilityEntryToOpenRouterModel`,:737-739 把数 `String()` 一下),
 * 而它的入参 `OnethingModelCapabilityEntry.pricing` 在 :881-886 白纸黑字写着是
 * **USD per 1M token**。没有任何代码去拉 `openrouter.ai/api/v1/models` ——
 * 连叫 `openrouter` 的那一家,目录也是从 models.dev 来的(models.dev 的
 * `cost.input/output` 本身就是每百万)。其余产地(Copilot / ACP / Codex /
 * 自定义模型)一律硬写 `"0"`,由下面 `<= 0` 那一条挡掉。
 *
 * 所以判据**不是**按源分辨、更不是拿阈值猜:这一层只有一个产地,单位是它的合同。
 * 旁证:`onething-runtime/src/usage/pricing.ts:36-40` 算完账才 `/ 1_000_000`。
 */
export function priceOf(model: OpenRouterModel): { input: number; output: number } | null {
  const input = Number(model.pricing?.prompt)
  const output = Number(model.pricing?.completion)
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null
  if (input <= 0 && output <= 0) return null
  return { input, output }
}

/**
 * 3 → 「$3」;2.19 → 「$2.19」;0.3 → 「$0.3」;0.861 → 「$0.86」。
 *
 * 两位小数 + **去掉拖尾的零**:目录里的价既有 `3` 也有 `2.19` 也有 `0.3`,
 * 固定位数会把 `$0.3` 写成 `$0.30`(多一个没意义的零)或把 `$2.19` 截成 `$2.2`
 * (少一个有意义的分)。
 *
 * 两位截到 0 而原值不是 0 时退到三位 —— 「$0」是**说这东西免费**,
 * 而它其实是 $0.002。宁可多一位,不可说错。
 */
export function formatPrice(value: number): string {
  const two = Number(value.toFixed(2))
  const text = two === 0 && value > 0 ? value.toFixed(3) : value.toFixed(2)
  // 去零只砍小数部分,`$150` 的那两个零一根都不许动。
  return `$${text.replace(/\.?0+$/, '')}`
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
    manual: false,
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
      // 「勾了但目录不认识」= 手填。这不是另一份存储,是同一个事实的名字。
      manual: true,
    }))

  const all = [...orphans, ...rows]
  const needle = query.trim().toLowerCase()
  if (!needle) return all
  return all.filter(
    (row) => row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle),
  )
}

/* ── 厂牌折叠(OpenRouter 300+ 行)─────────────────────────────────────── */

/**
 * 到多少行才值得折叠。**低于这个数就平铺** —— 十几行的目录折起来只是多了两次点击。
 * 60 这个数的来历:一屏大约放得下 20 行,三屏还翻不完的时候,折叠才开始省事。
 */
export const GROUP_MIN_ROWS = 60

/**
 * 一个厂牌要有多少型才配单独一组。低于这个数的全并进「其他」——
 * 45 个只有两三型的厂牌各占一行组头,那不是折叠,是把噪音换了个形状。
 */
export const GROUP_MIN_VENDOR_ROWS = 10

/** 检索命中最多画多少行。截了必须如实报,不能默默少画。 */
export const SEARCH_ROW_CAP = 50

/** `anthropic/claude-sonnet-4` → `anthropic/`;没有斜杠 = 没有厂牌。 */
export function vendorPrefixOf(id: string): string | null {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash + 1) : null
}

/**
 * 目录 → 折叠后的目录。三条判据,一条都不藏在组件里:
 *
 *  ① **已选置顶**:勾过的行永远在最上面、永远展开。它们是「这一坑此刻在用什么」,
 *     折进某个厂牌组里就等于把当下最重要的事实藏进了一次点击后面。
 *  ② **按 `vendor/` 前缀分组**,行数不够(< `GROUP_MIN_ROWS`)就不分。
 *  ③ **检索时截 `SEARCH_ROW_CAP` 行**并如实报剩余 —— 一次画三百行是卡顿的产地,
 *     而「只画前 50」不说出来就是说谎。
 *
 * 注意 `rows` 已经是**过滤后**的(`buildCatalogRows` 吃过 query),所以这里的
 * `searching` 只用来决定「要不要截」与「组要不要自动展开」,不再筛一遍。
 *
 * ── `placement`:①用的是**固化过的**「已选」,不是此刻的(09-01 报障)────────
 * 判据①一旦直接读 `row.selected`,勾选就成了重排:真机量到勾一下中段的模型,
 * 它当场从第 16 行飞到第 3 行(-689px),而且因为换了父容器,DOM 节点被整个
 * 换掉。用户原话「很难受」。
 *
 * 所以**位置与状态分家**:`placement` 是进这块面 / 显式刷新时拍的一张快照
 * (`ui/list-placement`),决定行落在哪一区;`row.selected` 仍然是活值,决定
 * 勾选框画成什么样。快照不认识的行(刚手填的那种)按活值算。
 * 不给 `placement` = 老行为(立刻重排),只留给不在交互中的调用方与测试。
 */
export function groupCatalog(
  rows: readonly CatalogRow[],
  searching: boolean,
  placement?: ReadonlyMap<string, boolean>,
): GroupedCatalog {
  const placedPicked = (row: CatalogRow) => frozenFlagOf(placement, row.id, row.selected)
  const picked = rows.filter(placedPicked)
  const rest = rows.filter((row) => !placedPicked(row))

  // 检索时只截未选的那一半:已选是「我在用的」,再多也得画全。
  const capped = searching ? rest.slice(0, SEARCH_ROW_CAP) : rest
  const truncated = rest.length - capped.length

  if (rows.length < GROUP_MIN_ROWS) {
    return { picked, groups: [{ prefix: OTHER_GROUP, rows: capped, vendors: 0 }], grouped: false, truncated }
  }

  const buckets = new Map<string, CatalogRow[]>()
  for (const row of capped) {
    const prefix = vendorPrefixOf(row.id) ?? OTHER_GROUP
    const bucket = buckets.get(prefix)
    if (bucket) bucket.push(row)
    else buckets.set(prefix, [row])
  }

  const groups: CatalogGroup[] = []
  const other: CatalogRow[] = []
  let otherVendors = 0
  for (const [prefix, bucket] of buckets) {
    if (prefix !== OTHER_GROUP && bucket.length >= GROUP_MIN_VENDOR_ROWS) {
      groups.push({ prefix, rows: bucket, vendors: 1 })
      continue
    }
    other.push(...bucket)
    if (prefix !== OTHER_GROUP) otherVendors += 1
  }

  // 大组在前,同样大小按前缀字典序 —— 顺序必须是**算出来的**,
  // 不然同一份目录两次打开的排布会不一样。
  groups.sort((a, b) => b.rows.length - a.rows.length || a.prefix.localeCompare(b.prefix))
  if (other.length > 0) groups.push({ prefix: OTHER_GROUP, rows: other, vendors: otherVendors })

  return { picked, groups, grouped: true, truncated }
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
