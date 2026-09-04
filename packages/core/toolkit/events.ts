/**
 * §3 内核 —— 一次调用过程中的一切观察,分成**两条**:工具事件与生命周期事件。
 *
 * 尺子④:进度/元数据/部分结果是一条流,不是四个回调字段。今天
 * `ctx.metadata()` / `onStepStart` / `updateResult` / `onPartialResult` 由三层
 * 适配器层层转发,每加一个消费者就要再穿一层;这里工具只 `emit`,桌面 IPC、
 * server SSE、events.jsonl、评估轨迹各自是这条流的一个投影。
 *
 * 生命周期事件由 **Runner 独发**,工具伪造不了(`RunContext.emit` 只收 `ToolEvent`,
 * 运行时也会把 lifecycle 挡掉)。§5 的 AuditProjector 要能回答「打算做什么 vs
 * 实际做了什么」—— 那需要 `planned`(计划)、`decided`(授权结论)、`finished`
 * (最终结局)这三条来自系统而非来自工具的证词;工具能编造的证词不叫审计。
 */

import type { JsonObject } from '../json.js'
import type { Decision, Intent } from './intent.js'
import type { JobSnapshot } from './job.js'
import type { Outcome } from './outcome.js'
import type { Result } from './result.js'

/** 工具自己发的。`RunContext.emit` 只接受这些。 */
export type ToolEvent =
  /**
   * 干到哪儿了。`ratio` ∈ [0,1],不知道就别给(假进度条比没有更糟)。
   *
   * `outputTail` 是**此刻最后那几行给人看的输出**(C2-b)。它与 `partial` 那条
   * 不是一回事:`partial` 交的是「已经能给模型看的一份结果」(会进 step 的
   * partialResult、参与后续投影),`outputTail` 只是一句读数 —— 谁都不许拿它
   * 当结果用,它随这次调用收场一起没。
   */
  | { type: 'progress'; message?: string; ratio?: number; outputTail?: string; metadata?: JsonObject }
  /** 还没完,但已经有能给人看的东西了(流式命令输出、边搜边出的结果)。 */
  | { type: 'partial'; result: Result }
  /** 工具内部的一个可命名阶段。id 用来把 start/end 配对。 */
  | { type: 'step'; phase: 'start' | 'end'; id: string; title?: string; error?: string; metadata?: JsonObject }
  /** 给这次调用补一个标题/结构化细节(取代今天的 `ctx.metadata()`)。 */
  | { type: 'annotate'; title?: string; details?: JsonObject }
  /** 生出了一个分离执行体。之后它的生命周期归 JobRegistry,不归这次调用。 */
  | { type: 'spawned'; job: JobSnapshot }

/**
 * Runner 发的。固定顺序:(intercepted) → planned → decided → finished。
 *
 * R2a 决定⑧ 加了 `intercepted`,而**没有**把归因塞进 `planned`。理由是时序:
 * 拦截发生在 plan 之前,而被 `block` 挡住的调用**根本不会有 planned** —— 把
 * "是哪个插件挡的"挂在 planned 上,等于恰好在最需要归因的那一次(被挡)里丢掉它。
 * 单独一条事件还让"改写"这件事有了独立的证据行:审计能回答"模型发的参数"与
 * "真正跑的参数"为什么不同,而不用去 diff 两条别的事件。
 *
 * 它只在拦截器**真的做了事**时发(挡下,或改了参数);一个恒返回 `{}` 的拦截器
 * 不产生噪声。
 */
export type ToolLifecycleEvent =
  | {
      type: 'lifecycle'
      phase: 'intercepted'
      action: 'rewrite' | 'block'
      /** 谁干的。拦截器给不出就没有 —— 内核不编。 */
      by?: readonly string[]
      /** `block` 的理由(与最终 `Outcome.denied` 的 reason 是同一句话)。 */
      reason?: string
    }
  | { type: 'lifecycle'; phase: 'planned'; intent: Intent }
  | { type: 'lifecycle'; phase: 'decided'; decision: Decision }
  | { type: 'lifecycle'; phase: 'finished'; outcome: Outcome }

/** Observer 看到的全集。 */
export type ObservedEvent = ToolEvent | ToolLifecycleEvent

export type ToolEventType = ToolEvent['type']
export type ObservedEventType = ObservedEvent['type']

export const LIFECYCLE_EVENT_TYPE = 'lifecycle'

export function isLifecycleEvent(event: ObservedEvent): event is ToolLifecycleEvent {
  return event.type === LIFECYCLE_EVENT_TYPE
}

export type Emit = (event: ToolEvent) => void
