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

export interface ResourceKernelOptions {
  /** `home: 'shell'` 的做法往哪儿派。缺席 = 这台宿主没有界面(结构化降级)。 */
  readonly shell?: ShellDispatch
  /** callId 的产地。缺席时用实例自己的计数器 —— 内核不认识 uuid,也不该认识。 */
  readonly callIds?: () => string
}

/** 一次调用的坐标。与 `Invocation` 里那几格同名同义,是一次转手不是翻译。 */
export interface ResourceCallOptions {
  readonly principal: Principal
  readonly sessionId: string
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
    provider.attach?.(this.events)

    return () => {
      unregister()
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
      sessionId: options.sessionId,
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
