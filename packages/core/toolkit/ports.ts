/**
 * §3 内核 —— 端口。宿主注入的那几件事,内核只知道形状。
 *
 * 这是"内核零依赖"能成立的原因:权限核、插件拦截、沙箱、时钟、后台进程表全部
 * 在 core 之外,内核只拿到几个接口。也因此 §10.2-⑥ 的两条绕过 Runner 的权限调用
 * (ACP permission-bridge、external-agents 的 effects)可以直接调 `Authorizer`
 * —— 它们不是工具调用,不该硬塞进 Runner,但该走同一个判定。
 */

import type { JsonSchema } from './spec.js'
import type { Decision, Intent } from './intent.js'
import type { ObservedEvent } from './events.js'
import type { Outcome } from './outcome.js'
import type { AbortScope } from './abort-scope.js'
import type { Invocation } from './run-context.js'

export type { Job, JobEvent, JobOwner, JobRegistry, JobSpec, JobStatus } from './job.js'

/**
 * 授权。`ask` 是它内部的过程(弹卡、等人答、记 grant),`decide` 落地时只剩
 * allow / deny。R2 的实现就是包住 `enforcePermissionPolicy`。
 */
export interface Authorizer {
  decide(intent: Intent, invocation: Invocation, scope: AbortScope): Promise<Decision>
}

/**
 * §10.2-③:用户的 per-tool 设置也是授权的输入。`autoExecute === false` 的含义是
 * 「这个工具每次都问我」—— 它不是效果,所以不该混进效果表,而是在这里把 Intent
 * 打上 `alwaysAsk`,由真正的 Authorizer 去决定怎么问。
 *
 * 写成装饰器而不是 Authorizer 的一个 if:装配层可以按宿主自由组合(桌面有设置页,
 * CLI 没有),内核不需要知道设置存在哪儿。
 */
export interface ToolUserSetting {
  readonly enabled?: boolean
  readonly autoExecute?: boolean
}

export function withUserToolSettings(
  inner: Authorizer,
  lookup: (toolId: string) => ToolUserSetting | undefined,
): Authorizer {
  return {
    decide(intent, invocation, scope) {
      const forced = lookup(invocation.toolId)?.autoExecute === false
      return inner.decide(forced ? intent.forceAsk() : intent, invocation, scope)
    },
  }
}

/**
 * 观察者。事件流的出口,IPC / SSE / events.jsonl / 评估轨迹各是一个实现。
 *
 * 它收到的是**全集**:工具发的 `ToolEvent` 与 Runner 发的 `ToolLifecycleEvent`。
 * 审计投影器只认后者(工具伪造不了它),渲染投影器通常只认前者。
 */
export interface Observer {
  on(invocation: Invocation, event: ObservedEvent): void
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

/** 契约解释权。core 禁 zod,所以"schema 怎么校验"是注入的。 */
export interface Validator {
  parse<T = unknown>(schema: JsonSchema, input: unknown): ValidationResult<T>
}

/**
 * 一位**可能不认识这份 schema** 的校验者(K2a)。
 *
 * `undefined` 的含义是「这份契约不是我生产的,问下一位」——它与 `{ ok: true }`
 * 是两件事:后者是「我看过了,没问题」。今天 `ZodValidator` 把这两件事合成了一件
 * (认不出的 schema 一律 `{ ok: true }` 放行),那对它是对的(插件 / MCP 的契约由
 * 对面把关),但**合并之后就没法再串第二位** —— 第一位一放行,第二位永远轮不上。
 * 所以「不认识」得有自己的答案。
 */
export interface PartialValidator {
  parse<T = unknown>(schema: JsonSchema, input: unknown): ValidationResult<T> | undefined
}

/**
 * 串成一位 `Validator`:按顺序问 `parts`,第一个**认领**的说了算;都不认领就交给
 * `fallback` 兜底。写法与 `combineObservers` 同形 —— 内核的端口都是单槽,要多位
 * 就在装配层折成一位。
 *
 * 与 `combineObservers` 的一处**不同**:这里不吞异常。观察者是旁观者,炸了不该影响
 * 调用;校验者是判定者,一位校验者炸了却被吞掉,结果是「没校验过」被当成「校验通过」
 * —— 那是一次静默免检。让它抛,由 Runner 判成一次失败。
 */
export function combineValidators(
  parts: readonly PartialValidator[],
  fallback: Validator,
): Validator {
  return {
    parse<T = unknown>(schema: JsonSchema, input: unknown): ValidationResult<T> {
      for (const part of parts) {
        const claimed = part.parse<T>(schema, input)
        if (claimed) return claimed
      }
      return fallback.parse<T>(schema, input)
    },
  }
}

/** 沙箱。路径的解析与判定归宿主,内核既不认识 fs 也不认识仓库根。 */
export interface SandboxPolicy {
  root(): string | undefined
  resolve(target: string, cwd?: string): string
  contains(target: string): boolean
  isSensitive(target: string): boolean
}

export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

/**
 * 裁决是三态的**结论**,加上一条 R2a 决定⑧ 补回来的**归因**。
 *
 * 设计文档 §11.4 记了一笔:今天 `app/plugins/tool-call-intercept.ts` 知道是哪个
 * 插件改了参数 / 挡了调用,而内核的 verdict 里没有地方放这句话,于是审计里只看得见
 * "参数变了",看不见"谁改的"。`rewrittenBy` / `blockedBy` 是**可选**的归因位:
 * 内核不解释它、不据此改变任何判定,只负责把它原样搬进 `lifecycle:intercepted`
 * 事件交给审计投影器。
 *
 * 注意仍然**没有** `toolId`(§11.4 的结论):可改的工具名会让审计与场景面各说各话,
 * 而且是一次伪装成便利的提权。
 */
export type InterceptVerdict =
  | { readonly block?: false; readonly input?: unknown; readonly rewrittenBy?: readonly string[] }
  | { readonly block: true; readonly reason: string; readonly blockedBy?: string }

/**
 * §10.2-①:插件拦截。今天的管线在 validate 之后、analyze 之前跑
 * `interceptToolCall`(可改参、可阻断),在结果返回前跑 `interceptToolResult`。
 * 内核给它们两个**固定**挂点,不多不少 —— 拦截点一旦可扩展,执行顺序就没人说得清了。
 */
export interface Interceptor {
  beforePlan(invocation: Invocation): InterceptVerdict | Promise<InterceptVerdict>
  afterApply(outcome: Outcome, invocation: Invocation): Outcome | Promise<Outcome>
}
