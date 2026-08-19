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
import { SurfaceIndex } from './surface.js'
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
  text: string
  ended: boolean
  /** part 收齐的时刻。`tool-input` 的这一格就是 toolCall 的 `receivedAt`。 */
  endedAt?: number
  blob?: { hash: string; bytes: number; mime?: string }
}

interface ToolState {
  callId: string
  name: string
  toolId?: string
  argumentsRaw: string
  callTime: number
  callSeq: number
  turnIndex: number
  streamingArgs?: string
  receivedAt?: number
  resultText?: string
  resultBlob?: { hash: string; bytes: number; mime?: string }
  resultTime?: number
  isError?: boolean
  outcome?: 'ok' | 'invalid' | 'denied' | 'aborted' | 'failed'
  previewTitle?: string
  rejectionReason?: string
  /** `tool/result` 事件的 seq —— surface 剪枝按它判定。 */
  resultSeq?: number
}

export interface AssistantNode extends BaseNode {
  kind: 'assistant'
  runId: string
  messageId: string
  agentId?: string
  provider?: string
  model?: string
  ended: boolean
  outcome?: 'completed' | 'aborted' | 'error' | 'interrupted'
  errorDetails?: string
  parts: Map<number, PartState>
  partOrder: number[]
  tools: Map<string, ToolState>
  toolOrder: string[]
  usage?: ProjectedStepUsage
  /** requestIndex → 该 run 内第几次请求(1 起),即 `turnIndex`。 */
  turnByRequest: Map<number, number>
  turnCount: number
  usageByTurn: Map<number, ProjectedStepUsage>
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
      const node: AssistantNode = {
        kind: 'assistant',
        eventSeq: event.seq,
        time: event.time,
        hidden: false,
        patch: {},
        runId: event.data.runId,
        messageId: event.data.assistantMessageId,
        agentId: event.data.agentId,
        provider: event.data.provider,
        model: event.data.model,
        ended: false,
        parts: new Map(),
        partOrder: [],
        tools: new Map(),
        toolOrder: [],
        turnByRequest: new Map(),
        turnCount: 0,
        usageByTurn: new Map(),
      }
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
      const part = ensurePart(run, event.data.partIndex, event.data.kind, event.data.requestIndex, event.data.toolCallId)
      part.text += event.data.text.join('')
      if (part.kind === 'tool-input' && part.toolCallId) {
        const tool = run.tools.get(part.toolCallId)
        if (tool) tool.streamingArgs = part.text
      }
      break
    }

    case 'assistant/part-end': {
      const run = state.runs.get(event.data.runId)
      if (!run) break
      const part = ensurePart(run, event.data.partIndex, event.data.kind, event.data.requestIndex, event.data.toolCallId)
      part.ended = true
      part.endedAt = event.time
      if (event.data.blob) part.blob = event.data.blob
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
      tool.argumentsRaw = event.data.argumentsRaw
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

    // 记录在案但不改投影:它们回答的是"什么时候发生了什么",不是"屏幕上有什么"。
    case 'session/created':
    case 'session/agent-changed':
    case 'session/model-changed':
    case 'session/workdir-changed':
    case 'request/tools':
    case 'request/header':
    case 'request/start':
    case 'request/end':
    case 'assistant/first-token':
    case 'permission/asked':
    case 'permission/answered':
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
): PartState {
  let part = run.parts.get(partIndex)
  if (!part) {
    part = { partIndex, kind, requestIndex, toolCallId, text: '', ended: false }
    run.parts.set(partIndex, part)
    run.partOrder.push(partIndex)
  }
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

function toolCallStatus(tool: ToolState, run: AssistantNode): ProjectedToolCallStatus {
  if (tool.resultTime === undefined) {
    if (run.ended) return 'cancelled'
    return tool.receivedAt !== undefined ? 'executing' : 'input-streaming'
  }
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

/** 结果的两种落法:blob 引用,或正文;失败时正文进 `error` 而不是 `result`。 */
function toolResultFields(tool: ToolState): Partial<ProjectedToolCall> {
  if (tool.resultBlob) return { result: { blob: tool.resultBlob } }
  if (tool.resultText === undefined) return {}
  return tool.isError ? { error: tool.resultText } : { result: tool.resultText }
}

/** 一次性构造(条件展开),不先建后改 —— 理由见 `chat-messages.ts` 的同款注释。 */
export function materializeToolCall(run: AssistantNode, tool: ToolState): ProjectedToolCall {
  return {
    id: tool.callId,
    toolId: tool.toolId ?? tool.name,
    toolName: tool.name,
    arguments: parseToolArguments(tool.argumentsRaw),
    status: toolCallStatus(tool, run),
    timestamp: tool.callTime,
    ...(tool.receivedAt !== undefined ? { receivedAt: tool.receivedAt } : {}),
    ...(tool.streamingArgs !== undefined ? { streamingArgs: tool.streamingArgs } : {}),
    ...toolResultFields(tool),
    ...(tool.outcome === 'denied' ? { rejected: true as const } : {}),
    ...(tool.rejectionReason !== undefined ? { rejectionReason: tool.rejectionReason } : {}),
  }
}

export function materializeStep(run: AssistantNode, tool: ToolState): ProjectedStep {
  const toolCall = materializeToolCall(run, tool)
  const usage = run.usageByTurn.get(tool.turnIndex)
  const hasResultText = tool.resultText !== undefined
  return {
    // 事件里没有 stepId(七类里从来没记过)。派生一个确定性的:同一份日志
    // 投两次得到同一个 id,而它与 toolCallId 一一对应 —— S1 若要保真,
    // 需要在 `tool/call` 上补 `stepId`(见 §9.7 的缺口清单)。
    id: `step-${tool.callId}`,
    type: 'tool-call',
    title: tool.previewTitle ?? tool.name,
    status: stepStatus(toolCall.status),
    timestamp: tool.callTime,
    turnIndex: tool.turnIndex,
    toolCallId: tool.callId,
    toolCall,
    ...(hasResultText && !tool.isError ? { result: tool.resultText } : {}),
    ...(hasResultText && tool.isError ? { error: tool.resultText } : {}),
    ...(toolCall.rejected ? { rejected: true as const } : {}),
    ...(tool.rejectionReason !== undefined ? { rejectionReason: tool.rejectionReason } : {}),
    ...(usage ? { usage } : {}),
  }
}

export function materializeContentParts(run: AssistantNode): ProjectedContentPart[] {
  const parts: ProjectedContentPart[] = []
  for (const partIndex of [...run.partOrder].sort((a, b) => a - b)) {
    const part = run.parts.get(partIndex)!
    const turnIndex = run.turnByRequest.get(part.requestIndex)
    if (part.kind === 'text' && part.text) {
      parts.push({ type: 'text', content: part.text, ...(turnIndex !== undefined ? { turnIndex } : {}) })
    } else if (part.kind === 'reasoning' && part.text) {
      parts.push({ type: 'reasoning', content: part.text, ...(turnIndex !== undefined ? { turnIndex } : {}) })
    } else if (part.kind === 'image' && part.blob) {
      parts.push({ type: 'image', blob: part.blob, ...(turnIndex !== undefined ? { turnIndex } : {}) })
    }
    // `tool-input` 不进 contentParts:它喂的是 toolCalls[].arguments 那一路。
  }
  return parts
}

export function materializePartText(run: AssistantNode, kind: 'text' | 'reasoning'): string {
  let out = ''
  for (const partIndex of [...run.partOrder].sort((a, b) => a - b)) {
    const part = run.parts.get(partIndex)!
    if (part.kind === kind) out += part.text
  }
  return out
}
