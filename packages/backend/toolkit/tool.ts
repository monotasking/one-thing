/**
 * §3 内核 —— `Tool`:注册表里**唯一**的工具类型(尺子⑥)。
 *
 * 内置、插件、MCP、`feature_*`、将来的远程工具,对 Catalog / Surface / Runner /
 * Authorizer / 各个投影器都是这一个类;没有 `if (isAsync)`,没有
 * `if (category === 'mcp')`。异步初始化不是另一种工具,而是 `prepare()` 这个
 * 生命周期方法,由 Catalog 统一管(只跑一次、并发安全)。
 *
 * 一个工具要写的东西只有四样:spec、plan、apply,外加可选的 visibleIn/prepare。
 * abort / 校验 / 权限 / 截断 / 沙箱 / 进度上报一个字都不出现 —— 那些是系统的事。
 */

import type { Intent } from './intent.js'
import type { Result } from './result.js'
import type { PlanContext, RunContext } from './run-context.js'
import type { PrepareEnv, Scene, ToolSpec } from './spec.js'

export abstract class Tool<In = unknown, Payload = unknown> {
  abstract readonly spec: ToolSpec

  get id(): string {
    return this.spec.id
  }

  /** 懒初始化(MCP 连接、异步 schema)。默认 noop。 */
  async prepare(_env: PrepareEnv): Promise<void> {}

  /** 场景面。默认到处成立 —— 不成立才需要写这个方法。 */
  visibleIn(_scene: Scene): boolean {
    return true
  }

  /** 计划:说清楚将要做什么,还没动手。无副作用工具返回 `Intent.none(payload)`。 */
  abstract plan(input: In, ctx: PlanContext): Promise<Intent<Payload>>

  /** 施行:按已经被授权的计划动手。 */
  abstract apply(intent: Intent<Payload>, ctx: RunContext): Promise<Result>
}
