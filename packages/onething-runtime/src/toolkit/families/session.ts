/**
 * R3a 家族基类 —— `SessionTool`(§4 的第八族)。
 *
 * 成员是那些**动会话本身**的工具:派工(开一条新会话)、目标(读写这条会话的
 * 目标状态)。家族只放两样东西:
 *
 *  1. **plan 的形状**:效果由子类给,给空就是 `Intent.none`(goal 就是这一格 ——
 *     它读写的是这条会话自己的目标记录,旧实现没有 `analyze`,权限层看到的是空的)。
 *  2. **场景面的接口**:`visibleIn` 默认到处成立,由子类按 `Scene` 的
 *     `goalActive` / `taskSession` 两位收紧(判据在产品层的 `resolveScene` 一处
 *     算好,工具只读结论)。
 *
 * 刻意**不**在这里塞"开会话"的实现:派工那台机器(建会话、驱动引擎、等终端事件、
 * 回投唤醒)在装配层,产品层只有工具壳。
 */

import { Intent, Tool } from '@onething/core/toolkit'
import type { Effect, PlanContext, Preview, Result, RunContext } from '@onething/core/toolkit'

export abstract class SessionTool<In, Payload = In> extends Tool<In, Payload> {
  async plan(input: In, ctx: PlanContext): Promise<Intent<Payload>> {
    const payload = this.payloadFor(input, ctx)
    const effects = this.effectsFor(input, ctx)
    if (effects.length === 0) return Intent.none(payload)
    const preview = this.previewFor(input)
    return Intent.of({ effects, ...(preview ? { preview } : {}), payload })
  }

  async apply(intent: Intent<Payload>, ctx: RunContext): Promise<Result> {
    return await this.perform(intent.payload, ctx)
  }

  /** 默认无效果(goal)。派工覆盖成一条 `session_spawn`。 */
  protected effectsFor(_input: In, _ctx: PlanContext): Effect[] {
    return []
  }

  protected previewFor(_input: In): Preview | undefined {
    return undefined
  }

  protected payloadFor(input: In, _ctx: PlanContext): Payload {
    return input as unknown as Payload
  }

  protected abstract perform(payload: Payload, ctx: RunContext): Promise<Result>
}
