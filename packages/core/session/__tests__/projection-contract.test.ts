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

import {
  CORE_ABORTED_TOOL_ERROR,
  finalizeLingeringAgentLoopToolWork,
} from '../../engine/agent-loop-executor.js'
import {
  coreToolInputStartStepTitle,
  createCoreToolInputStartArtifacts,
} from '../../engine/stream-processor.js'
import { buildHistoryMessages } from '../../engine/history.js'
import { detectSkillUsage, getStepType } from '../../engine/tool-step.js'
import type { CoreHistoryChatMessage, CoreHistoryMessage } from '../../engine/history.js'
import { buildContextCompactContent } from '../../engine/context-compact.js'
import { applySessionCommand } from '../commands.js'
import {
  CORE_INTERRUPTED_PERMISSION_ERROR,
  CORE_INTERRUPTED_TOOL_ERROR,
} from '../interrupted.js'
import { computeInterruptedStepRepair, computeSessionRepairOnLoad } from '../timeline.js'
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
  foldSessionProjection,
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
  /**
   * 引擎**归一之后**的显示名(`resolveToolIdentity().displayName`)。消息上那一格
   * (`toolCall.toolName`)就是它,`getStepType` / `detectSkillUsage` 读的也是它。
   */
  name: string
  /**
   * A6+A7(§13.1):模型写在 wire 上的那个名字。与 `name` 不同就说明中间过了
   * 一次归一(别名表 / MCP 折成服务器名)—— 账本上两格并列,投影必须取归一后
   * 的那一格。缺省 = 与 `name` 相同(绝大多数工具)。
   */
  rawName?: string
  toolId?: string
  args: Record<string, unknown>
  /** 结果正文;缺席 = 这次调用没有结果(abort / 还在跑)。 */
  resultText?: string
  isError?: boolean
  outcome?: 'ok' | 'denied' | 'failed' | 'aborted'
  /** 参数是流式来的:多一条 `assistant/chunks{kind:'tool-input'}` + part-end。 */
  streamedArgs?: boolean
  /**
   * **孤儿参数流**(G7 / §10.14 第 7 类):参数流到一半就收场了,`tool/call`
   * 永远不会来。引擎留下的是 `createCoreToolInputStartArtifacts` 那一对占位
   * (调用 + step),收场时由 `finalizeLingeringAgentLoopToolWork` 判死。
   * A 线直接调那两个引擎函数 —— 派生字段不许在 fixture 里手写(§10.10)。
   */
  orphan?: boolean
  /**
   * §13.8 第一类:**派工出去了,结局却是收场修复写的** —— 用户按停止 / 请求
   * 最终出错时,工具永远不会报 `tool-result`。但它在执行途中已经在 step 上留下
   * 了东西:这一格就是那时的 `step.result`(工具的 `annotate{metadata}` 变成
   * `JSON.stringify(metadata)`,或最后一次 partial 的正文),而 `reportedTitle`
   * 是它自报的标题。两格在真机上都存在(`sleep 20` / `提问已取消`),而账本上
   * 从前一个字都没有。
   *
   * 与 `orphan` 的分界:那一条是**参数流没写完**(`tool/call` 都不会来),
   * 这一条是参数定稿、工具已经在跑。
   */
  inFlightResult?: string
  /**
   * 工具的**结构化**结局(`ToolCall.result` 的正身)。成功时是
   * `{title, output, metadata}`,失败时是 `{success:false, error}` —— 两种都写进
   * `toolCall.result`,引擎那一份是 `toJsonValue(result.data ?? result.content)`,
   * 不看成败(§10.12 第 6 类)。
   */
  resultData?: Record<string, unknown>
  /**
   * 工具自报的标题(`annotate{title}` 的最后一条)。引擎当场拿它盖掉 step 标题,
   * 所以两条线都以它为准 —— **失败的调用只有它**(结局对象里没有 title)。
   */
  reportedTitle?: string
  /**
   * §13.17:edit/write 的结构化 diff(`CoreToolCallChangesLike`)。引擎把它写在
   * `toolCall.changes`(顶层 = step.toolCall 同引用),事件面记在
   * `tool/result.changes` —— 结局正文派生不出 hunks。不含 originalContent。
   */
  changes?: Record<string, unknown>
}

interface RequestSpec {
  reasoning?: string
  text?: string
  /**
   * A1(§13.1):这一轮中途来了一块 provider-data(Claude 的思考签名 / codex 的
   * 加密推理)。引擎把它落成 `contentParts` 的一格,**并且它是一条分段边界** ——
   * `appendOrderedPart` 只合并相邻同类,所以 `text` 与 `textAfter` 会被切成两格。
   */
  providerData?: Record<string, unknown>
  /** provider-data 之后的那一段正文(验分段:text → provider-data → text = 3 格)。 */
  textAfter?: string
  tools?: ToolSpec[]
  usage?: { inputTokens: number; outputTokens: number }
  /**
   * 这一轮**没走到** `turn-end`(用户 abort / 请求出错)。
   *
   * 引擎只在那一刻把这一轮的 part 落到消息上(`persistTurnContentParts`),
   * 所以走不到的那一轮:`contentParts` 一格都没有,`request/response` 与
   * `request/end` 两条事件也都没有。正文与 top 推理照旧有 —— 它们是实时写
   * 字段的另外两条路(§10.14 第 7 类)。
   */
  unfinished?: boolean
  /**
   * §13.9:这一次请求里的**轮分界**(外部执行器 = Claude Code SDK 连接器)。
   *
   * 连接器把一整段多轮会话装进一次 `streamTurn`:工具结果到齐、新一轮正文开始
   * 时它发一条 `finish(tool_calls)`,runner 当场转发,引擎于是
   * ① 把这一轮的 part 落到消息上、换一份 turn state,② **回合号 +1** ——
   * 而 `requestIndex` 一动不动(`turn-start` 只来过一次)。
   *
   * 所以这一格描述的是"工具之后的那几段输出属于下一个回合",而这一次请求的
   * usage(带 usage 的是**最后**那条 finish)也落在下一个回合上 —— 工具那个
   * 回合的 step 因此一格 usage 都没有。真机 `web-14d8bc3f` 逐格如此。
   *
   * 只写在**最后一次**请求上:一次请求里有分界、后面还有第二次请求这种组合在
   * 生产里不存在(外部执行器一次执行只发一次请求),fixture 不去描述它。
   */
  roundBoundary?: {
    text?: string
    providerData?: Record<string, unknown>
    /** 分界之后**又**调了工具(外部执行器多轮工具的常态):同一次请求,下一个回合。 */
    tools?: ToolSpec[]
  }
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
  /**
   * §13.9:助手占位消息上的 `source`(`stampCollabAgentId` 在 room / agent 形态的
   * 会话上盖的那格 `'collab-turn'`)。A 线盖在消息上,B 线记在 `run/start` 里。
   */
  messageSource?: string
  /**
   * steering:这条 run **接着**那条 run 的执行往下跑(§10.12 第 5 类)。
   *
   * 换的是助手消息、不是执行 —— 回合号接着数(所以新消息开头那段推理是
   * `inline` 不是 `top`),用量累加器接着加,而总量只落在**接手的**这条消息上。
   */
  continuesRunId?: string
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
    // 没有结局的那一次:**执行中**。判死是收场那一刻由
    // `finalizeLingeringAgentLoopToolWork` 干的事(它连 `error` 一起写),
    // fixture 直接写 `'cancelled'` 会把那次修复整个跳过 —— 又一处"fixture 抢先
    // 写下结论"的空转(§10.14 第 7 类)。
    spec.resultText === undefined
      ? 'executing'
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
  // 引擎:`result: toJsonValue(result.data ?? result.content)` —— 成败都写,
  // 结构化那一份优先;`error` 只有失败才有,两格并存(§10.12 第 6 类)。
  if (spec.resultData !== undefined) call.result = spec.resultData
  else if (spec.resultText !== undefined && !spec.isError) call.result = spec.resultText
  if (spec.isError && spec.resultText !== undefined) call.error = spec.resultText
  if (spec.outcome === 'denied') call.rejected = true
  // §13.17:引擎把结构化 diff 写在 toolCall.changes(step.toolCall 同引用)。
  if (spec.changes !== undefined) call.changes = spec.changes
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
    // A 线也照引擎实时那一份算 type(`tool-execution.ts` → `getStepType`)。
    // 从前这里写死 'tool-call',于是 bash 的 command/file-read/skill-read 在合同上是空的。
    //
    // S3.1(§10.11):算的是**最终参数**。引擎那一份从前把它冻在占位时刻
    // (`tool_input_start` 参数还是 `{}`,bash 只能是 command),真机影子第一类
    // mismatch 就是它 —— 已按"修引擎不供养怪癖"在引擎侧改口,合同这一格不动。
    type: getStepType(spec.name, spec.args as Parameters<typeof getStepType>[1]),
    // 生产里活着的那条路只有两步:占位标题(`调用工具: X`),外加工具自报的
    // `annotate{title}` 当场盖掉它。**没有** `generateStepTitle` 这一步 ——
    // 它只在旧编排器里,而旧编排器在生产里已经没有构造点(§10.11 尾巴第 3 条)。
    // 一个不自报标题的工具因此永远停在占位标题(§10.14 第 8 类)。
    title: spec.reportedTitle
      ?? (typeof spec.resultData?.title === 'string' ? spec.resultData.title : undefined)
      ?? coreToolInputStartStepTitle(spec.name),
    status:
      toolCall.status === 'completed' ? 'completed'
        : toolCall.status === 'failed' ? 'failed'
          : toolCall.status === 'cancelled' ? 'cancelled'
            : toolCall.status === 'executing' ? 'running'
              : 'pending',
    timestamp,
    turnIndex,
    toolCallId: spec.callId,
    toolCall,
  }
  // 引擎的 `stepUpdate`:`result: resultText(result)`(失败时它**就是** error 那句
  // 话)、`error: result.error`。两格并存,不是二选一。
  if (spec.resultText !== undefined) step.result = spec.resultText
  // §13.8 第一类:执行途中已经写下的那一格(收场修复不动它,只加 status + error)。
  else if (spec.inFlightResult !== undefined) step.result = spec.inFlightResult
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
    providerData?: number
    textAfter?: number
    response?: number
    tools: Array<{ inputEnd?: number; call: number; result?: number; audit?: number }>
    /** §13.9:轮分界之后那几段的时刻(它们排在工具之后)。 */
    boundaryTools?: Array<{ inputEnd?: number; call: number; result?: number; audit?: number }>
    boundaryText?: number
    boundaryProviderData?: number
  }>
  end: number
}

function planTurn(turn: TurnSpec, clock: Clock): TurnTimeline {
  const start = clock.next()
  const requests = turn.requests.map(request => ({
    ...(request.reasoning !== undefined ? { reasoning: clock.next() } : {}),
    ...(request.text !== undefined ? { text: clock.next() } : {}),
    ...(request.providerData !== undefined ? { providerData: clock.next() } : {}),
    ...(request.textAfter !== undefined ? { textAfter: clock.next() } : {}),
    ...(request.usage ? { response: clock.next() } : {}),
    tools: (request.tools ?? []).map(tool => ({
      ...(tool.streamedArgs || tool.orphan ? { inputEnd: clock.next() } : {}),
      call: clock.next(),
      ...(tool.resultText !== undefined ? { result: clock.next(), audit: clock.next() } : {}),
    })),
    // 分界之后 —— 时刻当然排在工具之后。
    ...(request.roundBoundary?.tools
      ? {
          boundaryTools: request.roundBoundary.tools.map(tool => ({
            ...(tool.streamedArgs || tool.orphan ? { inputEnd: clock.next() } : {}),
            call: clock.next(),
            ...(tool.resultText !== undefined ? { result: clock.next(), audit: clock.next() } : {}),
          })),
        }
      : {}),
    ...(request.roundBoundary?.text !== undefined ? { boundaryText: clock.next() } : {}),
    ...(request.roundBoundary?.providerData !== undefined
      ? { boundaryProviderData: clock.next() }
      : {}),
  }))
  return { start, requests, end: clock.next() }
}

/**
 * 一次**执行**跨到这条 run 上时带过来的东西(steering,§10.12 第 5 类)。
 * `turns` = 被接手的那条 run 已经跑过几轮请求,`usage` = 累加器当时的值。
 */
interface CarriedExecution {
  turns: number
  usage?: ProjectedStepUsage
}

function applyTurnCommands(
  line: CommandLine,
  turn: TurnSpec,
  timeline: TurnTimeline,
  carried: CarriedExecution = { turns: 0 },
): { usage?: ProjectedStepUsage } {
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
      ...(turn.messageSource ? { source: turn.messageSource } : {}),
    } as CoreSessionCommandMessage,
  })

  let text = ''
  let reasoning = ''
  const toolCalls: ProjectedToolCall[] = []
  let usage: ProjectedStepUsage | undefined = carried.usage

  turn.requests.forEach((request, index) => {
    // 回合号是**执行**级的:steering 换消息时接着数(引擎的 turnIndex 一格不重置)。
    const turnIndex = carried.turns + index + 1
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
      } else if (!request.unfinished) {
        // `inline` 的推理只有一个落点:turn-end 的 `persistTurnContentParts`。
        // 走不到那一刻就一格都没有(top 那一支是实时写字段的,照旧有)。
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
      if (!request.unfinished) {
        line.run({
          type: 'appendContentPart',
          messageId: turn.messageId,
          part: { type: 'text', content: request.text, turnIndex },
        })
      }
    }
    if (request.providerData !== undefined && !request.unfinished) {
      // 引擎:`applyAgentLoopProviderDataWithAdapters` → `appendOrderedPart`。
      // 它不进 `message.content`(不是正文),只占 contentParts 的一格。
      line.run({
        type: 'appendContentPart',
        messageId: turn.messageId,
        part: { type: 'provider-data', providerData: request.providerData, turnIndex },
      })
    }
    if (request.textAfter !== undefined) {
      text += request.textAfter
      line.run({ type: 'patchMessage', messageId: turn.messageId, patch: { content: text } as never, hint: 'stream' })
      if (!request.unfinished) {
        line.run({
          type: 'appendContentPart',
          messageId: turn.messageId,
          part: { type: 'text', content: request.textAfter, turnIndex },
        })
      }
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
      // 注意:**这里不写消息上的 usage**。引擎只在整次执行收尾时写一次
      // (`updateUsage` → `store.updateMessageUsage(ctx.assistantMessageId, 累加器)`),
      // 落点是那一刻的助手消息 —— steering 之后就是接手的那条。由 `Scenario`
      // 在执行真正收尾时补(`flushPendingExecutionUsage`)。
    }

    const runTools = (
      tools: readonly ToolSpec[],
      slotsList: TurnTimeline['requests'][number]['tools'],
      toolTurnIndex: number,
    ): void => tools.forEach((tool, toolIndex) => {
      const slots = slotsList[toolIndex]
      if (tool.orphan) {
        // 引擎本人建的那一对占位(`tool_input_start` 那一刻,参数还是 `{}`)。
        // fixture 不手写它们的 type / title / status —— 那正是 §10.10 立下的规矩。
        const { placeholderToolCall, placeholderStep } = createCoreToolInputStartArtifacts({
          toolCallId: tool.callId,
          resolved: { toolId: tool.toolId ?? tool.name, displayName: tool.name },
          stepId: `step-${tool.callId}`,
          rawToolName: tool.name,
          turnIndex: toolTurnIndex,
          timestamp: slots.inputEnd ?? slots.call,
        })
        toolCalls.push(placeholderToolCall as unknown as ProjectedToolCall)
        line.run({
          type: 'setToolCalls',
          messageId: turn.messageId,
          toolCalls: toolCalls.map(entry => ({ ...entry })) as never,
        })
        line.run({ type: 'upsertStep', messageId: turn.messageId, step: placeholderStep as never })
        return
      }
      const call = toolCallOf(tool, slots.call, slots.inputEnd)
      // S3.1(§10.11):技能识别**一个判定点、两个落点**。引擎在参数定稿那一刻认
      // 一次并宣告(`startAgentLoopToolExecution`),宿主同时落消息上的 `skillUsed`
      // 与账本上的 `skill/activated`。A 线落前者,B 线落后者 —— 判据是同一个函数。
      const skill = detectSkillUsage(tool.name, tool.args as Parameters<typeof detectSkillUsage>[1])
      if (skill) {
        line.run({ type: 'patchMessage', messageId: turn.messageId, patch: { skillUsed: skill } as never, hint: 'settle' })
      }
      toolCalls.push(call)
      line.run({
        type: 'setToolCalls',
        messageId: turn.messageId,
        toolCalls: toolCalls.map(entry => ({ ...entry })) as never,
      })
      line.run({
        type: 'upsertStep',
        messageId: turn.messageId,
        step: stepOf(tool, call, slots.call, toolTurnIndex) as never,
      })
    })

    runTools(request.tools ?? [], slot.tools, turnIndex)

    // §13.9:轮分界之后的那几段属于**下一个**回合(引擎在那条 finish 上
    // `persistTurnContentParts` + `resetTurn`,回合号 +1)。
    const boundaryTurnIndex = request.roundBoundary ? turnIndex + 1 : turnIndex
    // 分界之后的工具:**同一次请求**,下一个回合 —— 外部执行器多轮工具的常态。
    runTools(request.roundBoundary?.tools ?? [], slot.boundaryTools ?? [], boundaryTurnIndex)
    if (request.roundBoundary?.text !== undefined && !request.unfinished) {
      text += request.roundBoundary.text
      line.run({ type: 'patchMessage', messageId: turn.messageId, patch: { content: text } as never, hint: 'stream' })
      line.run({
        type: 'appendContentPart',
        messageId: turn.messageId,
        part: { type: 'text', content: request.roundBoundary.text, turnIndex: boundaryTurnIndex },
      })
    }
    if (request.roundBoundary?.providerData !== undefined && !request.unfinished) {
      line.run({
        type: 'appendContentPart',
        messageId: turn.messageId,
        part: {
          type: 'provider-data',
          providerData: request.roundBoundary.providerData,
          turnIndex: boundaryTurnIndex,
        },
      })
    }

    if (request.usage) {
      line.run({
        type: 'patchStepsUsageByTurn',
        messageId: turn.messageId,
        // 引擎写 usage 的时刻是**带 usage 的那条 finish**,记的是那一刻的回合号。
        // 外部执行器那条路上分界的 finish 不带 usage,所以用量落在分界之后 ——
        // 工具那个回合的 step 于是没有 usage(真机如此)。
        turnIndex: boundaryTurnIndex,
        usage: normalizedUsage(request.usage),
      })
    }
  })

  // 收场修复 —— 引擎本人那一份(`emitAgentLoopFinalMessageUpdateWithAdapters`
  // 里调的就是这个函数)。abort 那条路带 `'User cancelled'`,其余两条不带
  // 参数,于是写默认那一句。fixture 不手抄字面量(§10.10)。
  const settling = line.session.messages.find(message => message.id === turn.messageId)
  const repair = settling
    ? finalizeLingeringAgentLoopToolWork(
      settling as never,
      timeline.end,
      turn.outcome === 'aborted' ? CORE_ABORTED_TOOL_ERROR : undefined,
    )
    : undefined
  if (repair?.toolCalls) {
    line.run({ type: 'setToolCalls', messageId: turn.messageId, toolCalls: repair.toolCalls as never })
  }
  for (const step of repair?.steps ?? []) {
    line.run({ type: 'upsertStep', messageId: turn.messageId, step: step as never })
  }

  line.run({
    type: 'patchMessage',
    messageId: turn.messageId,
    patch: {
      isStreaming: false,
      ...(turn.outcome === 'error' && turn.error ? { errorDetails: turn.error } : {}),
    } as never,
    hint: 'settle',
  })

  return usage ? { usage } : {}
}

function emitTurnEvents(
  line: EventLine,
  turn: TurnSpec,
  timeline: TurnTimeline,
  requestIndexBase = 0,
  turnIndexBase = 0,
): void {
  line.push({
    time: timeline.start,
    type: 'run/start',
    data: {
      runId: turn.runId,
      kind: turn.kind,
      assistantMessageId: turn.messageId,
      ...(turn.provider ? { provider: turn.provider } : {}),
      ...(turn.model ? { model: turn.model } : {}),
      ...(turn.continuesRunId ? { continuesRunId: turn.continuesRunId } : {}),
      ...(turn.messageSource ? { messageSource: turn.messageSource } : {}),
    },
    surfaceOp: 'append',
  })

  let partIndex = 0
  turn.requests.forEach((request, index) => {
    // `requestIndex` 是**会话级**的(`nextSessionRequestIndex`),不是 run 级 ——
    // steering 之后接着往下发号,投影靠它把回合号接上。
    const requestIndex = requestIndexBase + index + 1
    const slot = timeline.requests[index]
    // §13.9:回合号是**引擎盖的章**,采集点照抄一份进事件行。平时它与
    // `requestIndex` 推出来的那个数相同 —— 分界(下面的 `roundBoundary`)才让
    // 两者分家。A 线用的是同一个表达式(`carried.turns + index + 1`)。
    const turnIndex = turnIndexBase + index + 1
    const boundaryTurnIndex = request.roundBoundary ? turnIndex + 1 : turnIndex

    if (request.reasoning !== undefined) {
      const at = partIndex++
      line.push({
        time: slot.reasoning!,
        type: 'assistant/chunks',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'reasoning', turnIndex, time0: slot.reasoning!, dt: [0], text: [request.reasoning],
        },
      })
      line.push({
        time: slot.reasoning!,
        type: 'assistant/part-end',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'reasoning', turnIndex, len: request.reasoning.length,
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
          kind: 'text', turnIndex, time0: slot.text!, dt: halves.map((_, i) => i * 3), text: halves,
        },
      })
      line.push({
        time: slot.text!,
        type: 'assistant/part-end',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'text', turnIndex, len: request.text.length,
        },
      })
    }
    if (request.providerData !== undefined) {
      // A1:一格 part,一次到齐(没有 delta)。载荷与工具结局同一条 64KB 线,
      // 这里当然走 `{text}` 那一支。
      const at = partIndex++
      const payload = JSON.stringify(request.providerData)
      line.push({
        time: slot.providerData!,
        type: 'assistant/part-end',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'provider-data', turnIndex, len: payload.length, providerData: { text: payload },
        },
      })
    }
    if (request.textAfter !== undefined) {
      const at = partIndex++
      line.push({
        time: slot.textAfter!,
        type: 'assistant/chunks',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'text', turnIndex, time0: slot.textAfter!, dt: [0], text: [request.textAfter],
        },
      })
      line.push({
        time: slot.textAfter!,
        type: 'assistant/part-end',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'text', turnIndex, len: request.textAfter.length,
        },
      })
    }

    const emitTools = (
      tools: readonly ToolSpec[],
      slotsList: TurnTimeline['requests'][number]['tools'],
      toolTurnIndex: number,
    ): void => tools.forEach((tool, toolIndex) => {
      const slots = slotsList[toolIndex]
      const argumentsRaw = JSON.stringify(tool.args)
      // 孤儿:参数流到一半就没了 —— 事件上只有半截原文,`tool/call` 不来。
      const streamedText = tool.orphan ? argumentsRaw.slice(0, Math.ceil(argumentsRaw.length / 2)) : argumentsRaw
      if (tool.streamedArgs || tool.orphan) {
        const at = partIndex++
        line.push({
          time: slots.inputEnd!,
          type: 'assistant/chunks',
          data: {
            runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
            kind: 'tool-input', toolCallId: tool.callId, toolName: tool.name, turnIndex: toolTurnIndex,
            time0: slots.inputEnd!, dt: [0], text: [streamedText],
          },
        })
        line.push({
          time: slots.inputEnd!,
          type: 'assistant/part-end',
          data: {
            runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
            kind: 'tool-input', toolCallId: tool.callId, toolName: tool.name, turnIndex: toolTurnIndex,
            len: streamedText.length,
          },
        })
      }
      if (tool.orphan) return
      const skill = detectSkillUsage(tool.name, tool.args as Parameters<typeof detectSkillUsage>[1])
      if (skill) {
        line.push({
          time: slots.call,
          type: 'skill/activated',
          data: { runId: turn.runId, messageId: turn.messageId, skill },
        })
      }
      line.push({
        time: slots.call,
        type: 'tool/call',
        data: {
          runId: turn.runId, callId: tool.callId,
          // A6+A7:wire 上的原始名 + 引擎归一之后的两格。归一没改变什么时
          // (`rawName` 缺席)采集点照旧只记一个名字 —— 那正是老文件的形状。
          name: tool.rawName ?? tool.name,
          ...(tool.rawName
            ? { resolvedToolId: tool.toolId ?? tool.name, displayName: tool.name }
            : {}),
          argumentsRaw, messageId: turn.messageId, turnIndex: toolTurnIndex,
        },
      })
      if (tool.resultText !== undefined) {
        line.push({
          time: slots.result!,
          type: 'tool/result',
          data: {
            runId: turn.runId, callId: tool.callId, isError: Boolean(tool.isError),
            resultPreview: tool.resultText, result: { text: tool.resultText },
            ...(tool.resultData !== undefined
              ? { resultData: { text: JSON.stringify(tool.resultData) } }
              : {}),
            ...(tool.changes !== undefined
              ? { changes: { text: JSON.stringify(tool.changes) } }
              : {}),
            ...(tool.reportedTitle ? { reportedTitle: tool.reportedTitle } : {}),
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

    emitTools(request.tools ?? [], slot.tools, turnIndex)

    // §13.9:轮分界之后的那几段 —— 同一个 `requestIndex`,**下一个**回合号。
    // 采集点在那条 finish 上把开着的段收了(引擎的 `resetTurn`),所以它们是
    // 各自独立的 part,不会与分界之前的正文折进同一格。
    emitTools(request.roundBoundary?.tools ?? [], slot.boundaryTools ?? [], boundaryTurnIndex)
    if (request.roundBoundary?.text !== undefined && !request.unfinished) {
      const at = partIndex++
      line.push({
        time: slot.boundaryText!,
        type: 'assistant/chunks',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'text', turnIndex: boundaryTurnIndex, time0: slot.boundaryText!,
          dt: [0], text: [request.roundBoundary.text],
        },
      })
      line.push({
        time: slot.boundaryText!,
        type: 'assistant/part-end',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'text', turnIndex: boundaryTurnIndex, len: request.roundBoundary.text.length,
        },
      })
    }
    if (request.roundBoundary?.providerData !== undefined && !request.unfinished) {
      const at = partIndex++
      const payload = JSON.stringify(request.roundBoundary.providerData)
      line.push({
        time: slot.boundaryProviderData!,
        type: 'assistant/part-end',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId, partIndex: at,
          kind: 'provider-data', turnIndex: boundaryTurnIndex, len: payload.length,
          providerData: { text: payload },
        },
      })
    }

    if (request.unfinished) return
    if (request.usage) {
      line.push({
        time: slot.response!,
        type: 'request/response',
        data: {
          runId: turn.runId, requestIndex, messageId: turn.messageId,
          usage: { inputTokens: request.usage.inputTokens, outputTokens: request.usage.outputTokens },
          // 引擎把这份 usage 记到哪个回合的 step 上(带 usage 的那条 finish
          // **推进之前**的回合号)。没有分界时它就是这次请求的回合号。
          usageTurnIndex: boundaryTurnIndex,
        },
      })
    }
    // 记录器在 `turn-end` 上**无条件**写这一条(有没有 usage 都写)——
    // 它就是"这一轮收齐了"的账,投影靠它判 contentParts 落没落地。
    line.push({
      time: slot.response ?? timeline.end,
      type: 'request/end',
      data: { runId: turn.runId, requestIndex },
    })
  })

  // §13.8 第一类:收场那一刻,引擎把写在消息上的取消结局记成一条 `tool/result`
  // (采集点 `captureCancelledToolResults` → `recordCancelledToolResults`)。
  // 它排在 `run/end` **之前** —— 收场修复先落盘,run 才收掉。
  // 判据与采集点相同:收场修复判死的那些 step(= 派工出去、没等到结局的调用),
  // 无论它有没有留下正文 —— 什么都没留下时那条事件也照记(账上多一个结局时刻,
  // 投影的每一格都不变)。孤儿不在其中:它连 `tool/call` 都没有。
  if (turn.outcome === 'aborted' || turn.outcome === 'error') {
    for (const request of turn.requests) {
      for (const tool of request.tools ?? []) {
        if (tool.orphan || tool.resultText !== undefined) continue
        line.push({
          time: timeline.end,
          type: 'tool/result',
          data: {
            runId: turn.runId,
            callId: tool.callId,
            isError: false,
            cancelled: true,
            resultPreview: tool.inFlightResult ?? '',
            ...(tool.inFlightResult !== undefined ? { result: { text: tool.inFlightResult } } : {}),
            ...(tool.reportedTitle ? { reportedTitle: tool.reportedTitle } : {}),
          },
          surfaceOp: 'append',
        })
      }
    }
  }

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

  /** 会话级的请求号(`nextSessionRequestIndex`)—— 与真机同口径,跨 run 单调。 */
  private requestIndex = 0
  /** runId → 这条 run 跑完时执行的状态(steering 接手时从这里取)。 */
  private readonly executionByRun = new Map<string, CarriedExecution>()
  /**
   * 还没落地的那一次执行的用量。引擎只在执行收尾时写一次消息上的 `usage`,
   * 落点是那一刻的助手消息 —— steering 把执行接走时,被打断的那条一格都没有。
   */
  private pendingExecutionUsage?: { messageId: string; usage: ProjectedStepUsage }

  turn(turn: TurnSpec): void {
    const carried = turn.continuesRunId
      ? this.executionByRun.get(turn.continuesRunId) ?? { turns: 0 }
      : { turns: 0 }
    // 接手的话,上一条消息的用量从来没落地过;不接手就说明上一次执行到此为止。
    if (!turn.continuesRunId) this.flushPendingExecutionUsage()
    else this.pendingExecutionUsage = undefined

    const timeline = planTurn(turn, this.clock)
    const requestIndexBase = this.requestIndex
    const result = applyTurnCommands(this.a, turn, timeline, carried)
    const before = this.b.events.length
    // 回合号的基数与 A 线同一个(`carried.turns`)—— 两条线各写各的,但数的是
    // 同一件事:引擎的 `state.turnIndex`。
    emitTurnEvents(this.b, turn, timeline, requestIndexBase, carried.turns)
    this.requestIndex += turn.requests.length
    this.executionByRun.set(turn.runId, {
      turns: carried.turns + turn.requests.length,
      ...(result.usage ? { usage: result.usage } : {}),
    })
    // 用量只在执行**正常**收尾时落一次(`updateUsage` 排在 chunk 循环之后)。
    // abort / 出错是从 catch 里走的,那一格永远没被写过(§10.14 第 7 类)。
    if (result.usage && turn.outcome === 'completed') {
      this.pendingExecutionUsage = { messageId: turn.messageId, usage: result.usage }
    }
    this.nodeSeq.set(turn.messageId, this.b.events[before].seq)
  }

  /** 执行真正收尾:把累加器写到**那一刻**的助手消息上(引擎的 `updateUsage`)。 */
  flushPendingExecutionUsage(): void {
    const pending = this.pendingExecutionUsage
    if (!pending) return
    this.pendingExecutionUsage = undefined
    this.a.run({
      type: 'patchMessage',
      messageId: pending.messageId,
      patch: { usage: pending.usage } as never,
      hint: 'settle',
    })
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
    const marker = {
      id: options.messageId,
      role: 'system',
      content: buildContextCompactContent({ status: 'compacting', compactedMessageCount: count, compactedThroughMessageId: options.throughMessageId }),
      timestamp: time,
    }
    this.a.run({
      type: 'appendMessage',
      now: time,
      message: marker as CoreSessionCommandMessage,
    })
    // §13.10 M3:`store.addMessage(标记消息)` 在 B 线上**确实**记了一条
    // `system/message`(翻译器的 appendMessage:role 不是 user、也不是流式助手)。
    // 从前这个 fixture 只写 `session/compacted` —— 又一处"fixture 写下结论"的
    // 空转(§10.10),真机上那两条一起进账本就多出一条消息。
    const markerEvent = this.b.push({ time, type: 'system/message', data: { message: marker }, surfaceOp: 'append' })
    // 标记那一格是 surface 上的一个节点 —— 先登记,下面的 `surfaceGroupEnd`
    // 才不会把它当成"挂在切点后面的附属事件"一起圈进遮蔽区间。
    this.nodeSeq.set(options.messageId, markerEvent.seq)
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
      // 收尾那条事件晚于标记消息自己的 timestamp(摘要要等模型回来),
      // 投影必须沿用**消息**那一格 —— 见 M3。
      time: this.clock.next(),
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

  /**
   * F2(§13.2):**失败**的压缩。
   *
   * 三件事一件都不发生:不写 `session.summary`、不遮蔽任何 surface 节点、
   * 模型历史一个字节不变(那条卡是 role:'system',builder 直接跳过)。UI 上
   * 它是一张红卡,所以 A 线照旧追加那条消息。
   */
  failedCompact(options: { messageId: string; error: string; throughMessageId: string }): void {
    const time = this.clock.next()
    const count = this.a.session.messages.findIndex(message => message.id === options.throughMessageId) + 1
    // 引擎那边这是**两步**:先追加一条 `status:'compacting'` 的占位,失败之后
    // `updateMessageContent` 把它改成 failed 正文(§13.10 M3)。
    const marker = {
      id: options.messageId,
      role: 'system',
      content: buildContextCompactContent({
        status: 'compacting',
        compactedMessageCount: count,
        compactedThroughMessageId: options.throughMessageId,
      }),
      timestamp: time,
    }
    this.a.run({
      type: 'appendMessage',
      now: time,
      message: marker as CoreSessionCommandMessage,
    })
    // B 线记的正是那条占位(翻译器的 `appendMessage`);正文补丁不进账本。
    this.b.push({ time, type: 'system/message', data: { message: marker }, surfaceOp: 'append' })
    this.a.run({
      type: 'patchMessage',
      messageId: options.messageId,
      hint: 'settle',
      patch: {
        content: buildContextCompactContent({
          status: 'failed',
          compactedMessageCount: count,
          error: options.error,
          compactedThroughMessageId: options.throughMessageId,
        }),
      } as never,
    })
    // 翻译器对失败的压缩写的是 `surfaceOp: 'append'` —— 它不遮蔽任何东西。
    // 时刻用 `clock.next()`:收尾那条事件晚于消息自己的 timestamp(真机上差
    // 5–9ms),投影必须沿用**消息**那一格,否则每次失败压缩都差一个时刻。
    const event = this.b.push({
      time: this.clock.next(),
      type: 'session/compacted',
      data: {
        summary: '',
        messageId: options.messageId,
        compactedMessageCount: count,
        compactedThroughMessageId: options.throughMessageId,
        status: 'failed',
        error: options.error,
      },
      surfaceOp: 'append',
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
  // 最后一次执行的用量在这里落地(引擎的 `updateUsage` 在收尾时写一次)。
  scenario.flushPendingExecutionUsage()
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

  /**
   * 真机第四批(§10.12 第 5 类)的最小复现:**steering 把一次执行劈成两条消息**。
   *
   * 账本上是两条 run(一条 assistant 消息一条 run),引擎那边只有一次执行 ——
   * `turnIndex` 与 `accumulatedUsage` 一格都不重置。于是接手的那条消息:
   *  - 开头那段推理是第 2 轮,落点是 `inline`(**不是** `top`);
   *  - step 的 `turnIndex` 从 2 起;
   *  - 整次执行的用量落在它身上,被打断的那条**一格都没有**。
   *
   * 投影从前按"每个 run 从第 1 轮数起"猜,三样全错(真机 17 行不等)。
   */
  it('steering splits one execution across two assistant messages', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'write it down' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{
        reasoning: 'first I plan',
        tools: [{ callId: 'c1', name: 'read', args: { path: '/skill' }, resultText: 'body', outcome: 'ok' }],
        usage: { inputTokens: 100, outputTokens: 30 },
      }],
      outcome: 'completed',
    })
    scenario.user({ id: 'u2', content: 'be thorough' })
    scenario.turn({
      runId: 'r2', messageId: 'a2', kind: 'steer', continuesRunId: 'r1',
      requests: [
        {
          reasoning: 'now with the steer in mind',
          tools: [{ callId: 'c2', name: 'write', args: { path: '/out' }, resultText: 'wrote', outcome: 'ok' }],
          usage: { inputTokens: 200, outputTokens: 50 },
        },
        { text: 'done', usage: { inputTokens: 300, outputTokens: 10 } },
      ],
      outcome: 'completed',
    })
    expectEquivalent(scenario)

    const messages = projectChatMessages(scenario.b.events).messages
    const steeredAway = messages.find(message => message.id === 'a1')!
    const continued = messages.find(message => message.id === 'a2')!
    // 被打断的那条:自己那一轮的推理照旧是 top,但**没有** usage。
    expect(steeredAway.reasoning).toBe('first I plan')
    expect(steeredAway.usage).toBeUndefined()
    // step 级的每轮用量照旧有 —— 那是 turn-end 当场写的,发生在换消息之前。
    expect(steeredAway.steps?.[0].usage).toEqual({ inputTokens: 100, outputTokens: 30, totalTokens: 130 })
    // 接手的那条:开头那段推理是**第 2 轮**,所以在 contentParts 里,字段是空的。
    expect(continued.reasoning).toBeUndefined()
    expect(continued.contentParts).toEqual([
      { type: 'reasoning', content: 'now with the steer in mind', turnIndex: 2 },
      { type: 'text', content: 'done', turnIndex: 3 },
    ])
    expect(continued.steps?.[0].turnIndex).toBe(2)
    // 整次执行的用量(三次请求)落在它身上。
    expect(continued.usage).toEqual({ inputTokens: 600, outputTokens: 90, totalTokens: 690 })
  })

  it('pre-fix vocabulary: a steer run without continuesRunId infers continuation (2026-08-20 兜底)', () => {
    // 9dde092d 之前的 recorder 写出的 steer run/start 没有 continuesRunId。
    // kind:'steer' 只有 rotateSessionRun 一个产地,投影按"最近开张的 run"兜底 ——
    // 结果必须与显式字段逐字节相同。构造:同上个场景,但 B 线剥掉字段。
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'write it down' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{
        reasoning: 'first I plan',
        tools: [{ callId: 'c1', name: 'read', args: { path: '/skill' }, resultText: 'body', outcome: 'ok' }],
        usage: { inputTokens: 100, outputTokens: 30 },
      }],
      outcome: 'completed',
    })
    scenario.user({ id: 'u2', content: 'be thorough' })
    scenario.turn({
      runId: 'r2', messageId: 'a2', kind: 'steer', continuesRunId: 'r1',
      requests: [
        {
          reasoning: 'now with the steer in mind',
          tools: [{ callId: 'c2', name: 'write', args: { path: '/out' }, resultText: 'wrote', outcome: 'ok' }],
          usage: { inputTokens: 200, outputTokens: 50 },
        },
        { text: 'done', usage: { inputTokens: 300, outputTokens: 10 } },
      ],
      outcome: 'completed',
    })
    // 剥的不只是 `continuesRunId`:那一代的账本连 §13.9 的回合号都没有,靠的
    // 全是"按 requestIndex 推"。两样一起剥,这条兜底才是真的老文件。
    const legacyEvents = scenario.b.events.map(event => {
      const {
        continuesRunId: _dropped,
        turnIndex: _turn,
        usageTurnIndex: _usageTurn,
        ...data
      } = event.data as unknown as Record<string, unknown>
      return { ...event, data } as unknown as typeof event
    })
    const withField = projectChatMessages(scenario.b.events).messages
    const inferred = projectChatMessages(legacyEvents as typeof scenario.b.events).messages
    expect(canonicalChatMessages(inferred)).toEqual(canonicalChatMessages(withField))
  })

  /**
   * 真机第四批(§10.12 第 6 类):**一次失败但跑完了的调用**。
   *
   * 引擎那份账里 `toolCall.result` 是结构化结局(失败时是 `{success:false,error}`)、
   * `step.result` 与 `step.error` **两格并存**、标题是工具自报的那一个(失败的结局
   * 对象里没有 title,只有过程中的 `annotate` 记得住)。投影从前在 `isError` 时把
   * 结构化结局与 `result` 一起丢掉,标题退回派生的 "Tool: read: …"。
   */
  it('a failed-but-completed tool keeps its structured result and its self-reported title', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'read it' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{
        text: 'oops',
        tools: [{
          callId: 'c1', name: 'read', args: { path: '/notes/a.md', offset: 330 },
          resultText: 'Offset 330 is beyond end of file (205 lines total)',
          isError: true,
          outcome: 'failed',
          resultData: { success: false, error: 'Offset 330 is beyond end of file (205 lines total)' },
          reportedTitle: 'Reading a.md',
        }],
      }],
      outcome: 'completed',
    })
    expectEquivalent(scenario)

    const message = projectChatMessages(scenario.b.events).messages[1]
    const step = message.steps![0]
    expect(step.title).toBe('Reading a.md')
    expect(step.status).toBe('failed')
    expect(step.result).toBe('Offset 330 is beyond end of file (205 lines total)')
    expect(step.error).toBe('Offset 330 is beyond end of file (205 lines total)')
    expect(step.toolCall?.result).toEqual({
      success: false,
      error: 'Offset 330 is beyond end of file (205 lines total)',
    })
    // 失败的调用没有 partialResult(引擎写的是 `result.error ? undefined : …`)。
    expect(step.partialResult).toBeUndefined()
  })

  /**
   * §13.17:edit/write 的结构化 diff 在两条线上都到位 —— A 线写在
   * `toolCall.changes`,B 线记在 `tool/result.changes`,投影物化后
   * `toolCalls[].changes` 与 `step.toolCall.changes`(同引用)都拿得到。
   */
  it('carries edit changes onto both toolCall and step.toolCall', () => {
    const changes = {
      diff: '@@ -1 +1 @@\n-old\n+new',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
      filePath: 'a.ts',
      additions: 1,
      deletions: 1,
    }
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'edit it' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{
        text: 'edited',
        tools: [{
          callId: 'c1', name: 'edit', args: { path: 'a.ts' },
          resultText: 'ok', resultData: { success: true }, outcome: 'ok',
          reportedTitle: 'Editing a.ts', changes,
        }],
      }],
      outcome: 'completed',
    })
    expectEquivalent(scenario)

    const message = projectChatMessages(scenario.b.events).messages[1]
    expect(message.toolCalls![0].changes).toEqual(changes)
    expect(message.steps![0].toolCall?.changes).toEqual(changes)
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

  /**
   * S3.1(§10.11):真机 fe5261d9 那一回合的最小复现 —— 参数是流式来的 bash,
   * 命令是 `cat …/SKILL.md`。两个缺陷都在这一条里:
   *   - step.type 必须是 `skill-read`(占位那一刻只能算出 `command`)
   *   - message.skillUsed 必须落上(以前只有事件账本有)
   */
  it('streamed bash reading a SKILL.md lands skill-read + skillUsed on both lines', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: '按 lenovo-scripts 来' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [
        {
          text: 'reading the skill',
          tools: [
            {
              callId: 'c1', name: 'bash',
              args: { command: 'cat ~/.onething/skills/lenovo-scripts/SKILL.md' },
              resultText: '# lenovo-scripts', outcome: 'ok', streamedArgs: true,
            },
            { callId: 'c2', name: 'bash', args: { command: 'mkdir -p out' }, resultText: '', outcome: 'ok' },
          ],
        },
      ],
      outcome: 'completed',
    })
    expectEquivalent(scenario)

    const message = projectChatMessages(scenario.b.events).messages[1]
    expect(message.skillUsed).toBe('lenovo-scripts')
    expect(message.steps?.map(step => step.type)).toEqual(['skill-read', 'file-write'])
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
    // 收尾修复写在两边的同一句话。
    expect(message.toolCalls?.[0].error).toBe('User cancelled')
    expect(message.steps?.[0].error).toBe('User cancelled')
    // abort 掉的执行**没有** usage(`updateUsage` 在 catch 之外,一次都没跑)。
    expect(message.usage).toBeUndefined()
  })

  /**
   * 真机 `17b342a2…`(§10.14 第 7 类)的最小复现:两轮工具跑完,第 3 轮的参数
   * 流到一半用户按了停止。三处一起验 —— 占位 step、被打断那一轮的 contentParts、
   * 整条消息的 usage。
   */
  it('abort mid tool-input: the orphan placeholder survives, the unfinished turn does not', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: '整理一下' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [
        {
          reasoning: '先看看目录', usage: { inputTokens: 100, outputTokens: 10 },
          tools: [{ callId: 'c1', name: 'bash', args: { command: 'ls' }, resultText: 'a.md', streamedArgs: true }],
        },
        {
          reasoning: '再数一数', usage: { inputTokens: 120, outputTokens: 12 },
          tools: [{ callId: 'c2', name: 'bash', args: { command: 'wc -l a.md' }, resultText: '3', streamedArgs: true }],
        },
        // 第 3 轮:推理流了一段,参数流到一半 —— 两样都没走到 turn-end。
        { reasoning: '看起来要再查一次', unfinished: true, tools: [{ callId: 'c3', name: 'bash', args: { command: 'grep -r x .' }, orphan: true }] },
      ],
      outcome: 'aborted',
    })
    expectEquivalent(scenario)

    const message = projectChatMessages(scenario.b.events).messages[1]
    const orphanStep = message.steps?.find(step => step.toolCallId === 'c3')
    expect(orphanStep).toMatchObject({
      type: 'command',
      title: '调用工具: bash',
      status: 'cancelled',
      error: 'User cancelled',
      turnIndex: 3,
    })
    expect(orphanStep?.toolCall).toMatchObject({
      toolId: 'bash', toolName: 'bash', arguments: {}, status: 'cancelled',
      streamingArgs: '', error: 'User cancelled',
    })
    // 第 3 轮那段推理在事件里齐全,却从来没落到消息上 —— 前两轮的才在。
    expect(message.contentParts?.map(part => part.turnIndex)).toEqual([2])
    expect(message.reasoning).toBe('先看看目录')
    expect(message.usage).toBeUndefined()
    // step 级的每轮用量照旧有(turn-end 当场写的)。
    expect(message.steps?.find(step => step.toolCallId === 'c1')?.usage).toMatchObject({ inputTokens: 100 })
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
// §13.13 #2:压缩卡的时刻
// ============================================================================

/**
 * #2(§13.13):M3 那次修复读错了字段。压缩标记那格的 `node.time` 是
 * `system/message` 事件的**记账时刻**(`addMessageNode` 拿的是 `event.time`),
 * 而不是那条标记消息自己的 `timestamp` —— 真机上两者差 5–73ms。压缩卡的时刻必须
 * 沿用消息自己的 `timestamp`。
 *
 * 合同 fixture(`Scenario.compact`)当年抓不到:它把 `system/message` 事件的
 * `time` 写成和消息 `timestamp` 相等,两格恒同。这里**故意错开**它俩,反证才立得住。
 */
describe('§13.13 #2:压缩卡取标记消息自己的 timestamp', () => {
  const T_MSG = 1000
  const T_EVENT = 1007 // 占位那格的记账时刻(system/message 的 event.time),晚 7ms
  const marker = { id: 'k1', role: 'system', content: 'compacting', timestamp: T_MSG }
  const base: SessionLogEventRecord[] = [
    { seq: 1, time: 1, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: 'hi', timestamp: 1 } }, surfaceOp: 'append' },
    { seq: 2, time: T_EVENT, type: 'system/message', data: { message: marker }, surfaceOp: 'append' },
  ]
  const compacted = (status: 'completed' | 'failed'): SessionLogEventRecord => ({
    seq: 3, time: 2000, type: 'session/compacted',
    data: {
      summary: status === 'completed' ? '## Goal\nx' : '',
      messageId: 'k1', compactedMessageCount: 1, status,
      ...(status === 'failed' ? { error: 'boom' } : {}),
    },
    surfaceOp: 'append',
  } as SessionLogEventRecord)

  it.each(['completed', 'failed'] as const)('%s compaction: card timestamp === marker message timestamp', status => {
    const card = projectChatMessages([...base, compacted(status)]).messages.find(message => message.id === 'k1')!
    expect(card.timestamp).toBe(T_MSG)
    // 反证:旧 M3 修复读的是占位那格的**记账时刻** —— 改回去这一格就变 T_EVENT。
    expect(card.timestamp).not.toBe(T_EVENT)
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
  it('G2: the step title is derived — the placeholder unless the tool reported one', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2,
      type: 'tool/call',
      data: { runId: 'r', callId: 'c1', name: 'bash', argumentsRaw: '{"command":"npm test"}', messageId: 'a1' },
    })

    const step = projectChatMessages(line.events).messages[0].steps?.[0]
    // 引擎在生产里只有占位标题这一档兜底(`createCoreToolInputStartArtifacts`)——
    // `generateStepTitle` 那一份只活在旧编排器里(§10.14 第 8 类)。
    expect(step?.title).toBe('调用工具: bash')
    // G1:id 是派生的,与 toolCallId 一一对应。
    expect(step?.id).toBe('step-c1')

    // 工具自报的标题当场盖掉它。
    line.push({
      time: 3,
      type: 'tool/result',
      data: { runId: 'r', callId: 'c1', isError: false, resultPreview: 'ok', result: { text: 'ok' }, reportedTitle: 'Run: npm test' },
      surfaceOp: 'append',
    })
    expect(projectChatMessages(line.events).messages[0].steps?.[0].title).toBe('Run: npm test')
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

  it('G7: an orphan tool-input part becomes the engine placeholder — call AND step', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2,
      type: 'assistant/chunks',
      data: {
        runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'tool-input',
        toolCallId: 'c1', toolName: 'bash', time0: 10, dt: [0], text: ['{"command":"ls'],
      },
    })

    const live = projectChatMessages(line.events).messages[0]
    // 引擎的占位卡:名字从第一帧起就有,参数是 `{}`,`streamingArgs` 在**消息上**
    // 永远是空串(delta 只发给渲染层,一格都没回写)。
    expect(live.toolCalls).toEqual([
      expect.objectContaining({
        id: 'c1', toolId: 'bash', toolName: 'bash', arguments: {},
        status: 'input-streaming', streamingArgs: '',
      }),
    ])
    // 占位 step 与占位调用是同一行代码建的两样东西 —— 补一样漏一样就是少一条 step。
    expect(live.steps).toEqual([
      expect.objectContaining({
        toolCallId: 'c1', type: 'command', title: '调用工具: bash', status: 'running', turnIndex: 1,
      }),
    ])
    // 参数流不进 contentParts —— 它喂的是 toolCalls 那一路。
    expect(live.contentParts).toBeUndefined()

    // 收场:引擎的收尾修复把它判死并写上那句话(abort 那条路是 'User cancelled')。
    line.push({ time: 3, type: 'run/end', data: { runId: 'r', outcome: 'aborted' } })
    const settled = projectChatMessages(line.events).messages[0]
    expect(settled.toolCalls?.[0]).toMatchObject({ status: 'cancelled', error: 'User cancelled' })
    expect(settled.steps?.[0]).toMatchObject({ status: 'cancelled', error: 'User cancelled' })
  })

  it('G7: an aborted turn persists no contentParts (the engine only writes them at turn-end)', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    // 第 1 轮走完:part 落地。
    line.push({
      time: 2, type: 'assistant/chunks',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 2, dt: [0], text: ['done'] },
    })
    line.push({ time: 3, type: 'request/end', data: { runId: 'r', requestIndex: 1 } })
    // 第 2 轮被打断:同样的 chunks,但没有 `request/end`。
    line.push({
      time: 4, type: 'assistant/chunks',
      data: { runId: 'r', requestIndex: 2, messageId: 'a1', partIndex: 1, kind: 'text', time0: 4, dt: [0], text: ['half'] },
    })
    line.push({ time: 5, type: 'run/end', data: { runId: 'r', outcome: 'aborted' } })

    const message = projectChatMessages(line.events).messages[0]
    // `content` 是实时写的那条路 —— 半截正文照旧在。
    expect(message.content).toBe('donehalf')
    expect(message.contentParts).toEqual([{ type: 'text', content: 'done', turnIndex: 1 }])
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

// ============================================================================
// Q1 批(§13.5):静态审计挖出的日常必现缺口
// ============================================================================

describe('Q1: provider-data / 图片闸 / 工具身份 / 中段截断 / 压缩口径', () => {
  /**
   * A1+A13(§13.1):**provider-data 是一条分段边界**。
   *
   * 引擎的 `appendOrderedPart` 只合并**相邻**同类,一块 Claude 思考签名夹在两段
   * 正文之间就把它们切成两格。采集点从前没有这个词汇,于是两段正文攒成了一段 ——
   * 投影出来的 contentParts 永远比事实少一格,而且后面每一格全部错位。
   */
  it('A1: provider-data cuts the text run in two and materializes as its own part', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'think about it' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{
        text: 'before',
        providerData: { provider: 'anthropic', type: 'thinking-signature', signature: 'sig-abc' },
        textAfter: 'after',
        usage: { inputTokens: 8, outputTokens: 3 },
      }],
      outcome: 'completed',
    })
    expectEquivalent(scenario)

    const message = projectChatMessages(scenario.b.events).messages[1]
    expect(message.contentParts).toEqual([
      { type: 'text', content: 'before', turnIndex: 1 },
      { type: 'provider-data', providerData: { provider: 'anthropic', type: 'thinking-signature', signature: 'sig-abc' }, turnIndex: 1 },
      { type: 'text', content: 'after', turnIndex: 1 },
    ])
    // 正文本身照旧是两段的 fold —— provider-data 不是正文。
    expect(message.content).toBe('beforeafter')
  })

  /**
   * A1 的另一半:provider-data **不算"可见产出"**,所以它不打断 top 推理的判定。
   * 引擎的判据逐字是 `orderedParts.some(part => part.type !== 'provider-data')`。
   */
  it('A1: a provider-data part does not turn the opening reasoning into an inline one', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'why' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{
        reasoning: 'weighing it',
        providerData: { provider: 'anthropic', type: 'thinking-signature', signature: 'sig' },
        textAfter: 'because',
      }],
      outcome: 'completed',
    })
    expectEquivalent(scenario)

    const message = projectChatMessages(scenario.b.events).messages[1]
    expect(message.reasoning).toBe('weighing it')
    expect(message.contentParts?.map(part => part.type)).toEqual(['provider-data', 'text'])
  })

  /** 老文件兜底(§10.16):没有 `providerData` 那一格的 part-end 不产出任何东西。 */
  it('A1 fallback: an old part-end without the payload projects no provider-data part', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2, type: 'assistant/chunks',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 2, dt: [0], text: ['hi'] },
    })
    line.push({ time: 3, type: 'request/end', data: { runId: 'r', requestIndex: 1 } })
    line.push({ time: 4, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })

    expect(projectChatMessages(line.events).messages[0].contentParts)
      .toEqual([{ type: 'text', content: 'hi', turnIndex: 1 }])
  })

  /**
   * A2(§13.1):**图片 part 不受"这一轮收齐了吗"那道闸管**。
   *
   * 图片生成是引擎里的一条特化流,一条 delta 都不经 agent-loop,`request/end`
   * 永远不会来 —— §10.14 引入 `settledRequests` 时把它一并圈了进去,于是 S1b
   * 缺口 3 补上的采集成果被闸吃掉,一次生图在投影里连一格 part 都没有。
   */
  it('A2: an image part materializes even though its request never settles', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2,
      type: 'assistant/part-end',
      data: {
        runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'image',
        len: 12, hash: 'cafe', blob: { hash: 'cafe', bytes: 12, mime: 'image/png' },
      },
    })
    line.push({ time: 3, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })

    expect(projectChatMessages(line.events).messages[0].contentParts).toEqual([
      { type: 'image', blob: { hash: 'cafe', bytes: 12, mime: 'image/png' }, turnIndex: 1 },
    ])
  })

  /**
   * A6+A7(§13.1):**工具身份归一进账本**。
   *
   * 模型写的是 wire 上那个名字,引擎当场归一(别名表 / MCP 折成服务器名)并把
   * 归一后的两格写在消息上。账本从前只有原始名,于是装了 MCP 的机器上每张工具卡
   * 的身份都对不上 —— 连带 `steps[].type`(`getStepType` 读的是 `toolName`)。
   */
  it('A6+A7: the resolved identity rides the event and drives steps[].type', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'read the skill' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{
        text: 'looking',
        tools: [{
          callId: 'c1',
          // 归一之后是 `bash`,模型写的是别名 `Bash`。
          name: 'bash', rawName: 'Bash',
          args: { command: 'cat skills/demo/SKILL.md' },
          resultText: '# demo', outcome: 'ok',
        }],
      }],
      outcome: 'completed',
    })
    expectEquivalent(scenario)

    const message = projectChatMessages(scenario.b.events).messages[1]
    expect(message.toolCalls?.[0]).toMatchObject({ toolId: 'bash', toolName: 'bash' })
    // 归一之后才判得出来:`Bash` 会被 `getStepType` 判成 'tool-call'。
    expect(message.steps?.[0].type).toBe('skill-read')
    expect(message.skillUsed).toBe('demo')
  })

  /** 老文件兜底(§10.16):没有归一那两格时,投影退回原始名 = 修复前的行为。 */
  it('A6+A7 fallback: an old tool/call without the resolved identity keeps the raw name', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({ time: 2, type: 'tool/call', data: { runId: 'r', callId: 'c1', name: 'mcp__docs__search', argumentsRaw: '{}', messageId: 'a1' } })

    expect(projectChatMessages(line.events).messages[0].toolCalls?.[0])
      .toMatchObject({ toolId: 'mcp__docs__search', toolName: 'mcp__docs__search' })
  })

  /**
   * A5(§13.1):**中段 retry 的截断遮的是一整段**。
   *
   * `truncateFrom{inclusive:true}` 删的是目标**以及它后面的一切**,而翻译出来的
   * 是一条 `message/deleted` —— 遮蔽范围写在它的账本层字段上。从前归约器只 hide
   * 目标那一格,于是投影比事实多出整段(surface 半对:历史绿、消息红)。
   */
  it('A5: regenerating a middle assistant message hides everything after it too', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'one' })
    scenario.turn({ runId: 'r1', messageId: 'a1', kind: 'send', requests: [{ text: 'reply one' }], outcome: 'completed' })
    scenario.user({ id: 'u2', content: 'two' })
    scenario.turn({ runId: 'r2', messageId: 'a2', kind: 'send', requests: [{ text: 'reply two' }], outcome: 'completed' })
    // 中段:a1 之后还有 u2 / a2 两条。
    scenario.regenerateFrom('a1')
    scenario.turn({ runId: 'r3', messageId: 'a3', kind: 'retry', requests: [{ text: 'reply again' }], outcome: 'completed' })

    expectEquivalent(scenario)
    expect(projectChatMessages(scenario.b.events).messages.map(m => m.id)).toEqual(['u1', 'a3'])
  })

  /**
   * F2(§13.2):**一次失败的压缩对模型历史零影响**。
   *
   * 真机上发生过(deepseek 返回空摘要)。从前投影只看"有没有 compacted 节点",
   * 于是一次失败就让整份历史切换压缩口径:per-result 预算掉 8 倍、老摘要锚点
   * 失效整段重放、消息组在那一点被劈成两段各 build 一次。
   */
  it('F2: a failed compaction leaves the model history exactly as the engine builds it', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'one' })
    scenario.turn({ runId: 'r1', messageId: 'a1', kind: 'send', requests: [{ text: 'reply one' }], outcome: 'completed' })
    scenario.failedCompact({ messageId: 'k1', error: 'empty summary', throughMessageId: 'a1' })
    scenario.user({ id: 'u2', content: 'two' })
    scenario.turn({
      runId: 'r2', messageId: 'a2', kind: 'send',
      // 大结果是这条用例的**判据**:压缩口径把 per-result 预算从 200k 收到 24k,
      // 所以"一次失败的压缩有没有切口径"在这里是可见的字节差,不是口头承诺。
      requests: [{
        text: 'reply two',
        // 40k:压缩口径的 per-result 上限是 24k,普通口径是 200k —— 正好夹在中间。
        tools: [{ callId: 'c1', name: 'read', args: { path: '/big' }, resultText: 'x'.repeat(40_000), outcome: 'ok' }],
      }],
      outcome: 'completed',
    })

    // A ≡ B 两条线都在这里比一遍(消息 + 历史 + 历史字节)。
    expectEquivalent(scenario)

    // UI 上那张红卡还在,模型历史里一格都没有它。
    expect(projectChatMessages(scenario.b.events).messages.map(m => m.id))
      .toEqual(['u1', 'a1', 'k1', 'u2', 'a2'])
    const history = projectModelHistory(scenario.b.events, scenario.sessionMeta, {
      buildMessageContent: defaultHistoryMessageContent,
    })
    expect(history.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'tool'])
    expect(JSON.stringify(history)).not.toContain('<summary>')

    // 而且它**连段都没切**:宿主的预处理(`prepareMessages`)是对整份消息列表
    // 应用一次的,一次失败的压缩若还在那里 `flush()`,这一遍就会被劈成两段各跑
    // 一次 —— 下面这个只认"最后一条"的探针会因此打两个标记。
    const marked = projectModelHistory(scenario.b.events, scenario.sessionMeta, {
      buildMessageContent: defaultHistoryMessageContent,
      prepareMessages: messages => messages.map((message, index) =>
        index === messages.length - 1
          ? ({ ...message, content: `${message.content ?? ''}[LAST]` } as CoreHistoryChatMessage)
          : message),
    })
    expect(JSON.stringify(marked).split('[LAST]').length - 1).toBe(1)
  })

  /**
   * F1(§13.2):**压缩之后 providerData 只跟最后一条保留消息走**。
   *
   * 摘要分支里那条规则(`message === recentMessages[last]`)在 surface 路径上没了
   * 来源 —— 投影压缩后走的是非摘要分支,而那一支逐条求值。A1 一补上生产者,
   * codex/claude 的加密推理就会在压缩后的每一条消息上各带一份。
   */
  it('F1: after a compaction only the last retained message carries providerData', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'one' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{ text: 'first', providerData: { provider: 'codex', type: 'encrypted-reasoning', encryptedContent: 'E1' } }],
      outcome: 'completed',
    })
    scenario.compact({ messageId: 'k1', summary: '## Goal\nship', throughMessageId: 'u1' })
    scenario.user({ id: 'u2', content: 'two' })
    scenario.turn({
      runId: 'r2', messageId: 'a2', kind: 'send',
      requests: [{ text: 'second', providerData: { provider: 'codex', type: 'encrypted-reasoning', encryptedContent: 'E2' } }],
      outcome: 'completed',
    })

    // 两条线逐字节相同(历史比较在 `expectEquivalent` 里)。
    expectEquivalent(scenario)

    const history = projectModelHistory(scenario.b.events, scenario.sessionMeta, {
      buildMessageContent: defaultHistoryMessageContent,
    })
    const carriers = history.filter(message => (message as { providerData?: unknown[] }).providerData?.length)
    expect(carriers).toHaveLength(1)
    expect(JSON.stringify(carriers[0])).toContain('E2')
    expect(JSON.stringify(history)).not.toContain('E1')
  })

  /**
   * A4(§13.1):`run/start.agentId` —— collab 工作会话里"这条助手消息是哪个
   * agent 说的"。来源是**占位消息上盖过的那一格**,所以两条线天然同源;
   * 老文件没有这一格,投影也就没有(不猜)。
   */
  it('A4: run/start carries the agent, and its absence stays an absence', () => {
    const line = eventLine()
    line.push({
      time: 1, type: 'run/start',
      data: { runId: 'r', kind: 'send', assistantMessageId: 'a1', agentId: 'researcher' },
      surfaceOp: 'append',
    })
    expect(projectChatMessages(line.events).messages[0].agentId).toBe('researcher')

    const plain = eventLine()
    plain.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    expect(projectChatMessages(plain.events).messages[0].agentId).toBeUndefined()
  })
})

// ============================================================================
// Q2+R 批(§13.6):blob 回填 / 等确认三格 / 可见性 / 崩溃收口 / 生图正文
//
// 这一组的判据全部落在**同一句话**上:S2b 拿投影那一份当真相之后,用户看到的
// 东西会不会变?会变的一格都不许静默丢掉(F6 的 issue 就是"不许静默"的实现)。
// ============================================================================

describe('Q2+R: blob 回填 / 等确认 / 可见性 / 崩溃收口 / 生图正文', () => {
  /** 一次工具调用 + 一条结局(结局的正文/结构化都可以走 blob)。 */
  function toolLine(result: {
    text?: string
    blob?: { hash: string; bytes: number }
    data?: { text: string } | { blob: { hash: string; bytes: number } }
  }): EventLine {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2, type: 'tool/call',
      data: { runId: 'r', callId: 'c1', name: 'read', argumentsRaw: '{"path":"big.md"}', messageId: 'a1' },
    })
    line.push({
      time: 3, type: 'tool/result',
      data: {
        runId: 'r', callId: 'c1', isError: false,
        resultPreview: 'preview…',
        ...(result.blob ? { result: { blob: result.blob } } : { result: { text: result.text ?? '' } }),
        ...(result.data ? { resultData: result.data } : {}),
      },
      surfaceOp: 'append',
    })
    line.push({ time: 4, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })
    return line
  }

  /**
   * A8(§13.1):**>64KB 的工具结局在事件行里只有引用**。
   *
   * 引擎那份账里 `steps[].result` 是全文,而投影从前在 blob 那一支上整格缺席 ——
   * 一次 read 大文件就是一条必然的不等,而且 S2b 之后工具卡会直接变空。
   */
  it('A8: a blobbed tool result is materialized in full through the injected resolver', () => {
    const big = 'x'.repeat(70_000)
    const line = toolLine({ blob: { hash: 'aaaa1111', bytes: big.length } })

    const resolved = projectChatMessages(line.events, { resolveBlob: () => big }).messages[0]
    expect(resolved.steps?.[0].result).toBe(big)
    expect(resolved.toolCalls?.[0].result).toBe(big)

    // 没有 resolver:照实留引用,**而且**记一条 issue —— 从前这里是静默的。
    const issues: unknown[] = []
    const degraded = projectChatMessages(line.events, { onIssue: issue => issues.push(issue) }).messages[0]
    expect(degraded.toolCalls?.[0].result).toEqual({ blob: { hash: 'aaaa1111', bytes: big.length } })
    expect(degraded.steps?.[0].result).toBeUndefined()
    expect(issues).toContainEqual(expect.objectContaining({ kind: 'blob-missing', hash: 'aaaa1111' }))
  })

  it('A8: the structured outcome rides the same resolver (the tool card lives on it)', () => {
    const structured = { title: 'Read big.md', output: 'x'.repeat(70_000), metadata: { lines: 900 } }
    const line = toolLine({ text: 'ok', data: { blob: { hash: 'bbbb2222', bytes: 70_000 } } })

    const resolved = projectChatMessages(line.events, {
      resolveBlob: () => JSON.stringify(structured),
    }).messages[0]
    expect(resolved.toolCalls?.[0].result).toEqual(structured)
    // 结构化结局在场时 step 的标题跟着它走(与引擎同一条规则)。
    expect(resolved.steps?.[0].title).toBe('Read big.md')
  })

  /**
   * A9(§13.1):**附件的 base64 是单向的** —— 翻译器把它换成 BlobRef,
   * 投影从前不回填,于是每一条带图的用户消息都必红。
   */
  it('A9: an attachment base64 comes back byte-for-byte, and its absence is reported', () => {
    const line = eventLine()
    line.push({
      time: 1, type: 'user/message',
      data: {
        message: {
          id: 'u1', role: 'user', content: 'look', timestamp: 1,
          attachments: [{ id: 'att1', fileName: 'a.png', mimeType: 'image/png', base64Data: { hash: 'cccc3333', bytes: 4 } }],
        },
      },
      surfaceOp: 'append',
    })

    const resolved = projectChatMessages(line.events, { resolveBlob: () => 'QUJDRA==' }).messages[0]
    expect((resolved.attachments as Array<{ base64Data: unknown }>)[0].base64Data).toBe('QUJDRA==')

    const issues: unknown[] = []
    const degraded = projectChatMessages(line.events, { onIssue: issue => issues.push(issue) }).messages[0]
    // 消息这条路上换不回来就**照实留引用**(摘掉等于让消息凭空变短)。
    expect((degraded.attachments as Array<{ base64Data: unknown }>)[0].base64Data)
      .toEqual({ hash: 'cccc3333', bytes: 4 })
    expect(issues).toContainEqual(expect.objectContaining({ kind: 'blob-missing', where: 'attachments.base64Data' }))
  })

  /**
   * A12(§13.1):**等确认的三格**。账本里这件事早就有(`permission/asked` 有、
   * `permission/answered` 没有),只是从前没人 join。引擎那一刻写的是
   * `toolCall.status='pending' + requiresConfirmation:true`、
   * `step.status='awaiting-confirmation'`(`settleAgentLoopToolCallResult` /
   * `buildAgentLoopToolResultPresentation` 的 awaiting 分支)。
   */
  it('A12: an unanswered permission ask projects the awaiting-confirmation triple', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2, type: 'tool/call',
      data: { runId: 'r', callId: 'c1', name: 'bash', argumentsRaw: '{"command":"rm -rf x"}', messageId: 'a1' },
    })
    line.push({ time: 3, type: 'permission/asked', data: { requestId: 'p1', runId: 'r', toolCallId: 'c1', toolName: 'bash' } })

    const message = projectChatMessages(line.events).messages[0]
    expect(message.toolCalls?.[0]).toMatchObject({ status: 'pending', requiresConfirmation: true })
    expect(message.steps?.[0].status).toBe('awaiting-confirmation')

    // 答复之后回到普通轨道(批准与否都结束"在等"这个状态)。
    line.push({ time: 4, type: 'permission/answered', data: { requestId: 'p1', runId: 'r', toolCallId: 'c1', approved: true } })
    const answered = projectChatMessages(line.events).messages[0]
    expect(answered.toolCalls?.[0].requiresConfirmation).toBeUndefined()
    expect(answered.steps?.[0].status).not.toBe('awaiting-confirmation')
  })

  /**
   * A12 × R-a 的交汇:**等审批时进程没了**。
   *
   * 账本上是 `permission/asked` + prepare 合成的中断结局 + `run/end{interrupted}`;
   * 消息侧 `sanitizeSessionOnStartup` 那次修复写的是
   * `cancelled` + `CORE_INTERRUPTED_PERMISSION_ERROR`(权限那一句压过通用那一句)。
   * 两侧必须逐字相同 —— 这正是 A10 那四格打架的收口。
   */
  it('A12 × R-a: a crash while awaiting projects exactly what the message-side repair writes', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2, type: 'tool/call',
      data: { runId: 'r', callId: 'c1', name: 'bash', argumentsRaw: '{}', messageId: 'a1' },
    })
    line.push({ time: 3, type: 'permission/asked', data: { requestId: 'p1', runId: 'r', toolCallId: 'c1' } })
    // prepare 合成的那两条(`app/session/prepare.ts`)。
    line.push({
      time: 4, type: 'tool/result',
      data: {
        runId: 'r', callId: 'c1', isError: true,
        resultPreview: CORE_INTERRUPTED_TOOL_ERROR,
        result: { text: CORE_INTERRUPTED_TOOL_ERROR },
      },
      surfaceOp: 'append',
    })
    line.push({ time: 5, type: 'run/end', data: { runId: 'r', outcome: 'interrupted' } })

    const projected = projectChatMessages(line.events).messages[0]
    expect(projected.steps?.[0]).toMatchObject({
      status: 'cancelled',
      error: CORE_INTERRUPTED_PERMISSION_ERROR,
    })
    expect(projected.toolCalls?.[0]).toMatchObject({
      status: 'cancelled',
      error: CORE_INTERRUPTED_PERMISSION_ERROR,
    })

    // A 线:引擎留在盘上的那条消息,过一次真的启动期修复(不手写字面量)。
    const crashed = {
      id: 'a1', role: 'assistant', content: '', isStreaming: true,
      steps: [{ id: 's1', title: '调用工具: bash', status: 'awaiting-confirmation', toolCallId: 'c1', toolCall: { id: 'c1', status: 'pending', requiresConfirmation: true } }],
      toolCalls: [{ id: 'c1', status: 'pending', requiresConfirmation: true }],
    }
    const repaired = computeSessionRepairOnLoad(
      { id: 's1' },
      [crashed as never],
      'startup',
    ).messages[0] as unknown as { steps: Array<{ status: string; error?: string; title: string }> }
    expect(repaired.steps[0].status).toBe(projected.steps?.[0].status)
    expect(repaired.steps[0].error).toBe(projected.steps?.[0].error)
    // 标题也一致 —— R-a 取消了那次改写,占位标题两侧都留着。
    expect(repaired.steps[0].title).toBe(projected.steps?.[0].title)
  })

  /**
   * R-a(§13.6):**没等到结局就崩了**的调用 —— 收尾修复的那一句话。
   *
   * `interrupted` 从前是"没有收尾修复"的一档,于是每条崩溃过的消息在投影里都
   * 少一句话;现在三处(prepare 合成 / 消息侧修复 / 投影)共用同一个常量。
   */
  it('R-a: an interrupted run leaves the same sentence on both lines', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2, type: 'tool/call',
      data: { runId: 'r', callId: 'c1', name: 'bash', argumentsRaw: '{}', messageId: 'a1' },
    })
    line.push({ time: 3, type: 'run/end', data: { runId: 'r', outcome: 'interrupted' } })

    const message = projectChatMessages(line.events).messages[0]
    expect(message.toolCalls?.[0]).toMatchObject({ status: 'cancelled', error: CORE_INTERRUPTED_TOOL_ERROR })
    expect(message.steps?.[0]).toMatchObject({ status: 'cancelled', error: CORE_INTERRUPTED_TOOL_ERROR })

    const repaired = computeInterruptedStepRepair({
      title: '调用工具: bash',
      status: 'running',
      error: undefined as string | undefined,
      toolCall: { status: 'executing' },
    })
    expect(repaired?.status).toBe(message.steps?.[0].status)
    expect(repaired?.error).toBe(message.steps?.[0].error)
    expect(repaired?.title).toBe('调用工具: bash')
  })

  /**
   * A11(§13.1):**引擎藏起来的调用不进消息**。老文件没有这一格 = 可见。
   */
  it('A11: a hidden tool call leaves toolCalls/steps alone, and its absence means visible', () => {
    const build = (hidden: boolean): EventLine => {
      const line = eventLine()
      line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
      line.push({
        time: 2, type: 'tool/call',
        data: {
          runId: 'r', callId: 'c1', name: 'bash', argumentsRaw: '{}', messageId: 'a1',
          ...(hidden ? { hidden: true } : {}),
        },
      })
      line.push({
        time: 3, type: 'tool/result',
        data: { runId: 'r', callId: 'c1', isError: false, resultPreview: 'ok', result: { text: 'ok' } },
        surfaceOp: 'append',
      })
      line.push({ time: 4, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })
      return line
    }

    const hidden = projectChatMessages(build(true).events).messages[0]
    expect(hidden.toolCalls).toBeUndefined()
    expect(hidden.steps).toBeUndefined()

    // §10.16:老文件缺这一格 = 可见(修复前的事实)。
    const legacy = projectChatMessages(build(false).events).messages[0]
    expect(legacy.toolCalls).toHaveLength(1)
    expect(legacy.steps).toHaveLength(1)
  })

  /**
   * R-b(§13.6):**生图那一轮的正文**。
   *
   * markdown 里那段 data URL 换成 `onething-blob://<hash>` 落进账本,投影按同一
   * 张表换回去 —— `content` 与 `contentParts` 两格都与消息侧逐字节相同。
   * 那一格还带着 `synthetic`:它没有 `turn-end`(不受收齐闸管),也没有回合号。
   */
  it('R-b: an image turn projects the exact markdown the message carries', () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(4000)}`
    const markdown = `**优化后的提示词:** a cat\n\n![Generated Image|mediaId:m1](${dataUrl})`
    const stored = markdown.replace(dataUrl, 'onething-blob://dddd4444')

    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2, type: 'assistant/chunks',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 2, dt: [0], text: [stored] },
    })
    line.push({
      time: 3, type: 'assistant/part-end',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', len: stored.length, synthetic: true },
    })
    line.push({ time: 4, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })

    const projected = projectChatMessages(line.events, { resolveBlob: () => dataUrl }).messages[0]
    // A 线:引擎写进消息的那两格(`updateMessageContent` + `addMessageContentPart`)。
    expect(projected.content).toBe(markdown)
    expect(projected.contentParts).toEqual([{ type: 'text', content: markdown }])
    // 没有 `request/end` —— 收齐闸对 `synthetic` 豁免(A2 的同一条理由)。
    expect(projected.contentParts?.[0]).not.toHaveProperty('turnIndex')

    // §10.16:老文件没有 `synthetic` = 照旧按闸判(这一轮没收齐 → 一格都没有)。
    const legacy = eventLine()
    legacy.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    legacy.push({
      time: 2, type: 'assistant/chunks',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 2, dt: [0], text: [stored] },
    })
    legacy.push({
      time: 3, type: 'assistant/part-end',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', len: stored.length },
    })
    legacy.push({ time: 4, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })
    expect(projectChatMessages(legacy.events, { resolveBlob: () => dataUrl }).messages[0].contentParts)
      .toBeUndefined()
  })

  it('R-b: an unresolvable image blob keeps the placeholder and reports it', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2, type: 'assistant/chunks',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 2, dt: [0], text: ['see onething-blob://eeee5555 here'] },
    })
    line.push({
      time: 3, type: 'assistant/part-end',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', len: 10, synthetic: true },
    })
    line.push({ time: 4, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })

    const issues: unknown[] = []
    const message = projectChatMessages(line.events, { onIssue: issue => issues.push(issue) }).messages[0]
    expect(message.content).toContain('onething-blob://eeee5555')
    expect(issues).toContainEqual(expect.objectContaining({ kind: 'blob-missing', where: 'part.text' }))
  })

  /**
   * F3(§13.2):**`prepareMessages` 对整份保留序列跑一次**。
   *
   * 探针是一个只在数组末尾盖戳的 prepare:跑一次就只有一个戳,被切成两段各跑
   * 一次就会有两个 —— 从前一次成功压缩就足以让房投影 / goal drive 折叠各看半份。
   */
  it('F3: prepareMessages runs once over the whole retained sequence', () => {
    // 压缩节点插在**中间**(它遮蔽的是第二条,第一条留在它前面)—— 这是唯一
    // 能长出两段的形状,也正是 F3 点名的那一种:按段各跑一次 prepare,房投影
    // 与 goal drive 折叠就各看半份。
    const line = eventLine()
    line.push({
      time: 1, type: 'user/message',
      data: { message: { id: 'u1', role: 'user', content: 'one', timestamp: 1 } }, surfaceOp: 'append',
    })
    const second = line.push({
      time: 2, type: 'user/message',
      data: { message: { id: 'u2', role: 'user', content: 'two', timestamp: 2 } }, surfaceOp: 'append',
    })
    line.push({
      time: 3, type: 'session/compacted',
      data: { messageId: 'k1', summary: 'S', compactedMessageCount: 1, status: 'completed' },
      surfaceOp: { op: 'replace', start: second.seq, end: second.seq },
      sourceEventSeqs: [second.seq],
    })
    line.push({
      time: 4, type: 'user/message',
      data: { message: { id: 'u3', role: 'user', content: 'three', timestamp: 4 } }, surfaceOp: 'append',
    })

    let calls = 0
    const history = projectModelHistory(line.events, {}, {
      prepareMessages: messages => {
        calls += 1
        return messages.map((message, index) => index === messages.length - 1
          ? { ...message, content: `${message.content}[LAST]` }
          : message)
      },
    })
    expect(calls).toBe(1)
    // 整份只盖一个戳:切成两段各跑一次的话会有两个(F3 的病根)。
    expect(JSON.stringify(history).match(/\[LAST\]/g)).toHaveLength(1)
    // 压缩前缀仍然插在它该在的位置(第一条保留消息之后)。
    expect((history[0] as { content: string }).content).toContain('one')
    expect((history[1] as { content: string }).content).toContain('S')
  })

  /**
   * F3 的另一半:**成功的压缩没遮蔽任何东西 = 切点没解出来**,读侧要认得出来。
   * 从前这条路是完全静默的(replace 退化成 append,而模型同时看到摘要和原文)。
   */
  it('F3: a completed compaction that shadowed nothing is a surface violation', () => {
    const line = eventLine()
    line.push({
      time: 1, type: 'user/message',
      data: { message: { id: 'u1', role: 'user', content: 'one', timestamp: 1 } }, surfaceOp: 'append',
    })
    line.push({
      time: 2, type: 'session/compacted',
      data: { messageId: 'k1', summary: 'S', compactedMessageCount: 1, status: 'completed' },
      surfaceOp: 'append',
    })
    expect(foldSurface(line.events).violations)
      .toContainEqual(expect.objectContaining({ reason: 'compact-anchor-unresolved' }))

    // 失败的压缩本来就该 append —— 它不遮蔽任何东西,不算违规。
    const failed = eventLine()
    failed.push({
      time: 1, type: 'user/message',
      data: { message: { id: 'u1', role: 'user', content: 'one', timestamp: 1 } }, surfaceOp: 'append',
    })
    failed.push({
      time: 2, type: 'session/compacted',
      data: { messageId: 'k1', summary: '', compactedMessageCount: 0, status: 'failed', error: 'empty' },
      surfaceOp: 'append',
    })
    expect(failed.events.length).toBe(2)
    expect(foldSurface(failed.events).violations).toEqual([])
  })

  /**
   * F8(§13.2):**回合重放的硬条件**在投影这份物化消息上算一遍。
   *
   * 判据是引擎导出的那一个函数;这里不改字节,要的是"退化看得见" ——
   * 一条多回合的助手消息一旦掉回 collapsed,reasoning 的口径跟着变。
   */
  it('F8: a turn-split fallback on a multi-turn message is reported', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    // 第 1 轮:一段正文 + 一次调用(调用没有回合号来源时硬条件不成立)。
    line.push({
      time: 2, type: 'assistant/chunks',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 2, dt: [0], text: ['one'] },
    })
    line.push({
      time: 3, type: 'assistant/part-end',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', len: 3, synthetic: true },
    })
    line.push({
      time: 4, type: 'assistant/chunks',
      data: { runId: 'r', requestIndex: 2, messageId: 'a1', partIndex: 1, kind: 'text', time0: 4, dt: [0], text: ['two'] },
    })
    line.push({
      time: 5, type: 'assistant/part-end',
      data: { runId: 'r', requestIndex: 2, messageId: 'a1', partIndex: 1, kind: 'text', len: 3 },
    })
    line.push({ time: 6, type: 'request/end', data: { runId: 'r', requestIndex: 1 } })
    line.push({ time: 7, type: 'request/end', data: { runId: 'r', requestIndex: 2 } })
    line.push({ time: 8, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })

    const issues: unknown[] = []
    projectModelHistory(line.events, {}, { onIssue: issue => issues.push(issue) })
    // 一格 `synthetic`(没有 turnIndex)+ 一格有 turnIndex = 硬条件不成立。
    expect(issues).toContainEqual(expect.objectContaining({ kind: 'turn-split-fallback' }))
  })
})

/**
 * §13.8(2026-08-20 真机第六批):**修完之后还差的两格**。
 *
 * 第一类 —— 中止时工具已经在跑:账本上只有 `tool/call`,而引擎在消息上写了
 * 结局正文与自报标题;第二类 —— 生图**失败**的那句正文只落在 `content` 上,
 * R-b 挂在 contentPart 上的采集点看不见它。
 */
describe('§13.8: 中止时在飞的工具 / 生图失败正文', () => {
  /**
   * 真机 `web-7abaca68`(`sleep 20`)与 `fd899977`(`提问已取消`)的最小复现。
   *
   * A 线走的是引擎本人那一个收场函数(`finalizeLingeringAgentLoopToolWork`):
   * 它只加 `status` + `error`,执行途中写下的 `result` 与 `title` 原样留着。
   * B 线因此必须有一条**收场记的** `tool/result` 才对得上。
   */
  it('§13.8-1: an aborted in-flight tool carries its outcome and self-reported title', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: '跑一下 sleep 20' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{
        reasoning: '先跑起来',
        tools: [{
          callId: 'c1', name: 'bash', args: { command: 'sleep 20' },
          // 执行途中工具已经报过标题、也落过一次 partial —— 两格都在 step 上。
          reportedTitle: 'sleep 20',
          inFlightResult: '{"content":[]}',
        }],
      }],
      outcome: 'aborted',
    })
    expectEquivalent(scenario)

    const step = projectChatMessages(scenario.b.events).messages[1].steps?.[0]
    expect(step).toMatchObject({
      status: 'cancelled',
      // 工具自报的标题压过占位标题 —— 修复前这里是 `调用工具: bash`。
      title: 'sleep 20',
      // 执行途中写下的结局正文 —— 修复前这一格整个缺席。
      result: '{"content":[]}',
      // 收场那句话仍然由 run 的收场方式派生,不是工具报的错。
      error: CORE_ABORTED_TOOL_ERROR,
    })
    // 调用那一格**没有**结局对象:那次修复只写 status + error。
    expect(step?.toolCall).toMatchObject({ status: 'cancelled', error: CORE_ABORTED_TOOL_ERROR })
    expect(step?.toolCall).not.toHaveProperty('result')
  })

  /** ask_user 那一支:结局是工具 `annotate{metadata}` 的 JSON,标题是它自报的。 */
  it('§13.8-1: an aborted host-tool interaction keeps its structured outcome text', () => {
    const outcome = '{"interaction":"ask_user","outcome":"aborted","answers":[]}'
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: '问我一句' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{
        text: '我先问一下。',
        tools: [{
          callId: 'c1', name: 'ask_user', args: { questions: [] },
          reportedTitle: '提问已取消', inFlightResult: outcome,
        }],
      }],
      outcome: 'aborted',
    })
    expectEquivalent(scenario)

    const step = projectChatMessages(scenario.b.events).messages[1].steps?.[0]
    expect(step).toMatchObject({ title: '提问已取消', result: outcome, status: 'cancelled' })
  })

  /**
   * §10.16 的成对交付:**老账本没有这条事件**。
   *
   * 那些调用在盘上根本没有 `tool/result` —— 投影照旧走"没等到结局"那一支
   * (占位标题、没有结局正文)。这正是修复前的事实,一个字节都不该改。
   */
  it('§13.8-1 fallback: an old ledger without the cancellation result keeps the placeholder', () => {
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2, type: 'tool/call',
      data: { runId: 'r', callId: 'c1', name: 'bash', argumentsRaw: '{"command":"sleep 20"}', messageId: 'a1' },
    })
    line.push({ time: 3, type: 'run/end', data: { runId: 'r', outcome: 'aborted' } })

    const step = projectChatMessages(line.events).messages[0].steps?.[0]
    expect(step?.title).toBe(coreToolInputStartStepTitle('bash'))
    expect(step).not.toHaveProperty('result')
    expect(step?.status).toBe('cancelled')
    expect(step?.error).toBe(CORE_ABORTED_TOOL_ERROR)
  })

  /**
   * 什么都没留下的那次调用:事件照记(账上多一个结局时刻),而投影的每一格
   * 与"没有这条事件"逐字相同 —— 采集点因此不必先问"引擎写过东西没有"。
   */
  it('§13.8-1: a cancellation result with nothing on it changes not one projected cell', () => {
    const build = (withResult: boolean): EventLine => {
      const line = eventLine()
      line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
      line.push({
        time: 2, type: 'tool/call',
        data: { runId: 'r', callId: 'c1', name: 'bash', argumentsRaw: '{"command":"x"}', messageId: 'a1' },
      })
      if (withResult) {
        line.push({
          time: 3, type: 'tool/result',
          data: { runId: 'r', callId: 'c1', isError: false, cancelled: true, resultPreview: '' },
          surfaceOp: 'append',
        })
      }
      line.push({ time: 4, type: 'run/end', data: { runId: 'r', outcome: 'aborted' } })
      return line
    }
    const withResult = projectChatMessages(build(true).events).messages
    const without = projectChatMessages(build(false).events).messages
    expect(canonicalChatMessages(withResult as unknown as Record<string, unknown>[]))
      .toEqual(canonicalChatMessages(without as unknown as Record<string, unknown>[]))
  })

  /**
   * §13.8 第二类:**生图失败那句正文**只落在 `content` 上。
   *
   * 成功分支写两格(R-b),失败分支只写 `content` —— 形状由 `contentOnly` 说清楚,
   * 不然投影会凭空多出一格 contentPart(那是新的不等,不是修好)。
   */
  it('§13.8-2: a content-only synthesized body lands on content and not on contentParts', () => {
    const body = '图片生成失败: fetch failed'
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2, type: 'assistant/chunks',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 2, dt: [0], text: [body] },
    })
    line.push({
      time: 3, type: 'assistant/part-end',
      data: {
        runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0,
        kind: 'text', len: body.length, synthetic: true, contentOnly: true,
      },
    })
    line.push({ time: 4, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })

    const projected = projectChatMessages(line.events).messages[0]
    // 引擎写的正是这两格:`content` 有话,`contentParts` 一格都没有。
    expect(projected.content).toBe(body)
    expect(projected.contentParts).toBeUndefined()
  })

  /** §10.16:老文件没有这一格 = 照旧两格都产出(生图成功那条路本来就有 part)。 */
  it('§13.8-2 fallback: without the flag the body still becomes a contentPart', () => {
    const body = '图片生成失败: fetch failed'
    const line = eventLine()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' })
    line.push({
      time: 2, type: 'assistant/chunks',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 2, dt: [0], text: [body] },
    })
    line.push({
      time: 3, type: 'assistant/part-end',
      data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', len: body.length, synthetic: true },
    })
    line.push({ time: 4, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })

    const projected = projectChatMessages(line.events).messages[0]
    expect(projected.content).toBe(body)
    expect(projected.contentParts).toEqual([{ type: 'text', content: body }])
  })
})

describe('§13.9: 外部执行器的内轮分界 / 用量归属 / 协作回合标记', () => {
  /**
   * 真机 `web-14d8bc3f`(provider `claude-code-agent`,一次工具调用)的最小复现。
   *
   * 账本上**一次请求**(`request/start` 只有一条),而引擎的回合号在中途 +1:
   * 连接器在工具结果之后发了一条 `finish(tool_calls)` 当轮分界。于是
   *  - 工具之后的正文 / provider-data 是**第 2 回合**(投影从前按请求数推 = 1);
   *  - 带 usage 的是**最后**那条 finish,用量落在第 2 回合 —— 第 1 回合那个工具
   *    step 因此一格 usage 都没有(投影从前照旧给它 = 凭空多一格)。
   */
  it('§13.9-1: an inner round boundary moves the post-tool body onto the next turn', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: '17*23?' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      provider: 'claude-code-agent', model: 'claude-sonnet-5',
      requests: [{
        tools: [{
          callId: 'c1', name: 'Bash', args: { command: 'echo 391' },
          resultText: '391', outcome: 'ok', streamedArgs: true,
        }],
        roundBoundary: {
          // 分界之后 SDK 又调了一次工具(多轮工具在这条路上是常态),再吐正文。
          tools: [{
            callId: 'c2', name: 'read', args: { path: '/x' },
            resultText: 'body', outcome: 'ok', streamedArgs: true,
          }],
          text: '17 × 23 = 391',
          providerData: { provider: 'claude-code-agent', type: 'cost', costUSD: 0.016 },
        },
        usage: { inputTokens: 4, outputTokens: 93 },
      }],
      outcome: 'completed',
    })
    scenario.flushPendingExecutionUsage()
    expectEquivalent(scenario)

    const message = projectChatMessages(scenario.b.events).messages[1]
    // 分界之后的两格都是第 2 回合 —— 真机影子日志上那两行 `a=2 b=1`。
    expect(message.contentParts).toEqual([
      { type: 'text', content: '17 × 23 = 391', turnIndex: 2 },
      {
        type: 'provider-data',
        providerData: { provider: 'claude-code-agent', type: 'cost', costUSD: 0.016 },
        turnIndex: 2,
      },
    ])
    // 第一次调用还在第 1 回合、分界之后那次是第 2 回合(投影从前按"这条 run
    // 跑到第几次请求"推,两次调用会一起塌到 1)。
    expect(message.steps?.map(step => step.turnIndex)).toEqual([1, 2])
    // 用量落在第 2 回合:第 1 回合那个 step 一格都没有,第 2 回合那个才有。
    expect(message.steps?.[0]).not.toHaveProperty('usage')
    expect(message.steps?.[1].usage).toEqual({ inputTokens: 4, outputTokens: 93, totalTokens: 97 })
    // 消息级用量照旧是整次执行的那一份(它与回合归属无关)。
    expect(message.usage).toEqual({ inputTokens: 4, outputTokens: 93, totalTokens: 97 })
  })

  /**
   * §10.16 的成对交付:**老账本没有回合号那一格**。
   *
   * 投影退回按 `requestIndex` 推 —— 那正是修复前的答案(也是普通 provider 上的
   * 同一个数)。构造用同一个场景,B 线剥掉两格新词汇。
   */
  it('§13.9-1 fallback: an old ledger without the turn stamp derives it from the request', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: '17*23?' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{
        tools: [{ callId: 'c1', name: 'Bash', args: { command: 'echo 391' }, resultText: '391', outcome: 'ok' }],
        roundBoundary: { text: '17 × 23 = 391' },
        usage: { inputTokens: 4, outputTokens: 93 },
      }],
      outcome: 'completed',
    })
    const legacy = scenario.b.events.map(event => {
      const { turnIndex: _turn, usageTurnIndex: _usageTurn, ...data } =
        event.data as unknown as Record<string, unknown>
      return { ...event, data } as unknown as typeof event
    })

    const message = projectChatMessages(legacy as typeof scenario.b.events).messages[1]
    // 修复前的事实:回合号按请求数推(1),用量也就落回第 1 回合的 step 上。
    expect(message.contentParts).toEqual([{ type: 'text', content: '17 × 23 = 391', turnIndex: 1 }])
    expect(message.steps?.[0].usage).toEqual({ inputTokens: 4, outputTokens: 93, totalTokens: 97 })
  })

  /**
   * 没有分界时两条口径**逐字节相同** —— 新词汇不改变普通 provider 上的任何一格。
   * (剥掉再投一次,与带着字段投出来的那一份 canonical 相等。)
   */
  it('§13.9-1: without a boundary the stamp and the derivation agree byte for byte', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'read it' })
    scenario.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [
        {
          reasoning: 'let me look',
          tools: [{ callId: 'c1', name: 'read', args: { path: '/x' }, resultText: 'body', outcome: 'ok' }],
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        { text: 'done', usage: { inputTokens: 20, outputTokens: 6 } },
      ],
      outcome: 'completed',
    })
    const legacy = scenario.b.events.map(event => {
      const { turnIndex: _turn, usageTurnIndex: _usageTurn, ...data } =
        event.data as unknown as Record<string, unknown>
      return { ...event, data } as unknown as typeof event
    })
    expect(canonicalChatMessages(projectChatMessages(legacy as typeof scenario.b.events).messages))
      .toEqual(canonicalChatMessages(projectChatMessages(scenario.b.events).messages))
  })

  /**
   * 真机 `agent-exec-…`(Iris 的执行会话):`1.source` a=collab-turn b=(absent)。
   *
   * `stampCollabAgentId` 在建占位消息那一刻同时盖 `agentId` 与 `source` 两格,
   * A4 只把前一格接进了账本。与 A4 逐字同一条规矩:**缺席仍是缺席,不猜**。
   */
  it('§13.9-3: run/start carries the collab turn marker, and its absence stays an absence', () => {
    const marked = new Scenario()
    marked.user({ id: 'u1', content: '干活' })
    marked.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      messageSource: 'collab-turn',
      requests: [{ text: '好的', usage: { inputTokens: 1, outputTokens: 1 } }],
      outcome: 'completed',
    })
    marked.flushPendingExecutionUsage()
    expectEquivalent(marked)
    expect(projectChatMessages(marked.b.events).messages[1].source).toBe('collab-turn')

    const plain = new Scenario()
    plain.user({ id: 'u1', content: '干活' })
    plain.turn({
      runId: 'r1', messageId: 'a1', kind: 'send',
      requests: [{ text: '好的', usage: { inputTokens: 1, outputTokens: 1 } }],
      outcome: 'completed',
    })
    plain.flushPendingExecutionUsage()
    expectEquivalent(plain)
    expect(projectChatMessages(plain.b.events).messages[1]).not.toHaveProperty('source')
  })
})

// ============================================================================
// §13.10:压缩收尾换掉占位那一格 / 会话换 agent 记一条账
// ============================================================================

describe('§13.10: 压缩标记只有一格 / agent 切换进账本', () => {
  /**
   * M3(真机第三轮):一次**失败**的压缩在投影上多出一条消息。
   *
   * 账本上是两条事件、一条消息:`system/message`(占位,`status:'compacting'`)
   * 与 `session/compacted`(收尾,failed)。归约器从前对后者无条件再登记一格,
   * 于是 `projectChatMessages` 比 `messages.jsonl` 多 N 条(每次尝试一条),
   * 而活下来的那条冻在 `compacting`、时刻还是**记账时刻**(真机差 5–9ms)。
   */
  it('§13.10 M3: a failed compaction projects exactly one marker, settled and stamped by the message', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'one' })
    scenario.turn({ runId: 'r1', messageId: 'a1', kind: 'send', requests: [{ text: 'reply one' }], outcome: 'completed' })
    scenario.user({ id: 'u2', content: 'two' })
    scenario.turn({ runId: 'r2', messageId: 'a2', kind: 'send', requests: [{ text: 'reply two' }], outcome: 'completed' })
    scenario.failedCompact({ messageId: 'k1', error: 'Context compact returned an empty summary.', throughMessageId: 'a1' })

    expectEquivalent(scenario)

    const messages = projectChatMessages(scenario.b.events).messages
    expect(messages.map(message => message.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'k1'])
    const marker = messages[messages.length - 1]
    // 正文是 failed(不是冻在 compacting 的占位),时刻是**消息自己**那一格。
    expect(JSON.parse(String(marker.content)).status).toBe('failed')
    expect(marker.timestamp).toBe(scenario.a.messages[4].timestamp)
  })

  /** 同一条病在**成功**的压缩上一样成立(真机第三轮没驱动起来,判据在这里)。 */
  it('§13.10 M3: a completed compaction projects exactly one marker too', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'one' })
    scenario.turn({ runId: 'r1', messageId: 'a1', kind: 'send', requests: [{ text: 'reply one' }], outcome: 'completed' })
    scenario.user({ id: 'u2', content: 'two' })
    scenario.turn({ runId: 'r2', messageId: 'a2', kind: 'send', requests: [{ text: 'reply two' }], outcome: 'completed' })
    scenario.compact({ messageId: 'k1', summary: '## Goal\nship it', throughMessageId: 'a1' })

    expectEquivalent(scenario)

    const messages = projectChatMessages(scenario.b.events).messages
    expect(messages.filter(message => message.id === 'k1')).toHaveLength(1)
    expect(JSON.parse(String(messages[messages.length - 1].content)).status).toBe('completed')
  })

  /**
   * 一次压缩失败、再压一次成功:两条标记消息各自一格,不是四格。
   * (真机上"多出 N 条"里的 N 正是尝试次数。)
   */
  it('§13.10 M3: a retried compaction keeps one node per attempt', () => {
    const scenario = new Scenario()
    scenario.user({ id: 'u1', content: 'one' })
    scenario.turn({ runId: 'r1', messageId: 'a1', kind: 'send', requests: [{ text: 'reply one' }], outcome: 'completed' })
    scenario.user({ id: 'u2', content: 'two' })
    scenario.turn({ runId: 'r2', messageId: 'a2', kind: 'send', requests: [{ text: 'reply two' }], outcome: 'completed' })
    scenario.failedCompact({ messageId: 'k1', error: 'empty summary', throughMessageId: 'a1' })
    scenario.compact({ messageId: 'k2', summary: '## Goal\nship it', throughMessageId: 'a1' })

    expectEquivalent(scenario)
    expect(projectChatMessages(scenario.b.events).messages.map(message => message.id))
      .toEqual(['u1', 'a1', 'u2', 'a2', 'k1', 'k2'])
  })

  /**
   * 旧文件兜底(§10.16):账本里只有 `session/compacted`、没有那条占位
   * `system/message`(迁移/导入出来的会话)—— 照旧追加一格,那正是修复前的事实。
   */
  it('§13.10 M3 fallback: a compacted event without its placeholder still appends a node', () => {
    const events: SessionLogEventRecord[] = [
      { seq: 1, time: 1, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: 'hi', timestamp: 1 } }, surfaceOp: 'append' },
      {
        seq: 2, time: 2, type: 'session/compacted',
        data: { messageId: 'k1', summary: '## Goal\nx', compactedMessageCount: 1, status: 'completed' },
        surfaceOp: 'append',
      },
    ] as unknown as SessionLogEventRecord[]
    const messages = projectChatMessages(events).messages
    expect(messages.map(message => message.id)).toEqual(['u1', 'k1'])
    // 时刻退回记账时刻(账本里没有第二个来源可问)。
    expect(messages[1].timestamp).toBe(2)
  })

  /**
   * M7:换 agent 记一条 `session/agent-changed`,投影把它折成**会话级**元数据
   * (不是一条消息 —— 屏幕上什么都没多出来)。
   */
  it('§13.10 M7: switching the agent folds into session-level meta, not a message', () => {
    const events: SessionLogEventRecord[] = [
      { seq: 1, time: 1, type: 'session/created', data: { sessionId: 's1', agentId: 'onething', model: 'm1', provider: 'p1' } },
      { seq: 2, time: 2, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: 'hi', timestamp: 2 } }, surfaceOp: 'append' },
      { seq: 3, time: 3, type: 'session/agent-changed', data: { from: 'onething', to: 'claude-code-agent' } },
    ] as unknown as SessionLogEventRecord[]

    const state = foldSessionProjection(events)
    expect(state.sessionMeta).toEqual({ agentId: 'claude-code-agent', model: 'm1', provider: 'p1' })
    // 屏幕上只有那条用户消息。
    expect(projectChatMessages(events).messages.map(message => message.id)).toEqual(['u1'])
  })

  /** 旧文件:没有 `session/agent-changed` 就是没有 —— 会话级元数据停在建会话那一刻。 */
  it('§13.10 M7 fallback: an old ledger without the event keeps the created agent', () => {
    const events: SessionLogEventRecord[] = [
      { seq: 1, time: 1, type: 'session/created', data: { sessionId: 's1', agentId: 'onething' } },
      { seq: 2, time: 2, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: 'hi', timestamp: 2 } }, surfaceOp: 'append' },
    ] as unknown as SessionLogEventRecord[]
    expect(foldSessionProjection(events).sessionMeta).toEqual({ agentId: 'onething' })
  })
})
