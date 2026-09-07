/**
 * 凭证轮换策略(批 E)—— 宿主动词面的第四间屋,也是**第一间不给插件看数据的屋子**。
 *
 * 一个插件用 `api.registerCredentialStrategy({ name, title, select })` 决定
 * 「这个空间的这个 provider,下一次请求该用池里的哪一条凭证」。批 D 已经把三种
 * 内置策略(single / priority-failover / round-robin)落在
 * `spaces/credentials.ts` 的**唯一分叉点**上;本屋只是让那个分叉点多认一种取值:
 * `plugin:<pluginId>:<name>`。
 *
 * 三条红线,全落在这一个文件里:
 *
 *  1. **插件不见钥匙**。递给策略的每一条 entry 都是
 *     `PLUGIN_CREDENTIAL_ENTRY_FIELDS` 的**白名单投影** —— id / label / authType /
 *     source / cooldownUntil / usage / lastErrorKind,句号。`apiKey`、`oauthToken`、
 *     `baseUrl`(它也能泄露账号归属)一个字节都不出现。投影是**正向构造**而不是
 *     "删掉几个字段":删字段的写法每加一个 schema 字段就漏一次,而白名单加字段
 *     要有人动手。策略交回来的是一个 **entry id**,宿主拿 id 去取真钥匙。
 *  2. **失效绝不阻塞起流**。超时 / 抛错 / 返回非法 id / 返回冷却中的 id,统统
 *     回落内置 `priority-failover`,并按 `credential-strategy` 家族记熔断
 *     (degrade-one-surface —— 停这一个策略,不连坐插件其余能力)。
 *     "换钥匙"这件事从来就有一个可用的默认答案,没有任何理由让它变成起不了流。
 *  3. **只在请求/重试边界问,流中绝不问**。与批 D 的轮换边界逐字同一句话
 *     (`credential-rotation.ts` 顶注):流已经失败之后才换,不存在"换到一半"的流。
 *
 * 与 registerIMConnector / registerSearchProvider / registerDeepLinkAction 同构:
 * core 立契约,装配层接线(注册表 + 超时 + 熔断 + 用量聚合),桌面宿主执行
 * (§6 方案 A)。
 */

/** `api.registerCredentialStrategy` 的声明门。装前确认页把这条念给用户听。 */
export const PLUGIN_PERMISSION_CREDENTIAL_STRATEGY = 'credentials:strategy'

/**
 * 披露文案。**两个半句都不能省**:前半句说它能做什么(决定用哪把钥匙 ——
 * 这直接影响账单落在谁头上),后半句说它做不到什么(碰不到钥匙内容)。
 * 只说前半句,用户会以为自己在把 API key 交出去;只说后半句,等于把一条真实
 * 的影响力说成没有。
 */
export const PLUGIN_CREDENTIAL_STRATEGY_PERMISSION_NOTE =
  'can choose which of your credentials a workspace uses (it never sees the key or token itself)'

/**
 * 策略名的形状。刻意窄:小写字母、数字、连字符 —— 它要进
 * `credentials.json` 的 `policy` 字段并被人眼读,松一点就得在解析侧补转义。
 */
export const PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN = /^[a-z0-9-]+$/

/** 插件 id 的形状。与深链那条逐字相同(npm 包名的可用子集,不含冒号)。 */
export const PLUGIN_CREDENTIAL_STRATEGY_PLUGIN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * `select` 的超时预算(毫秒)。
 *
 * 比搜索供给方(300ms,键入延迟敏感)宽、比深链 handler(15s,用户刚按过确认)
 * 窄得多。它坐在**起流的关键路径**上:超过这个数,用户看到的是"点了发送之后
 * 卡了一下"。2 秒足够一个策略读自己的 KV 并算一次,又短到卡顿不至于被察觉;
 * 超时即回落 —— 回落的代价只是"这次没按你的策略挑",而不是任何失败。
 */
export const PLUGIN_CREDENTIAL_STRATEGY_TIMEOUT_MS = 2_000

/**
 * 脱敏 entry 视图的**字段白名单**。
 *
 * 这个数组是红线 1 的执行点:投影函数按它构造,测试按它正向断言
 * (「视图的键集合 ⊆ 白名单」而不是「视图里没有 apiKey」—— 后者每加一个新的
 * 秘密字段就漏一次)。
 */
export const PLUGIN_CREDENTIAL_ENTRY_FIELDS = [
  'id',
  'label',
  'authType',
  'source',
  'cooldownUntil',
  'usage',
  'lastErrorKind',
] as const

export type PluginCredentialEntryField = (typeof PLUGIN_CREDENTIAL_ENTRY_FIELDS)[number]

/**
 * 一条凭证的近期用量摘要。
 *
 * 窗口由宿主定(`ctx.usageWindowMs`),口径是账本 `credentialId` 归因的聚合
 * (批 B3 打通的那条)。**没有成本以外的任何标识** —— 用量能回答"哪把 key
 * 用得多",回答不了"这把 key 是谁的"。
 */
export interface PluginCredentialUsage {
  /** 窗口内该 entry 出现在账本里的记录条数(≈ 请求轮数)。 */
  requests: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 能定价的那部分的美元合计;定不出价的记 0(不编)。 */
  costUSD: number
}

/** 上一条 entry 的失败分类(批 D 的统一分类器口径)。 */
export type PluginCredentialFailureKind =
  | 'quota-exhausted'
  | 'rate-limited'
  | 'auth-invalid'
  | 'transient'
  | 'unknown'

export const PLUGIN_CREDENTIAL_FAILURE_KINDS: readonly PluginCredentialFailureKind[] = [
  'quota-exhausted',
  'rate-limited',
  'auth-invalid',
  'transient',
  'unknown',
]

/**
 * 策略看得见的一条凭证。**这就是全部** —— 见 `PLUGIN_CREDENTIAL_ENTRY_FIELDS`。
 *
 * 刻意不含:`apiKey` / `oauthToken`(钥匙原文)、`baseUrl` / `apiMode`
 * (端点能泄露账号归属与套餐档位)、任何 OAuth 账号名/邮箱。
 */
export interface PluginCredentialEntryView {
  /** 稳定 id —— 策略要交回来的就是它。 */
  id: string
  /** 用户给这条凭证起的名字。策略可以拿它做人话决策("先用带 '主力' 的")。 */
  label: string
  authType: 'apiKey' | 'oauth'
  /** `user` 或 `plugin:<id>` —— 谁带来的这条凭证。 */
  source: string
  /** 冷却到期时间戳(ms)。**候选集里不会有还在冷却的条目**,这一格是历史信息。 */
  cooldownUntil?: number
  /** 近期用量(窗口见 `ctx.usageWindowMs`)。账本里没有它的记录时全是 0。 */
  usage: PluginCredentialUsage
  /** 这条 entry 最近一次被判定的失败类型(宿主记得住时才有)。 */
  lastErrorKind?: PluginCredentialFailureKind
}

/**
 * 递给策略的上下文。
 *
 * `entries` 已经是**可用候选集**:剔掉了没有凭证材料的、正在冷却的、以及鉴权
 * 形态对不上的(OAuth 型 provider 只给 oauth entry)。策略只需回答"这几条里挑
 * 哪一条",不必重新实现宿主的过滤规则 —— 让它重实现一遍,就等于开了一个绕过
 * 冷却的口子。
 */
export interface CorePluginCredentialStrategyContext {
  /** Aborted when the owning plugin or Backend closes; raw select work is still drained. */
  signal?: AbortSignal
  providerId: string
  /** 空间 id。默认空间不参与轮换(它的凭证源是 settings.ai,无池)。 */
  spaceId: string
  /** 可用候选集,顺序 = 用户在面板里排的优先级。**至少一条**。 */
  entries: readonly PluginCredentialEntryView[]
  /**
   * 第几次为这一轮挑凭证。首次解析 = 1;轮换重试时递增。
   * 策略可以据此实现"第一次用主力、失败后按用量挑最闲的"这类分档逻辑。
   */
  attempt: number
  /** 上一条 entry 为什么失败(只有轮换路径才有)。 */
  lastFailure?: {
    entryId: string
    kind: PluginCredentialFailureKind
    /** HTTP 状态码(解析得出才有)。 */
    status?: number
  }
  /** `entries[].usage` 的统计窗口长度(毫秒)。 */
  usageWindowMs: number
  /** 宿主的"现在"。测试与策略里的时间比较都用它,别自己 Date.now()。 */
  now: number
}

export interface CorePluginCredentialStrategyRegistration {
  /** 策略名(插件内唯一)。`[a-z0-9-]+`;宿主再加 `plugin:<id>:` 前缀做全局地址。 */
  name: string
  /** 面板策略选择器上显示的**人话**。不是 id —— 用户读的是这一句。 */
  title: string
  /** 一句话说清它按什么挑。面板把它显示在选择器下方(与三种内置策略同位)。 */
  description?: string
  /**
   * 挑一条。返回 `entries` 里某条的 `id`。
   *
   * 返回不认识的 id / 空串 / 抛错 / 超时 —— 一律回落内置 `priority-failover`,
   * 并记一次熔断。**永远不要在这里做副作用**:它可能因为超时被丢弃结果。
   */
  select(
    ctx: CorePluginCredentialStrategyContext,
  ): string | undefined | Promise<string | undefined>
}

/**
 * 全局地址,也就是落进 `credentials.json` 的 `policy` 取值:
 * `plugin:<pluginId>:<name>`。
 *
 * 与 registerIMConnector / registerDeepLinkAction / registerTool 同构 ——
 * 命名空间不由插件自己保证。熔断车道与降级 surface 都用它,一把尺量到底。
 */
export function pluginCredentialStrategyPolicy(pluginId: string, name: string): string {
  return `plugin:${pluginId}:${name}`
}

/** `plugin:<id>:<name>` 的形状判定。**不判断它是否真的注册过** —— 那是宿主的事。 */
export function isPluginCredentialStrategyPolicy(policy: unknown): policy is string {
  if (typeof policy !== 'string') return false
  const parts = policy.split(':')
  if (parts.length !== 3) return false
  const [prefix, pluginId, name] = parts
  return prefix === 'plugin'
    && PLUGIN_CREDENTIAL_STRATEGY_PLUGIN_ID_PATTERN.test(pluginId)
    && PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN.test(name)
}

/** 拆出 `{pluginId, name}`;形状不对回 null。 */
export function parsePluginCredentialStrategyPolicy(
  policy: string,
): { pluginId: string; name: string } | null {
  if (!isPluginCredentialStrategyPolicy(policy)) return null
  const [, pluginId, name] = policy.split(':')
  return { pluginId, name }
}

/**
 * 降级时停掉的界面名。与 `pluginScope.credentialStrategy` 折出来的 surface
 * (policy.ts 的 `describePluginSurface`)是同一把尺 —— 一边报账、一边据它短路,
 * 不能各写各的。
 */
export function pluginCredentialStrategySurface(policy: string): string {
  return `credential-strategy:${policy}`
}

/** 空用量 —— 账本里查不到这条 entry 时的诚实答案(不是"未知",就是零)。 */
export function emptyPluginCredentialUsage(): PluginCredentialUsage {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 }
}

/**
 * 宿主投影时喂进来的一条 entry。
 *
 * **刻意不写索引签名**:写了它,产品层那个没有索引签名的 `SpaceCredentialEntry`
 * 反而传不进来(TS2345)。这里只声明投影要读的那几格 —— 多出来的字段
 * (apiKey / oauthToken / baseUrl / …)在类型上看不见、在实现里也读不到,
 * 正是白名单投影想要的效果。
 */
export interface PluginCredentialEntrySource {
  id: string
  label?: string
  authType: 'apiKey' | 'oauth'
  source?: string
  cooldownUntil?: number
}

/**
 * **白名单投影** —— 红线 1 的执行点。
 *
 * 正向构造:只把 `PLUGIN_CREDENTIAL_ENTRY_FIELDS` 里的键装进新对象,原对象上
 * 别的东西(apiKey / oauthToken / baseUrl / apiMode / 未来任何新字段)一律进不来。
 * 反过来写("`delete next.apiKey`")每加一个 schema 字段就漏一次 —— B3 的 schema
 * 已经从 §3 表里那几格长到今天这样,那条路早晚会漏。
 */
export function toPluginCredentialEntryView(
  entry: PluginCredentialEntrySource,
  extras: { usage?: PluginCredentialUsage; lastErrorKind?: PluginCredentialFailureKind } = {},
): PluginCredentialEntryView {
  const view: PluginCredentialEntryView = {
    id: String(entry.id),
    label: String(entry.label ?? entry.id),
    authType: entry.authType === 'oauth' ? 'oauth' : 'apiKey',
    source: String(entry.source ?? 'user'),
    usage: extras.usage ?? emptyPluginCredentialUsage(),
  }
  if (typeof entry.cooldownUntil === 'number' && Number.isFinite(entry.cooldownUntil)) {
    view.cooldownUntil = entry.cooldownUntil
  }
  if (extras.lastErrorKind) view.lastErrorKind = extras.lastErrorKind
  return view
}

/**
 * 策略交回来的东西是否是一条**合法的**选择。
 *
 * 三种不合法压成同一个答案(回落 + 记熔断),因为它们对用户是同一件事
 * ——「这个策略今天没给出可用的答案」:
 *  - 不是字符串 / 空串;
 *  - 不在候选集里(包括:一条正在冷却的 entry —— 候选集里本来就没有它);
 *  - 候选集为空(压根轮不到策略)。
 */
export function isPluginCredentialChoiceValid(
  choice: unknown,
  entries: readonly { id: string }[],
): choice is string {
  if (typeof choice !== 'string') return false
  const trimmed = choice.trim()
  if (!trimmed) return false
  return entries.some(entry => entry.id === trimmed)
}
