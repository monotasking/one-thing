/**
 * K1 —— `ResourceKernel`:非 AI 调用方进管线的那扇门
 * (`docs/design/atom-2026-09.md` §2 不变量 2:「每一次『做』经过同一条管线……
 * **没有第二条路**,界面点按钮也走它」)。
 *
 * 这只文件是那句话的**证据**。它对外的两个方法 `do` / `read` 做的全部事情是:把
 * 一次调用摆成一条 `Invocation`,然后调 `ToolRunner.run(tool, invocation)` —— 与
 * agent-loop 调一只工具时走的是**同一个 run**。所以:
 *
 *   · 授权:同一个 `Authorizer`,同一张效果表,同一批 grant;
 *   · 审计:同一条 `lifecycle:finished` 证词,进同一本 `events.jsonl`;
 *   · 取消 / 预算 / 插件拦截:同上。
 *
 * 反过来说,这只文件里**没有**任何一句「如果是界面调的就……」。一旦这里长出那样
 * 一句 if,§2 不变量 2 就当场失效了 —— 那正是今天「24 个 RPC 域各写各的授权」这笔
 * 债的形状,K2 要还的就是它。
 *
 * ── 为什么 `do` / `read` 返回 `Outcome` 而不抛 ──────────────────────────────
 * `Outcome` 已经是一个五态的判别联合(ok / invalid / denied / aborted / failed),
 * 它就是「这次调用发生了什么」的完整答案。让「地址写错了」走异常、让「被用户拒绝」
 * 走返回值,等于同一个问题有两种答法,每个调用方都得两边都处理。
 *
 * ── 为什么它持有注册表和事件总线,而不是反过来 ─────────────────────────────
 * 因为 `mount` 是一件**成对**的事:登记自述、建工具、把总线交给实现,注销时三样
 * 一起撤。让调用方分别调三次 = 三次都有可能漏掉一次(尤其是注销那一半)。
 * 与组合根法条同一句话:谁起的,谁给出收尾。
 */

import type { Outcome } from '../toolkit/outcome.js'
import { Outcome as OutcomeOps } from '../toolkit/outcome.js'
import type { Invocation } from '../toolkit/run-context.js'
import type { ToolRunner } from '../toolkit/runner.js'
import type { Principal } from '../permission/principal.js'
import { ResourceSchemeUnknownError } from './errors.js'
import { ResourceEventHub } from './events.js'
import type { ResourceProvider } from './provider.js'
import { parseRef } from './ref.js'
import type { ResourceRegistry } from './registry.js'
import { RESOURCE_OP_KEY, RESOURCE_READ_KEY, RESOURCE_REF_KEY } from './schema.js'
import { ResourceTool, type ShellDispatch } from './tool.js'
import type { ResourceInputValidator } from './validator.js'

export interface ResourceKernelOptions {
  /** `home: 'shell'` 的做法往哪儿派。缺席 = 这台宿主没有界面(结构化降级)。 */
  readonly shell?: ShellDispatch
  /** callId 的产地。缺席时用实例自己的计数器 —— 内核不认识 uuid,也不该认识。 */
  readonly callIds?: () => string
  /**
   * 认得生成 schema 的那位校验者(K2a)。给了,`mount` 就把这个 scheme 的入参契约
   * 认领进去,于是未知 op / 形状不对走 `Outcome.invalid` 而不是 `failed`。
   *
   * 它在**这里**而不是在 runner 的构造参数里,是因为只有 `mount` 同时知道两件事:
   * 这坨 schema 是刚造出来的哪一份、它属于哪份自述。装配层把同一个实例既交给这里
   * 又串进 runner 的 `Validator`(`backend/wiring/resource/index.ts`)。
   *
   * 缺席 = 这台宿主没配那位校验者,plan 期那几只具名错原样兜底(K1 的行为)。
   */
  readonly validator?: ResourceInputValidator
}

/**
 * 「这次调用不是从任何一条会话里发起的」——调度、deeplink、CLI、界面上一个与当前
 * 会话无关的按钮(K2a)。
 *
 * 它是一个**保留坐标**,不是某条会话的 id:`Invocation.sessionId` 在 toolkit 里是
 * 必填的(它是审计与取消的坐标,不是可选的元数据),而「没有发起会话」是一个真实
 * 存在的答案。给它一个具名的值,好过让每个无会话调用方随手编一条 id —— 那样审计
 * 会落进一条不存在的会话,或者更糟,落进**被改的那一条**(K1 留账说的正是这个:
 * 重命名会话 A 时若拿 A 当发起坐标,审计就变成了「A 自己改了自己」)。
 *
 * `@` 开头是刻意的:id 是 uuid,字母表里没有 `@`,所以它与任何真 id 都撞不上,而且
 * 一眼看得出不是 id。谁读到这个坐标,谁负责把审计落到别处 —— 今天唯一的读者是
 * `backend/wiring/toolkit/audit-sink.ts`(落 `<store>/audit/resource.jsonl`)。
 *
 * 字面量里**不写出那个命名空间的名字**:内核不认识任何 scheme(§2 不变量 3),
 * 而 `__tests__/stranger.test.ts` 按词边界扫本目录来执法 —— 这一条是它当场抓出来的,
 * 而且抓对了:一个叫 `@no-origin-<某个 scheme 名>` 的保留坐标,读起来像是那种资源
 * 的特例,而它不是。
 */
export const NO_ORIGIN_SESSION = '@no-origin'

/** 一次调用的坐标。与 `Invocation` 里那几格同名同义,是一次转手不是翻译。 */
export interface ResourceCallOptions {
  readonly principal: Principal
  /**
   * 从哪条会话里发起的。**可选**(K2a):不给 = `NO_ORIGIN_SESSION`,见上。
   * 它是发起坐标,不是操作对象 —— 操作对象在 `ref` 里。
   */
  readonly sessionId?: string
  readonly signal?: AbortSignal
  readonly messageId?: string
}

export class ResourceKernel {
  readonly registry: ResourceRegistry
  readonly events: ResourceEventHub

  private readonly runner: ToolRunner
  private readonly options: ResourceKernelOptions
  private readonly tools_ = new Map<string, ResourceTool>()
  private seq = 0

  constructor(registry: ResourceRegistry, runner: ToolRunner, options: ResourceKernelOptions = {}) {
    this.registry = registry
    this.runner = runner
    this.options = options
    this.events = new ResourceEventHub()
  }

  /**
   * 登记一种资源:自述进注册表、工具进内部表、事件总线交给实现。返回**幂等**的
   * 注销函数,三样一起撤。
   *
   * 自述非法(`ResourceSpecError`)或 scheme 已被占(`ResourceSchemeTakenError`)时
   * 由注册表抛,而且是在写表之前抛 —— 所以一次失败的 `mount` 不会留下半张表。
   */
  mount<Payload>(provider: ResourceProvider<Payload>): () => void {
    const unregister = this.registry.register(provider.spec)
    const scheme = provider.spec.scheme
    const tool = new ResourceTool<Payload>(
      provider,
      this.options.shell ? { shell: this.options.shell } : {},
    )
    this.tools_.set(scheme, tool as ResourceTool)
    // 生成的入参契约认领给校验者(K2a)。它与建工具是**同一拍** —— 那坨 schema 就是
    // 这一行上面刚造出来的,再晚一步就得靠别人去猜「这份 schema 是谁的」。
    const unclaim = this.options.validator?.register(tool.spec.input, provider.spec)
    provider.attach?.(this.events)

    return () => {
      unregister()
      unclaim?.()
      // 身份判等,与 `registry.ts` 的注销同一个理由:同一个 scheme 可能已经被
      // 另一个提供者装上了(插件重装、MCP 重连),旧闭包不该把后来者摘掉。
      if (this.tools_.get(scheme) === (tool as ResourceTool)) this.tools_.delete(scheme)
    }
  }

  /**
   * 全体资源工具,**顺序跟着 `registry.list()`**(scheme 字典序)。
   *
   * 顺序不是为了好看:这份清单会被注册进工具目录、进而进提示词与 MCP 的 tool
   * list,让它取决于装配顺序 = 同一台机器换个装配顺序就换一份 system 前缀。
   */
  tools(): readonly ResourceTool[] {
    const out: ResourceTool[] = []
    for (const spec of this.registry.list()) {
      const tool = this.tools_.get(spec.scheme)
      if (tool) out.push(tool)
    }
    return out
  }

  toolFor(scheme: string): ResourceTool | undefined {
    return this.tools_.get(scheme)
  }

  /** 做一件事。与 AI 走的是同一个 `ToolRunner.run`。 */
  do(ref: string, op: string, params: Record<string, unknown>, options: ResourceCallOptions): Promise<Outcome> {
    return this.invoke(ref, { [RESOURCE_OP_KEY]: op, ...params }, options)
  }

  /** 读一件事。同上,只是判别字段换一个。 */
  read(ref: string, name: string, query: Record<string, unknown>, options: ResourceCallOptions): Promise<Outcome> {
    return this.invoke(ref, { [RESOURCE_READ_KEY]: name, ...query }, options)
  }

  private async invoke(
    ref: string,
    input: Record<string, unknown>,
    options: ResourceCallOptions,
  ): Promise<Outcome> {
    const parsed = parseRef(ref)
    // 地址与 scheme 这两关在**进管线之前**判,因为它们决定的是「调哪一只工具」——
    // 没有工具就没有管线可走。工具选定之后的每一句判定都在管线里(`ResourceTool`
    // 的 plan),这里不多判一个字。
    if (!parsed) return OutcomeOps.failed(new ResourceSchemeUnknownError(ref))
    const tool = this.tools_.get(parsed.scheme)
    if (!tool) return OutcomeOps.failed(new ResourceSchemeUnknownError(parsed.scheme))

    const invocation: Invocation = {
      callId: this.mintCallId(),
      toolId: parsed.scheme,
      input: { ...input, [RESOURCE_REF_KEY]: ref },
      sessionId: options.sessionId ?? NO_ORIGIN_SESSION,
      principal: options.principal,
      ...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
    }
    return this.runner.run(tool, invocation, options.signal)
  }

  private mintCallId(): string {
    const mint = this.options.callIds
    if (mint) return mint()
    this.seq += 1
    return `resource-${this.seq}`
  }
}
