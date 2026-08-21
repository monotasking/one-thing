/**
 * N2 的**装配层实现**:发送前拦截链的进程内注册表 + 健康态接线。
 *
 * 协议在 core(`@onething/core/plugins` 的 input-intercept.ts):三态、归一化、
 * 链的次序与 fail-open 语义。这里只做两件产品层的事:
 *
 *  1. **一个进程一本注册表**(与 lifecycle 钩子同构),生命周期跟着插件的
 *     `lifecycleUnsubs` 走 —— 拆除时自动退订,不需要第二条清扫路径;
 *  2. **熔断接线**:失败进 `inputIntercept:<hookId>` 车道(policy 表判为
 *     degrade-surface,surface 折成 `input-intercept`),降级后靠时间半开。
 *
 * ## 闸为什么在这里而不在请求通道上
 *
 * 拦截根本不走 `manager.handleRequest` —— 它挂在引擎的发送路径上。所以短路闸
 * 只能在链的入口自己判(与 IM 渠道同一个先例:闸在投递口)。半开探测同理:
 * 被跳过的插件永远不会成功,没有"用户点重试"这种逃生口,不靠时间就是一扇
 * 单向的死门。
 */
import {
  CorePluginInputInterceptRegistry,
  PLUGIN_INPUT_INTERCEPT_SURFACE,
  emptyPluginInputInterceptOutcome,
  pluginScope,
  type PluginInputInterceptContext,
  type PluginInputInterceptHandler,
  type PluginInputInterceptOutcome,
} from '@onething/core/plugins'
import {
  probePluginSurface,
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from './health.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('plugins')


const registry = new CorePluginInputInterceptRegistry({
  // 超时预算走 core 默认(1.5s,刻意短于生命周期钩子的 5s):这条链挂在用户
  // 按下回车与消息出现之间,五秒的空白就已经是"应用卡了"。
  onHandlerFailure({ pluginId, hookId, error }) {
    reportPluginRuntimeFailure(pluginId, pluginScope.inputIntercept(hookId), error)
  },
  onHandlerSuccess({ pluginId, hookId }) {
    reportPluginRuntimeSuccess(pluginId, pluginScope.inputIntercept(hookId))
  },
  /**
   * 降级闸 + 半开探测。`probePluginSurface` 在未降级时恒真,降级后每隔
   * `PLUGIN_SURFACE_PROBE_INTERVAL_MS` 放行一次 —— 放行的那一次若成功,
   * `recordSuccess` 会按 surface 解除降级。
   */
  isDegraded: pluginId => !probePluginSurface(pluginId, PLUGIN_INPUT_INTERCEPT_SURFACE),
  /**
   * 注册期违规(空 id / 重复 id)。与"未声明的面板 id"同性质:**代码错误**,
   * 不是运行期抖动 —— registration 族阈值 1,第一次就算数。
   *
   * 注意它与"未声明 `input:intercept` 权限"不同:那一条是 manifest 笔误,
   * 在 api-builder 里报错即止、不计熔断(与 N1 的 sendMessage 同规)。
   */
  onRegistrationViolation({ pluginId, reason }) {
    reportPluginRuntimeFailure(
      pluginId,
      pluginScope.registration('InputIntercept'),
      new Error(reason),
    )
  },
})

export function registerPluginInputInterceptHook(
  pluginId: string,
  hookId: string,
  handler: PluginInputInterceptHandler,
): () => void {
  return registry.register(pluginId, hookId, handler)
}

/**
 * 跑一遍拦截链。**从不抛错**;没有任何插件注册时是一次零分配的早退
 * (它挂在每一次发送上)。
 */
export async function runPluginInputIntercept(
  context: PluginInputInterceptContext,
): Promise<PluginInputInterceptOutcome> {
  if (registry.getHookCount() === 0) return emptyPluginInputInterceptOutcome(context.text)
  try {
    return await registry.run(context)
  } catch (error) {
    // 兜底的兜底:registry.run 自己已经逐 handler catch 了,这里只防注册表本身
    // 出意外。fail-open 的最后一格 —— 原样放行。
    log.error('input intercept chain failed, input passed through untouched', {}, error)
    return emptyPluginInputInterceptOutcome(context.text)
  }
}

export function clearPluginInputInterceptForPlugin(pluginId: string): void {
  registry.clearForPlugin(pluginId)
}

/** Registry footprint accessor — the teardown guard compares it across enable/disable. */
export function getInputInterceptHookCount(): number {
  return registry.getHookCount()
}

/** 诊断 / 测试:当前链的顺序(与真正执行的顺序逐字一致)。 */
export function listInputInterceptHooks(): Array<{ pluginId: string; hookId: string }> {
  return registry.listOrdered()
}

/** 测试与进程收摊用。 */
export function resetPluginInputIntercept(): void {
  registry.clear()
}
