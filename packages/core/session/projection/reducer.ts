/**
 * 会话投影的**归约器** —— `(state, event) → state`(§9.4)。
 *
 * `projectChatMessages` 是它上面的一次 fold;活跃会话每来一条事件走一次
 * `reduceSessionProjection`,只 patch 尾部那一格(§3.2"活跃流"那一段)。
 * 两条路必须给出同一个结果 —— 合同测试里 `fold ≡ push` 那一条钉的就是它。
 *
 * ## 所有权约定(读到这里的人必须知道)
 *
 * 归约器返回的是**新的 state 对象**,但内部的 Map/数组/节点是**线性持有**的:
 * 传进去的那份 state 交出去之后就不该再用了。理由是性能 —— 每条事件复制一遍
 * 全部节点会让"活跃会话增量维护"退化成 O(n²),而这个投影要跑在主线程上
 * (§7.2 M7 点名的那条)。需要历史某一刻的快照就 `projectChatMessages(events,
 * {upToSeq})` 重跑一次:那是纯的。
 *
 * ## 两种"看不见"是两回事
 *
 * - **UI 隐藏**(`node.hidden`):删除 / 清空 / 编辑重发截断掉的消息。UI 上没了。
 * - **surface 遮蔽**(`SurfaceIndex`):只是不进模型可见历史。`session/compacted`
 *   走的是这一种 —— 被压缩的消息在 UI 上**照旧显示**(§9.4 的那条"注意"),
 *   只有下一次请求看不到它们。
 *
 * 把这两件事混成一个标志位是最容易犯的错:压缩一次,聊天记录就当场少半屏。
 */

import type {
  SessionAssistantPartKind,
  SessionEventMessage,
  SessionLogEventRecord,
  SessionResponseUsage,
} from '../events/types.js'
import { CORE_ABORTED_TOOL_ERROR, CORE_LINGERING_TOOL_ERROR } from '../../engine/agent-loop-executor.js'
import { coreStepTypeForToolName, coreToolInputStartStepTitle } from '../../engine/stream-processor.js'
import { getStepType } from '../../engine/tool-step.js'
import { toolResultToStructured } from '../../tools/tool-result.js'
import {
  CORE_INTERRUPTED_PERMISSION_ERROR,
  CORE_INTERRUPTED_TOOL_ERROR,
  isCoreInterruptedToolResultText,
} from '../interrupted.js'
import {
  resolveProjectionBlobRef,
  resolveProjectionBlobText,
  type ProjectionMaterializeOptions,
} from './blobs.js'
import { SurfaceIndex } from './surface.js'

/**
 * 有结局的三态 —— 与 `sessions/session-dehydrate.ts` 的冷加载补算同一张表
 * (`partialResult` 只在这三态上算得回来)。
 */
const TERMINAL_STEP_STATUSES = new Set<ProjectedStepStatus>(['completed', 'failed', 'cancelled'])
import type {
  ProjectedContentPart,
  ProjectedStep,
  ProjectedStepStatus,
  ProjectedStepUsage,
  ProjectedToolCall,
  ProjectedToolCallStatus,
} from './types.js'

// ============ 节点 ============

interface BaseNode {
  eventSeq: number
  time: number
  hidden: boolean
  /** `message/patched` 的叠加层。 */
  patch: Record<string, unknown>
}

export interface MessageNode extends BaseNode {
  kind: 'message'
  messageId: string
  message: SessionEventMessage
  /** 用户消息的尾块上下文(`context/turn-update`)。 */
  turnContext?: { set?: Record<string, string>; removed?: string[] }
}

interface PartState {
  partIndex: number
  kind: SessionAssistantPartKind
  requestIndex: number
  toolCallId?: string
  /**
   * `tool-input` 段的工具名(`assistant/chunks|part-end.toolName`)。
   *
   * 孤儿参数流(等不到 `tool/call` 的那一段)只有这一格说得出"被打断的是谁" ——
   * 引擎的占位卡从第一帧起就带着名字,投影不许把它留空(§10.14 第 7 类)。
   */
  toolName?: string
  text: string
  ended: boolean
  /** part 收齐的时刻。`tool-input` 的这一格就是 toolCall 的 `receivedAt`。 */
  endedAt?: number
  /**
   * R-b(§13.6):这一格是引擎**直接落到消息上**的,不是模型某一轮的产出。
   *
   * 生图那条特化流一条 delta 都不经 agent-loop:正文一写就落在消息上,
   * 既没有 `turn-end`(所以不受 `settledRequests` 那道闸管),也没有回合号
   * (所以不派生 `turnIndex` —— 消息上那一格就没有它)。缺席 = 老文件 = 照旧。
   */
  synthetic?: boolean
  blob?: { hash: string; bytes: number; mime?: string }
  /**
   * `provider-data` part 的载荷,已经解回对象(A1,§13.1)。
   *
   * 事件行里是 `{text}`(那个对象的 JSON)或 `{blob}`;解不开就没有这一格,
   * 而 blob 那一支留在 `blob` 里 —— 与图片 part 走同一个坑口,将来注入
   * resolver(G8)时一处修好两处。
   */
  providerData?: unknown
}

interface ToolState {
  callId: string
  /** provider 给的原始工具名(`tool/call.name`)。 */
  name: string
  /**
   * A6+A7:引擎归一之后的身份(`tool/call.resolvedToolId` / `displayName`)。
   *
   * 消息上那两格就是它们(`applyCoreToolCallChunk`:`toolId = resolved.toolId`、
   * `toolName = resolved.displayName`),而 `getStepType` / `detectSkillUsage`
   * 在引擎里读的都是 `toolName`。老文件没有这两格 → 退回 `name`(= 修复前的
   * 行为,§10.16)。
   */
  resolvedToolId?: string
  displayName?: string
  toolId?: string
  /** G3:父调用。有它就挂到父 step 的 `childSteps` 里,没有就平铺。 */
  parentCallId?: string
  argumentsRaw: string
  callTime: number
  callSeq: number
  turnIndex: number
  streamingArgs?: string
  receivedAt?: number
  resultText?: string
  resultBlob?: { hash: string; bytes: number; mime?: string }
  /** 结构化结局(`tool/result.resultData` 解出来的那一份)。 */
  resultData?: unknown
  /** 结构化结局超了 64KB 那一支 —— 物化时由 resolver 换回来(A8)。 */
  resultDataBlob?: { hash: string; bytes: number; mime?: string }
  resultTime?: number
  isError?: boolean
  outcome?: 'ok' | 'invalid' | 'denied' | 'aborted' | 'failed'
  previewTitle?: string
  /** 工具自报的标题(`tool/result.reportedTitle`)—— 引擎的 step 标题就是它。 */
  reportedTitle?: string
  rejectionReason?: string
  /** `tool/result` 事件的 seq —— surface 剪枝按它判定。 */
  resultSeq?: number
  /**
   * A11(§13.1):引擎把这次调用**藏起来了**(`publish:false`)。
   *
   * 藏起来的调用不进 `message.toolCalls`,也没有 step —— 而记录器是无条件记的
   * (它挂在 agent-loop 的事件流上,看不见呈现层的决定)。所以可见性由引擎那
   * 一个判定点(`stream-processor.ts` 的 `visible`)经端口回传,记在
   * `tool/call.hidden` 上;投影据此从 `toolCalls[]` / `steps[]` 里摘掉它。
   * **轨迹与审计照旧看得见**(它们读事件,不读投影)。
   * 老文件没有这一格 = 可见(修复前的事实)。
   */
  hidden?: boolean
  /**
   * A12(§13.1):这次调用问过审批,而审批**还没有答复**。
   *
   * 引擎那一刻的消息是 `toolCall.status='pending' + requiresConfirmation:true`、
   * `step.status='awaiting-confirmation'`(`settleAgentLoopToolCallResult` /
   * `buildAgentLoopToolResultPresentation` 的 awaiting 分支)。账本里这件事早就
   * 有:`permission/asked` 有、`permission/answered` 没有 —— 只是从前没人 join。
   */
  awaitingPermission?: boolean
}

export interface AssistantNode extends BaseNode {
  kind: 'assistant'
  runId: string
  messageId: string
  agentId?: string
  provider?: string
  model?: string
  /** 触发这次执行的命令来源(`run/start.origin`)。 */
  origin?: Record<string, unknown>
  ended: boolean
  outcome?: 'completed' | 'aborted' | 'error' | 'interrupted'
  errorDetails?: string
  /** G5:`skill/activated` 记下的技能名。 */
  skillUsed?: string
  /** G5 派生 `thinkingTime` 的三个时刻(只记时刻,时长是消费者算的)。 */
  firstRequestStartAt?: number
  firstTokenAt?: number
  reasoningFirstAt?: number
  reasoningLastAt?: number
  parts: Map<number, PartState>
  partOrder: number[]
  tools: Map<string, ToolState>
  toolOrder: string[]
  usage?: ProjectedStepUsage
  /**
   * requestIndex → 这次**执行**里的第几轮请求(1 起),即引擎的 `turnIndex`。
   *
   * 一次执行通常就是一个 run,但 steering 会让它跨两条 run(`continuesRunId`):
   * 那时这张表是从被接手的那条 run **抄过来**的,回合号接着往下数。
   */
  turnByRequest: Map<number, number>
  turnCount: number
  usageByTurn: Map<number, ProjectedStepUsage>
  /**
   * 收齐了的请求(`request/end` = 记录器在 `turn-end` 那一刻写的)。
   *
   * 引擎把这一轮的 part **落到消息上**的唯一时刻就是那一刻
   * (`applyAgentLoopFinishChunkWithAdapters` → `persistTurnContentParts`):
   * 被 abort / 出错打断的那一轮,正文与推理只活在流里,`contentParts` 上
   * 一格都没有。投影按同一条闸(§10.14 第 7 类)。
   */
  settledRequests: Set<number>
  /** `run/start.continuesRunId`:这次 run 接着哪一次 run 的执行往下跑。 */
  continuesRunId?: string
  /**
   * 反向:哪一次 run 接手了这次执行(steering 换消息时由后来者盖上)。
   *
   * 被接手的那条消息**没有 usage** —— 引擎的累加器一路带到接手的那条消息上
   * (`state.ctx.accumulatedUsage` 跟着 `assistantMessageId` 走),被打断的那条
   * 从来没被写过用量。step 级的每轮用量照旧有(那是 turn-end 当场写的)。
   */
  continuedByRunId?: string
}

export interface CompactedNode extends BaseNode {
  kind: 'compacted'
  messageId: string
  summary: string
  compactedMessageCount: number
  compactedThroughMessageId?: string
  status: 'completed' | 'failed'
  error?: string
}

export type ProjectionNode = MessageNode | AssistantNode | CompactedNode

// ============ 状态 ============

export interface SessionProjectionState {
  nodes: ProjectionNode[]
  byEventSeq: Map<number, ProjectionNode>
  byMessageId: Map<string, ProjectionNode>
  runs: Map<string, AssistantNode>
  surface: SurfaceIndex
  activeRun?: { runId: string; messageId: string }
  /** 最近一条可见用户消息的 id —— `context/turn-update` 的默认落点。 */
  lastUserMessageId?: string
  /** callId → 该 `tool/result` 事件的 seq(surface 剪枝用)。 */
  toolResultSeqByCallId: Map<string, number>
  /**
   * G6:`permission/answered{approved:false, reason}` 按 toolCallId 落到调用上。
   * 审批常常**早于** `tool/call` 落账(权限在 plan 之后、apply 之前问),所以
   * 先存这里,`tool/call` 一到就取走 —— 不是补丁,是两条时刻线的汇合。
   */
  rejectionReasonByCallId: Map<string, string>
  /** requestId → toolCallId:`permission/answered` 自己没带 callId 时回头查。 */
  permissionCallIdByRequestId: Map<string, string>
  /**
   * A12:问过审批、还没答复的那些 callId。
   *
   * 与 `rejectionReasonByCallId` 同一条理由:两条时刻线的汇合处不一定按顺序到 ——
   * 审批问在 `tool/call` 之后(plan 之后、apply 之前),但老文件的 `tool/call`
   * 可能整条不在(只有七类的那段历史),所以先记在会话级,`tool/call` 一到就取。
   */
  awaitingPermissionCallIds: Set<string>
  lastSeq: number
}

export function createSessionProjectionState(): SessionProjectionState {
  return {
    nodes: [],
    byEventSeq: new Map(),
    byMessageId: new Map(),
    runs: new Map(),
    surface: new SurfaceIndex(),
    toolResultSeqByCallId: new Map(),
    rejectionReasonByCallId: new Map(),
    permissionCallIdByRequestId: new Map(),
    awaitingPermissionCallIds: new Set(),
    lastSeq: 0,
  }
}

// ============ 归约 ============

export function reduceSessionProjection(
  state: SessionProjectionState,
  event: SessionLogEventRecord,
): SessionProjectionState {
  state.surface.push(event)
  state.lastSeq = Math.max(state.lastSeq, event.seq)

  switch (event.type) {
    case 'user/message':
    case 'system/message':
    case 'message/imported': {
      addMessageNode(state, event.seq, event.time, event.data.message)
      break
    }

    case 'user/message-edited': {
      // 编辑重发 = 改写这条 + 砍掉它之后的一切(今天 `truncateFrom{inclusive:false}`)。
      const previous = state.byMessageId.get(event.data.messageId)
      if (previous) {
        hideFrom(state, previous)
      }
      addMessageNode(state, event.seq, event.time, event.data.message)
      break
    }

    case 'message/deleted': {
      const node = state.byMessageId.get(event.data.messageId)
      if (node) node.hidden = true
      // A5(§13.1):一条 `message/deleted` 可以遮蔽**一整段**。
      //
      // `truncateFrom{inclusive:true}`(regenerate / 中段 retry)翻译出来的就是
      // 这一条,而它的 replace 区间是"这条到末尾" —— 引擎那边删的是目标**以及
      // 它后面的一切**。从前这里只 hide 目标那一格,于是对非末尾消息 retry 时
      // 投影比事实多出整段(surface 半对:历史绿、消息红)。
      //
      // 遮蔽范围写在事件的**账本层**字段上,不靠投影猜:`deleteMessage` 那条的
      // 区间就是它自己一格(start === end),两条命令因此共用同一段代码。
      hideEventCoveredNodes(state, event)
      break
    }

    case 'session/cleared': {
      for (const node of state.nodes) node.hidden = true
      state.lastUserMessageId = undefined
      break
    }

    case 'message/patched': {
      const node = state.byMessageId.get(event.data.messageId)
      if (node) Object.assign(node.patch, sanitizePatch(node, event.data.patch))
      break
    }

    case 'session/compacted': {
      const node: CompactedNode = {
        kind: 'compacted',
        eventSeq: event.seq,
        time: event.time,
        hidden: false,
        patch: {},
        messageId: event.data.messageId,
        summary: event.data.summary,
        compactedMessageCount: event.data.compactedMessageCount,
        compactedThroughMessageId: event.data.compactedThroughMessageId,
        status: event.data.status ?? 'completed',
        error: event.data.error,
      }
      register(state, node)
      break
    }

    case 'run/start': {
      // steering:换的是助手消息,不是执行。回合号与用量累加器都从被接手的那条
      // run 上接着走(引擎侧就是同一个 agent-loop 在跑)。
      // 兜底(2026-08-20,词汇演进):`continuesRunId` 是 9dde092d 才有的字段,
      // 修复前的 recorder 写出的 steer run 没有它。`kind:'steer'` 的 run/start
      // **只有** `rotateSessionRun` 一个产地(必然延续上一条 run),所以旧事件按
      // "账本里最近开张的那条 run"推断 —— 推出来的正是当年该写的值。新事件仍以
      // 显式字段为准,只在缺席时兜底。
      const continuesRunId = event.data.continuesRunId
        ?? (event.data.kind === 'steer' ? lastRunId(state) : undefined)
      const continued = continuesRunId ? state.runs.get(continuesRunId) : undefined
      const node: AssistantNode = {
        kind: 'assistant',
        eventSeq: event.seq,
        // 助手消息自己的时刻优先于记账时刻(见 `SessionRunStartEventData.timestamp`)。
        time: event.data.timestamp ?? event.time,
        hidden: false,
        patch: {},
        runId: event.data.runId,
        messageId: event.data.assistantMessageId,
        agentId: event.data.agentId,
        provider: event.data.provider,
        model: event.data.model,
        origin: event.data.origin,
        ended: false,
        parts: new Map(),
        partOrder: [],
        tools: new Map(),
        toolOrder: [],
        // 抄一份而不是共享:接手之后两条 run 各自还会往里写。
        turnByRequest: new Map(continued?.turnByRequest ?? []),
        turnCount: continued?.turnCount ?? 0,
        usageByTurn: new Map(continued?.usageByTurn ?? []),
        // 与回合号同一条理由:steering 换的是消息不是执行,前一条 run 已经收齐的
        // 那几轮在接手的这条上照样是"收齐了的"。
        settledRequests: new Set(continued?.settledRequests ?? []),
        ...(continued?.usage ? { usage: continued.usage } : {}),
        ...(continuesRunId ? { continuesRunId } : {}),
      }
      if (continued) continued.continuedByRunId = node.runId
      register(state, node)
      state.runs.set(node.runId, node)
      state.activeRun = { runId: node.runId, messageId: node.messageId }
      break
    }

    case 'run/end': {
      const run = state.runs.get(event.data.runId)
      if (run) {
        run.ended = true
        run.outcome = event.data.outcome
        if (event.data.outcome === 'error' && event.data.error) {
          run.errorDetails = event.data.error.message
        }
        for (const tool of run.tools.values()) {
          if (tool.resultTime === undefined) tool.outcome ??= 'aborted'
        }
      }
      if (state.activeRun?.runId === event.data.runId) state.activeRun = undefined
      break
    }

    case 'request/recipe':
    case 'request/response':
    case 'request/error': {
      const run = state.runs.get(event.data.runId)
      if (!run) break
      turnOf(run, event.data.requestIndex)
      if (event.type === 'request/response' && event.data.usage) {
        const usage = normalizeUsage(event.data.usage)
        run.usage = addUsage(run.usage, usage)
        run.usageByTurn.set(turnOf(run, event.data.requestIndex), usage)
      }
      break
    }

    case 'assistant/chunks': {
      const run = state.runs.get(event.data.runId)
      if (!run) break
      const part = ensurePart(
        run, event.data.partIndex, event.data.kind, event.data.requestIndex,
        event.data.toolCallId, event.data.toolName,
      )
      part.text += event.data.text.join('')
      if (event.data.kind === 'reasoning' && event.data.dt.length > 0) {
        const first = event.data.time0 + event.data.dt[0]
        const last = event.data.time0 + event.data.dt[event.data.dt.length - 1]
        if (run.reasoningFirstAt === undefined || first < run.reasoningFirstAt) run.reasoningFirstAt = first
        if (run.reasoningLastAt === undefined || last > run.reasoningLastAt) run.reasoningLastAt = last
      }
      if (part.kind === 'tool-input' && part.toolCallId) {
        const tool = run.tools.get(part.toolCallId)
        if (tool) tool.streamingArgs = part.text
      }
      break
    }

    case 'assistant/part-end': {
      const run = state.runs.get(event.data.runId)
      if (!run) break
      const part = ensurePart(
        run, event.data.partIndex, event.data.kind, event.data.requestIndex,
        event.data.toolCallId, event.data.toolName,
      )
      part.ended = true
      part.endedAt = event.time
      if (event.data.blob) part.blob = event.data.blob
      // R-b:引擎直接落到消息上的那一格(生图正文)。缺席 = 老文件 = 照旧。
      if (event.data.synthetic === true) part.synthetic = true
      // A1:provider-data 的载荷一次到齐(它没有 delta)。
      const payload = event.data.providerData
      if (payload && 'text' in payload) part.providerData = parseJsonSafely(payload.text)
      else if (payload && 'blob' in payload) part.blob = payload.blob
      if (part.kind === 'tool-input' && part.toolCallId) {
        // 参数流**先**收齐,`tool/call` 才落账(铁律 2:执行前记账在参数定稿之后)。
        // 所以这里通常还没有 tool —— 有就补,没有就等 `tool/call` 回头来取。
        const tool = run.tools.get(part.toolCallId)
        if (tool) tool.receivedAt = event.time
      }
      break
    }

    case 'tool/call': {
      const run = resolveRun(state, event.data.runId, event.data.messageId)
      if (!run) break
      const existing = run.tools.get(event.data.callId)
      const tool: ToolState = existing ?? {
        callId: event.data.callId,
        name: event.data.name,
        argumentsRaw: event.data.argumentsRaw,
        callTime: event.time,
        callSeq: event.seq,
        turnIndex: run.turnCount || 1,
      }
      tool.name = event.data.name
      if (event.data.resolvedToolId !== undefined) tool.resolvedToolId = event.data.resolvedToolId
      if (event.data.displayName !== undefined) tool.displayName = event.data.displayName
      // A11:老文件没有这一格 → 可见(缺席 = 修复前的事实)。
      if (event.data.hidden === true) tool.hidden = true
      tool.argumentsRaw = event.data.argumentsRaw
      if (event.data.parentCallId !== undefined) tool.parentCallId = event.data.parentCallId
      const pendingReason = state.rejectionReasonByCallId.get(tool.callId)
      if (pendingReason !== undefined) tool.rejectionReason = pendingReason
      if (state.awaitingPermissionCallIds.has(tool.callId)) tool.awaitingPermission = true
      // 参数已经定稿:流式片段撤下(它表达的是"还在生成")。
      tool.streamingArgs = undefined
      if (tool.receivedAt === undefined) {
        tool.receivedAt = findToolInputPartEnd(run, tool.callId)
      }
      if (!existing) {
        run.tools.set(tool.callId, tool)
        run.toolOrder.push(tool.callId)
      }
      break
    }

    case 'tool/result': {
      const run = findRunByCallId(state, event.data.callId, event.data.runId)
      if (!run) break
      const tool = run.tools.get(event.data.callId)
      if (!tool) break
      tool.isError = event.data.isError
      tool.resultTime = event.time
      tool.resultSeq = event.seq
      state.toolResultSeqByCallId.set(tool.callId, event.seq)
      const result = event.data.result
      if (result && 'text' in result) tool.resultText = result.text
      else if (result && 'blob' in result) tool.resultBlob = result.blob
      // 老文件只有 500 字预览。诚实地把它当结果 —— 那**就是**那份账里存下的全部。
      else tool.resultText = event.data.resultPreview
      const resultData = event.data.resultData
      if (resultData && 'text' in resultData) tool.resultData = parseJsonSafely(resultData.text)
      // A8:结构化结局也可能走了 blob(与正文同一条 64KB 线)。从前这一支被整格
      // 丢掉 —— 大结果的工具卡在投影里连 metadata 都没有。
      else if (resultData && 'blob' in resultData) tool.resultDataBlob = resultData.blob
      if (event.data.reportedTitle) tool.reportedTitle = event.data.reportedTitle
      break
    }

    case 'tool/audit': {
      const run = findRunByCallId(state, event.data.callId, event.data.runId)
      const tool = run?.tools.get(event.data.callId)
      if (!tool) break
      tool.toolId = event.data.toolId
      tool.outcome = event.data.outcome
      tool.previewTitle = event.data.previewTitle
      break
    }

    case 'context/turn-update': {
      const node = state.byMessageId.get(event.data.messageId)
      if (node?.kind === 'message') {
        node.turnContext = {
          ...(event.data.set ? { set: event.data.set } : {}),
          ...(event.data.removed ? { removed: event.data.removed } : {}),
        }
      }
      break
    }

    case 'skill/activated': {
      const run = resolveRun(state, event.data.runId, event.data.messageId)
      if (run) run.skillUsed = event.data.skill
      break
    }

    case 'request/start': {
      const run = resolveRun(state, event.data.runId, event.data.messageId)
      if (run && run.firstRequestStartAt === undefined) run.firstRequestStartAt = event.time
      break
    }

    case 'assistant/first-token': {
      const run = resolveRun(state, event.data.runId, event.data.messageId)
      if (run && run.firstTokenAt === undefined) run.firstTokenAt = event.time
      break
    }

    case 'permission/asked': {
      if (event.data.toolCallId) {
        state.permissionCallIdByRequestId.set(event.data.requestId, event.data.toolCallId)
        // A12:从这一刻起这次调用在等确认,直到 `permission/answered` 到达。
        state.awaitingPermissionCallIds.add(event.data.toolCallId)
        const asked = findRunByCallId(state, event.data.toolCallId, event.data.runId)
        const tool = asked?.tools.get(event.data.toolCallId)
        if (tool) tool.awaitingPermission = true
      }
      break
    }

    case 'permission/answered': {
      // A12:**批准与否都**结束"等确认"那个状态 —— 下面那段只管拒绝的理由。
      const answeredCallId = event.data.toolCallId
        ?? state.permissionCallIdByRequestId.get(event.data.requestId)
      if (answeredCallId) {
        state.awaitingPermissionCallIds.delete(answeredCallId)
        const answeredRun = findRunByCallId(state, answeredCallId, event.data.runId)
        const answeredTool = answeredRun?.tools.get(answeredCallId)
        if (answeredTool) answeredTool.awaitingPermission = false
      }
      if (event.data.approved) break
      const callId = answeredCallId
      if (!callId) break
      const reason = event.data.reason
      if (reason === undefined) break
      state.rejectionReasonByCallId.set(callId, reason)
      const run = findRunByCallId(state, callId, event.data.runId)
      const tool = run?.tools.get(callId)
      if (tool) tool.rejectionReason = reason
      break
    }

    case 'request/end': {
      // 这一轮走到了 `turn-end` —— 引擎正是在这一刻把它的 part 落到消息上。
      const run = resolveRun(state, event.data.runId, undefined)
      if (run) run.settledRequests.add(event.data.requestIndex)
      break
    }

    // 记录在案但不改投影:它们回答的是"什么时候发生了什么",不是"屏幕上有什么"。
    case 'session/created':
    case 'session/agent-changed':
    case 'session/model-changed':
    case 'session/workdir-changed':
    case 'request/tools':
    case 'request/header':
    case 'interaction/asked':
    case 'interaction/answered':
    case 'plugin/status':
      break
  }

  return state
}

// ============ 内部 ============

function register(state: SessionProjectionState, node: ProjectionNode): void {
  state.nodes.push(node)
  state.byEventSeq.set(node.eventSeq, node)
  state.byMessageId.set(node.messageId, node)
}

function addMessageNode(
  state: SessionProjectionState,
  eventSeq: number,
  time: number,
  message: SessionEventMessage,
): void {
  const node: MessageNode = {
    kind: 'message',
    eventSeq,
    time,
    hidden: false,
    patch: {},
    messageId: message.id,
    message,
  }
  register(state, node)
  if (message.role === 'user') state.lastUserMessageId = message.id
}

/**
 * 把这条事件**遮蔽到的节点**在 UI 上一并隐藏(A5)。
 *
 * 只给 `message/deleted` 用。压缩(`session/compacted`)带的也是一段 replace,
 * 但那是另一种"看不见"——被压掉的消息在聊天记录里照旧显示,只有下一次请求
 * 看不到它们(文件头那条"两种看不见是两回事")。所以这段代码**不**放在
 * `state.surface.push` 旁边当成通用规则。
 *
 * `sourceEventSeqs` 优先:它是翻译时从活 surface 上取下来的**确切名单**;
 * 只有 replace 区间时按 [start, end] 圈(两者由同一个采集点写出,恒等)。
 */
function hideEventCoveredNodes(state: SessionProjectionState, event: SessionLogEventRecord): void {
  const seqs = event.sourceEventSeqs
  if (seqs && seqs.length > 0) {
    for (const seq of seqs) {
      const node = state.byEventSeq.get(seq)
      if (node) node.hidden = true
    }
    return
  }
  const op = event.surfaceOp
  if (!op || op === 'append') return
  for (const node of state.nodes) {
    if (node.eventSeq >= op.start && node.eventSeq <= op.end) node.hidden = true
  }
}

/** 从 `node`(含)开始把后面的全部隐藏 —— 编辑重发的截断语义。 */
function hideFrom(state: SessionProjectionState, node: ProjectionNode): void {
  const from = state.nodes.indexOf(node)
  if (from === -1) return
  for (let index = from; index < state.nodes.length; index++) {
    state.nodes[index].hidden = true
  }
}

/**
 * `message/patched` 只叠加**非正文**字段。
 *
 * assistant 节点上的 content/contentParts/reasoning 唯一来源是 chunks
 * (§9.2 助手行);让一条 patch 事件盖过它们,就等于又开了第二个正文来源。
 */
function sanitizePatch(node: ProjectionNode, patch: Record<string, unknown>): Record<string, unknown> {
  if (node.kind !== 'assistant') return patch
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'content' || key === 'contentParts' || key === 'reasoning') continue
    next[key] = value
  }
  return next
}

function ensurePart(
  run: AssistantNode,
  partIndex: number,
  kind: SessionAssistantPartKind,
  requestIndex: number,
  toolCallId: string | undefined,
  toolName?: string,
): PartState {
  let part = run.parts.get(partIndex)
  if (!part) {
    part = { partIndex, kind, requestIndex, toolCallId, text: '', ended: false }
    run.parts.set(partIndex, part)
    run.partOrder.push(partIndex)
  }
  // 老事件行没有这一格(采集点是本期加的),所以只补不覆盖。
  if (toolName && part.toolName === undefined) part.toolName = toolName
  turnOf(run, requestIndex)
  return part
}

/** 这次调用的参数流是什么时候收齐的(`tool/call` 迟到时回头取)。 */
function findToolInputPartEnd(run: AssistantNode, callId: string): number | undefined {
  for (const part of run.parts.values()) {
    if (part.kind === 'tool-input' && part.toolCallId === callId) return part.endedAt
  }
  return undefined
}

/** requestIndex → 该 run 内的 1 起序号。事件里的 requestIndex 是会话级的。 */
function turnOf(run: AssistantNode, requestIndex: number): number {
  const known = run.turnByRequest.get(requestIndex)
  if (known !== undefined) return known
  const turn = run.turnCount + 1
  run.turnCount = turn
  run.turnByRequest.set(requestIndex, turn)
  return turn
}

function resolveRun(
  state: SessionProjectionState,
  runId: string | undefined,
  messageId: string | undefined,
): AssistantNode | undefined {
  if (runId) {
    const run = state.runs.get(runId)
    if (run) return run
  }
  if (messageId) {
    const node = state.byMessageId.get(messageId)
    if (node?.kind === 'assistant') return node
  }
  // 老文件的 tool/* 没有 runId,messageId 也可能指向已经不在的消息:落到活跃 run。
  return state.activeRun ? state.runs.get(state.activeRun.runId) : undefined
}

function findRunByCallId(
  state: SessionProjectionState,
  callId: string,
  runId: string | undefined,
): AssistantNode | undefined {
  if (runId) {
    const run = state.runs.get(runId)
    if (run?.tools.has(callId)) return run
  }
  for (let index = state.nodes.length - 1; index >= 0; index--) {
    const node = state.nodes[index]
    if (node.kind === 'assistant' && node.tools.has(callId)) return node
  }
  return undefined
}

function normalizeUsage(usage: SessionResponseUsage): ProjectedStepUsage {
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  }
}

function addUsage(
  current: ProjectedStepUsage | undefined,
  next: ProjectedStepUsage,
): ProjectedStepUsage {
  if (!current) return next
  const merged: ProjectedStepUsage = {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    totalTokens: current.totalTokens + next.totalTokens,
  }
  const cacheRead = (current.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0)
  const cacheWrite = (current.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0)
  const reasoning = (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0)
  if (cacheRead > 0) merged.cacheReadTokens = cacheRead
  if (cacheWrite > 0) merged.cacheWriteTokens = cacheWrite
  if (reasoning > 0) merged.reasoningTokens = reasoning
  return merged
}

// ============ 物化(节点 → ChatMessage 的派生字段) ============

/**
 * `tool/call.argumentsRaw` 是**唯一**的参数真相 —— 它是真正执行的那一份。
 * `tool-input` 的 delta 只喂 `streamingArgs`(参数还在生成时的显示),
 * `tool/call` 一到就撤下。解不开就给空对象,原文留在 `streamingArgs` 里。
 */
export function parseToolArguments(argumentsRaw: string): Record<string, unknown> {
  if (!argumentsRaw) return {}
  try {
    const parsed = JSON.parse(argumentsRaw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 模型把 JSON 写坏了。铁律 2:原样记账,不替它修。
  }
  return {}
}

/**
 * R-a(§13.6):这次调用的结局是 `prepare` 崩溃收尾**合成**出来的吗?
 *
 * 判据是那一句话本身(全仓唯一产地是 `interrupted.ts` 的常量)。合成的结局在
 * 事件账本里是一条 `isError` 的 `tool/result`,但消息侧那次修复写的是
 * `cancelled`(它没有失败,是没跑完)—— 不认出来就每一条崩溃过的会话都不等。
 */
function isSynthesizedInterrupt(tool: ToolState): boolean {
  return tool.isError === true && isCoreInterruptedToolResultText(tool.resultText)
}

/**
 * A12:等确认的那一格 —— 问过审批、没有答复、也还没有结局。
 *
 * 有结局(包括 prepare 合成的那条)就不是"在等"了:进程已经不在,消息侧那次
 * 修复把确认闸关掉了(`computeInterruptedToolCallRepair` 的 stalePermission 分支)。
 */
function isAwaitingConfirmation(tool: ToolState): boolean {
  return tool.awaitingPermission === true && tool.resultTime === undefined
}

function toolCallStatus(tool: ToolState, run: AssistantNode): ProjectedToolCallStatus {
  if (tool.resultTime === undefined) {
    // A12:引擎那一刻写的是 `status:'pending' + requiresConfirmation:true`
    // (`settleAgentLoopToolCallResult` 的 requiresConfirmation 分支)——
    // `awaiting-confirmation` 只是 step 上的说法,调用那一格是 pending。
    if (isAwaitingConfirmation(tool) && !run.ended) return 'pending'
    if (run.ended) return 'cancelled'
    return tool.receivedAt !== undefined ? 'executing' : 'input-streaming'
  }
  // R-a:合成的中断结局 = cancelled,与 `computeInterruptedToolCallRepair` 同口径。
  if (isSynthesizedInterrupt(tool)) return 'cancelled'
  if (tool.outcome === 'aborted') return 'cancelled'
  if (tool.isError || tool.outcome === 'denied' || tool.outcome === 'failed' || tool.outcome === 'invalid') {
    return 'failed'
  }
  return 'completed'
}

function stepStatus(status: ProjectedToolCallStatus): ProjectedStepStatus {
  switch (status) {
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'executing': return 'running'
    default: return 'pending'
  }
}

/**
 * `ToolCall` 上的结局两格,与引擎逐字同规则
 * (`agent-loop-executor.ts` 的 `settleAgentLoopToolResult`):
 *
 * ```
 * result: toJsonValue(result.data ?? result.content)   // 成功失败都写
 * error:  result.error                                  // 失败才有
 * ```
 *
 * 也就是说 **`result` 与 `error` 不是二选一**:一次失败的调用两格都有 ——
 * `result` 是结构化结局(`{success:false, error}`),`error` 是给人看的那句话。
 * 从前这里在 `isError` 时把结构化那一格整个丢掉,于是真机上 `read` 越界失败的
 * 那次调用在投影里连 `result` 都没有(§10.12 第 6 类)。
 */
/**
 * **收尾修复**(§10.14 第 7 类):一次执行收场时,引擎会把所有还没有结局的调用
 * 就地判死 —— `finalizeLingeringAgentLoopToolWork(message, now, errorMessage)`:
 *
 * ```
 * toolCall.status = 'cancelled'; toolCall.error = 'User cancelled' | LINGERING
 * step.status     = 'cancelled'; step.error     = 同一句
 * ```
 *
 * 那句话由收场的**方式**决定,不是由调用自己:用户按停止 → `'User cancelled'`
 * (`emitFinalAssistantMessageUpdate("User cancelled")`),其余两条收场路
 * (正常收尾 / 请求出错)都不带 errorMessage → 默认那一句。两个常量从引擎
 * 导出,这里不手抄字面量(§10.10 的规矩)。
 *
 * `interrupted` 那一档 **R-a 之后也有了话**(§13.6):崩溃重启时消息侧的
 * `sanitizeSessionOnStartup` 会把还挂着的 step / toolCall 判成
 * `cancelled` + `CORE_INTERRUPTED_TOOL_ERROR`(等审批的那些是权限那句),
 * 而账本侧 `prepare` 合成的结局逐字相同 —— 三处共用 `interrupted.ts` 那组常量。
 * 从前这里返回 undefined,于是每一条崩溃过的消息在投影里都少一句话。
 */
function lingeringToolError(run: AssistantNode, tool?: ToolState): string | undefined {
  if (!run.ended) return undefined
  if (run.outcome === 'aborted') return CORE_ABORTED_TOOL_ERROR
  if (run.outcome === 'completed' || run.outcome === 'error') return CORE_LINGERING_TOOL_ERROR
  if (run.outcome === 'interrupted') {
    return tool?.awaitingPermission ? CORE_INTERRUPTED_PERMISSION_ERROR : CORE_INTERRUPTED_TOOL_ERROR
  }
  return undefined
}

function toolResultFields(
  tool: ToolState,
  options: ProjectionMaterializeOptions,
  messageId: string,
): Partial<ProjectedToolCall> {
  // R-a:合成的中断结局在消息上**什么都没写** —— 它是账本侧为了闭合 run 记的一笔,
  // 不是工具真的返回了那句话。消息侧那次修复只写 status + error(见 timeline.ts)。
  if (isSynthesizedInterrupt(tool)) {
    return { error: tool.awaitingPermission ? CORE_INTERRUPTED_PERMISSION_ERROR : CORE_INTERRUPTED_TOOL_ERROR }
  }
  const resultText = resolveToolText(tool, options, messageId)
  const error = tool.isError && resultText !== undefined ? { error: resultText } : {}
  // 结构化结局优先:`ToolCall.result` 的正身是它,`result.text` 只是给模型的那段。
  const structured = resolveToolResultData(tool, options, messageId)
  if (structured !== undefined) return { result: structured, ...error }
  if (resultText === undefined) {
    // A8 + F6:blob 换不回来时**照实留引用**(退化,但不静默:issue 已经记了)。
    return tool.resultBlob ? { result: { blob: tool.resultBlob } } : {}
  }
  return tool.isError ? error : { result: resultText }
}

/** 结构化结局:事件行里的 `{text}`,或 blob 换回来再解一次(A8)。 */
function resolveToolResultData(
  tool: ToolState,
  options: ProjectionMaterializeOptions,
  messageId: string,
): unknown {
  if (tool.resultData !== undefined) return tool.resultData
  if (!tool.resultDataBlob) return undefined
  const resolved = resolveProjectionBlobRef(tool.resultDataBlob, options, 'toolCall.result', messageId)
  return resolved === undefined ? undefined : parseJsonSafely(resolved)
}

/**
 * 这次调用的结局正文(A8):事件行里的 `{text}`,或 blob 换回来的那一份。
 *
 * `steps[].result` 与 `toolCall.error` 都读它 —— 引擎那份账里它们是同一段全文,
 * 投影从前在 blob 那一支上整格缺席(大结果的每一次调用都不等)。
 */
function resolveToolText(
  tool: ToolState,
  options: ProjectionMaterializeOptions,
  messageId: string,
): string | undefined {
  if (tool.resultText !== undefined) return tool.resultText
  if (!tool.resultBlob) return undefined
  return resolveProjectionBlobRef(tool.resultBlob, options, 'step.result', messageId)
}

/** `JSON.parse`,坏了就当没有(记账坏掉不该让整份投影塌掉)。 */
function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 工具执行的三个时刻。
 *
 * `startTime` / `endTime` 在引擎那份账里是**执行前后各读一次表**,事件这边是
 * `tool/call` / `tool/result` 两条记录的时刻 —— 同一件事的两次读表,差一两毫秒。
 * `canonicalChatMessage` 因此把这三格排除在比较之外(见那边的说明);投影仍然
 * 产出它们,因为 S2 切读之后工具卡要靠它显示"跑了多久"。
 */
function toolTimingFields(tool: ToolState): Partial<ProjectedToolCall> {
  if (tool.resultTime === undefined) return { startTime: tool.callTime }
  return {
    startTime: tool.callTime,
    endTime: tool.resultTime,
    durationMs: Math.max(0, tool.resultTime - tool.callTime),
  }
}

/** 一次性构造(条件展开),不先建后改 —— 理由见 `chat-messages.ts` 的同款注释。 */
export /** 账本里最近开张的 run(按 eventSeq)。只作旧词汇(无 continuesRunId 的 steer)兜底用。 */
function lastRunId(state: SessionProjectionState): string | undefined {
  let best: { seq: number; runId: string } | undefined
  for (const [runId, node] of state.runs) {
    if (!best || node.eventSeq > best.seq) best = { seq: node.eventSeq, runId }
  }
  return best?.runId
}

function materializeToolCall(
  run: AssistantNode,
  tool: ToolState,
  options: ProjectionMaterializeOptions = {},
): ProjectedToolCall {
  const awaiting = isAwaitingConfirmation(tool) && !run.ended
  return {
    id: tool.callId,
    // A6:引擎写的是 `resolved.toolId`。`tool/audit.toolId`(工具包那一侧的
    // spec id)是次选 —— 它在没有别名/MCP 折叠时与前者相等,老文件只有它。
    toolId: tool.resolvedToolId ?? tool.toolId ?? tool.name,
    // A7:引擎写的是 `resolved.displayName`(MCP 会折成服务器名)。
    toolName: tool.displayName ?? tool.name,
    arguments: parseToolArguments(tool.argumentsRaw),
    status: toolCallStatus(tool, run),
    timestamp: tool.callTime,
    ...(tool.receivedAt !== undefined ? { receivedAt: tool.receivedAt } : {}),
    ...(tool.streamingArgs !== undefined ? { streamingArgs: tool.streamingArgs } : {}),
    ...toolTimingFields(tool),
    ...toolResultFields(tool, options, run.messageId),
    // 没等到结局就收场的那一次:引擎的收尾修复在它身上写了一句话(见上)。
    ...(tool.resultTime === undefined && lingeringToolError(run, tool)
      ? { error: lingeringToolError(run, tool) }
      : {}),
    // A12:等确认的那一刻,引擎把这一位写成 **true**(那张卡还等着人按)。
    // 引擎在收尾那一刻把它写死成 false(确认已经不再需要了)。它不是
    // 事实的一部分,是那条 UI 闸的收场态 —— 有结局就有它。
    ...(awaiting
      ? { requiresConfirmation: true as const }
      : tool.resultTime !== undefined ? { requiresConfirmation: false } : {}),
    ...(tool.outcome === 'denied' ? { rejected: true as const } : {}),
    ...(tool.rejectionReason !== undefined ? { rejectionReason: tool.rejectionReason } : {}),
  }
}

export function materializeStep(
  run: AssistantNode,
  tool: ToolState,
  childSteps: ProjectedStep[] = [],
  options: ProjectionMaterializeOptions = {},
): ProjectedStep {
  const toolCall = materializeToolCall(run, tool, options)
  const usage = run.usageByTurn.get(tool.turnIndex)
  const resultText = isSynthesizedInterrupt(tool)
    // R-a:合成的中断结局不进 `step.result` —— 消息侧那次修复只写 status + error。
    ? undefined
    : resolveToolText(tool, options, run.messageId)
  const hasResultText = resultText !== undefined
  // A12:step 那一格的说法是 `awaiting-confirmation`(调用那一格是 pending)。
  const status: ProjectedStepStatus = isAwaitingConfirmation(tool) && !run.ended
    ? 'awaiting-confirmation'
    : stepStatus(toolCall.status)
  // 工具自己报的标题压过派生标题 —— 引擎那份账的规则逐字相同:每一条带 title 的
  // `annotate` 当场盖掉 step 标题(`applyAgentLoopToolMetadata`),旧编排器那条路
  // 收尾时也是 `resultData.title || currentTitle`(`finalTitle`)。
  // `reportedTitle` 是那条 annotate 的直接记录,`resultData.title` 是成功结局里
  // 抄的那一份 —— 失败的调用只有前者(§10.12 第 6 类)。
  // A8:结构化结局可能住在 blob 里 —— 标题与 partialResult 都读**换回来的**
  // 那一份(手写 `tool.resultData` 会让大结果的工具卡退回派生标题)。
  const structuredResult = resolveToolResultData(tool, options, run.messageId)
  const reportedTitle = tool.reportedTitle
    ?? (structuredResult as { title?: unknown } | undefined)?.title
  // 落盘时 `partialResult` 被摘掉,冷加载时由 `rehydrateSessionFromStorage` 从
  // `toolCall.result` 原样算回来。投影用的是**同一条**派生规则。
  // 失败的调用没有这一格:引擎写的是 `partialResult: result.error ? undefined : …`。
  const structured = structuredResult !== undefined && !tool.isError && TERMINAL_STEP_STATUSES.has(status)
    ? toolResultToStructured(structuredResult as Parameters<typeof toolResultToStructured>[0])
    : undefined
  return {
    // G1(§10.1):事件里**不带** stepId。派生一个确定性的 —— 同一份日志投两次
    // 得到同一个 id,而它与 toolCallId 一一对应;比较时 `canonicalChatMessage`
    // 忽略它并按 toolCallId 排序(那才是身份)。
    id: `step-${tool.callId}`,
    // 与引擎同一条规则(`tool-execution.ts` → `getStepType`):bash 按命令内容分
    // command/file-read/skill-read/file-write,其余工具 tool-call。参数以
    // argumentsRaw 的解析结果为准(唯一参数真相),解析失败为 {} 与引擎同行为。
    type: getStepType(toolCall.toolName, toolCall.arguments as Parameters<typeof getStepType>[1]),
    // G2(§10.1):标题是**派生**的,事件不带 title —— 但派生规则是引擎那一份,
    // 不是"最好看的那一份"。生产里活着的那条路(agent-loop)只有两步:
    //
    //   ① `tool_input_start` 建占位 → `调用工具: X`(`createCoreToolInputStartArtifacts`);
    //   ② 工具自报的 `annotate{title}` 当场盖掉它(`applyAgentLoopToolMetadata`)。
    //
    // **没有第三步**:`generateStepTitle` 只在旧编排器里被调用过,而它在生产里
    // 已经没有构造点(§10.11 尾巴第 3 条)。所以一个**不自报标题**的工具
    // (参数校验就失败的那种,模型写错参数名时天天发生)在账上永远停在占位标题,
    // 而投影从前退回 `generateStepTitle` —— 这正是 §10.11 尾巴第 1 条预告的
    // "不自报标题的工具",矩阵在 `tool-invalid-args` 那一格当场抓到(§10.14)。
    //
    // `resultData.title` 夹在中间:本期之前写的事件行没有 `reportedTitle`,
    // 成功结局里抄的那一份是它们唯一的标题来源。
    title: typeof reportedTitle === 'string' && reportedTitle
      ? reportedTitle
      : coreToolInputStartStepTitle(toolCall.toolName),
    status,
    timestamp: tool.callTime,
    turnIndex: tool.turnIndex,
    toolCallId: tool.callId,
    toolCall,
    // 与 `toolCall` 那两格同一条规则:`Step.result` 是 `resultText(result)`
    // (失败时它**就是** error 那句话),`error` 只有失败才有 —— 两格并存,不是二选一
    // (`buildAgentLoopToolResultPresentation` 的 `stepUpdate`)。
    ...(hasResultText ? { result: resultText } : {}),
    ...(hasResultText && tool.isError ? { error: resultText } : {}),
    // 收尾修复把同一句话写在 step 上(`step.error = step.error || 那一句`)。
    ...(!hasResultText && toolCall.error !== undefined ? { error: toolCall.error } : {}),
    ...(structured ? { partialResult: structured, partialResultIsPartial: false } : {}),
    ...(toolCall.rejected ? { rejected: true as const } : {}),
    ...(tool.rejectionReason !== undefined ? { rejectionReason: tool.rejectionReason } : {}),
    ...(usage ? { usage } : {}),
    ...(childSteps.length > 0 ? { childSteps } : {}),
  }
}

/**
 * G3:按 `tool/call.parentCallId` 把调用摊成两层。
 *
 * 没有父的(绝大多数)平铺在顶层,顺序仍是到达序;父不在本 run 里的
 * (跨消息的调用栈)也**平铺**,不凭空造一个父 —— 事件说不出来的东西
 * 投影不猜。
 */
export function materializeSteps(
  run: AssistantNode,
  options: ProjectionMaterializeOptions = {},
): ProjectedStep[] {
  const childrenByParent = new Map<string, string[]>()
  for (const callId of visibleToolOrder(run)) {
    const parentCallId = run.tools.get(callId)?.parentCallId
    if (!parentCallId || !run.tools.has(parentCallId)) continue
    const bucket = childrenByParent.get(parentCallId)
    if (bucket) bucket.push(callId)
    else childrenByParent.set(parentCallId, [callId])
  }

  const steps: ProjectedStep[] = []
  for (const callId of visibleToolOrder(run)) {
    const tool = run.tools.get(callId)!
    if (tool.parentCallId && run.tools.has(tool.parentCallId)) continue
    const children = (childrenByParent.get(callId) ?? [])
      .map(childId => materializeStep(run, run.tools.get(childId)!, [], options))
    steps.push(materializeStep(run, tool, children, options))
  }
  return steps
}

/**
 * A11(§13.1):**引擎藏起来的调用不进消息**。
 *
 * `publish:false` 那条路上引擎连 `toolCalls.push` 都没做过(占位卡与 step 一并
 * 不建),而记录器是无条件记的 —— 它挂在 agent-loop 的事件流上,看不见呈现层的
 * 决定。所以 `toolCalls[]` / `steps[]` 这两格按事件里的 `hidden` 摘;
 * **轨迹与审计不受影响**(它们读的是事件本身)。
 * 老文件没有这一格 = 全部可见,与修复前逐字相同。
 */
function visibleToolOrder(run: AssistantNode): string[] {
  return run.toolOrder.filter(callId => run.tools.get(callId)?.hidden !== true)
}

/** 顶层 toolCalls:与 `materializeSteps` 同一条筛法(子调用不再单列一格)。 */
export function materializeToolCalls(
  run: AssistantNode,
  options: ProjectionMaterializeOptions = {},
): ProjectedToolCall[] {
  return visibleToolOrder(run)
    .filter(callId => {
      const parentCallId = run.tools.get(callId)?.parentCallId
      return !parentCallId || !run.tools.has(parentCallId)
    })
    .map(callId => materializeToolCall(run, run.tools.get(callId)!, options))
}

/**
 * G7(§10.1):**孤儿参数流** —— 有 `assistant/chunks{kind:'tool-input'}`,
 * 却从来没等到 `tool/call`(模型写到一半被打断 / 请求出错)。
 *
 * 今天 UI 上那是一张 `input-streaming` 的卡;丢掉它等于把"模型开了个头"
 * 抹平成"什么都没发生"。run 已经收尾(非 completed)时转 `cancelled` ——
 * 参数流永远等不到它的调用了。
 */
export function materializeOrphanToolCalls(run: AssistantNode): ProjectedToolCall[] {
  return orphanToolInputParts(run).map(part => materializeOrphanToolCall(run, part))
}

/** 孤儿参数流的那几段 part(按 partIndex 排好)。 */
function orphanToolInputParts(run: AssistantNode): PartState[] {
  const parts: PartState[] = []
  for (const partIndex of [...run.partOrder].sort((a, b) => a - b)) {
    const part = run.parts.get(partIndex)!
    if (part.kind !== 'tool-input') continue
    if (!part.toolCallId || run.tools.has(part.toolCallId)) continue
    parts.push(part)
  }
  return parts
}

/**
 * 引擎在 `tool_input_start` 那一刻建的**占位调用**
 * (`createCoreToolInputStartArtifacts`),外加收场时的那次修复。逐格对照:
 *
 * | 格 | 引擎 | 这里 |
 * |---|---|---|
 * | `toolId` / `toolName` | `resolved.toolId` / `resolved.displayName` | part 上记的工具名(与 `tool/call.name` 同一条口径:那边也只有一个 `name`) |
 * | `arguments` | `{}` —— 参数永远没定稿 | `{}` |
 * | `streamingArgs` | **`''`** —— delta 只发给渲染层,一格都没回写进消息 | `''` |
 * | `status` | `'input-streaming'` → 收场修复判 `'cancelled'` | 同 |
 * | `error` | 收场修复写的那一句 | `lingeringToolError(run)` |
 */
function materializeOrphanToolCall(run: AssistantNode, part: PartState): ProjectedToolCall {
  const error = lingeringToolError(run)
  const name = part.toolName ?? ''
  return {
    id: part.toolCallId!,
    toolId: name,
    toolName: name,
    arguments: {},
    // 收场修复只认 `input-streaming` 这一档,而收场的方式与它无关 —— 三条路
    // (abort / 出错 / 正常收尾)都会把还开着的参数流判死。
    status: error !== undefined ? 'cancelled' : 'input-streaming',
    timestamp: run.time,
    // 参数流的原文**不在**消息上:`streamingArgs` 是渲染层的活文本,引擎写进
    // 消息的那一格从建卡起就是空串(`createCoreToolInputStartArtifacts`)。
    // 原文仍在事件里(`part.text`),要用的人自己去取。
    streamingArgs: '',
    ...(error !== undefined ? { error } : {}),
  }
}

/**
 * G7 的另一半:孤儿参数流**也有一条 step**。
 *
 * 引擎建占位 step 与建占位调用是同一行代码(`createCoreToolInputStartArtifacts`
 * 一次返回两样),所以"只补 toolCalls 不补 steps"是投影漏了一半 ——
 * 真机上那条 abort 的消息因此少一条 step(§10.14 第 7 类)。
 *
 * 标题与类型都**冻在占位那一刻**:参数还是 `{}`,`getStepType` 无从判起
 * (bash 一律 `command`),标题是"调用工具: X"(工具自报的标题永远不会来)。
 * 两者都调引擎自己的函数,不手抄。
 */
export function materializeOrphanSteps(run: AssistantNode): ProjectedStep[] {
  return orphanToolInputParts(run).map(part => {
    const toolCall = materializeOrphanToolCall(run, part)
    const turnIndex = run.turnByRequest.get(part.requestIndex)
    return {
      id: `step-${toolCall.id}`,
      type: coreStepTypeForToolName(toolCall.toolName),
      title: coreToolInputStartStepTitle(toolCall.toolName),
      status: toolCall.status === 'cancelled' ? 'cancelled' : 'running',
      timestamp: run.time,
      ...(turnIndex !== undefined ? { turnIndex } : {}),
      toolCallId: toolCall.id,
      toolCall,
      ...(toolCall.error !== undefined ? { error: toolCall.error } : {}),
    }
  })
}

/**
 * G5(§10.1):`thinkingTime` 是**派生**的 —— 推理段 chunks 的
 * `time0+dt` 首尾差;没有推理段就退回"首 token 减请求开始"(那是模型在
 * 那次请求上真正让人等的时间)。两者都拿不到就没有这一格,不填 0
 * (0 与"没量到"不是一回事)。
 */
export function deriveThinkingTime(run: AssistantNode): number | undefined {
  const span = run.reasoningFirstAt !== undefined && run.reasoningLastAt !== undefined
    ? run.reasoningLastAt - run.reasoningFirstAt
    : run.firstRequestStartAt !== undefined && run.firstTokenAt !== undefined
      ? run.firstTokenAt - run.firstRequestStartAt
      : undefined
  // 0 与"没量到"是同一件事(单条 delta 的推理段没有跨度可言),所以不产出 0 ——
  // 与 `canonicalChatMessage` 对 `isStreaming:false` 的处置同一条理由。
  return span !== undefined && span > 0 ? span : undefined
}

/**
 * 推理段的**两个落点**(引擎侧的判据是 `core/engine/agent-loop-executor.ts` 的
 * `getAgentLoopReasoningPlacement`,这里是它在事件上的复刻):
 *
 *  - `'top'` —— 第 1 轮请求**开头**那一段(此前这次执行还没产出过任何正文 /
 *    工具调用 / 可见 part)。它只进 `message.reasoning` 字段(`updateMessageReasoning`),
 *    **不进 `contentParts`**;
 *  - `'inline'` —— 其余一律进 `contentParts`(`appendOrderedPart`),字段不再动。
 *
 * 因为 `partIndex` 在一次执行里单调、且同类连续 delta 归同一段,"turn 1 开头
 * 那一段"就等价于**按 partIndex 排序后开头那一串连续的 reasoning 段**。
 *
 * 真机第一天(§10.9)这里曾把两个落点合成一个:投影把 top 段也物化成
 * contentPart,于是每条带推理的助手消息都比事实多一格,后面的 part 整体错位。
 *
 * 真机第四批(§10.12)则是 `turnIndex` 本身错了:steering 换出来的那条消息
 * partIndex 从 0 重新数,但引擎的回合号是 2 —— 判成 `'top'` 就把一段本该在
 * `contentParts` 里的推理搬进了 `message.reasoning`,后面每一格再次整体错位。
 * 现在 `turnByRequest` 由 `continuesRunId` 接着上一条 run 数,这里一个字没改。
 */
export function topReasoningPartIndexes(run: AssistantNode): Set<number> {
  const top = new Set<number>()
  for (const partIndex of [...run.partOrder].sort((a, b) => a - b)) {
    const part = run.parts.get(partIndex)!
    // A1:`provider-data` 不算"可见产出" —— 引擎的判据
    // (`hasAgentLoopVisibleTurnActivity`)逐字写着
    // `orderedParts.some(part => part.type !== 'provider-data')`。Claude 的签名块
    // 就夹在推理段中间,把它当边界会让本该 `'top'` 的那一段判成 `'inline'`。
    if (part.kind === 'provider-data') continue
    if (part.kind !== 'reasoning') break
    if (run.turnByRequest.get(part.requestIndex) !== 1) break
    top.add(partIndex)
  }
  return top
}

/** `message.reasoning` 字段 = **只有** `'top'` 那一段(见上)。 */
export function materializeTopReasoning(
  run: AssistantNode,
  options: ProjectionMaterializeOptions = {},
): string {
  const top = topReasoningPartIndexes(run)
  let out = ''
  for (const partIndex of [...top].sort((a, b) => a - b)) {
    out += partText(run.parts.get(partIndex)!, options, run.messageId)
  }
  return out
}

/**
 * 一段 part 的正文,占位符换回正身(R-b)。
 *
 * 生图那条特化流的正文里有一段几百 KB 的 data URL,事件行装不下 —— 采集点把它
 * 换成 `onething-blob://<hash>`,这里换回来。其余正文一个字节都不动(热路径上
 * 先做一次 `includes` 短路)。
 */
function partText(
  part: PartState,
  options: ProjectionMaterializeOptions,
  messageId: string,
): string {
  return resolveProjectionBlobText(part.text, options, 'part.text', messageId)
}

/**
 * 这一轮的 part 落到消息上了吗?
 *
 * 引擎只有一个落点:`finish` chunk → `persistTurnContentParts`,与记录器写
 * `request/end` 是同一刻(`turn-end`)。走不到那一刻的那一轮(用户 abort、
 * 请求出错重试)—— 正文与推理只在流里活过一次,`contentParts` 上一格都没有
 * (`message.content` / `message.reasoning` 是**另外**两条实时写的路,它们照旧有)。
 *
 * 真机 `17b342a2…`:abort 掉的第 3 轮那 272 字推理在事件里齐全,而
 * `messages.jsonl` 的 contentParts 里根本没有它(§10.14 第 7 类)。
 */
function requestSettled(run: AssistantNode, requestIndex: number): boolean {
  return run.settledRequests.has(requestIndex)
}

/**
 * 这条闸**只管 agent-loop 那条路**(A2,§13.1)。
 *
 * `image` part 不是 agent-loop 产的:图片生成是引擎里的一条特化流,正文一写就
 * 落在消息上,根本没有 `turn-end` 这一刻,`request/end` 也永远不会来。§10.14
 * 引入 `settledRequests` 时把它一并圈了进去,于是 S1b 缺口 3 补上的采集成果被
 * 闸吃掉:事件里有那一格 image part,投影里一格都没有。
 *
 * 为什么是"豁免"而不是"让图片流补记一对 request/start+end":那两条事件说的是
 * "向模型发了一次请求、收齐了一次响应",图片流没有发生过那件事 —— 记一条就是
 * 往账本里写一件没发生的事,而且会连带派生出 `firstRequestStartAt` /
 * `thinkingTime`(引擎那边没有)。豁免表达的是事实本身:这一格的落盘不由
 * `persistTurnContentParts` 决定。
 */
function isSettleExemptPartKind(kind: SessionAssistantPartKind): boolean {
  return kind === 'image'
}

/**
 * 这一格豁免"这一轮收齐了吗"那道闸吗?
 *
 * 两种豁免,同一条理由 —— **它的落盘不由 `persistTurnContentParts` 决定**:
 *  - `kind:'image'`(A2,老文件里生图留下的那一格);
 *  - `synthetic`(R-b,引擎直接落到消息上的正文,今天只有生图正文一条产地)。
 */
function partIsSettleExempt(part: PartState): boolean {
  return part.synthetic === true || isSettleExemptPartKind(part.kind)
}

export function materializeContentParts(
  run: AssistantNode,
  options: ProjectionMaterializeOptions = {},
): ProjectedContentPart[] {
  const parts: ProjectedContentPart[] = []
  const topReasoning = topReasoningPartIndexes(run)
  for (const partIndex of [...run.partOrder].sort((a, b) => a - b)) {
    const part = run.parts.get(partIndex)!
    if (!partIsSettleExempt(part) && !requestSettled(run, part.requestIndex)) continue
    // R-b:`synthetic` 那一格没有回合 —— 它不是模型某一轮的产出,消息上那一格
    // 也就没有 `turnIndex`。凭空补一个会让每一次生图都不等。
    const turnIndex = part.synthetic ? undefined : run.turnByRequest.get(part.requestIndex)
    const text = partText(part, options, run.messageId)
    if (part.kind === 'text' && text) {
      parts.push({ type: 'text', content: text, ...(turnIndex !== undefined ? { turnIndex } : {}) })
    } else if (part.kind === 'reasoning' && text && !topReasoning.has(partIndex)) {
      parts.push({ type: 'reasoning', content: text, ...(turnIndex !== undefined ? { turnIndex } : {}) })
    } else if (part.kind === 'image' && part.blob) {
      parts.push({ type: 'image', blob: part.blob, ...(turnIndex !== undefined ? { turnIndex } : {}) })
    } else if (part.kind === 'provider-data') {
      // A1:引擎那一格是 `{type:'provider-data', providerData, turnIndex}`
      // (`applyAgentLoopProviderDataWithAdapters`)。载荷解不回来(超 64KB 走了
      // blob 而这里没有 resolver)时**照实留引用**,与 image part 同一个坑口 ——
      // 静默丢掉一整格才是错的。
      if (part.providerData !== undefined) {
        parts.push({
          type: 'provider-data',
          providerData: part.providerData,
          ...(turnIndex !== undefined ? { turnIndex } : {}),
        })
      } else if (part.blob) {
        parts.push({ type: 'provider-data', blob: part.blob, ...(turnIndex !== undefined ? { turnIndex } : {}) })
      }
    }
    // `tool-input` 不进 contentParts:它喂的是 toolCalls[].arguments 那一路。
  }
  return parts
}

export function materializePartText(
  run: AssistantNode,
  kind: 'text' | 'reasoning',
  options: ProjectionMaterializeOptions = {},
): string {
  let out = ''
  for (const partIndex of [...run.partOrder].sort((a, b) => a - b)) {
    const part = run.parts.get(partIndex)!
    if (part.kind === kind) out += partText(part, options, run.messageId)
  }
  return out
}
