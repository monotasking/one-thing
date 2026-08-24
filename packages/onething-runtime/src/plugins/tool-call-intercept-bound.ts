/**
 * N4 的**装配层实现**:工具调用拦截链的进程内注册表 + 健康态接线 + 校验口。
 *
 * 协议在 core(`@onething/core/plugins` 的 tool-call-intercept.ts):三态、
 * 归一化、链的次序与 fail-closed 语义。这里做三件产品层的事:
 *
 *  1. **一个进程一本注册表**(与 N2 同构),生命周期跟着插件的 `lifecycleUnsubs`
 *     走 —— 拆除时自动退订,不需要第二条清扫路径;
 *  2. **熔断接线**:失败进 `toolCallIntercept:<hookId>` 车道(policy 表判为
 *     degrade-surface,surface 折成 `toolcall-intercept`),降级后靠时间半开;
 *  3. **改写后的参数校验**:把工具自己那份 zod 接到链上 —— 这是与 pi 的关键
 *     差异,它跳校验,我们不跳。
 *
 * ## 熔断在这里承担的职责与 N2 不同
 *
 * N2 的降级是"别再浪费 1.5s 了"。这里的降级是**这条链唯一的逃生口**:
 * 单次故障阻断一次工具调用,但一个持续坏掉的插件不能持续挡工具,所以连败到
 * 阈值后它的拦截面被停掉,之后一律放行。**单次 fail-closed、熔断后 fail-open。**
 *
 * 这也是为什么 `runPluginToolCallIntercept` 的最外层兜底是 **allow**
 * 而不是 block:那一层兜的是"注册表本身出了意外"(不是任何一个插件的错),
 * 归责不到任何插件,也就不能拿任何插件的连败账去开逃生口 —— 一个谁也不为它
 * 负责的故障如果判阻断,就没有任何机制能让它恢复,应用会永久失去所有工具。
 * 逐 handler 的 fail-closed 在 `registry.run` 里已经完整生效;这一层之外的
 * 意外只能是宿主自己的 bug,而宿主的 bug 不该表现为"你的工具全废了"。
 */
import {
  CorePluginToolCallInterceptRegistry,
  PLUGIN_TOOL_CALL_INTERCEPT_SURFACE,
  emptyPluginToolCallInterceptOutcome,
  pluginScope,
  type PluginToolCallInterceptContext,
  type PluginToolCallInterceptHandler,
  type PluginToolCallInterceptOutcome, type CorePluginToolCallInterceptRegistryOptions,
} from '@onething/core/plugins'
import type { JsonObject } from '@shared/json.js'
import {
  probePluginSurface,
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from './health.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('plugins')


const pluginToolCallInterceptRegistryOptions: CorePluginToolCallInterceptRegistryOptions = {
  // 超时预算走 core 默认(2s):高于 N2 的 1.5s(用户此刻在看"正在执行"的转圈,
  // 比空白输入框耐受度高),远低于生命周期钩子的 5s(它同步阻塞在每一次工具
  // 执行之前)。
  onHandlerFailure({ pluginId, hookId, error }) {
    reportPluginRuntimeFailure(pluginId, pluginScope.toolCallIntercept(hookId), error)
  },
  onHandlerSuccess({ pluginId, hookId }) {
    reportPluginRuntimeSuccess(pluginId, pluginScope.toolCallIntercept(hookId))
  },
  /**
   * 降级闸 + 半开探测。`probePluginSurface` 在未降级时恒真,降级后每隔
   * `PLUGIN_SURFACE_PROBE_INTERVAL_MS` 放行一次 —— 放行的那一次若成功,
   * `recordSuccess` 会按 surface 解除降级。
   */
  isDegraded: pluginId => !probePluginSurface(pluginId, PLUGIN_TOOL_CALL_INTERCEPT_SURFACE),
  /**
   * 改写后的参数校验。**动态 import**:这个模块被插件 API 在启动早期引用,
   * 而工具目录要等 backend 装完;顶层静态引它会把两者的初始化顺序绑死。校验口
   * 每次调用现取,与 configure*Host 端口的晚绑定同一个姿势。
   *
   * 认不出的工具名(MCP 工具、外部 agent 工具)在这里判 `ok:true` ——
   * 它们的校验在别人家(MCP 服务器按自己的 inputSchema 拒绝并回 isError)。
   * 这一格是与"绝不把非法参数喂给工具"之间**唯一**的缝:我们保证的是
   * "过得了本地这份 zod 的才进本地工具",而不是"替远端服务器把关"。
   *
   * R4b:读源从旧注册表的 `validateToolArgs` 换成目录 + `ZodValidator`(它就是
   * runner 每次调用走的那一个,连"认不出的 schema 放行"这条默认都是同一份)。
   */
  async validateInput(toolName, input) {
    const { getToolkitCatalog, ZodValidator } = await import('../toolkit/index.js')
    const tool = getToolkitCatalog()?.get(toolName)
    if (!tool) return { ok: true as const }
    const parsed = new ZodValidator().parse(tool.spec.input, input as JsonObject)
    return parsed.ok ? { ok: true as const } : { ok: false as const, message: parsed.message }
  },
  /**
   * 注册期违规(空 id / 重复 id)。与 N2 同规:**代码错误**,registration 族
   * 阈值 1,第一次就算数。在一条安全链上"第二条守卫悄悄顶掉第一条"比没有守卫
   * 更糟 —— 作者以为自己装了两道闸。
   */
  onRegistrationViolation({ pluginId, reason }) {
    reportPluginRuntimeFailure(
      pluginId,
      pluginScope.registration('ToolCallIntercept'),
      new Error(reason),
    )
  },
};
const registry = new CorePluginToolCallInterceptRegistry(pluginToolCallInterceptRegistryOptions)

export function registerPluginToolCallInterceptHook(
  pluginId: string,
  hookId: string,
  handler: PluginToolCallInterceptHandler,
): () => void {
  return registry.register(pluginId, hookId, handler)
}

/**
 * 跑一遍拦截链。**从不抛错**;没有任何插件注册时是一次零分配的早退
 * (它挂在每一次工具执行上,包括 headless / server —— 那两个宿主永远是这条早退)。
 */
export async function runPluginToolCallIntercept(
  context: PluginToolCallInterceptContext,
): Promise<PluginToolCallInterceptOutcome> {
  if (registry.getHookCount() === 0) return emptyPluginToolCallInterceptOutcome(context.input)
  try {
    return await registry.run(context)
  } catch (error) {
    // 兜底的兜底,判 allow 而不是 block —— 理由见文件头:这一层的故障不归任何
    // 插件,没有连败账可开逃生口,判阻断就是永久失去所有工具。
    log.error('tool call intercept chain failed, tool call allowed through', {}, error)
    return emptyPluginToolCallInterceptOutcome(context.input)
  }
}

export function clearPluginToolCallInterceptForPlugin(pluginId: string): void {
  registry.clearForPlugin(pluginId)
}

/** Registry footprint accessor — the teardown guard compares it across enable/disable. */
export function getToolCallInterceptHookCount(): number {
  return registry.getHookCount()
}

/** 诊断 / 测试:当前链的顺序(与真正执行的顺序逐字一致)。 */
export function listToolCallInterceptHooks(): Array<{ pluginId: string; hookId: string }> {
  return registry.listOrdered()
}

/** 测试与进程收摊用。 */
export function resetPluginToolCallIntercept(): void {
  registry.clear()
}
