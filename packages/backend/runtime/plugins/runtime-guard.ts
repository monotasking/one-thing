/**
 * 插件软隔离原语:超时预算 + 失败熔断 + 运行期健康状态。
 *
 * 设计文档 §3.1 的结论:异常层面的 catch 早就是齐的,真正的故障面是**挂起、慢
 * 与不可见**——一个不 resolve 的 promptContextProvider 会把所有会话的发消息热
 * 路径永久钉死,而插件卡片仍然显示 Active。
 *
 * 这里只放机制(零依赖纯 TS,四个宿主共享),接线在 app 层。
 */

import { describePluginSurface, resolvePluginScopeSeverity, type PluginFailureScope } from './policy.js'
import { CORE_PLUGIN_FAILURE_THRESHOLD } from './runtime-guard-constants.js'

/** 提示词装配是每次发消息的热路径,预算必须小。 */
export const CORE_PLUGIN_PROMPT_CONTEXT_TIMEOUT_MS = 5_000
/** 上下文压缩 / 回合结束钩子。 */
export const CORE_PLUGIN_LIFECYCLE_HOOK_TIMEOUT_MS = 5_000
/**
 * api.settings.onChange 回调(R3)。
 *
 * 它是插件代码,挂起不能影响配置保存本身 —— 保存在推送之前就完成了,
 * 这个预算只保证宿主不会为了等一个回调而卡住推送队列。
 */
export const CORE_PLUGIN_SETTINGS_HOOK_TIMEOUT_MS = 5_000
/** 插件 entry(api):注册期可以慢一点,但不能无限。 */
export const CORE_PLUGIN_ENTRY_TIMEOUT_MS = 10_000
/**
 * 一次插件请求(UI → 插件)的预算。
 *
 * 比钩子宽松得多:请求是用户主动发起的产品级操作(搜一次、跑一次导出),
 * 秒级是正常的;但不能没有上界 —— 一个不理 abortSignal 又永不 resolve 的
 * handler 会让 renderer 的 invoke 永远 pending,登记簿条目也永久滞留。
 */
export const CORE_PLUGIN_REQUEST_TIMEOUT_MS = 30_000
/** 连续失败到这个数就触发罚则(罚则由 policy.ts 的严重度表决定)。 */
export { CORE_PLUGIN_FAILURE_THRESHOLD } from './runtime-guard-constants.js'

export class CorePluginTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`Plugin call "${label}" exceeded ${timeoutMs}ms`)
    this.name = 'CorePluginTimeoutError'
  }
}

export function isCorePluginTimeoutError(error: unknown): error is CorePluginTimeoutError {
  return error instanceof CorePluginTimeoutError
}

/**
 * 给一次插件调用套超时预算。
 *
 * 超时**不取消**插件那一侧的工作(JS 里没法真正杀掉一个 promise),它保证的是
 * 宿主这一侧不再等下去——先例是权限 120s 降级。
 */
export async function runWithPluginTimeout<T>(
  label: string,
  timeoutMs: number,
  run: () => T | Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await run()
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => run())(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CorePluginTimeoutError(label, timeoutMs)), timeoutMs)
        // 别让守卫计时器把进程钉住(CLI daemon / server 退出时尤为要紧)。
        ;(timer as unknown as { unref?: () => void }).unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export type CorePluginHealthStatus = 'healthy' | 'degraded' | 'disabled'

export interface CorePluginRuntimeHealth {
  status: CorePluginHealthStatus
  consecutiveFailures: number
  lastError?: string
  lastErrorScope?: string
  lastErrorAt?: number
  disabledReason?: string
  /**
   * 被降级的界面(R7)。
   *
   * 用户主动触发的失败(面板动作、插件请求、IM 连接器)达阈时**只标记这一个
   * 界面不可用**,插件的工具/命令/提示词/定时任务照常 —— 罚则来自
   * `PLUGIN_SEVERITY_TABLE`,不在上报点上写条件。
   */
  degradedSurfaces?: Array<{ surface: string; reason: string; at: number }>
}

export interface CorePluginHealthTrackerOptions {
  threshold?: number
  now?: () => number
  /** 熔断时回调一次(只回调一次,直到该插件被重新启用)。 */
  onTrip?(pluginId: string, health: CorePluginRuntimeHealth): void
  /**
   * 界面降级时回调(R7)。**插件不被禁用** —— 只有那一个界面不可用。
   * 与 onTrip 一样只回调一次,直到该界面恢复。
   */
  onDegradeSurface?(pluginId: string, surface: string, health: CorePluginRuntimeHealth): void
}

function describePluginError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'Unknown error'
}

interface PluginHealthEntry {
  /** 每条车道各记各的连败数。 */
  scopes: Map<string, number>
  status: CorePluginHealthStatus
  lastError?: string
  lastErrorScope?: string
  lastErrorAt?: number
  disabledReason?: string
  /** 降级中的界面 → 原因(R7)。插件本身不受影响。 */
  degradedSurfaces?: Map<string, { reason: string; at: number }>
}

/**
 * 运行期失败计数与熔断。
 *
 * **计数键是 pluginId + scope,不是 pluginId。** 插件级混算有两个反向的坏处:
 *  - 一个每回合都成功的 afterAssistantResponse 钩子会不停清掉同一插件里那个
 *    挂死的 promptContextProvider 的失败计数 —— R1 的头号目标场景永不熔断;
 *  - 一个纯事件插件的偶发错误会跨天累加,最后被误禁。
 * 所以:**某一 scope 连败达阈**即触发**插件级**熔断(插件是启停的单位),
 * 而一次成功只清同 scope 的账。
 */
export class CorePluginHealthTracker {
  private readonly health = new Map<string, PluginHealthEntry>()
  private readonly threshold: number
  private readonly now: () => number

  constructor(private readonly options: CorePluginHealthTrackerOptions = {}) {
    // 显式传入的 threshold **压过表**(测试与将来的宿主调参需要它)。
    // 上一版写成 `severity.threshold ?? this.threshold`,而表里每一条都有
    // threshold —— 右侧永远取不到,这个构造参数成了死配置。
    this.threshold = options.threshold ?? 0
    this.now = options.now ?? (() => Date.now())
  }

  get(pluginId: string): CorePluginRuntimeHealth | undefined {
    const entry = this.health.get(pluginId)
    return entry ? this.project(entry) : undefined
  }

  list(): Array<CorePluginRuntimeHealth & { pluginId: string }> {
    return [...this.health.entries()].map(([pluginId, entry]) => ({ pluginId, ...this.project(entry) }))
  }

  recordFailure(pluginId: string, scope: PluginFailureScope, error: unknown): CorePluginRuntimeHealth {
    const entry = this.health.get(pluginId) ?? { scopes: new Map<string, number>(), status: 'healthy' as CorePluginHealthStatus }
    const scopeFailures = (entry.scopes.get(scope) ?? 0) + 1
    entry.scopes.set(scope, scopeFailures)

    // 罚则来自**一张表**,不在这里写条件。阈值也归表管:注册期违规是代码错误,
    // 重试没有意义,它的阈值是 1。
    const severity = resolvePluginScopeSeverity(scope)
    const threshold = this.threshold > 0 ? this.threshold : severity.threshold
    const alreadyDisabled = entry.status === 'disabled'
    const reached = !alreadyDisabled && scopeFailures >= threshold
    const degrading = severity.remedy === 'degrade-surface'
    const tripped = reached && !degrading

    entry.lastError = describePluginError(error)
    entry.lastErrorScope = scope
    entry.lastErrorAt = this.now()

    let newlyDegradedSurface: string | undefined
    if (reached && degrading && severity.surface) {
      entry.degradedSurfaces ??= new Map()
      if (!entry.degradedSurfaces.has(severity.surface)) {
        newlyDegradedSurface = severity.surface
      }
      entry.degradedSurfaces.set(severity.surface, {
        reason: `${scopeFailures} consecutive failures in ${scope} (last: ${describePluginError(error)})`,
        at: entry.lastErrorAt,
      })
    }

    // 降级**不改插件状态为 disabled** —— 那正是这一期要治的连坐。
    entry.status = alreadyDisabled || tripped ? 'disabled' : 'degraded'
    if (tripped) {
      entry.disabledReason = `${scopeFailures} consecutive failures in ${scope} (last: ${describePluginError(error)})`
    }
    this.health.set(pluginId, entry)

    const projected = this.project(entry)
    if (tripped) {
      this.options.onTrip?.(pluginId, projected)
    } else if (newlyDegradedSurface) {
      this.options.onDegradeSurface?.(pluginId, newlyDegradedSurface, projected)
    }
    return projected
  }

  /** 某个界面当前是否处于降级态。 */
  isSurfaceDegraded(pluginId: string, surface: string): boolean {
    return Boolean(this.health.get(pluginId)?.degradedSurfaces?.has(surface))
  }

  /**
   * 半开探测:降级满 `afterMs` 之后放行**一次**。
   *
   * 请求通道那侧的逃生口是用户点"Try once more"(bypassDegraded);而渠道投递
   * 没有人在旁边点按钮 —— 没有等价物的话,连败降级之后解除降级的唯一路径是
   * `onSendSuccess`,而它要求 sendReply 成功返回,而闸又在 sendReply 之前抛:
   * **一扇单向的死门**,接上 gateway 那天就是一条永久哑掉的渠道。
   *
   * 放行时把 `at` 推到现在,所以探测本身是有节流的。
   */
  probeDegradedSurface(pluginId: string, surface: string, afterMs: number): boolean {
    const info = this.health.get(pluginId)?.degradedSurfaces?.get(surface)
    if (!info) return true
    if (this.now() - info.at < afterMs) return false
    info.at = this.now()
    return true
  }

  /**
   * 只清 `scope` 这一条车道。
   *
   * 高频路径(每次发消息的 promptContext、每个事件 handler)都会调它,所以
   * 快路径必须零分配:从没失败过的插件在这里直接返回。
   */
  recordSuccess(pluginId: string, scope: PluginFailureScope): void {
    const entry = this.health.get(pluginId)
    if (!entry || entry.status === 'disabled') return

    /*
     * 界面恢复必须**先于**车道早退判断。
     *
     * surface 是聚合的(render 与 action 折成同一个 `panel:<id>`),而计数键是
     * 完整 scope。上一版把恢复写在 `if (!entry.scopes.get(scope)) return` 之后:
     * action 连败降级之后,render 成功那条车道计数是 undefined,直接 return ——
     * 降级永远解不开,而面板渲染完全正常。反向同理。
     *
     * 语义取"这块 UI 有一次成功就算恢复":用户点了重试并且成功了,面板必须回来。
     * 于是同 surface 的所有车道一起归零。
     */
    if (entry.degradedSurfaces?.size) {
      const surface = describePluginSurface(scope)
      if (entry.degradedSurfaces.delete(surface)) {
        for (const lane of [...entry.scopes.keys()]) {
          if (describePluginSurface(lane) === surface) entry.scopes.set(lane, 0)
        }
        if (entry.degradedSurfaces.size === 0) entry.degradedSurfaces = undefined
      }
    }

    if (!entry.scopes.get(scope)) {
      if ([...entry.scopes.values()].every(count => count === 0)) {
        entry.status = 'healthy'
        entry.disabledReason = undefined
      }
      return
    }

    entry.scopes.set(scope, 0)
    if ([...entry.scopes.values()].every(count => count === 0)) {
      entry.status = 'healthy'
      entry.disabledReason = undefined
    }
  }

  /**
   * 加载期错误。
   *
   * **不查严重度表,也不计连败** —— 它只把"为什么没加载起来"写进健康态供设置页
   * 显示。所以 policy.ts 里不该为它的 scope 停放家族规则(曾经有过一条 install,
   * 是纯死规则)。scope 仍收成品牌类型,免得这里成为裸字符串的后门。
   */
  markLoadError(pluginId: string, scope: PluginFailureScope, error: unknown): void {
    const entry = this.health.get(pluginId) ?? { scopes: new Map<string, number>(), status: 'healthy' as CorePluginHealthStatus }
    if (entry.status !== 'disabled') entry.status = 'degraded'
    entry.lastError = describePluginError(error)
    entry.lastErrorScope = scope
    entry.lastErrorAt = this.now()
    this.health.set(pluginId, entry)
  }

  /**
   * 回灌(重启后从盘上读回禁用原因)。
   *
   * 只恢复"说明为什么被禁"的那部分,不恢复计数 —— 计数是本次进程的连败观察,
   * 跨重启累加没有意义。
   */
  restore(pluginId: string, health: CorePluginRuntimeHealth): void {
    this.health.set(pluginId, {
      scopes: new Map<string, number>(),
      status: health.status,
      lastError: health.lastError,
      lastErrorScope: health.lastErrorScope,
      lastErrorAt: health.lastErrorAt,
      disabledReason: health.disabledReason,
    })
  }

  /** 重新启用时清账:熔断状态与失败计数都不该跨越一次显式启用。 */
  clear(pluginId: string): void {
    this.health.delete(pluginId)
  }

  clearAll(): void {
    this.health.clear()
  }

  private project(entry: PluginHealthEntry): CorePluginRuntimeHealth {
    let worst = 0
    for (const count of entry.scopes.values()) {
      if (count > worst) worst = count
    }
    return {
      status: entry.status,
      consecutiveFailures: worst,
      lastError: entry.lastError,
      lastErrorScope: entry.lastErrorScope,
      lastErrorAt: entry.lastErrorAt,
      disabledReason: entry.disabledReason,
      degradedSurfaces: entry.degradedSurfaces?.size
        ? [...entry.degradedSurfaces].map(([surface, info]) => ({ surface, ...info }))
        : undefined,
    }
  }
}
