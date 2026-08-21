/**
 * 插件运行期健康 —— 失败计数熔断的装配层落点。
 *
 * core 只提供机制(CorePluginHealthTracker),这里把它接到三样宿主设施上:
 * 自动禁用(走完整 disablePlugin/dispose)、ui.notify、以及插件信息里的
 * 健康字段(设置页据此亮红)。
 *
 * 为什么要熔断:加载期错误会写进 CorePluginInfo.error,**运行期**错误在此之前
 * 不进任何用户可见状态 —— 一个每回合都抛错的插件会一直显示 Active。
 */
import type { PluginFailureScope } from '@onething/core/plugins'
import { PLUGIN_SURFACE_PROBE_INTERVAL_MS } from '@onething/core/plugins'
import {
  CorePluginHealthTracker,
  type CorePluginRuntimeHealth,
  type PersistedPluginHealth,
} from '@onething/core/plugins'
import { getLogger } from '../logging/index.js'

const log = getLogger('plugins.health')


export interface PluginHealthHost {
  /** 熔断时禁用插件(走完整 dispose)。 */
  disablePlugin(pluginId: string): void | Promise<void>
  /** 熔断时通知用户。 */
  notify(pluginId: string, message: string): void
  /**
   * 落盘"为什么被禁"。传 null 表示清账。
   * 存储细节归 manager(它才认识 plugin-settings),这里只声明需求。
   */
  persistHealth?(pluginId: string, health: PersistedPluginHealth | null): void
  /** 启动时回灌:上次跑的时候被熔断禁用的插件,重启后仍要能说明原因。 */
  loadPersistedHealth?(): Array<{ pluginId: string; health: PersistedPluginHealth }>
}

let host: PluginHealthHost | null = null

function toPersisted(health: CorePluginRuntimeHealth): PersistedPluginHealth | null {
  if (health.status !== 'disabled' && health.status !== 'degraded') return null
  return {
    status: health.status,
    lastError: health.lastError,
    lastErrorScope: health.lastErrorScope,
    lastErrorAt: health.lastErrorAt,
    disabledReason: health.disabledReason,
  }
}

const tracker = new CorePluginHealthTracker({
  /**
   * 界面降级(R7):**不禁用插件**,只把那一个界面标红。
   *
   * 熔断存在的理由是"运行期失败不可见";而面板动作是用户刚点下、当场看到错误态
   * 与重试按钮的 —— 前提不成立。面板只在打开时跑,失败自限于一个界面,不该连坐
   * 掉插件的工具/命令/提示词/定时任务。罚则由 core 的策略表决定,不在这里判。
   */
  onDegradeSurface(pluginId, surface, health) {
    const reason = health.degradedSurfaces?.find(entry => entry.surface === surface)?.reason ?? 'repeated failures'
    log.warn('degrading plugin surface', { pluginId, surface, reason })
    try {
      host?.notify(pluginId, `"${pluginId}" — ${surface} is temporarily unavailable: ${reason}`)
    } catch (error) {
      log.error('plugin health notify failed', { pluginId, surface }, error)
    }
  },
  onTrip(pluginId, health) {
    const reason = health.disabledReason ?? health.lastError ?? 'repeated runtime failures'
    log.error('auto-disabling plugin', { pluginId, reason })
    try {
      host?.notify(pluginId, `Plugin "${pluginId}" was disabled automatically: ${reason}`)
    } catch (error) {
      log.error('plugin health notify failed', { pluginId }, error)
    }
    // 原因必须落盘:enabled:false 本来就持久化,原因不落盘的话重启后就成了
    // 一个用户没关过、又没有任何解释的关闭开关。
    try {
      host?.persistHealth?.(pluginId, toPersisted(health))
    } catch (error) {
      log.error('persist plugin health failed', { pluginId }, error)
    }
    // 熔断禁用必须走完整的 disablePlugin —— 半禁用等于把注册表足迹留在原地。
    Promise.resolve(host?.disablePlugin(pluginId)).catch(error => {
      log.error('auto-disable plugin failed', { pluginId }, error)
    })
  },
})

/** 启动时回灌上次的禁用原因。幂等。 */
export function restorePluginRuntimeHealth(): void {
  const persisted = host?.loadPersistedHealth?.() ?? []
  for (const { pluginId, health } of persisted) {
    tracker.restore(pluginId, {
      status: health.status,
      consecutiveFailures: 0,
      lastError: health.lastError,
      lastErrorScope: health.lastErrorScope,
      lastErrorAt: health.lastErrorAt,
      disabledReason: health.disabledReason,
    })
  }
}

/** 由 plugin manager 在 bootstrap 时接线(late-bound:core 不认识宿主)。 */
export function configurePluginHealthHost(next: PluginHealthHost | null): void {
  host = next
}

/**
 * 运行期失败上报。
 *
 * scope 是**品牌类型**:只能由 `pluginScope.*` 工厂产出,裸字符串在 typecheck
 * 就红。这是"新增 scope 必须在严重度表里有条目"的执行点 —— R7 第一版靠正则反查
 * 源码,而正则只认两种写法 × 五个文件,`npm-install` 就那样漏了过去。
 */
export function reportPluginRuntimeFailure(pluginId: string, scope: PluginFailureScope, error: unknown): void {
  tracker.recordFailure(pluginId, scope, error)
}

export function reportPluginRuntimeSuccess(pluginId: string, scope: PluginFailureScope): void {
  tracker.recordSuccess(pluginId, scope)
}

/**
 * 加载期错误 —— **不受严重度表管辖**(不计连败、不触发罚则),只写进健康态
 * 供设置页显示"为什么没起来"。scope 仍是品牌类型,免得这里成为裸字符串的后门。
 */
export function markPluginLoadError(pluginId: string, scope: PluginFailureScope, error: unknown): void {
  tracker.markLoadError(pluginId, scope, error)
}

export function getPluginRuntimeHealth(pluginId: string): CorePluginRuntimeHealth | undefined {
  return tracker.get(pluginId)
}

export function listPluginRuntimeHealth(): Array<CorePluginRuntimeHealth & { pluginId: string }> {
  return tracker.list()
}

/** 某个界面是否被降级(R7)—— 请求通道的短路判据。 */
export function isPluginSurfaceDegraded(pluginId: string, surface: string): boolean {
  return tracker.isSurfaceDegraded(pluginId, surface)
}

/**
 * 半开:降级满一个间隔之后放行一次探测(R7 收官)。
 *
 * 渠道投递没有"用户点重试"这种逃生口,只能靠时间 —— 否则降级是单向死门。
 */
export function probePluginSurface(pluginId: string, surface: string): boolean {
  return tracker.probeDegradedSurface(pluginId, surface, PLUGIN_SURFACE_PROBE_INTERVAL_MS)
}

/** 降级原因,给用户看的一句话。 */
export function describePluginSurfaceDegradation(pluginId: string, surface: string): string | undefined {
  return tracker.get(pluginId)?.degradedSurfaces?.find(entry => entry.surface === surface)?.reason
}

/** 显式启用(或手动停用)是一次清账:熔断状态与失败计数都不跨越它,盘上也清掉。 */
export function clearPluginRuntimeHealth(pluginId: string): void {
  tracker.clear(pluginId)
  try {
    host?.persistHealth?.(pluginId, null)
  } catch (error) {
    log.error('clear persisted plugin health failed', { pluginId }, error)
  }
}

export function resetPluginRuntimeHealthForTests(): void {
  tracker.clearAll()
}

export type { CorePluginRuntimeHealth, PersistedPluginHealth }
