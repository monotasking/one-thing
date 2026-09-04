/**
 * R2a —— `IpcProjector`(设计文档 §5)。把内核的事件流与结局投影回**今天的**
 * `@shared/ipc` 形状,渲染器一行不改。
 *
 * 内核不认识任何消费者:工具只 `emit`,Runner 只产出 `Outcome`。这个文件是那条流
 * 到桌面 IPC / server SSE 的那一次投影,取代旧管线里 `coreToolContextFromHost` +
 * 三层回调转发的那 ~350 行。
 *
 * 四条对应关系(§5 的表):
 *
 * | 内核 | 旧形状 |
 * | --- | --- |
 * | `annotate{title, details}` | `onMetadata({ title, metadata })` |
 * | `partial{result}` | `onPartialResult(ToolPartialResult)` —— 形状**逐字相同**,恒等映射 |
 * | `step{phase,id,title}` | `onStepStart(Step)` / `onStepComplete(Step)` |
 * | `Outcome` 五态 | `OnethingToolExecutionResult { success, data, error, aborted, rejected, rejectionReason }` |
 *
 * ## 为什么 `Result.content` 必须拆回 `output` + `attachments`
 *
 * canonical `Result` 把附件折进了 `content`(§11.5 偏差 3)。直接用
 * `Outcome.toModelText` 会给 file/image part 补一行 `[File: …]` 占位,而旧的
 * `data.output` 里没有那一行(附件走 `data.attachments`)。所以这里做的是
 * `toolResultToStructured` 的**逆**运算 —— 那个函数怎么折进去,这里就怎么拆出来。
 */

import type { JsonObject } from '@onething/core'
import { Outcome as OutcomeOps } from '@onething/core/toolkit'
import type {
  Decision,
  Invocation,
  ObservedEvent,
  Observer,
  Outcome,
  Result,
  ResultPart,
  ToolEvent,
} from '@onething/core/toolkit'
import type { ToolExecutionResult as OnethingToolExecutionResult } from './execution-types.wiring.js'
import type { Step, ToolPartialResult } from '@shared/ipc.js'

/** 旧 `data.attachments` 的元素形状(`core/tools/tool-result.ts` 的 `ToolResultLike`)。 */
export interface LegacyToolAttachment {
  type: 'file' | 'image'
  path: string
  content?: string
  data?: string
  mimeType?: string
}

export interface LegacyMetadataUpdate {
  title?: string
  metadata?: JsonObject
}

/**
 * `progress` 那条的出口形状(C2-b)。
 *
 * 与 `ToolEvent` 里那条**同形去掉 metadata**:`metadata` 是给审计与结果投影的
 * 结构化细节,而这个出口只服务一件事 —— 屏幕上那一行此刻显示什么。多带一格
 * 就等于让进度这条旁路也变成一条结果通道。
 */
export interface LegacyToolProgressUpdate {
  message?: string
  ratio?: number
  outputTail?: string
}

/** 旧执行上下文交给工具的那四个回调。装配层把它们包成一个 `Observer`。 */
export interface LegacyToolCallbacks {
  onMetadata?(update: LegacyMetadataUpdate): void
  onPartialResult?(update: ToolPartialResult): void
  onStepStart?(step: Step): void
  onStepComplete?(step: Step): void
  /**
   * 进度(C2-b)。**缺席即从前**:没接这个回调的宿主(RPC 直调、外部 agent 的
   * 本地工具执行)照旧一条进度都不发,行为逐字不变。
   */
  onProgress?(update: LegacyToolProgressUpdate): void
}

// ── 纯函数 ──────────────────────────────────────────────────────────────────

/** `annotate` → 旧 `onMetadata` 的入参。 */
export function metadataUpdateFromAnnotate(
  event: Extract<ToolEvent, { type: 'annotate' }>,
): LegacyMetadataUpdate {
  return { title: event.title, metadata: event.details }
}

/**
 * `progress` → 出口入参。**只搬三格,不补一格** —— 工具没报的就是没报,
 * 这里给一个默认 `ratio` 或拿 `metadata` 凑一句 `message`,都是在编。
 */
export function toolProgressFromEvent(
  event: Extract<ToolEvent, { type: 'progress' }>,
): LegacyToolProgressUpdate {
  return {
    ...(event.message !== undefined ? { message: event.message } : {}),
    ...(event.ratio !== undefined ? { ratio: event.ratio } : {}),
    ...(event.outputTail !== undefined ? { outputTail: event.outputTail } : {}),
  }
}

/** `partial` → `ToolPartialResult`。两个形状逐字相同,所以这是恒等映射。 */
export function partialResultFromEvent(
  event: Extract<ToolEvent, { type: 'partial' }>,
): ToolPartialResult {
  return event.result as ToolPartialResult
}

/**
 * `step` → 旧 `Step`。
 *
 * `id` 用 `<callId>:<stepId>` 拼:工具给的 step id 只在这次调用里唯一(工具写的是
 * `'spawn'` 这种名字),而渲染器的 step 列表是跨调用的一条流水。
 */
export function stepFromEvent(
  event: Extract<ToolEvent, { type: 'step' }>,
  invocation: Invocation,
  now: number = Date.now(),
): Step {
  return {
    id: `${invocation.callId}:${event.id}`,
    type: 'tool-call',
    title: event.title ?? invocation.toolId,
    status: event.phase === 'start' ? 'running' : event.error ? 'failed' : 'completed',
    timestamp: now,
    toolCallId: invocation.callId,
    ...(event.error ? { error: event.error } : {}),
  }
}

/**
 * `Result` → 旧 `{ output, attachments, metadata }`。
 *
 * 文本 part 拼成 `output`(旧的 `output` 就是一个字符串);image/file part 回到
 * `attachments`;`details` 回到 `metadata`。
 */
export function splitResultContent(result: Result): {
  output: string
  attachments?: LegacyToolAttachment[]
  metadata?: JsonObject
} {
  const texts: string[] = []
  const attachments: LegacyToolAttachment[] = []

  for (const part of result.content) {
    if (part.type === 'text') {
      texts.push(part.text ?? '')
      continue
    }
    if (!part.path) continue
    attachments.push(toLegacyAttachment(part))
  }

  return {
    output: texts.join('\n'),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(result.details !== undefined ? { metadata: result.details as JsonObject } : {}),
  }
}

function toLegacyAttachment(part: ResultPart): LegacyToolAttachment {
  if (part.type === 'image') {
    return { type: 'image', path: part.path!, content: part.data, mimeType: part.mimeType }
  }
  // 文件附件的 base64 在 `data`,文本内容在 `text` —— `toolResultToStructured` 折
  // 进来时就是这么分的,拆出去照原样。
  return {
    type: 'file',
    path: part.path!,
    ...(part.text !== undefined ? { content: part.text } : {}),
    ...(part.data !== undefined ? { data: part.data } : {}),
    mimeType: part.mimeType,
  }
}

export interface ExecutionResultProjectionInput {
  /** 过程中累积下来的最后一个标题(旧 `ToolResult.title`,由 annotate 事件给)。 */
  readonly title?: string
  /** 授权结论。`denied` 要靠它区分"人拒了"与"策略/插件挡了"。 */
  readonly decision?: Decision
}

/**
 * `Outcome` 五态 → 旧 `OnethingToolExecutionResult`。
 *
 * 与旧路的两处**有意**差异,都写在这里:
 *
 *  1. `aborted` 的文案是 `Outcome.toModelText`(`Tool execution was cancelled.`
 *     加上决定④ 的 `<partial_output>` 尾巴),不是旧的
 *     `Execution cancelled by user` / 工具抛出的原文。取消的措辞由内核一处说了算,
 *     而已收到的输出仍然在,只是换了个有名字的位置。
 *  2. 用户拒绝的文案是 `formatPermissionRejectedMessage(reason)` 一次,不是旧
 *     `tools/registry.ts` 那句把 reason **拼两遍**的
 *     `${error.message} Reason: ${reason}`(error.message 里已经含着一次)。
 *     那是个显而易见的重复,不复制。
 */
export function executionResultFromOutcome(
  outcome: Outcome,
  input: ExecutionResultProjectionInput = {},
): OnethingToolExecutionResult {
  switch (outcome.kind) {
    case 'ok': {
      const { output, attachments, metadata } = splitResultContent(outcome.result)
      return {
        success: true,
        data: {
          title: input.title ?? '',
          output,
          metadata: metadata ?? {},
          ...(attachments ? { attachments } : {}),
        },
        ...(outcome.result.terminate ? { terminate: true } : {}),
      } as OnethingToolExecutionResult
    }
    case 'invalid':
      return { success: false, error: outcome.message }
    case 'denied': {
      const decision = input.decision
      if (decision?.kind === 'deny' && decision.byUser) {
        return {
          success: false,
          error: outcome.reason,
          rejected: true,
          ...(decision.rejectionReason ? { rejectionReason: decision.rejectionReason } : {}),
        }
      }
      // 策略硬拒 / 插件阻断:一条普通的工具错误,与旧路一致。
      return { success: false, error: outcome.reason }
    }
    case 'aborted':
      return { success: false, error: OutcomeOps.toModelText(outcome), aborted: true }
    case 'failed':
      return { success: false, error: outcome.message || 'Unknown error during tool execution' }
  }
}

// ── 适配器 ──────────────────────────────────────────────────────────────────

/**
 * 把旧的四个回调包成一个 `Observer`,顺带记住投影最终结果所需的那点状态
 * (最后一个非空标题、授权结论)。
 *
 * 一个实例服务**一次调用**:`toExecutionResult` 读的就是这一次累积下来的东西。
 * 想服务一整条会话就每次调用新建一个 —— 它一共两个字段。
 */
export class IpcProjector implements Observer {
  private readonly callbacks: LegacyToolCallbacks
  private readonly now: () => number
  private lastTitle?: string
  private lastDecision?: Decision

  constructor(callbacks: LegacyToolCallbacks = {}, options: { now?: () => number } = {}) {
    this.callbacks = callbacks
    this.now = options.now ?? (() => Date.now())
  }

  get title(): string | undefined {
    return this.lastTitle
  }

  get decision(): Decision | undefined {
    return this.lastDecision
  }

  on(invocation: Invocation, event: ObservedEvent): void {
    if (event.type === 'lifecycle') {
      if (event.phase === 'decided') this.lastDecision = event.decision
      return
    }

    switch (event.type) {
      case 'annotate':
        // 只有带标题的 annotate 更新标题:工具在收尾时会发一条**只带 metadata**
        // 的 annotate(write/edit 都是),那一条不该把标题清空。
        if (event.title !== undefined) this.lastTitle = event.title
        this.callbacks.onMetadata?.(metadataUpdateFromAnnotate(event))
        return
      case 'partial':
        this.callbacks.onPartialResult?.(partialResultFromEvent(event))
        return
      case 'step': {
        const step = stepFromEvent(event, invocation, this.now())
        if (event.phase === 'start') this.callbacks.onStepStart?.(step)
        else this.callbacks.onStepComplete?.(step)
        return
      }
      /*
       * C2-b:progress 有了自己的出口。
       *
       * 它走的是**活流那根管**(StreamChannel 上的 `tool-progress` chunk),
       * 不是旧契约里任何一个已有的回调 —— 所以这里只把三格摆出来,
       * 发给谁、发不发得出去都是装配层的事。
       */
      case 'progress':
        this.callbacks.onProgress?.(toolProgressFromEvent(event))
        return
      // spawned 在旧契约里没有对应的出口 —— 它是新增的观察面(后台 job 表),
      // 由别的投影器消费,这里静默略过而不是硬塞进 metadata:塞进去等于给
      // 渲染器发明一个它没约定过的字段。
      default:
        return
    }
  }

  toExecutionResult(outcome: Outcome): OnethingToolExecutionResult {
    return executionResultFromOutcome(outcome, { title: this.lastTitle, decision: this.lastDecision })
  }
}

/** 只要一个 `Observer` 时的门面(不需要最终结果投影的场合)。 */
export function createIpcObserver(callbacks: LegacyToolCallbacks): Observer {
  return new IpcProjector(callbacks)
}
