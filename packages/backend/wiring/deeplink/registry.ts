/**
 * 插件深链动作注册表 + 派发口(H4,装配层)。
 *
 * core 立了协议(`deep-link.ts`:URL 语法、声明门、动作名形状、超时预算、
 * 返回值整形),这里接三样只有装配层认识的东西:
 *
 *   1. **归属** —— 注册表按 `plugin:<id>:<name>` 全局寻址,一个插件可以注册多个
 *      动作,退订只删自己那一份;
 *   2. **熔断** —— handler 抛错 / 超时记进 `deep-link` 家族(degrade-surface),
 *      连败到阈值后**这一个动作**被降级,派发口在调用它之前就短路;
 *   3. **确认门之后** —— 这个模块只在用户已经确认之后被调用。它不认识窗口、
 *      不画卡片(那是 Electron 宿主的事),但它是"这个动作还在不在、还灰不灰"
 *      的唯一事实源,确认卡问的也是它。
 *
 * 拆的是**入口**不是在飞的调用:退订之后 `describePluginDeepLinkAction` 立刻查
 * 不到,但一次已经开始跑的 handler 不被打断 —— 它已经是插件自己进程里的调用。
 */
import {
  PLUGIN_DEEPLINK_HANDLER_TIMEOUT_MS,
  normalizePluginDeepLinkResult,
  pluginDeepLinkAddress,
  pluginDeepLinkSurface,
  pluginScope,
  type CorePluginDeepLinkActionRegistration,
  type CorePluginDeepLinkResult,
} from '@onething/core/plugins'
import {
  isPluginSurfaceDegraded,
  probePluginSurface,
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from '../../plugins/health.js'

interface PluginDeepLinkEntry {
  pluginId: string
  name: string
  title: string
  registration: CorePluginDeepLinkActionRegistration
}

/** key = 全局地址 `plugin:<pluginId>:<name>`。 */
const actions = new Map<string, PluginDeepLinkEntry>()

/**
 * 装配层落点:core 的 `host.registerDeepLinkAction` 转发到这里。返回退订函数。
 *
 * 同一 (pluginId, name) 重复注册 = 覆盖(与搜索供给方同规:一个 manifest 动作
 * 绑一份实现,最终登记表以后到者为准)。
 */
export function registerPluginDeepLinkAction(
  pluginId: string,
  registration: CorePluginDeepLinkActionRegistration,
): () => void {
  const name = String(registration?.name ?? '').trim()
  if (!name || typeof registration?.handler !== 'function') return () => {}
  const address = pluginDeepLinkAddress(pluginId, name)
  actions.set(address, {
    pluginId,
    name,
    title: String(registration.title ?? '').trim() || name,
    registration,
  })
  let released = false
  return () => {
    if (released) return
    released = true
    // 只删自己那一份:竞态窗口里可能有新登记覆盖了它,别把别人的删了。
    if (actions.get(address)?.registration === registration) actions.delete(address)
  }
}

export interface PluginDeepLinkActionInfo {
  pluginId: string
  name: string
  address: string
  /** 确认卡上显示的人话。 */
  title: string
  /** 熔断降级中 —— 确认卡上**变灰而不是消失**(说得清"它暂时不在")。 */
  degraded: boolean
}

/**
 * 确认卡问的就是这一个函数:这个动作在不在、还灰不灰、人话怎么念。
 *
 * 查不到回 null —— 宿主据此给出一条**看得见的**拒绝("这个动作不在了"),
 * 而不是让用户确认一个不会发生的动作。
 */
export function describePluginDeepLinkAction(
  pluginId: string,
  name: string,
): PluginDeepLinkActionInfo | null {
  const address = pluginDeepLinkAddress(pluginId, name)
  const entry = actions.get(address)
  if (!entry) return null
  return {
    pluginId: entry.pluginId,
    name: entry.name,
    address,
    title: entry.title,
    degraded: isPluginSurfaceDegraded(entry.pluginId, pluginDeepLinkSurface(address)),
  }
}

/** 测试 / 拆除快照:注册表当前有哪些动作。 */
export function listPluginDeepLinkActions(): PluginDeepLinkActionInfo[] {
  return [...actions.keys()]
    .map(address => {
      const entry = actions.get(address)!
      return describePluginDeepLinkAction(entry.pluginId, entry.name)
    })
    .filter((info): info is PluginDeepLinkActionInfo => info !== null)
}

/** 测试专用:清空注册表。 */
export function resetPluginDeepLinkActionsForTests(): void {
  actions.clear()
}

export type InvokePluginDeepLinkOutcome =
  | { ok: true, notice?: string }
  | { ok: false, reason: 'not-registered' | 'degraded' | 'failed', detail: string }

function runWithTimeout<T>(run: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`deep link handler timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    Promise.resolve()
      .then(run)
      .then(
        value => { clearTimeout(timer); resolve(value) },
        error => { clearTimeout(timer); reject(error) },
      )
  })
}

export interface InvokePluginDeepLinkOptions {
  text: string
  params: Record<string, string>
  /** 超时(默认 PLUGIN_DEEPLINK_HANDLER_TIMEOUT_MS;测试可调小)。 */
  timeoutMs?: number
}

/**
 * 派发一次**已确认**的深链动作。
 *
 * 三件事按顺序:查得到吗 → 灰着吗(半开满一个间隔才放行一次探测)→ 跑,
 * 超时/抛错记熔断。返回结构化结果 —— 从不抛错:调用点是一次用户可见的动作,
 * 它要的是一句能显示给用户的话,不是一个异常。
 */
export async function invokePluginDeepLinkAction(
  pluginId: string,
  name: string,
  options: InvokePluginDeepLinkOptions,
): Promise<InvokePluginDeepLinkOutcome> {
  const address = pluginDeepLinkAddress(pluginId, name)
  const entry = actions.get(address)
  if (!entry) {
    return { ok: false, reason: 'not-registered', detail: `no deep link action "${address}"` }
  }
  const surface = pluginDeepLinkSurface(address)
  if (isPluginSurfaceDegraded(pluginId, surface) && !probePluginSurface(pluginId, surface)) {
    return { ok: false, reason: 'degraded', detail: `"${address}" is temporarily disabled after repeated failures` }
  }
  const scope = pluginScope.deepLinkAction(address)
  try {
    const raw = await runWithTimeout(
      () => entry.registration.handler({ text: options.text, params: { ...options.params } }),
      options.timeoutMs ?? PLUGIN_DEEPLINK_HANDLER_TIMEOUT_MS,
    )
    reportPluginRuntimeSuccess(pluginId, scope)
    const result: CorePluginDeepLinkResult = normalizePluginDeepLinkResult(raw)
    return result.notice ? { ok: true, notice: result.notice } : { ok: true }
  } catch (error) {
    reportPluginRuntimeFailure(pluginId, scope, error)
    return {
      ok: false,
      reason: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
