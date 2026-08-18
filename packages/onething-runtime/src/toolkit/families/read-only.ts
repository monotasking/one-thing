/**
 * R1 家族基类 —— `ReadOnlyTool`(§4 的第一族)。
 *
 * 没有副作用的工具:`plan` 恒为 `Intent.none(payload)`,子类只写 `perform`。
 * 它仍然要走完 authorize —— `Intent.none` 不等于"跳过授权",用户在设置页把这个
 * 工具设成 `autoExecute:false` 时,`withUserToolSettings` 装饰器照样把它打成
 * `alwaysAsk`(见 `core/toolkit/ports.ts`)。家族基类不该替系统提前下这个结论。
 */

import { Intent, Tool } from '@onething/core/toolkit'
import type { PlanContext, Result, RunContext } from '@onething/core/toolkit'

export abstract class ReadOnlyTool<In, Payload = In> extends Tool<In, Payload> {
  async plan(input: In, ctx: PlanContext): Promise<Intent<Payload>> {
    return Intent.none(this.payloadFor(input, ctx))
  }

  async apply(intent: Intent<Payload>, ctx: RunContext): Promise<Result> {
    return await this.perform(intent.payload, ctx)
  }

  /** 计划阶段要不要预处理输入。默认原样带走。 */
  protected payloadFor(input: In, _ctx: PlanContext): Payload {
    return input as unknown as Payload
  }

  /** 这一族唯一要写的方法。 */
  protected abstract perform(payload: Payload, ctx: RunContext): Promise<Result>
}
