/**
 * Search Everywhere 供给方(M2)—— 宿主动词面的第二间屋。
 *
 * 一个插件用 `api.registerSearchProvider({ id, label, search })` 往「搜索一切」
 * 里投结果。核心纪律有三条,全落在这一个文件里:
 *
 *  1. **结果形状 = 宿主枚举的受控子集**。插件只能给 `id/title/subtitle/detail/
 *     actionId/icon`,**给不了** `sessionId` / `messageId` / `filePath` / `type` ——
 *     那些字段能让一条插件结果伪装成内置结果、诱导宿主跳任意会话或打开任意文件。
 *     带了越界字段的结果**整条丢弃**(见 `sanitizePluginSearchResults`)。
 *  2. **点击只回到插件自己的 action**。宿主不替插件解释 actionId 的语义:它把
 *     actionId 原样交回 provider 的 `onAction`,插件在自己进程里响应。
 *  3. **搜索不等慢插件**。超时 / 抛错的供给方本次直接弃,不阻塞其它供给方与内置
 *     结果 —— 这里只立超时/上限常量与形状校验,并发与熔断在装配层(它才认识
 *     健康账本)。
 *
 * 与 IM 连接器同构:core 立契约,装配层接线,桌面宿主执行(§6 方案 A)。
 */

/** `api.registerSearchProvider` 的声明门。装前确认页把这条念给用户听。 */
export const PLUGIN_PERMISSION_SEARCH_PROVIDE = 'search:provide'

/**
 * 单个供给方的超时预算(毫秒)。
 *
 * 这是**键入延迟敏感路径**:每敲一个字都会重跑一次聚合。300ms 之外的结果对
 * 「边打边看」已经没有意义,晚到只会让整条搜索卡顿 —— 超时即弃是这条屋子的
 * 立身之本。
 */
export const PLUGIN_SEARCH_PROVIDER_TIMEOUT_MS = 300

/** 单个供给方一次最多贡献多少条 —— 防一个插件刷屏挤掉内置结果。 */
export const PLUGIN_SEARCH_PROVIDER_RESULT_CAP = 10

/**
 * 图标名是**宿主枚举**,不是 URL / SVG。插件点名其中一个,宿主决定画什么 ——
 * 不给插件在搜索结果里塞任意图片的口子(那是钓鱼面）。未知名一律忽略。
 */
export const PLUGIN_SEARCH_ICONS = [
  'search',
  'sparkle',
  'tag',
  'emoji',
  'file',
  'chat',
  'command',
  'clock',
  'star',
  'hash',
] as const

export type PluginSearchIcon = (typeof PLUGIN_SEARCH_ICONS)[number]

export function isPluginSearchIcon(value: unknown): value is PluginSearchIcon {
  return typeof value === 'string' && (PLUGIN_SEARCH_ICONS as readonly string[]).includes(value)
}

/**
 * 插件交出来的一条结果(受控子集)。
 *
 * 刻意**不含** sessionId / messageId / filePath / type / shortcut / matchRanges /
 * timestamp —— 见文件头第 1 条。带了这些键的对象会被 `sanitizePluginSearchResults`
 * 整条丢弃(不是"悄悄剥掉字段":悄悄剥掉会让作者以为自己在跳会话,而实际没有)。
 */
export interface PluginSearchResult {
  /** 插件内唯一即可;宿主再加 `plugin:<pluginId>:<providerId>:` 前缀做全局去重。 */
  id: string
  title: string
  subtitle?: string
  detail?: string
  /** 点击回调标识;宿主原样交回 `onAction`。缺省 = 点击只关窗,不回插件。 */
  actionId?: string
  /** 宿主枚举图标名(见 PLUGIN_SEARCH_ICONS)。非枚举值忽略。 */
  icon?: PluginSearchIcon
}

/** `search(query, opts)` 的第二参 —— limit 与可取消信号(超时即 abort）。 */
export interface CorePluginSearchContext {
  limit: number
  signal: AbortSignal
}

/** 点击一条插件结果时交给 `onAction` 的上下文。 */
export interface CorePluginSearchActionContext {
  /** 插件当初放进结果里的 actionId(宿主不解释它的语义）。 */
  actionId: string
  /** 触发这条结果的查询串,给插件做上下文。 */
  query: string
  /** 触发时的当前会话(可能没有)。 */
  sessionId?: string | null
  /** 静默横幅 —— 插件在自己进程里响应点击的最轻量出口。 */
  notify(message: string, level?: 'info' | 'warn' | 'error'): void
}

export interface CorePluginSearchProviderRegistration {
  /** 供给方 id(插件内唯一)。宿主用它做熔断车道与结果去重。 */
  id: string
  /** 分组标签 —— 结果并入结果集但按 label 分组可辨,不与内置结果混淆来源。 */
  label: string
  search(
    query: string,
    opts: CorePluginSearchContext,
  ): PluginSearchResult[] | Promise<PluginSearchResult[]>
  /** 点击一条本供给方结果时调用。缺省 = 点击只关窗。 */
  onAction?(ctx: CorePluginSearchActionContext): void | Promise<void>
}

/**
 * 越界字段名单 —— 出现任何一个,该结果整条丢弃。
 *
 * 这些是「能让插件伪装成内置结果」的字段:type 决定渲染与点击语义,
 * sessionId/messageId/filePath 会让宿主跳任意会话或打开任意文件。
 */
export const PLUGIN_SEARCH_FORBIDDEN_RESULT_KEYS = [
  'type',
  'sessionId',
  'messageId',
  'filePath',
  'shortcut',
  'matchRanges',
  'timestamp',
] as const

export interface SanitizedPluginSearchResult {
  id: string
  title: string
  subtitle?: string
  detail?: string
  actionId?: string
  icon?: PluginSearchIcon
}

/** 某条结果里带了越界字段吗。 */
export function pluginSearchResultHasForbiddenKey(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  return PLUGIN_SEARCH_FORBIDDEN_RESULT_KEYS.some(key =>
    Object.prototype.hasOwnProperty.call(raw, key))
}

/**
 * 把插件交出来的原始结果整形成受控子集。
 *
 * 规则:
 *  - 非对象 / 缺 id / 缺 title → 丢弃;
 *  - **带任一越界字段 → 整条丢弃**(拒绝,不是剥字段);
 *  - subtitle/detail/actionId 只取字符串,icon 只取宿主枚举;
 *  - 超过 cap 的多余结果截断。
 *
 * 纯函数、零副作用 —— 熔断与超时是装配层的事。
 */
export function sanitizePluginSearchResults(
  raw: unknown,
  options?: { cap?: number },
): SanitizedPluginSearchResult[] {
  if (!Array.isArray(raw)) return []
  const cap = Math.max(0, options?.cap ?? PLUGIN_SEARCH_PROVIDER_RESULT_CAP)
  const out: SanitizedPluginSearchResult[] = []
  for (const entry of raw) {
    if (out.length >= cap) break
    if (!entry || typeof entry !== 'object') continue
    if (pluginSearchResultHasForbiddenKey(entry)) continue
    const record = entry as Record<string, unknown>
    const id = String(record.id ?? '').trim()
    const title = String(record.title ?? '').trim()
    if (!id || !title) continue
    const result: SanitizedPluginSearchResult = { id, title }
    if (typeof record.subtitle === 'string' && record.subtitle) result.subtitle = record.subtitle
    if (typeof record.detail === 'string' && record.detail) result.detail = record.detail
    if (typeof record.actionId === 'string' && record.actionId) result.actionId = record.actionId
    if (isPluginSearchIcon(record.icon)) result.icon = record.icon
    out.push(result)
  }
  return out
}

/**
 * 供给方降级时停掉的界面名 —— 装配层熔断账与聚合器**共用同一把尺**,
 * 一边报 `searchProvide:<id>` 折成的 surface,一边据它短路,不能各写各的。
 */
export function pluginSearchProviderSurface(providerId: string): string {
  return `search:${providerId}`
}
