/**
 * §3 内核 —— `Invocation`(一次调用的坐标)与 `RunContext`(apply 期间工具能拿到的
 * 一切)。
 *
 * 尺子⑤ 就靠这个对象成立:RunContext 里没有一个回调字段、没有引擎、没有 store、
 * 没有 Electron,全部是端口和值。于是任何工具都能用一个手搓的 RunContext 单测。
 *
 * `forPlan()` 是刻意的窄视图:plan 阶段还没被授权,不该能生后台进程,也不该往
 * 观察流里写东西(那会让"计划"看起来像"已经发生")。
 */

import type { JsonObject } from '../json.js'
import type { Principal } from '../permission/principal.js'
import type { AbortScope, AbortView } from './abort-scope.js'
import type { ToolEvent } from './events.js'
import { LIFECYCLE_EVENT_TYPE } from './events.js'
import type { JobRegistry } from './job.js'
import { bindJobRegistry } from './job.js'
import type { OutputBudget } from './output-budget.js'
import type { Clock, SandboxPolicy } from './ports.js'

/** 一次调用。所有坐标在引擎边界一次性铸好,往下只读不重算。 */
export interface Invocation {
  readonly callId: string
  readonly toolId: string
  /** 模型给的原始参数,尚未过 Validator。 */
  readonly input: unknown
  readonly sessionId: string
  readonly messageId?: string
  readonly principal: Principal
  /** Opaque trusted host context; never reconstructed from the tool input or target session. */
  readonly executionContext?: unknown
  readonly cwd?: string
  readonly workspaceRoot?: string
  /**
   * R2a 决定①:沙箱要的是一个**根列表**,不是一个标量。
   *
   * 一个会话可以挂多个工作目录根(用户在设置里接入的目录、per-space 的接入目录),
   * 而 `cwd` / `workspaceRoot` 只能表达其中一个。R1 只好从
   * `SessionSnapshot.metadata.workingDirectoryRoots` 里捞 —— 那是把一个**调用坐标**
   * 藏进一个自由形状的 metadata 袋子里:没有类型、没人保证它在、每个读者都要自己
   * 写一遍 `Array.isArray` 过滤。升成一等字段之后,坐标在引擎边界一次铸好,往下只读。
   *
   * 空数组与 `undefined` 同义(都表示"没有额外的根"),读者不必区分。
   */
  readonly workingDirectoryRoots?: readonly string[]
}

/** 会话的只读快照。工具能看见自己在哪儿,但改不了任何东西。 */
export interface SessionSnapshot {
  readonly id: string
  readonly title?: string
  readonly kind?: string
  readonly workspaceRoot?: string
  readonly metadata?: JsonObject
}

export interface PlanContext {
  readonly invocation: Invocation
  readonly abort: AbortView
  readonly principal: Principal
  readonly cwd?: string
  readonly sandbox?: SandboxPolicy
  readonly session?: SessionSnapshot
  now(): number
}

export interface RunContextInit {
  readonly invocation: Invocation
  readonly abort: AbortScope
  readonly budget: OutputBudget
  readonly emit?: (event: ToolEvent) => void
  readonly jobs?: JobRegistry
  readonly sandbox?: SandboxPolicy
  readonly session?: SessionSnapshot
  readonly clock?: Clock
}

export class RunContext {
  readonly invocation: Invocation
  /** 工具视角:能查、能包、能登记撤回,掐不了也销毁不了(所有权归 Runner)。 */
  readonly abort: AbortView
  readonly budget: OutputBudget
  readonly sandbox?: SandboxPolicy
  readonly session?: SessionSnapshot
  readonly jobs: ReturnType<typeof bindJobRegistry>

  private readonly sink?: (event: ToolEvent) => void
  private readonly clock?: Clock
  private disposed = false

  constructor(init: RunContextInit) {
    this.invocation = init.invocation
    this.abort = init.abort
    this.budget = init.budget
    this.sandbox = init.sandbox
    this.session = init.session
    this.sink = init.emit
    this.clock = init.clock
    this.jobs = bindJobRegistry(init.jobs, {
      sessionId: init.invocation.sessionId,
      toolCallId: init.invocation.callId,
    })
  }

  get principal(): Principal {
    return this.invocation.principal
  }

  get cwd(): string | undefined {
    return this.invocation.cwd
  }

  now(): number {
    return this.clock ? this.clock.now() : Date.now()
  }

  /**
   * 调用结束后再 emit 的事件直接丢掉:一个跑过头的工具不该往下一次调用的流里
   * 写东西(取消之后的迟到输出正是今天渲染器串台的来源之一)。
   *
   * 生命周期事件也一并挡掉:那三条是 Runner 的证词,工具伪造出来的"我已被授权"
   * 会直接把审计变成一份自证清白的材料。类型上已经不允许,这里再挡一次运行时
   * ——插件与 MCP 送进来的工具不受 TS 约束。
   */
  emit(event: ToolEvent): void {
    if (this.disposed) return
    if ((event as { type?: string }).type === LIFECYCLE_EVENT_TYPE) return
    this.sink?.(event)
  }

  forPlan(): PlanContext {
    return {
      invocation: this.invocation,
      abort: this.abort,
      principal: this.principal,
      cwd: this.cwd,
      sandbox: this.sandbox,
      session: this.session,
      now: () => this.now(),
    }
  }

  dispose(): void {
    this.disposed = true
  }
}
