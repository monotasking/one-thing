/**
 * 插件搜索供给方注册表 + 聚合器(M2,装配层)。
 *
 * core 立了契约(`search-provider.ts`:受控结果形状、超时/上限常量、形状校验),
 * 这里接三样只有装配层认识的东西:
 *   1. **并发聚合** —— 所有供给方并发调用,各自独立超时;超时/抛错的**本次直接弃**,
 *      不阻塞内置结果与其它供给方(搜索不等慢插件);
 *   2. **熔断** —— 超时/抛错记进 `search-provide` 家族(degrade-surface);连败到阈值后
 *      该供给方被降级,聚合器在调用它之前就跳过(半开靠时间);
 *   3. **点击派发** —— 一条插件结果的点击回到它自己的 `onAction`,宿主不解释 actionId。
 *
 * 结果并入结果集但按 provider label 分组可辨(`group` 字段);类别归属只在 'all'
 * (装配层的 executeSearch 决定),不抢占内置类别(chats / files 等)的语义。
 */
import type { SearchResult } from '@shared/ipc/search.js'
import {
  PLUGIN_SEARCH_PROVIDER_RESULT_CAP,
  PLUGIN_SEARCH_PROVIDER_TIMEOUT_MS,
  pluginScope,
  pluginSearchProviderSurface,
  sanitizePluginSearchResults,
  type CorePluginSearchActionContext,
  type CorePluginSearchProviderRegistration,
} from '@onething/core/plugins'
import {
  isPluginSurfaceDegraded,
  probePluginSurface,
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from '../../plugins/health.js'

/** 一次聚合里,全体插件结果的总预算 —— 再多也不让插件淹没内置结果。 */
export const PLUGIN_SEARCH_TOTAL_BUDGET = 12

/** 点击派发用的 actionId 前缀。搜索窗把它原样回传,宿主据此路由到 provider.onAction。 */
export const PLUGIN_SEARCH_ACTION_PREFIX = 'plugin-search:'

interface PluginSearchProviderEntry {
  pluginId: string
  providerId: string
  label: string
  registration: CorePluginSearchProviderRegistration
  /** onAction 的 ctx.notify 出口(装配层注入,走既有 plugin:notification 轨)。 */
  notify?: (message: string, level: 'info' | 'warn' | 'error') => void
}

/** key = `<pluginId>::<providerId>` —— 同一插件可注册多个供给方。 */
const providers = new Map<string, PluginSearchProviderEntry>()

function keyOf(pluginId: string, providerId: string): string {
  return `${pluginId}::${providerId}`
}

export interface RegisterPluginSearchProviderDeps {
  notify?: (message: string, level: 'info' | 'warn' | 'error') => void
}

/**
 * 装配层落点:core 的 `host.registerSearchProvider` 转发到这里。返回退订函数。
 * 同一 (pluginId, providerId) 重复注册 = 覆盖(core 侧一个 manifest 供给方绑一份
 * 实现;这里是最终登记表,以后到者为准足够)。
 */
export function registerPluginSearchProvider(
  pluginId: string,
  registration: CorePluginSearchProviderRegistration,
  deps?: RegisterPluginSearchProviderDeps,
): () => void {
  const providerId = String(registration?.id ?? '').trim()
  if (!providerId) return () => {}
  const key = keyOf(pluginId, providerId)
  providers.set(key, {
    pluginId,
    providerId,
    label: String(registration.label ?? '').trim() || providerId,
    registration,
    notify: deps?.notify,
  })
  let released = false
  return () => {
    if (released) return
    released = true
    // 只删自己那一份:竞态窗口里可能有新登记覆盖了它,别把别人的删了。
    if (providers.get(key)?.registration === registration) providers.delete(key)
  }
}

/** 测试/拆除快照:注册表当前有哪些供给方。 */
export function listPluginSearchProviders(): Array<{ pluginId: string; providerId: string; label: string }> {
  return [...providers.values()].map(({ pluginId, providerId, label }) => ({ pluginId, providerId, label }))
}

/** 测试专用:清空注册表。 */
export function resetPluginSearchProvidersForTests(): void {
  providers.clear()
}

function encodePluginSearchAction(pluginId: string, providerId: string, actionId: string): string {
  return PLUGIN_SEARCH_ACTION_PREFIX
    + `${encodeURIComponent(pluginId)}:${encodeURIComponent(providerId)}:${encodeURIComponent(actionId)}`
}

export function decodePluginSearchAction(
  raw: string,
): { pluginId: string; providerId: string; actionId: string } | null {
  if (typeof raw !== 'string' || !raw.startsWith(PLUGIN_SEARCH_ACTION_PREFIX)) return null
  const parts = raw.slice(PLUGIN_SEARCH_ACTION_PREFIX.length).split(':')
  if (parts.length !== 3) return null
  try {
    return {
      pluginId: decodeURIComponent(parts[0]),
      providerId: decodeURIComponent(parts[1]),
      actionId: decodeURIComponent(parts[2]),
    }
  } catch {
    return null
  }
}

function runWithTimeout<T>(
  run: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`search provider timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    Promise.resolve()
      .then(() => run(controller.signal))
      .then(
        value => { clearTimeout(timer); resolve(value) },
        error => { clearTimeout(timer); reject(error) },
      )
  })
}

export interface SearchPluginProvidersOptions {
  limit: number
  /** 每个供给方的超时(默认 PLUGIN_SEARCH_PROVIDER_TIMEOUT_MS;测试可调小)。 */
  timeoutMs?: number
  /** 单个供给方结果上限(默认 PLUGIN_SEARCH_PROVIDER_RESULT_CAP)。 */
  perProviderCap?: number
  /** 全体插件结果总预算(默认 PLUGIN_SEARCH_TOTAL_BUDGET)。 */
  totalBudget?: number
}

/**
 * 并发聚合所有供给方的结果,整形成 `type:'plugin'` 的 SearchResult。
 *
 * - 降级的供给方在**调用之前**就跳过(半开靠时间);
 * - 每个供给方独立超时,超时/抛错记熔断并**本次弃**(不影响其它供给方与内置结果);
 * - 单供给方结果过 cap 截断,全体过总预算截断;
 * - 结果带 `group`(provider label)分组可辨,`actionId` 路由回该供给方的 onAction。
 */
export async function searchPluginProviders(
  query: string,
  options: SearchPluginProvidersOptions,
): Promise<SearchResult[]> {
  const entries = [...providers.values()]
  if (entries.length === 0) return []
  const timeoutMs = options.timeoutMs ?? PLUGIN_SEARCH_PROVIDER_TIMEOUT_MS
  const perProviderCap = options.perProviderCap ?? PLUGIN_SEARCH_PROVIDER_RESULT_CAP
  const totalBudget = options.totalBudget ?? PLUGIN_SEARCH_TOTAL_BUDGET
  const limit = Math.max(1, options.limit || perProviderCap)

  const perProvider = await Promise.all(entries.map(async (entry): Promise<SearchResult[]> => {
    const surface = pluginSearchProviderSurface(entry.providerId)
    // 降级的供给方:半开满一个间隔才放行一次探测,否则跳过(不调用它)。
    if (isPluginSurfaceDegraded(entry.pluginId, surface) && !probePluginSurface(entry.pluginId, surface)) {
      return []
    }
    const scope = pluginScope.searchProvide(entry.providerId)
    try {
      const raw = await runWithTimeout(
        signal => entry.registration.search(query, { limit: Math.min(perProviderCap, limit), signal }),
        timeoutMs,
      )
      const sanitized = sanitizePluginSearchResults(raw, { cap: perProviderCap })
      reportPluginRuntimeSuccess(entry.pluginId, scope)
      return sanitized.map((result): SearchResult => ({
        id: `plugin:${entry.pluginId}:${entry.providerId}:${result.id}`,
        type: 'plugin',
        title: result.title,
        subtitle: result.subtitle,
        detail: result.detail,
        group: entry.label,
        icon: result.icon,
        // 点击**永远**路由回该供给方(即便插件没给 actionId,onAction 收到 '')。
        actionId: encodePluginSearchAction(entry.pluginId, entry.providerId, result.actionId ?? ''),
      }))
    } catch (error) {
      // 超时 / 抛错:本次弃,记熔断(连败到阈值该供给方被降级)。
      reportPluginRuntimeFailure(entry.pluginId, scope, error)
      return []
    }
  }))

  return perProvider.flat().slice(0, totalBudget)
}

/**
 * 把插件供给方的结果并到内置结果之后(装配层 executeSearch 的一行门面)。
 *
 * 门控在这里(而不是让门面自己判):插件结果**只在 'all' 且有查询串**时出现 ——
 * 不抢占内置类别(chats / files 等)的语义,也不在空查询下刷屏。内置在前、插件
 * 在后,分组可辨。这样搜索门面保持极薄(boundary 守卫:facade 必须 ≤50 行)。
 */
export async function appendPluginSearchResults(
  builtin: SearchResult[],
  query: string,
  category: string,
  limit: number,
): Promise<SearchResult[]> {
  if (category !== 'all' || !query.trim()) return builtin
  const pluginResults = await searchPluginProviders(query, { limit })
  return pluginResults.length === 0 ? builtin : [...builtin, ...pluginResults]
}

/**
 * 点击一条插件结果 —— 路由到该供给方的 onAction。
 *
 * 宿主不解释 actionId 的语义:原样交回。onAction 抛错/超时同样记熔断。
 * 返回 true 表示确实调到了某个 onAction。
 */
export async function invokePluginSearchAction(
  raw: string,
  context: { query?: string; sessionId?: string | null },
): Promise<boolean> {
  const decoded = decodePluginSearchAction(raw)
  if (!decoded) return false
  const entry = providers.get(keyOf(decoded.pluginId, decoded.providerId))
  if (!entry?.registration.onAction) return false
  const surface = pluginSearchProviderSurface(entry.providerId)
  if (isPluginSurfaceDegraded(entry.pluginId, surface) && !probePluginSurface(entry.pluginId, surface)) {
    return false
  }
  const scope = pluginScope.searchProvide(entry.providerId)
  const ctx: CorePluginSearchActionContext = {
    actionId: decoded.actionId,
    query: context.query ?? '',
    sessionId: context.sessionId ?? null,
    notify: (message, level = 'info') => entry.notify?.(message, level),
  }
  try {
    await runWithTimeout(() => entry.registration.onAction!(ctx), PLUGIN_SEARCH_PROVIDER_TIMEOUT_MS * 4)
    reportPluginRuntimeSuccess(entry.pluginId, scope)
    return true
  } catch (error) {
    reportPluginRuntimeFailure(entry.pluginId, scope, error)
    return false
  }
}
