/**
 * 工具级并发声明(N3)—— 插件工具的 `executionMode`。
 *
 * **这里只有声明与校验,没有调度。** 调度早就存在,而且只有一处:
 * `packages/backend/agent-loop/runner.ts` 里 `tool-call-done` 的分支按
 * `toolsByName.get(name)?.executionMode !== 'parallel'` 决定这次执行是不是
 * 屏障,交给 `ToolExecutionScheduler`。本文件做的事只是让**插件**也能把这个
 * 判据填进去 —— 内置工具从 `Tool.define` 起就一路带着它,插件工具此前在
 * 协议里根本没有这个字段,于是永远落在缺省(屏障)那一侧。
 *
 * 语义(与 `AgentTool.executionMode` 同一份口径):
 *  - `'parallel'`:声明本工具与同一条 assistant 消息里的兄弟调用重叠是安全的
 *    (只读、或对排序无副作用)。它会进真实存在的并行通道。
 *  - `'sequential'`:本工具是执行屏障 —— 等前面所有调用落定、并挡住后面的。
 *    等价于不声明,但**写出来**表示这是作者的判断而不是遗漏。
 *  - 不声明:缺省 = 屏障 = 今天的行为,一字不改。
 *
 * 为什么非法值要拒注册而不是静默降级:降级是安全的,但作者把 `'parallel'`
 * 拼成 `'paralell'` 之后永远不会知道 —— 他只会看到"我的工具比别人慢",
 * 而这条线索不在任何日志里。宿主自己解析模型定义时(`agent-loop/tools.ts`)
 * 仍然对未知值安全降级:那条路上的值来自我们自己的注册表,已经过了这道闸。
 */

export type CorePluginToolExecutionMode = 'sequential' | 'parallel'

export const CORE_PLUGIN_TOOL_EXECUTION_MODES: readonly CorePluginToolExecutionMode[] = [
  'sequential',
  'parallel',
]

export function isCorePluginToolExecutionMode(
  value: unknown,
): value is CorePluginToolExecutionMode {
  return value === 'sequential' || value === 'parallel'
}

/**
 * 注册面的守卫:未声明放行(缺省 = 现状),声明了就必须是两个字面量之一。
 * 抛出的错误由 `api.registerTool` 既有的 try/catch 接住 —— 结果是**这一个
 * 工具没注册 + 一条点名的错误日志**,插件本身照常存活,也不计熔断
 * (与"未声明权限"/"钩子返回值不合规"同规:那是作者写错了,不是运行时故障)。
 */
export function assertCorePluginToolExecutionMode(
  value: unknown,
  toolName: string,
): CorePluginToolExecutionMode | undefined {
  if (value === undefined) return undefined
  if (!isCorePluginToolExecutionMode(value)) {
    throw new Error(
      `Tool "${toolName}" declared executionMode ${JSON.stringify(value)}; `
      + `expected ${CORE_PLUGIN_TOOL_EXECUTION_MODES.map(mode => `"${mode}"`).join(' or ')}. `
      + 'Omit the field to keep the default (barrier) scheduling.',
    )
  }
  return value
}
