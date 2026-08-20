/**
 * S0 合同测试(docs/design/session-event-sourcing-2026-08.md §9.5)。
 *
 * 每个场景**同时**跑两条线:
 *  - **A 线**(今天的真相):命令序列 → `applySessionCommand` 逐条 → `ChatMessage[]`;
 *  - **B 线**(事件溯源):同一场景按 §9.3 翻译成事件 → `projectChatMessages`。
 *
 * 断言 `canonical(A) ≡ canonical(B)`,以及
 * `projectModelHistory(B, meta) ≡ buildHistoryMessages(A, session)`。
 *
 * ## 为什么这不是恒真的(审查 B7 点名的那条)
 *
 * 原稿的金测是 `projectChatMessages(synthesize(messages)) ≡ messages` ——
 * 因为 `message/imported` 原样带全部字段,那个等式恒成立,证不了任何事。
 * 这里两条线的**输入是同一个场景描述,输出路径完全不共享**:A 线走命令 reducer
 * 逐字段拼消息,B 线走 delta fold + 工具事件派生。任何一个派生规则写错
 * (part 顺序、turnIndex 归属、denied 的状态映射、usage 累计口径、compact 的
 * 遮蔽范围)两条线立刻分叉。
 *
 * ## 它证不了什么(诚实交代,§9.7 的缺口清单里逐条列了)
 *
 * A 线的命令序列是**照引擎的写法手写的**,不是引擎本体。事件里没有来源的字段
 * (step 的 `id`/`title`、`thinkingTime`、`data-steps` 占位 part、
 * `rejectionReason`)在两条线上都不出现 —— 它们要等 S1 影子期才验得了。
 */

import { describe, expect, it } from 'vitest'

import { buildHistoryMessages } from '../../engine/history.js'
import { generateStepTitle } from '../../engine/tool-step.js'
import type { CoreHistoryChatMessage, CoreHistoryMessage } from '../../engine/history.js'
import { buildContextCompactContent } from '../../engine/context-compact.js'
import { applySessionCommand } from '../commands.js'
import type { CoreSessionCommandMessage, SessionCommand } from '../commands.js'
import { encodeSessionLogEventLine } from '../events/index.js'
import type { SessionLogEventRecord, SessionRunKind } from '../events/index.js'
import { foldEventPageBackward } from '../storage/events/index.js'
import type { SessionEventByteReader } from '../storage/events/index.js'
import {
  canonicalChatMessages,
  canonicalHistoryMessages,
  createSessionProjectionState,
  defaultHistoryMessageContent,
  foldSurface,
  projectChatMessages,
  projectModelHistory,
  reduceSessionProjection,
  SurfaceIndex,
} from '../projection/index.js'
import type { ProjectedStep, ProjectedStepUsage, ProjectedToolCall } from '../projection/index.js'

// ============================================================================
// 场景描述(两条线共同的输入,唯一共享的东西)
// ============================================================================

interface ToolSpec {
  callId: string
  name: string
  toolId?: string
  args: Record<string, unknown>
  /** 结果正文;缺席 = 这次调用没有结果(abort / 还在跑)。 */
  resultText?: string
  isError?: boolean
  outcome?: 'ok' | 'denied' | 'failed' | 'aborted'
  /** 参数是流式来的:多一条 `assistant/chunks{kind:'tool-input'}` + part-end。 */
  streamedArgs?: boolean
}

interface RequestSpec {
  reasoning?: string
  text?: string
  tools?: ToolSpec[]
  usage?: { inputTokens: number; outputTokens: number }
}

interface TurnSpec {
  runId: string
  messageId: string
  kind: SessionRunKind
  provider?: string
  model?: string
  requests: RequestSpec[]
  outcome: 'completed' | 'aborted' | 'error'
  error?: string
}

// ============================================================================
// 时间轴:两条线共用同一串时刻,免得比较退化成"时间戳不等"
// ============================================================================

class Clock {
  private value = 1_000
  next(): number {
    this.value += 10
    return this.value
  }
}

// ============================================================================
// A 线:命令序列 → ChatMessage[]
// ============================================================================

interface CommandSession {
  id: string
  messages: CoreSessionCommandMessage[]
  updatedAt: number
  summary?: string
  summaryUpToMessageId?: string
  summaryCreatedAt?: number
}

class CommandLine {
  session: CommandSession = { id: 's1', messages: [], updatedAt: 0 }

  run(command: SessionCommand<CoreSessionCommandMessage>): void {
    const result = applySessionCommand(this.session, command)
    if (result.changed) this.session = result.session
  }

  get messages(): Record<string, unknown>[] {
    return this.session.messages as unknown as Record<string, unknown>[]
  }
}

// ============================================================================
// B 线:事件序列
// ============================================================================

class EventLine {
  readonly events: SessionLogEventRecord[] = []
  private seq = 0
  private surface = new SurfaceIndex()

  push(record: Omit<SessionLogEventRecord, 'seq'> & { seq?: number }): SessionLogEventRecord {
    const event = { ...record, seq: ++this.seq } as SessionLogEventRecord
    this.events.push(event)
    this.surface.push(event)
    return event
  }

  /** 当前 surface 的首/末节点 —— replace 的 range 从这里取,不靠手数。 */
  surfaceRange(): { first?: number; last?: number; all: number[] } {
    const snapshot = this.surface.snapshot()
    return { first: snapshot.order[0], last: snapshot.order[snapshot.order.length - 1], all: snapshot.order }
  }

  /**
   * 从某个节点(含)到 surface 末尾的那一段。
   *
   * **按位置切,不按 seq 大小** —— compact 之后那个节点排在前面但 seq 最大,
   * 按大小筛会把它一起圈进来(第一版就是这么写的,于是"压缩后再编辑"把摘要
   * 也一并遮掉了)。
   */
  surfaceFrom(start: number): number[] {
    const order = this.surface.snapshot().order
    const at = order.indexOf(start)
    return at === -1 ? [] : order.slice(at)
  }

  /** 一个节点(连同紧跟它的 tool/result 节点)在 surface 上占的那一段的末尾。 */
  surfaceGroupEnd(start: number, knownNodeSeqs: ReadonlySet<number>): number {
    const order = this.surface.snapshot().order
    let at = order.indexOf(start)
    if (at === -1) return start
    while (at + 1 < order.length && !knownNodeSeqs.has(order[at + 1])) at++
    return order[at]
  }

  surfaceThrough(end: number): number[] {
    const order = this.surface.snapshot().order
    const at = order.indexOf(end)
    return at === -1 ? [] : order.slice(0, at + 1)
  }
}

// ============================================================================
// 一个回合:两条线各自的写法
// ============================================================================

function toolCallOf(spec: ToolSpec, timestamp: number, receivedAt?: number): ProjectedToolCall {
  const status: ProjectedToolCall['status'] =
    spec.resultText === undefined
      ? 'cancelled'
      : spec.isError || spec.outcome === 'denied' || spec.outcome === 'failed'
        ? 'failed'
        : spec.outcome === 'aborted'
          ? 'cancelled'
          : 'completed'
  const call: ProjectedToolCall = {
    id: spec.callId,
    toolId: spec.toolId ?? spec.name,
    toolName: spec.name,
    arguments: spec.args,
    status,
    timestamp,
  }
  if (receivedAt !== undefined) call.receivedAt = receivedAt
  if (spec.resultText !== undefined && !spec.isError) call.result = spec.resultText
  if (spec.isError && spec.resultText !== undefined) call.error = spec.resultText
  if (spec.outcome === 'denied') call.rejected = true
  return call
}

function stepOf(
  spec: ToolSpec,
  toolCall: ProjectedToolCall,
  timestamp: number,
  turnIndex: number,
  usage?: ProjectedStepUsage,
): ProjectedStep {
  const step: ProjectedStep = {
    // A 线也照引擎实时那一份算标题(`createToolExecutionStep` → `generateStepTitle`)。
    // 从前这里写死 `spec.name`,于是 G2 的"标题是纯派生"在合同上是空的。
    id: `step-${spec.callId}`,
    type: 'tool-call',
    title: generateStepTitle(spec.name, spec.args as Parameters<typeof generateStepTitle>[1]),
    status:
      toolCall.status === 'completed' ? 'completed'
        : toolCall.status === 'failed' ? 'failed'
          : toolCall.status === 'cancelled' ? 'cancelled'
            : 'pending',
    timestamp,
    turnIndex,
    toolCallId: spec.callId,
    toolCall,
  }
  if (spec.resultText !== undefined && !spec.isError) step.result = spec.resultText
  if (spec.isError && spec.resultText !== undefined) step.error = spec.resultText
  if (toolCall.rejected) step.rejected = true
  if (usage) step.usage = usage
  return step
}

function normalizedUsage(usage: { inputTokens: number; outputTokens: number }): ProjectedStepUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
  }
}

/** 两条线共用的"这一回合的时刻表" —— 先排好,再各自按它写。 */
interface TurnTimeline {
  start: number
  requests: Array<{
    reasoning?: number
    text?: number
    response?: number
    tools: Array<{ inputEnd?: number; call: number; result?: number; audit?: number }>
  }>
  end: number
}

function planTurn(turn: TurnSpec, clock: Clock): TurnTimeline {
  const start = clock.next()
  const requests = turn.requests.map(request => ({
    ...(request.reasoning !== undefined ? { reasoning: clock.next() } : {}),
    ...(request.text !== undefined ? { text: clock.next() } : {}),
    ...(request.usage ? { response: clock.next() } : {}),
    tools: (request.tools ?? []).map(tool => ({
      ...(tool.streamedArgs ? { inputEnd: clock.next() } : {}),
      call: clock.next(),
      ...(tool.resultText !== undefined ? { result: clock.next(), audit: clock.next() } : {}),
    })),
  }))
  return { start, requests, end: clock.next() }
}

function applyTurnCommands(line: CommandLine, turn: TurnSpec, timeline: TurnTimeline): void {
  line.run({
    type: 'appendMessage',
    now: timeline.start,
    message: {
      id: turn.messageId,
      role: 'assistant',
      content: '',
      timestamp: timeline.start,
      isStreaming: true,
      ...(turn.provider ? { provider: turn.provider } : {}),
      ...(turn.model ? { model: turn.model } : {}),
    } as CoreSessionCommandMessage,
  })

  let text = ''
  let reasoning = ''
  const toolCalls: ProjectedToolCall[] = []
  let usage: ProjectedStepUsage | undefined

  turn.requests.forEach((request, index) => {
    const turnIndex = index + 1
    const slot = timeline.requests[index]

    if (request.reasoning !== undefined) {
      // 引擎的落点规则(`core/engine/agent-loop-executor.ts` 的
      // `getAgentLoopReasoningPlacement`):第 1 轮请求开头、此前没产出过正文/
      // 工具调用的那一段是 `'top'` —— `updateMessageReasoning` 写**字段**,不进
      // contentParts;其余一律 `'inline'` —— `appendOrderedPart` 写 contentParts,
      // 字段不再动。A 线必须照抄这条,不然它和投影一起错、合同测试白跑
      // (真机第一天正是这么漏过去的,§10.9)。
      const placement = turnIndex === 1 && text.length === 0 && toolCalls.length === 0 ? 'top' : 'inline'
      if (placement === 'top') {
        reasoning += request.reasoning
        line.run({ type: 'patchMessage', messageId: turn.messageId, patch: { reasoning } as never, hint: 'stream' })
      } else {
        line.run({
          type: 'appendContentPart',
          messageId: turn.messageId,
          part: { type: 'reasoning', content: request.reasoning, turnIndex },
        })
      }
    }
    if (request.text !== undefined) {
      text += request.text
      line.run({ type: 'patchMessage', messageId: turn.messageId, patch: { content: text } as never, hint: 'stream' })
      line.run({
        type: 'appendContentPart',
        messageId: turn.messageId,
        part: { type: 'text', content: request.text, turnIndex },
      })
    }
    if (request.usage) {
      const next = normalizedUsage(request.usage)
      usage = usage
        ? {
            inputTokens: usage.inputTokens + next.inputTokens,
            outputTokens: usage.outputTokens + next.outputTokens,
            totalTokens: usage.totalTokens + next.totalTokens,
          }
        : next
      line.run({ type: 'patchMessage', messageId: turn.messageId, patch: { usage } as never, hint: 'settle' })
    }

    ;(request.tools ?? []).forEach((tool, toolIndex) => {
      const slots = slot.tools[toolIndex]
      const call = toolCallOf(tool, slots.call, slots.inputEnd)
      toolCalls.push(call)
      line.run({
        type: 'setToolCalls',
        messageId: turn.messageId,
        toolCalls: toolCalls.map(entry => ({ ...entry })) as never,
      })
      line.run({
        type: 'upsertStep',
        messageId: turn.messageId,
        step: stepOf(tool, call, slots.call, turnIndex) as never,
      })
    })

    if (request.usage) {
      line.run({
        type: 'patchStepsUsageByTurn',
        messageId: turn.messageId,
        turnIndex,
        usage: normalizedUsage(request.usage),
      })
    }
  })

  line.run({
    type: 'patchMessage',
    messageId: turn.messageId,
    patch: {
      isStreaming: false,
      ...(turn.outcome === 'error' && turn.error ? { errorDetails: turn.error } : {}),
    } as never,
    hint: 'settle',
  })
}

function emitTurnEvents(line: EventLine, turn: TurnSpec, timeline: TurnTimeline): void {
  line.push({
    time: timeline.start,
    type: 'run/start',
    data: {
      runId: turn.runId,
      kind: turn.kind,
      assistantMessageId: turn.messageId,
      ...(turn.provider ? { provider: turn.provider } : {}),
      ...(turn.model ? { model: turn.model } : {}),
    },
    surfaceOp: 'append',
  })

  let partIndex = 0
  turn.requests.forEach((request, index) => {
    const requestIndex = index + 1
    const slot = timeline.requests[index]

    if (request.reasoning !== undefined) {
      const at = partIndex++
      line.push({
        time: slot.reasoning!,
        type: 'assistant/chunks',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'reasoning', time0: slot.reasoning!, dt: [0], text: [request.reasoning],
        },
      })
      line.push({
        time: slot.reasoning!,
        type: 'assistant/part-end',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'reasoning', len: request.reasoning.length,
        },
      })
    }
    if (request.text !== undefined) {
      const at = partIndex++
      // 一批 delta:内容与到达时刻都在,fold 出来就是正文。
      const halves = [request.text.slice(0, 2), request.text.slice(2)].filter(Boolean)
      line.push({
        time: slot.text!,
        type: 'assistant/chunks',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'text', time0: slot.text!, dt: halves.map((_, i) => i * 3), text: halves,
        },
      })
      line.push({
        time: slot.text!,
        type: 'assistant/part-end',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'text', len: request.text.length,
        },
      })
    }

    ;(request.tools ?? []).forEach((tool, toolIndex) => {
      const slots = slot.tools[toolIndex]
      const argumentsRaw = JSON.stringify(tool.args)
      if (tool.streamedArgs) {
        const at = partIndex++
        line.push({
          time: slots.inputEnd!,
          type: 'assistant/chunks',
          data: {
            runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
            kind: 'tool-input', toolCallId: tool.callId, time0: slots.inputEnd!,
            dt: [0], text: [argumentsRaw],
          },
        })
        line.push({
          time: slots.inputEnd!,
          type: 'assistant/part-end',
          data: {
            runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
            kind: 'tool-input', toolCallId: tool.callId, len: argumentsRaw.length,
          },
        })
      }
      line.push({
        time: slots.call,
        type: 'tool/call',
        data: { runId: turn.runId, callId: tool.callId, name: tool.name, argumentsRaw, messageId: turn.messageId },
      })
      if (tool.resultText !== undefined) {
        line.push({
          time: slots.result!,
          type: 'tool/result',
          data: {
            runId: turn.runId, callId: tool.callId, isError: Boolean(tool.isError),
            resultPreview: tool.resultText, result: { text: tool.resultText },
          },
          surfaceOp: 'append',
        })
        line.push({
          time: slots.audit!,
          type: 'tool/audit',
          data: {
            runId: turn.runId, callId: tool.callId, toolId: tool.toolId ?? tool.name,
            effects: [], effectCount: 0, outcome: tool.outcome ?? 'ok',
            ...(tool.outcome === 'denied' ? { decision: 'deny' as const, asked: true } : {}),
          },
        })
      }
    })

    if (request.usage) {
      line.push({
        time: slot.response!,
        type: 'request/response',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId,
          usage: { inputTokens: request.usage.inputTokens, outputTokens: request.usage.outputTokens },
        },
      })
    }
  })

  line.push({
    time: timeline.end,
    type: 'run/end',
    data: {
      runId: turn.runId,
      outcome: turn.outcome,
      ...(turn.outcome === 'error' && turn.error ? { error: { message: turn.error } } : {}),
    },
  })
}

// ============================================================================
// 场景骨架
// ============================================================================

interface UserSpec { id: string; content: string; turnContext?: { set?: Record<string, string>; removed?: string[] } }

class Scenario {
  readonly clock = new Clock()
  readonly a = new CommandLine()
  readonly b = new EventLine()
  /** 消息 id → 它在 B 线上的节点 seq(replace 的 range 用)。 */
  readonly nodeSeq = new Map<string, number>()

  user(spec: UserSpec): void {
    const time = this.clock.next()
    const message = { id: spec.id, role: 'user', content: spec.content, timestamp: time }
    this.a.run({ type: 'appendMessage', now: time, message: message as CoreSessionCommandMessage })
    const event = this.b.push({ time, type: 'user/message', data: { message }, surfaceOp: 'append' })
    this.nodeSeq.set(spec.id, event.seq)

    if (spec.turnContext) {
      const at = this.clock.next()
      this.a.run({
        type: 'patchMessage', messageId: spec.id, patch: { turnContext: spec.turnContext } as never, hint: 'settle',
      })
      this.b.push({
        time: at,
        type: 'context/turn-update',
        data: { messageId: spec.id, ...spec.turnContext },
      })
    }
  }

  systemMarker(id: string, content: string): void {
    const time = this.clock.next()
    const message = { id, role: 'system', content, timestamp: time }
    this.a.run({ type: 'appendMessage', now: time, message: message as CoreSessionCommandMessage })
    const event = this.b.push({ time, type: 'system/message', data: { message }, surfaceOp: 'append' })
    this.nodeSeq.set(id, event.seq)
  }

  imported(message: Record<string, unknown>): void {
    const time = this.clock.next()
    this.a.run({ type: 'appendMessage', now: time, message: message as unknown as CoreSessionCommandMessage })
    const event = this.b.push({
      time,
      type: 'message/imported',
      data: { message: message as never },
      surfaceOp: 'append',
    })
    this.nodeSeq.set(String(message.id), event.seq)
  }

  turn(turn: TurnSpec): void {
    const timeline = planTurn(turn, this.clock)
    applyTurnCommands(this.a, turn, timeline)
    const before = this.b.events.length
    emitTurnEvents(this.b, turn, timeline)
    this.nodeSeq.set(turn.messageId, this.b.events[before].seq)
  }

  deleteMessage(messageId: string): void {
    const time = this.clock.next()
    this.a.run({ type: 'deleteMessage', messageId, now: time })
    const seq = this.nodeSeq.get(messageId)!
    this.b.push({
      time,
      type: 'message/deleted',
      data: { messageId },
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
  }

  /** regenerate:连这条一起砍,后面的一并没了。 */
  regenerateFrom(messageId: string): void {
    const time = this.clock.next()
    this.a.run({ type: 'truncateFrom', messageId, inclusive: true, now: time })
    const seq = this.nodeSeq.get(messageId)!
    const shadowed = this.b.surfaceFrom(seq)
    this.b.push({
      time,
      type: 'message/deleted',
      data: { messageId },
      surfaceOp: { op: 'replace', start: shadowed[0], end: shadowed[shadowed.length - 1] },
      sourceEventSeqs: shadowed,
    })
  }

  editResend(messageId: string, newContent: string): void {
    const time = this.clock.next()
    this.a.run({ type: 'truncateFrom', messageId, inclusive: false, newContent, now: time })
    const seq = this.nodeSeq.get(messageId)!
    const shadowed = this.b.surfaceFrom(seq)
    const message = { id: messageId, role: 'user', content: newContent, timestamp: time }
    const event = this.b.push({
      time,
      type: 'user/message-edited',
      data: { messageId, message },
      surfaceOp: { op: 'replace', start: shadowed[0], end: shadowed[shadowed.length - 1] },
      sourceEventSeqs: shadowed,
    })
    this.nodeSeq.set(messageId, event.seq)
  }

  clear(): void {
    const time = this.clock.next()
    this.a.run({ type: 'replaceAll', messages: [], reason: 'clear', now: time })
    const shadowed = this.b.surfaceRange().all
    this.b.push({
      time,
      type: 'session/cleared',
      data: { reason: 'clear' },
      surfaceOp: { op: 'replace', start: shadowed[0], end: shadowed[shadowed.length - 1] },
      sourceEventSeqs: shadowed,
    })
    this.nodeSeq.clear()
  }

  compact(options: { messageId: string; summary: string; throughMessageId: string }): void {
    const time = this.clock.next()
    const count = this.a.session.messages.findIndex(message => message.id === options.throughMessageId) + 1

    // A 线 = 今天 `context-compact.ts` 的三步:追加标记消息、写会话摘要、把
    // 标记消息改成 completed 正文。
    this.a.run({
      type: 'appendMessage',
      now: time,
      message: {
        id: options.messageId,
        role: 'system',
        content: buildContextCompactContent({ status: 'compacting', compactedMessageCount: count, compactedThroughMessageId: options.throughMessageId }),
        timestamp: time,
      } as CoreSessionCommandMessage,
    })
    this.a.session = {
      ...this.a.session,
      summary: options.summary,
      summaryUpToMessageId: options.throughMessageId,
      summaryCreatedAt: time,
    }
    this.a.run({
      type: 'patchMessage',
      messageId: options.messageId,
      hint: 'settle',
      patch: {
        content: buildContextCompactContent({
          status: 'completed', summary: options.summary,
          compactedMessageCount: count, compactedThroughMessageId: options.throughMessageId,
        }),
      } as never,
    })

    // 遮蔽的是"从 surface 开头到切点那个节点(连同它挂着的 tool/result)"。
    const throughSeq = this.nodeSeq.get(options.throughMessageId)!
    const groupEnd = this.b.surfaceGroupEnd(throughSeq, new Set(this.nodeSeq.values()))
    const range = this.b.surfaceThrough(groupEnd)
    const event = this.b.push({
      time,
      type: 'session/compacted',
      data: {
        summary: options.summary,
        messageId: options.messageId,
        compactedMessageCount: count,
        compactedThroughMessageId: options.throughMessageId,
        status: 'completed',
      },
      surfaceOp: { op: 'replace', start: range[0], end: range[range.length - 1] },
      sourceEventSeqs: range,
    })
    this.nodeSeq.set(options.messageId, event.seq)
  }

  get sessionMeta(): { id?: string; summary?: string; summaryUpToMessageId?: string } {
    return {
      id: this.a.session.id,
      ...(this.a.session.summary ? { summary: this.a.session.summary } : {}),
      ...(this.a.session.summaryUpToMessageId ? { summaryUpToMessageId: this.a.session.summaryUpToMessageId } : {}),
    }
  }
}

// ============================================================================
// 断言
// ============================================================================

function historyOf(messages: readonly Record<string, unknown>[], meta: Record<string, unknown>): CoreHistoryMessage[] {
  return buildHistoryMessages(
    messages as unknown as CoreHistoryChatMessage[],
    meta,
    { buildMessageContent: defaultHistoryMessageContent },
  )
}

/**
 * S2a:同一条事件流交给**倒读 pager**,取尾 N 条必须与全量 fold 取尾 N 条逐字段
 * 相同(§11.1 的门)。
 *
 * 放在 `expectEquivalent` 里的理由与 S1b 那行历史指纹一样:分页不是"另一种
 * 投影",而是同一个投影的一个窗口 —— 每条场景都该顺手证一遍,而不是另立一套
 * 场景(那套迟早和这套分叉)。
 */
function expectPagerMatchesFold(events: readonly SessionLogEventRecord[]): void {
  const buffer = new TextEncoder().encode(events.map(encodeSessionLogEventLine).join(''))
  const reader: SessionEventByteReader = {
    size: buffer.length,
    read: (position, length) => buffer.subarray(position, Math.min(buffer.length, position + length)),
  }
  const all = projectChatMessages(events).messages
  for (const limit of [1, 2, 3, all.length, all.length + 5]) {
    if (limit <= 0) continue
    // 小块尺寸是故意的:它逼着倒读走"跨块拼行"的那条路。
    const page = foldEventPageBackward(reader, { limit, chunkSize: 96 })
    expect(page.messages, `tail ${limit}`).toEqual(all.slice(Math.max(0, all.length - limit)))
  }
}

function expectEquivalent(scenario: Scenario): void {
  const projected = projectChatMessages(scenario.b.events)
  expect(canonicalChatMessages(projected.messages as unknown as Record<string, unknown>[]))
    .toEqual(canonicalChatMessages(scenario.a.messages))

  const projectedHistory = projectModelHistory(scenario.b.events, scenario.sessionMeta, {
    buildMessageContent: defaultHistoryMessageContent,
  })
  const builtHistory = historyOf(scenario.a.messages, scenario.sessionMeta)
  expect(projectedHistory).toEqual(builtHistory)
  // S1b:影子期的历史断言用的是**序列化之后的字节**(`canonicalHistoryMessages`)。
  // 这一行让 §9.5 的每一条场景同时成为那道断言的合同 —— 判据换了地方,场景不必
  // 各写一遍。
  expect(canonicalHistoryMessages(projectedHistory)).toBe(canonicalHistoryMessages(builtHistory))
  expectPagerMatchesFold(scenario.b.events)
}

// ============================================================================
// 场景(§9.5 的 12 条)
// ============================================================================

describe('projection contract: command line ≡ event line', () => {
  it('single text turn', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'hello' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send', provider: 'p', model: 'm',
      requests: [{ text: 'hi there', usage: { inputTokens: 10, outputTokens: 4 } }],
      outcome: 'completed',
    })
    expectEquivalent(scenario)
    expect(projectChatMessages(scenario.b.events).messages[1].content).toBe('hi there')
  })

  it('turn with reasoning', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'why?' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{ reasoning: 'thinking hard', text: 'because', usage: { inputTokens: 5, outputTokens: 2 } }],
      outcome: 'completed',
    })
    expectEquivalent(scenario)
    const message = projectChatMessages(scenario.b.events).messages[1]
    // 单轮:整段推理走 `'top'` —— 进字段,**不进** contentParts。
    expect(message.reasoning).toBe('thinking hard')
    expect(message.contentParts).toEqual([{ type: 'text', content: 'because', turnIndex: 1 }])
  })

  /**
   * 真机第一天(§10.9)那两次 `kind:'messages'` 不等的最小复现:一次执行里推理
   * 有**两个落点** —— 第 1 轮开头那段进 `message.reasoning` 字段,工具回来之后
   * 第 2 轮那段进 `contentParts`。投影从前把两段都物化成 part,于是 part 整体
   * 错位一格(事实 11 格 / 投影 12 格)。
   */
  it('reasoning has two landing spots: top goes to the field, post-tool reasoning goes inline', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'check it' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [
        {
          reasoning: 'let me think first',
          text: 'looking',
          tools: [{ callId: 'c1', name: 'read', args: { path: '/a' }, resultText: 'body', outcome: 'ok' }],
        },
        { reasoning: 'now I know', text: ' done' },
      ],
      outcome: 'completed',
    })
    expectEquivalent(scenario)

    const message = projectChatMessages(scenario.b.events).messages[1]
    expect(message.reasoning).toBe('let me think first')
    expect(message.contentParts).toEqual([
      { type: 'text', content: 'looking', turnIndex: 1 },
      { type: 'reasoning', content: 'now I know', turnIndex: 2 },
      { type: 'text', content: ' done', turnIndex: 2 },
    ])
    // 正文本身不受落点影响:两轮 text 仍然按 partIndex fold。
    expect(message.content).toBe('looking done')
  })

  it('two-request tool loop including a denied permission', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'do it' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [
        {
          text: 'let me look',
          usage: { inputTokens: 10, outputTokens: 5 },
          tools: [
            { callId: 'c1', name: 'read', args: { path: '/a' }, resultText: 'file body', outcome: 'ok', streamedArgs: true },
            { callId: 'c2', name: 'bash', args: { command: 'rm -rf /' }, resultText: 'denied by user', isError: true, outcome: 'denied' },
          ],
        },
        { text: ' done', usage: { inputTokens: 20, outputTokens: 3 } },
      ],
      outcome: 'completed',
    })
    expectEquivalent(scenario)

    const message = projectChatMessages(scenario.b.events).messages[1]
    expect(message.toolCalls?.map(call => call.status)).toEqual(['completed', 'failed'])
    expect(message.toolCalls?.[1].rejected).toBe(true)
    // 流式参数在 `tool/call` 到达后撤下 —— 参数真相只有 argumentsRaw 一份。
    expect(message.toolCalls?.[0].streamingArgs).toBeUndefined()
    expect(message.toolCalls?.[0].receivedAt).toBeDefined()
    expect(message.usage).toEqual({ inputTokens: 30, outputTokens: 8, totalTokens: 38 })
    expect(message.steps?.map(step => step.turnIndex)).toEqual([1, 1])
  })

  it('abort mid-turn leaves the running tool cancelled', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'go' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{ text: 'starting', tools: [{ callId: 'c1', name: 'bash', args: { command: 'sleep 100' } }] }],
      outcome: 'aborted',
    })
    expectEquivalent(scenario)
    const message = projectChatMessages(scenario.b.events).messages[1]
    expect(message.isStreaming).toBeUndefined()
    expect(message.toolCalls?.[0].status).toBe('cancelled')
    expect(message.steps?.[0].status).toBe('cancelled')
  })

  it('regenerate drops the old assistant turn', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'q' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{ text: 'first answer', usage: { inputTokens: 4, outputTokens: 2 } }],
      outcome: 'completed',
    })
    scenario.regenerateFrom('a1')
    scenario.turn({
      runId: 'r2', messageId: 'a2', kind: 'retry',
      requests: [{ text: 'second answer', usage: { inputTokens: 4, outputTokens: 3 } }],
      outcome: 'completed',
    })
    expectEquivalent(scenario)
    expect(projectChatMessages(scenario.b.events).messages.map(m => m.id)).toEqual(['u1', 'a2'])
  })

  it('edit-and-resend rewrites the user message and truncates after it', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'first ask' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{ text: 'answer one' }], outcome: 'completed',
    })
    scenario.editResend('u1', 'second ask')
    scenario.turn({
      runId: 'r2', messageId: 'a2', kind: 'edit-resend',
      requests: [{ text: 'answer two' }], outcome: 'completed',
    })
    expectEquivalent(scenario)
    const messages = projectChatMessages(scenario.b.events).messages
    expect(messages.map(m => m.id)).toEqual(['u1', 'a2'])
    expect(messages[0].content).toBe('second ask')
  })

  it('deleting a message in the middle hides it on both lines', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'one' })
    scenario.turn({ runId: 'r1', messageId: 'a1', kind: 'send', requests: [{ text: 'reply one' }], outcome: 'completed' })
    scenario.user({ id: 'u2', content: 'two' })
    scenario.turn({ runId: 'r2', messageId: 'a2', kind: 'send', requests: [{ text: 'reply two' }], outcome: 'completed' })
    scenario.deleteMessage('a1')
    expectEquivalent(scenario)
    expect(projectChatMessages(scenario.b.events).messages.map(m => m.id)).toEqual(['u1', 'u2', 'a2'])
  })

  it('compact keeps the UI messages and folds only the model history', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'one' })
    scenario.turn({ runId: 'r1', messageId: 'a1', kind: 'send', requests: [{ text: 'reply one' }], outcome: 'completed' })
    scenario.user({ id: 'u2', content: 'two' })
    scenario.turn({ runId: 'r2', messageId: 'a2', kind: 'send', requests: [{ text: 'reply two' }], outcome: 'completed' })
    scenario.compact({ messageId: 'k1', summary: '## Goal\nship it', throughMessageId: 'a1' })
    scenario.user({ id: 'u3', content: 'three' })
    scenario.turn({ runId: 'r3', messageId: 'a3', kind: 'send', requests: [{ text: 'reply three' }], outcome: 'completed' })

    expectEquivalent(scenario)

    // UI:被压掉的两条**照旧显示**,外加那张压缩卡。
    expect(projectChatMessages(scenario.b.events).messages.map(m => m.id))
      .toEqual(['u1', 'a1', 'u2', 'a2', 'k1', 'u3', 'a3'])
    // 模型历史:摘要 + 切点之后的。
    const history = projectModelHistory(scenario.b.events, scenario.sessionMeta, {
      buildMessageContent: defaultHistoryMessageContent,
    })
    expect(history).toHaveLength(5)
    expect(String((history[0] as { content: string }).content)).toContain('<summary>')
  })

  it('collab clear wipes both lines and keeps writing after it', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'before' })
    scenario.turn({ runId: 'r1', messageId: 'a1', kind: 'send', requests: [{ text: 'x' }], outcome: 'completed' })
    scenario.clear()
    scenario.user({ id: 'u2', content: 'after' })
    scenario.turn({ runId: 'r2', messageId: 'a2', kind: 'send', requests: [{ text: 'y' }], outcome: 'completed' })
    expectEquivalent(scenario)
    expect(projectChatMessages(scenario.b.events).messages.map(m => m.id)).toEqual(['u2', 'a2'])
  })

  it('system markers come and go', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'hi' })
    scenario.systemMarker('sys1', '[[collab-membership]] joined')
    scenario.systemMarker('sys2', '[[task]] started')
    scenario.deleteMessage('sys1')
    expectEquivalent(scenario)
    expect(projectChatMessages(scenario.b.events).messages.map(m => m.id)).toEqual(['u1', 'sys2'])
  })

  it('imported legacy messages pass through verbatim', () => {
    const scenario = new Scenario()
    scenario.imported({ id: 'old-u', role: 'user', content: 'legacy ask', timestamp: 1 })
    scenario.imported({
      id: 'old-a',
      role: 'assistant',
      content: 'legacy answer',
      timestamp: 2,
      reasoning: 'legacy reasoning',
      thinkingTime: 3,
      skillUsed: 'agent-plan',
      toolCalls: [{
        id: 'oc1', toolId: 'read', toolName: 'read', arguments: { path: '/x' },
        status: 'completed', result: 'ok', timestamp: 2,
      }],
      steps: [{
        id: 'os1', type: 'tool-call', title: '查看 /x', status: 'completed',
        timestamp: 2, turnIndex: 1, toolCallId: 'oc1',
      }],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    })
    expectEquivalent(scenario)
    // 原样 = 连事件里没有来源的字段(thinkingTime / skillUsed / step 标题)都在。
    const message = projectChatMessages(scenario.b.events).messages[1]
    expect(message.skillUsed).toBe('agent-plan')
    expect((message.steps as unknown as ProjectedStep[])[0].title).toBe('查看 /x')
  })

  it('chained surface replace: compact then edit an already-compacted session', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'one' })
    scenario.turn({ runId: 'r1', messageId: 'a1', kind: 'send', requests: [{ text: 'reply one' }], outcome: 'completed' })
    scenario.user({ id: 'u2', content: 'two' })
    scenario.turn({ runId: 'r2', messageId: 'a2', kind: 'send', requests: [{ text: 'reply two' }], outcome: 'completed' })
    scenario.compact({ messageId: 'k1', summary: '## Goal\nship it', throughMessageId: 'a1' })
    scenario.editResend('u2', 'two, revised')
    scenario.turn({ runId: 'r3', messageId: 'a3', kind: 'edit-resend', requests: [{ text: 'reply revised' }], outcome: 'completed' })

    expectEquivalent(scenario)

    const history = projectModelHistory(scenario.b.events, scenario.sessionMeta, {
      buildMessageContent: defaultHistoryMessageContent,
    })
    // 摘要仍在(它不是消息,删不掉),后面是改写过的那一问一答。
    expect(String((history[0] as { content: string }).content)).toContain('ship it')
    expect(history).toHaveLength(3)
  })

  it('turn context lands on the user message and replays into history', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'hello', turnContext: { set: { variables: 'cwd=/tmp' } } })
    scenario.turn({ runId: 'r1', messageId: 'a1', kind: 'send', requests: [{ text: 'hi' }], outcome: 'completed' })
    expectEquivalent(scenario)

    const history = projectModelHistory(scenario.b.events, scenario.sessionMeta, {
      buildMessageContent: defaultHistoryMessageContent,
    })
    expect(String((history[0] as { content: string }).content)).toContain('<context-update>')
    expect(String((history[0] as { content: string }).content)).toContain('cwd=/tmp')
  })
})

// ============================================================================
// SurfaceIndex
// ============================================================================

describe('SurfaceIndex', () => {
  const events: SessionLogEventRecord[] = [
    { seq: 1, time: 1, type: 'user/message', data: { message: { id: 'u1', role: 'user' } }, surfaceOp: 'append' },
    { seq: 2, time: 2, type: 'run/start', data: { runId: 'r1', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' },
    { seq: 3, time: 3, type: 'tool/result', data: { callId: 'c1', isError: false, resultPreview: 'x' }, surfaceOp: 'append' },
    { seq: 4, time: 4, type: 'user/message', data: { message: { id: 'u2', role: 'user' } }, surfaceOp: 'append' },
    {
      seq: 5, time: 5, type: 'session/compacted',
      data: { summary: 's', messageId: 'k1', compactedMessageCount: 2 },
      surfaceOp: { op: 'replace', start: 1, end: 3 }, sourceEventSeqs: [1, 2, 3],
    },
  ]

  it('folds and pushes to the same result', () => {
    const folded = foldSurface(events)
    const index = new SurfaceIndex()
    for (const event of events) index.push(event)
    expect(index.snapshot()).toEqual(folded)
    expect(folded.order).toEqual([5, 4])
    expect(folded.shadowed).toEqual([1, 2, 3])
    expect(folded.violations).toEqual([])
  })

  it('flags a replace whose range is not on the surface', () => {
    const bad = foldSurface([
      events[0],
      { seq: 2, time: 2, type: 'message/deleted', data: { messageId: 'nope' }, surfaceOp: { op: 'replace', start: 99, end: 99 }, sourceEventSeqs: [99] },
    ])
    expect(bad.violations.map(v => v.reason)).toEqual(['replace-start-missing'])
  })

  it('flags a replace that forgot to declare what it shadows', () => {
    const bad = foldSurface([
      events[0], events[1],
      { seq: 3, time: 3, type: 'session/cleared', data: { reason: 'clear' }, surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1] },
    ])
    expect(bad.violations.map(v => v.reason)).toEqual(['source-seqs-incomplete'])
  })
})

// ============================================================================
// 增量:fold 一次 ≡ 一条一条推
// ============================================================================

describe('incremental projection', () => {
  it('pushing events one at a time equals folding them all', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'one' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{ reasoning: 'hmm', text: 'reply', usage: { inputTokens: 3, outputTokens: 1 }, tools: [{ callId: 'c1', name: 'read', args: {}, resultText: 'r', outcome: 'ok' }] }],
      outcome: 'completed',
    })
    scenario.user({ id: 'u2', content: 'two' })
    scenario.compact({ messageId: 'k1', summary: '## Goal\nx', throughMessageId: 'a1' })

    const whole = projectChatMessages(scenario.b.events)

    let state = createSessionProjectionState()
    const seen: SessionLogEventRecord[] = []
    for (const event of scenario.b.events) {
      state = reduceSessionProjection(state, event)
      seen.push(event)
      // 每一步都要与"只到这里为止的 fold"相同 —— 尾部 patch 写错会在中途就红。
      expect(canonicalChatMessages(projectChatMessages(seen).messages as unknown as Record<string, unknown>[]))
        .toEqual(canonicalChatMessages(projectChatMessages(scenario.b.events, { upToSeq: event.seq }).messages as unknown as Record<string, unknown>[]))
    }
    expect(state.surface.snapshot()).toEqual(foldSurface(scenario.b.events))
    expect(whole.messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'k1'])
  })

  it('reports the active run while a turn is open', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'go' })
    scenario.turn({ runId: 'r1', messageId: 'a1', kind: 'send', requests: [{ text: 'partial' }], outcome: 'completed' })
    const beforeEnd = scenario.b.events.filter(event => event.type !== 'run/end')
    const live = projectChatMessages(beforeEnd)
    expect(live.activeRun).toEqual({ runId: 'r1', messageId: 'a1' })
    expect(live.messages[1].isStreaming).toBe(true)
    expect(projectChatMessages(scenario.b.events).activeRun).toBeUndefined()
  })
})

// ============================================================================
// S1a:投影侧补齐的派生规则(§10.1 G1–G9)
//
// 这一组**只跑 B 线**,而且是故意的:G1–G9 补的正是"事件里有、命令线里没有
// 来源"的那些格(技能、审批理由、孤儿参数流、子步骤、思考时长、压缩预算)。
// 拿命令线去比它们只会得到一条恒真的等式 —— 那正是审查 B7 点名的病。
// ============================================================================

function eventLine(): EventLine {
  return new EventLine()
}

describe('S1a projection catch-up (G1–G9)', () => {
  it('G2: the step title is derived, never carried on the event', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2,
      type: 'tool/call',
      data: { runId: 'r', callId: 'c1', name: 'bash', argumentsRaw: '{"command":"npm test"}', messageId: 'a1' },
    })

    const step = projectChatMessages(line.events).messages[0].steps?.[0]
    // 与引擎实时那一份(`createToolExecutionStep`)同源:`generateStepTitle`。
    expect(step?.title).toBe('Run: npm test')
    // G1:id 是派生的,与 toolCallId 一一对应。
    expect(step?.id).toBe('step-c1')
  })

  it('G3: parentCallId builds childSteps instead of a flat list', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({ time: 2, type: 'tool/call', data: { runId: 'r', callId: 'parent', name: 'task', argumentsRaw: '{}', messageId: 'a1' } })
    line.push({ time: 3, type: 'tool/call', data: { runId: 'r', callId: 'child', name: 'read', argumentsRaw: '{}', messageId: 'a1', parentCallId: 'parent' } })

    const message = projectChatMessages(line.events).messages[0]
    expect(message.steps?.map(step => step.toolCallId)).toEqual(['parent'])
    expect(message.steps?.[0].childSteps?.map(step => step.toolCallId)).toEqual(['child'])
    // 子调用也不在顶层 toolCalls 里重复一格。
    expect(message.toolCalls?.map(call => call.id)).toEqual(['parent'])
  })

  it('G5: skill/activated lands on the message, and thinkingTime is derived from the reasoning span', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({ time: 2, type: 'request/start', data: { runId: 'r', requestIndex: 1, messageId: 'a1' } })
    line.push({
      time: 3,
      type: 'assistant/chunks',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'reasoning', time0: 1000, dt: [0, 250, 900], text: ['a', 'b', 'c'] },
    })
    line.push({ time: 4, type: 'skill/activated', data: { runId: 'r', messageId: 'a1', skill: 'agent-plan' } })

    const message = projectChatMessages(line.events).messages[0]
    expect(message.skillUsed).toBe('agent-plan')
    // 首尾差:1900 − 1000。只记时刻,时长是消费者算的。
    expect(message.thinkingTime).toBe(900)
  })

  it('G5: with no reasoning, thinkingTime falls back to the first-token wait', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({ time: 100, type: 'request/start', data: { runId: 'r', requestIndex: 1, messageId: 'a1' } })
    line.push({ time: 420, type: 'assistant/first-token', data: { runId: 'r', requestIndex: 1, messageId: 'a1' } })

    expect(projectChatMessages(line.events).messages[0].thinkingTime).toBe(320)
  })

  it('G6: a denied permission carries its reason onto the tool call and the step', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    // 审批常常**早于** tool/call(权限在 plan 之后、apply 之前问)。
    line.push({ time: 2, type: 'permission/asked', data: { requestId: 'p1', runId: 'r', toolCallId: 'c1', toolName: 'bash' } })
    line.push({ time: 3, type: 'permission/answered', data: { requestId: 'p1', runId: 'r', toolCallId: 'c1', approved: false, reason: '太危险了' } })
    line.push({ time: 4, type: 'tool/call', data: { runId: 'r', callId: 'c1', name: 'bash', argumentsRaw: '{"command":"rm -rf /"}', messageId: 'a1' } })
    line.push({ time: 5, type: 'tool/result', data: { runId: 'r', callId: 'c1', isError: true, resultPreview: 'denied', result: { text: 'denied' } } })
    line.push({ time: 6, type: 'tool/audit', data: { runId: 'r', callId: 'c1', toolId: 'bash', effects: ['bash'], effectCount: 1, outcome: 'denied' } })

    const message = projectChatMessages(line.events).messages[0]
    expect(message.toolCalls?.[0]).toMatchObject({ rejected: true, rejectionReason: '太危险了' })
    expect(message.steps?.[0]).toMatchObject({ rejected: true, rejectionReason: '太危险了' })
  })

  it('G7: an orphan tool-input part becomes an input-streaming placeholder', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2,
      type: 'assistant/chunks',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'tool-input', toolCallId: 'c1', time0: 10, dt: [0], text: ['{"path":"'] },
    })

    const live = projectChatMessages(line.events).messages[0]
    expect(live.toolCalls).toEqual([
      expect.objectContaining({ id: 'c1', status: 'input-streaming', streamingArgs: '{"path":"' }),
    ])
    // 参数流不进 contentParts —— 它喂的是 toolCalls 那一路。
    expect(live.contentParts).toBeUndefined()

    // run 非正常收尾之后,那条永远等不到调用的参数流转 cancelled。
    line.push({ time: 3, type: 'run/end', data: { runId: 'r', outcome: 'aborted' } })
    expect(projectChatMessages(line.events).messages[0].toolCalls?.[0].status).toBe('cancelled')
  })

  it('G8: a BlobRef attachment is resolved by the host, and dropped when it cannot be', () => {
    const line = eventLine()
    line.push({
      time: 1,
      type: 'user/message',
      data: {
        message: {
          id: 'u1', role: 'user', content: 'look',
          attachments: [{ id: 'att1', fileName: 'a.png', mimeType: 'image/png', base64Data: { hash: 'deadbeef', bytes: 4 } }],
        },
      },
      surfaceOp: 'append',
    })

    const resolved = projectModelHistory(line.events, {}, {
      buildMessageContent: (message: CoreHistoryChatMessage) =>
        JSON.stringify((message as unknown as { attachments?: unknown[] }).attachments ?? []),
      resolveBlob: () => 'BASE64',
    })
    expect(resolved[0].content).toContain('BASE64')

    // 拿不到正文就把那一格**摘掉** —— 绝不让 `{hash,bytes}` 当成 base64 发出去。
    const dropped = projectModelHistory(line.events, {}, {
      buildMessageContent: (message: CoreHistoryChatMessage) =>
        JSON.stringify((message as unknown as { attachments?: unknown[] }).attachments ?? []),
    })
    expect(dropped[0].content).toBe('[]')
  })

  it('G9: a compacted surface switches the tool-result budget to the tighter one', () => {
    const big = 'x'.repeat(120_000)
    const build = (withCompact: boolean): CoreHistoryMessage[] => {
      const line = eventLine()
      const user = line.push({ time: 1, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: 'go' } }, surfaceOp: 'append' })
      if (withCompact) {
        line.push({
          time: 2,
          type: 'session/compacted',
          data: { summary: '## Goal\nx', messageId: 'k1', compactedMessageCount: 1, compactedThroughMessageId: 'u1', status: 'completed' },
          surfaceOp: { op: 'replace', start: user.seq, end: user.seq },
          sourceEventSeqs: [user.seq],
        })
      }
      line.push({ time: 3, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
      line.push({ time: 4, type: 'tool/call', data: { runId: 'r', callId: 'c1', name: 'read', argumentsRaw: '{}', messageId: 'a1' } })
      line.push({ time: 5, type: 'tool/result', data: { runId: 'r', callId: 'c1', isError: false, resultPreview: 'big', result: { text: big } }, surfaceOp: 'append' })
      line.push({ time: 6, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })
      return projectModelHistory(line.events, {}, { buildMessageContent: defaultHistoryMessageContent })
    }

    const plain = JSON.stringify(build(false)).length
    const compacted = JSON.stringify(build(true)).length
    // 压缩之后的尾部走 24k/80k 的紧预算,而不是 200k/600k。
    expect(compacted).toBeLessThan(plain)
  })
})
