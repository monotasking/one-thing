/**
 * §3 内核 —— `ToolRunner`:生命周期的**唯一**实现。
 *
 *   beforePlan → validate → plan → 越权检查 → authorize → apply → budget → afterApply
 *
 * 全程由 Runner 自己发生命周期事件(可选的 intercepted,然后 planned / decided /
 * finished),审计因此拿得到"打算做什么 vs 实际做了什么",而且这份证词不是工具
 * 自己写的。
 *
 * 今天这条链散在 direct-tool-execution / tool-execution / tool-orchestrator 三处,
 * 每处少一两步(有的不过拦截,有的不过预算,有的把取消判成失败)。收成一处之后,
 * 尺子②③④ 就是它的直接推论:任何工具的任何一次调用都被预览、被审批、被审计;
 * 信号一响恒为 aborted;过程全部走事件流。
 *
 * 与 §3 伪码的偏离(都在文件里就近注明):最前面多一次 `throwIfAborted`、
 * `beforePlan` 在 validate **之前**、`authorizer.decide` 也被 `scope.race` 包住、
 * `budget.finalize` 是 async、生命周期事件由 Runner 独发,以及 R2a 决定④ 的
 * 「取消时把最后一条 partial 附进结局」。
 */

import { AbortScope } from './abort-scope.js'
import type { ObservedEvent, ToolLifecycleEvent } from './events.js'
import type { Intent } from './intent.js'
import { Outcome } from './outcome.js'
import { OutputBudget, type SpillPort } from './output-budget.js'
import type { Result } from './result.js'
import type {
  Authorizer,
  Clock,
  Interceptor,
  JobRegistry,
  Observer,
  SandboxPolicy,
  Validator,
} from './ports.js'
import type { Invocation, SessionSnapshot } from './run-context.js'
import { RunContext } from './run-context.js'
import type { ToolSpec } from './spec.js'
import type { Tool } from './tool.js'

/** 工具产出了自己没声明过的效果。这是工具的 bug,不是用户的拒绝。 */
export class EffectViolationError extends Error {
  readonly toolId: string
  readonly kinds: readonly string[]

  constructor(toolId: string, kinds: readonly string[]) {
    super(`Tool "${toolId}" planned undeclared effects: ${kinds.join(', ')}`)
    this.name = 'EffectViolationError'
    this.toolId = toolId
    this.kinds = kinds
  }
}

/**
 * `spec.effects` 是静态上界。没有这道检查,"按效果授权"就只是自觉:一个工具
 * 声明 `read` 却在 plan 里报 `bash`,权限卡会照弹,但**审计与场景面**里它仍是一个
 * 只读工具 —— 上界是给系统看的,必须由系统兑现。
 */
export function assertWithinDeclaredEffects(spec: ToolSpec, intent: Intent): void {
  const declared = new Set<string>(spec.effects)
  const violations = [...new Set(intent.effects.map(effect => effect.kind).filter(kind => !declared.has(kind)))]
  if (violations.length > 0) throw new EffectViolationError(spec.id, violations)
}

export interface ToolRunnerPorts {
  readonly authorizer: Authorizer
  readonly observer: Observer
  readonly validator: Validator
  readonly sandbox?: SandboxPolicy
  readonly clock?: Clock
  readonly interceptor?: Interceptor
  readonly jobs?: JobRegistry
  readonly spill?: SpillPort
  readonly session?: (invocation: Invocation) => SessionSnapshot | undefined
}

export class ToolRunner {
  private readonly ports: ToolRunnerPorts

  constructor(ports: ToolRunnerPorts) {
    this.ports = ports
  }

  async run(tool: Tool, invocation: Invocation, signal?: AbortSignal): Promise<Outcome> {
    const scope = new AbortScope(signal)
    const budget = OutputBudget.for(tool.spec, { spill: this.ports.spill, callId: invocation.callId })
    // R2a 决定④:取消时把工具最后一次 `partial` 的内容附进结局。Runner 记它,
    // 因为只有 Runner 同时看得见事件流与结局 —— 工具不该为了"万一被掐"再存一份。
    let lastPartial: Result | undefined
    const context = new RunContext({
      invocation,
      abort: scope,
      budget,
      emit: event => {
        if (event.type === 'partial') lastPartial = event.result
        this.notify(invocation, event)
      },
      jobs: this.ports.jobs,
      sandbox: this.ports.sandbox,
      session: this.ports.session?.(invocation),
      clock: this.ports.clock,
    })

    let outcome: Outcome
    try {
      outcome = await this.execute(tool, invocation, scope, context, budget)
    } catch (error) {
      outcome = Outcome.fromError(error, scope)
    } finally {
      scope.dispose()
      context.dispose()
    }
    outcome = Outcome.withPartial(outcome, lastPartial)

    // finished 用**最终**结局:拦截器改写过的那一个才是真正发生的事。
    const finalOutcome = await this.afterApply(outcome, invocation, scope)
    this.notify(invocation, { type: 'lifecycle', phase: 'finished', outcome: finalOutcome })
    return finalOutcome
  }

  /** 观察者炸了不该改变结局 —— 它是旁观者,不是参与者。 */
  private notify(invocation: Invocation, event: ObservedEvent): void {
    try {
      this.ports.observer.on(invocation, event)
    } catch {
      // 一个坏掉的投影器不该把一次成功的调用变成失败。
    }
  }

  private lifecycle(invocation: Invocation, event: ToolLifecycleEvent): void {
    this.notify(invocation, event)
  }

  private async execute(
    tool: Tool,
    invocation: Invocation,
    scope: AbortScope,
    context: RunContext,
    budget: OutputBudget,
  ): Promise<Outcome> {
    // 伪码把首次查点放在 validate 之后。放在最前面:信号已经响了还先报一句
    // "参数不合法"是在说谎 —— 这次调用的结局是取消,与参数无关(尺子③)。
    scope.throwIfAborted()

    // §10.2-①:插件拦截的挂点,在**校验之前** —— 与今天的管线一致
    // (app/plugins/tool-call-intercept.ts 就是在校验前跑的),而且这是唯一
    // 只需要校验一次的排法:拦截器改完参数照样要过契约,改出来的非法参数会正常
    // 落成 invalid。反过来(先校验再改参)等于给了拦截器一条绕过契约的后门。
    let raw: unknown = invocation.input
    const interceptor = this.ports.interceptor
    if (interceptor) {
      const verdict = await scope.race(Promise.resolve(interceptor.beforePlan(invocation)))
      // 阻断判 denied 而不是 failed:拦截器说"别跑"和授权者说"不许"是同一类事
      // —— 一次被策略拒绝的调用,不该走进重试与事故统计。
      if (verdict.block === true) {
        this.lifecycle(invocation, {
          type: 'lifecycle',
          phase: 'intercepted',
          action: 'block',
          by: verdict.blockedBy ? [verdict.blockedBy] : undefined,
          reason: verdict.reason,
        })
        return Outcome.denied(verdict.reason)
      }
      if (verdict.input !== undefined) {
        raw = verdict.input
        this.lifecycle(invocation, {
          type: 'lifecycle',
          phase: 'intercepted',
          action: 'rewrite',
          by: verdict.rewrittenBy,
        })
      }
    }

    const parsed = this.ports.validator.parse(tool.spec.input, raw)
    if (!parsed.ok) return Outcome.invalid(parsed.message)
    const input: unknown = parsed.value

    scope.throwIfAborted()
    const intent = await scope.race(tool.plan(input, context.forPlan()))
    assertWithinDeclaredEffects(tool.spec, intent)
    this.lifecycle(invocation, { type: 'lifecycle', phase: 'planned', intent })

    // 也用 race 包住:审批可能是"等人回答",人不答就永远不 resolve。伪码里的裸
    // await 会让一次取消卡在这里,与尺子③ 冲突。
    const decision = await scope.race(Promise.resolve(this.ports.authorizer.decide(intent, invocation, scope)))
    this.lifecycle(invocation, { type: 'lifecycle', phase: 'decided', decision })
    if (decision.kind === 'deny') return Outcome.denied(decision.reason)
    scope.throwIfAborted()

    const result = await scope.race(tool.apply(intent.approved(decision), context))
    return Outcome.ok(await budget.finalize(result))
  }

  /** §10.2-① 的第二个挂点。它自己炸了不该冒充工具的失败,但也不能吞掉。 */
  private async afterApply(outcome: Outcome, invocation: Invocation, scope: AbortScope): Promise<Outcome> {
    const interceptor = this.ports.interceptor
    if (!interceptor) return outcome
    try {
      return await interceptor.afterApply(outcome, invocation)
    } catch (error) {
      return Outcome.fromError(error, scope)
    }
  }
}
