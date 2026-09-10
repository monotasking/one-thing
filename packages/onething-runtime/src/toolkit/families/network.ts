/**
 * R3a 家族基类 —— `NetworkTool`(§4 的第五族)。
 *
 * 这一族每个成员都做的两件事:
 *
 *  1. **plan 报一条 `net_fetch`**,资源是这次调用要去够的东西(web_open 是那条
 *     URL,web_search 是要发出去的那几条 query)。`net_fetch` 在内核策略表里是
 *     `silent`,所以 web_search / web_open 不弹权限卡 —— 出网取的是一份**只读**的
 *     东西,不动这台机器上的任何一格,每查一次资料一张卡是把审批变成噪音。
 *     报效果是为了把"这次调用会出网"这个事实**写进审计**,而不是让它只存在于
 *     工具的实现里。
 *
 *     (这句话**从合表那天起才是真的**:2026-09-10 之前判定核那一侧另有一份静默
 *     名单、只认 `read` / `ui_change`,策略表这一行的 `silent` 不作数,web_search
 *     真会弹卡。合表把那份名单删了,判据从此只有策略表一处。)
 *  2. **超时归子作用域,取消归父作用域**。`ctx.abort.child({ timeoutMs })` 生出
 *     的信号交给 fetch;它到点抛的是 `ToolTimeoutError`,而结局判定看的是父作用域
 *     ——一页超时是工具的失败,不是用户按了停止(见 `core/toolkit/outcome.ts`)。
 *     旧 web_search / web_open 把 `ctx.abortSignal` 直接递给 fetch,超时全靠
 *     `page-fetch.ts` 内部自己那只表,取消与超时在结局上分不开。
 *
 * 网络实现本身**一行都不重写**:`tools/builtin/web-search/page-fetch.ts` 的
 * `fetchSearchPage(s)` 与 `providers/brave.ts` 是纯逻辑,这里 import 它们。
 */

import { Intent, makeEffect, Tool } from '@onething/core/toolkit'
import type { AbortView, Effect, PlanContext, Preview, Result, RunContext } from '@onething/core/toolkit'

export abstract class NetworkTool<In, Payload = In> extends Tool<In, Payload> {
  async plan(input: In, ctx: PlanContext): Promise<Intent<Payload>> {
    const effects = this.effectsFor(input)
    const preview = this.previewFor(input)
    return Intent.of({
      effects,
      ...(preview ? { preview } : {}),
      payload: this.payloadFor(input, ctx),
    })
  }

  async apply(intent: Intent<Payload>, ctx: RunContext): Promise<Result> {
    return await this.perform(intent.payload, ctx)
  }

  /** 这次调用要去够哪些东西。默认包成一条 `net_fetch`。 */
  protected effectsFor(input: In): Effect[] {
    return [makeEffect('net_fetch', this.resourcesFor(input))]
  }

  protected abstract resourcesFor(input: In): string[]

  /** 给人看的一句话。`net_fetch` 是静默的,所以它今天只进审计,不进权限卡。 */
  protected previewFor(_input: In): Preview | undefined {
    return undefined
  }

  protected payloadFor(input: In, _ctx: PlanContext): Payload {
    return input as unknown as Payload
  }

  /**
   * 一次带超时的网络子作用域。**不给 timeoutMs 就直接用本次调用的作用域** ——
   * 编一个默认超时会让"这个工具多久算超时"变成家族基类的意见,而它不知道。
   */
  protected networkScope(ctx: RunContext, timeoutMs?: number): AbortView {
    return timeoutMs === undefined ? ctx.abort : ctx.abort.child({ timeoutMs })
  }

  protected abstract perform(payload: Payload, ctx: RunContext): Promise<Result>
}
