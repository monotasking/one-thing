/**
 * N5 的**装配层实现**:工具结果改写链的进程内注册表 + 健康态接线。
 *
 * 协议在 core(`@onething/core/plugins` 的 tool-result-intercept.ts):两态、
 * 归一化、链的次序、长度上限与 fail-open 语义。这里做两件产品层的事(比 N4 少
 * 一件 —— N5 改的是自由文本,没有 schema 校验口要接):
 *
 *  1. **一个进程一本注册表**(与 N2 / N4 同构),生命周期跟着插件的
 *     `lifecycleUnsubs` 走 —— 拆除时自动退订,不需要第二条清扫路径;
 *  2. **熔断接线**:失败进 `toolResultIntercept:<hookId>` 车道(policy 表判为
 *     degrade-surface,surface 折成 `toolresult-intercept`),降级后靠时间半开。
 *
 * ## 熔断在这里承担的职责与 N4 相反、与 N2 相同
 *
 * N4 的降级是**这条链唯一的逃生口**(它 fail-closed,单次故障会挡工具)。这里
 * 的降级只是"别再浪费 2s 了" —— 这条链本来就是 fail-open,单次故障只让模型看到
 * 未改写的原结果,工作流一步不断。连败到阈值后停掉这个插件的改写面,之后它的
 * 改写被跳过(= 原结果)。**单次 fail-open、熔断后仍 fail-open**,只是省了预算。
 *
 * `runPluginToolResultIntercept` 的最外层兜底判 keep(原结果),与 N2 同 ——
 * 注册表本身出意外时,原始结果原样交给模型是唯一无害的默认。
 */
import {
  CorePluginToolResultInterceptRegistry,
  PLUGIN_TOOL_RESULT_INTERCEPT_SURFACE,
  emptyPluginToolResultInterceptOutcome,
  pluginScope,
  type PluginToolResultInterceptContext,
  type PluginToolResultInterceptHandler,
  type PluginToolResultInterceptOutcome, type CorePluginToolResultInterceptRegistryOptions,
} from '@onething/core/plugins'
import {
  probePluginSurface,
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from './health.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('plugins')


const pluginToolResultInterceptRegistryOptions: CorePluginToolResultInterceptRegistryOptions = {
  // 超时预算走 core 默认(2s):与 N4 同 —— 它同样同步阻塞在一次工具结果回模型
  // 之前,用户此刻在看"正在执行"的转圈。
  onHandlerFailure({ pluginId, hookId, error }) {
    reportPluginRuntimeFailure(pluginId, pluginScope.toolResultIntercept(hookId), error)
  },
  onHandlerSuccess({ pluginId, hookId }) {
    reportPluginRuntimeSuccess(pluginId, pluginScope.toolResultIntercept(hookId))
  },
  /**
   * 降级闸 + 半开探测。`probePluginSurface` 在未降级时恒真,降级后每隔
   * `PLUGIN_SURFACE_PROBE_INTERVAL_MS` 放行一次 —— 放行的那一次若成功,
   * `recordSuccess` 会按 surface 解除降级。
   */
  isDegraded: pluginId => !probePluginSurface(pluginId, PLUGIN_TOOL_RESULT_INTERCEPT_SURFACE),
  /**
   * 注册期违规(空 id / 重复 id)。与 N2 / N4 同规:**代码错误**,registration 族
   * 阈值 1,第一次就算数。
   */
  onRegistrationViolation({ pluginId, reason }) {
    reportPluginRuntimeFailure(
      pluginId,
      pluginScope.registration('ToolResultIntercept'),
      new Error(reason),
    )
  },
};
const registry = new CorePluginToolResultInterceptRegistry(pluginToolResultInterceptRegistryOptions)

export function registerPluginToolResultInterceptHook(
  pluginId: string,
  hookId: string,
  handler: PluginToolResultInterceptHandler,
): () => void {
  return registry.register(pluginId, hookId, handler)
}

/**
 * 跑一遍改写链。**从不抛错**;没有任何插件注册时是一次零分配的早退
 * (它挂在每一次工具执行上,包括 headless / server —— 那两个宿主永远是这条早退)。
 */
export async function runPluginToolResultIntercept(
  context: PluginToolResultInterceptContext,
): Promise<PluginToolResultInterceptOutcome> {
  if (registry.getHookCount() === 0) return emptyPluginToolResultInterceptOutcome(context.result)
  try {
    return await registry.run(context)
  } catch (error) {
    // 兜底的兜底,判 keep(原结果):这一层的故障不归任何插件,而原始结果原样
    // 交给模型是唯一无害的默认(fail-open 的底色)。
    log.error('tool result intercept chain failed, result left unchanged', {}, error)
    return emptyPluginToolResultInterceptOutcome(context.result)
  }
}

export function clearPluginToolResultInterceptForPlugin(pluginId: string): void {
  registry.clearForPlugin(pluginId)
}

/** Registry footprint accessor — the teardown guard compares it across enable/disable. */
export function getToolResultInterceptHookCount(): number {
  return registry.getHookCount()
}

/** 诊断 / 测试:当前链的顺序(与真正执行的顺序逐字一致)。 */
export function listToolResultInterceptHooks(): Array<{ pluginId: string; hookId: string }> {
  return registry.listOrdered()
}

/** 测试与进程收摊用。 */
export function resetPluginToolResultIntercept(): void {
  registry.clear()
}
