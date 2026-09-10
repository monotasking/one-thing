/**
 * R3a 家族基类 —— `InteractiveTool`(§4 的第七族)。
 *
 * 这一族的成员向**人**要一个答案。三件事归家族:
 *
 *  1. **plan 报一条 `user_ask` + 一份预览**。`user_ask` 在策略表里是 `silent`
 *     —— ask_user 不弹权限卡:它**本身就是一次询问**,先弹一张「准不准我问你」
 *     的卡是同一件事问两遍,而且第二遍还挡在第一遍前面。(这句话从合表那天起
 *     才是真的 —— 2026-09-10 之前判定核另有一份只认 `read` / `ui_change` 的静默
 *     名单,策略表这一行不作数。)预览带上题面,于是
 *     "这次调用打算问什么"进了审计与 `lifecycle:planned`,而不是只存在于渲染层
 *     那张一次性的卡片里(提问栏位收场之后会话里不留痕)。
 *  2. **撤回登记**。`ctx.abort.onAbort(...)` 取代旧的
 *     `signal.addEventListener('abort', …, { once: true })` + `finally` 摘除:
 *     `onAbort` 返回摘除函数,而且**已经取消时立即回调** —— 旧写法里"注册得
 *     太晚"等于没注册。
 *  3. **四种收场都是正常返回**。answered / declined / timeout / aborted 一律翻成
 *     `Result`,没有一种走 throw。异常路径会诱使上层把它当红错冒泡,而那正是这套
 *     交互协议当初要修的病。
 *
 * 等待链本身一个字都不重写:真正挂起、广播、做通道亲和的那台机器在
 * `@onething/core/interaction`,这里只是一个工具壳。
 */

import { Intent, makeEffect, Tool } from '@onething/core/toolkit'
import type { Effect, PlanContext, Preview, Result, RunContext } from '@onething/core/toolkit'

/** plan 算出来的那份"要问什么",apply 直接用。 */
export interface InteractiveRequest<Questions> {
  /** 题 id 的锚(`toolCallId` 优先,回退 `messageId`)。 */
  readonly anchor: string
  readonly questions: Questions
}

export abstract class InteractiveTool<In, Questions> extends Tool<In, InteractiveRequest<Questions>> {
  async plan(input: In, ctx: PlanContext): Promise<Intent<InteractiveRequest<Questions>>> {
    const anchor = ctx.invocation.callId || ctx.invocation.messageId || ''
    const request: InteractiveRequest<Questions> = {
      anchor,
      questions: this.questionsFor(input, anchor),
    }
    return Intent.of({
      effects: this.effectsFor(request),
      preview: this.previewFor(request),
      payload: request,
    })
  }

  async apply(
    intent: Intent<InteractiveRequest<Questions>>,
    ctx: RunContext,
  ): Promise<Result> {
    // 已经停了就不要再挂一条没人会看的提问 —— `onAbort` 会立刻回调,
    // 但那之后再 `await` 一条永远不收场的 Promise 仍然是一次挂起。
    if (ctx.abort.aborted) return await this.cancelled(intent.payload, ctx)

    const release = ctx.abort.onAbort(() => this.withdraw(intent.payload, ctx))
    try {
      return await this.awaitAnswer(intent.payload, ctx)
    } finally {
      release()
    }
  }

  /** 模型给的入参 → 这一族的题面形状。 */
  protected abstract questionsFor(input: In, anchor: string): Questions

  /** 一条 `user_ask`,资源是这次调用自己(每次都不一样 —— 提问不该被记住)。 */
  protected effectsFor(request: InteractiveRequest<Questions>): Effect[] {
    return [makeEffect('user_ask', [request.anchor])]
  }

  protected abstract previewFor(request: InteractiveRequest<Questions>): Preview

  /** 登记 pending 并等收场。**只 resolve,永不 reject**。 */
  protected abstract awaitAnswer(
    request: InteractiveRequest<Questions>,
    ctx: RunContext,
  ): Promise<Result>

  /** 回合中止:撤回还没收场的那条提问。幂等。 */
  protected abstract withdraw(request: InteractiveRequest<Questions>, ctx: RunContext): void

  /** 进来时信号已经响了 —— 直接给一条取消收场,不挂任何东西。 */
  protected abstract cancelled(
    request: InteractiveRequest<Questions>,
    ctx: RunContext,
  ): Promise<Result>
}
