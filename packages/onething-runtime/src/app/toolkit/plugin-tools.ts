/**
 * R3b —— 插件工具进目录(设计文档 §14.5 第 1 条,R3b 的第一件事)。
 *
 * R2b 之后目录里有内置 17 只 + `feature_*` + 同步进来的 MCP,唯独**插件工具仍走
 * 旧路**(§14.4-4)—— 于是 R4 删不掉旧 registry。这个文件把那个口子收上:开关开
 * 时,`api.registerTool` 在注册进旧 registry 的**同时**把同一个定义包成
 * `PluginTool` 注册进 `Catalog`,插件从此也吃两阶段 + 统一取消 + 统一截断 +
 * 统一审计。
 *
 * **插件的对外契约一个字不改**(§9):def 的形状、`permissionGuard` 一律
 * permission-gated 的那句话(新树里由 `plugin_exec` 这条效果说出来)、
 * `executionMode` 的单读者、`prompt` 的随工具面进出 —— 全部照旧。
 *
 * ## 失败的处置:与旧路逐字相同,不进断路器
 *
 * 一次插件工具执行抛异常,只毁掉**这一次调用**:错误文本回给模型,模型换参数或
 * 换工具接着干。这是旧路的行为,R3b 原样保留。
 *
 * R3b 第一版给它接了一条插件健康断路器(连败三次把这只工具从模型的工具面上摘掉),
 * **已回滚**:重试的主体是模型而不是人,而模型面对的失败里有一大类是它自己能纠的
 * (参数语义不对、路径写错),摘掉工具恰好剥夺了它自纠的那条路。真要做,应当是
 * 用户在设置页显式开启的一个开关,而且门槛只计"插件代码异常"这一类,不能把模型
 * 可纠的失败也算进去。理由与设计文档 §13.7 裁定 4 的改口同一条。
 *
 * `ExternalTool` 的 `reporter` / `timeoutMs` 两个端口留在原地(没人注入 = 没有行为),
 * 阈值永远来自真表,不在这里发明。
 *
 * ## 拆除是两侧的
 *
 * 插件停用 / 卸载 / 刷新走 `disposePlugin` → core 的 `disposeCorePluginState`,它
 * 按注册过的工具 id 逐个调宿主给的 `unregisterTool`。装配层把那一个口包成"两边
 * 都摘"(旧 registry + 目录),所以 `builtin-teardown.test.ts` 钉的那条语义
 * ("停用之后注册表里一个字都不剩")在新树上同样成立。
 */

import { getToolkitCatalog, PluginTool } from '@onething/runtime/toolkit'
import type { PluginToolDefinitionLike, PluginToolHostContext, PluginToolHostResult } from '@onething/runtime/toolkit'
import type { JsonObject } from '@shared/json.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('toolkit')


export interface RegisterPluginToolInput {
  toolId: string
  definition: PluginToolDefinitionLike
  execute(args: JsonObject, ctx: PluginToolHostContext): Promise<PluginToolHostResult>
  /** 工具级超时。**不给就不设** —— 见文件头。 */
  timeoutMs?: number
}

/**
 * 把一只插件工具装进目录。
 *
 * 返回 `false` = 目录还没装上(宿主没走 backend,或开关关着时调用方压根不该来)
 * 或者同名工具已经在目录里 —— 两种情况都不抛:一个插件注册失败不该把整个插件的
 * 加载炸掉,而旧 registry 那一侧照旧注册成功,行为与今天一致。
 */
export function registerPluginToolInCatalog(input: RegisterPluginToolInput): boolean {
  const catalog = getToolkitCatalog()
  if (!catalog) return false
  if (catalog.has(input.toolId)) {
    log.warn('plugin tool already in the catalog, skipping', { toolId: input.toolId })
    return false
  }

  catalog.register(new PluginTool({
    toolId: input.toolId,
    definition: input.definition,
    execute: input.execute,
    ...(input.timeoutMs === undefined ? {} : { isolation: { timeoutMs: input.timeoutMs } }),
  }))
  return true
}

/** 从目录里摘掉一只插件工具。目录没装上 = 本来就没装进去,返回 false。 */
export function unregisterPluginToolFromCatalog(toolId: string): boolean {
  const catalog = getToolkitCatalog()
  return catalog ? catalog.unregister(toolId) : false
}
