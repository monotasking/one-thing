/**
 * `projectChatMessages(events, {upToSeq?})` —— UI 看的那一份(§9.4)。
 *
 * 它是 `reduceSessionProjection` 上的一次 fold + 一次物化。物化独立成
 * `materializeChatMessages(state)`,所以活跃会话可以"推一条事件、重物化尾部"
 * 而不必重跑整份日志。
 *
 * 派生规则(事件里没有的东西一律**派生**,不猜、不回填):
 *  - `content` / `reasoning` = 该 run 全部 text / reasoning part 的 fold(按 partIndex);
 *  - `contentParts` = 同一批 part 按 partIndex 排出来(`tool-input` 不进);
 *  - `toolCalls` / `steps` = `tool/call|result|audit` 按到达序;
 *  - `usage` = 该 run 全部 `request/response.usage` 之和;
 *  - `isStreaming` = `run/start` 之后、`run/end` 之前(它不是事件字段,是状态);
 *  - `message/patched` 最后叠加(assistant 上的正文字段会被剥掉,见 reducer)。
 */

import { buildContextCompactContent } from '../../engine/context-compact.js'
import type { SessionLogEventRecord } from '../events/types.js'
import type { AssistantNode, CompactedNode, MessageNode, ProjectionNode, SessionProjectionState } from './reducer.js'
import {
  createSessionProjectionState,
  deriveThinkingTime,
  materializeContentParts,
  materializeOrphanToolCalls,
  materializePartText,
  materializeSteps,
  materializeToolCalls,
  reduceSessionProjection,
} from './reducer.js'
import type { ProjectChatMessagesResult, ProjectedChatMessage } from './types.js'

export interface ProjectChatMessagesOptions {
  /** 只看到这条 seq(含)为止 —— 时间旅行/分页用。 */
  upToSeq?: number
}

/** 把事件折成投影状态。活跃会话持有它,新事件走 `reduceSessionProjection`。 */
export function foldSessionProjection(
  events: readonly SessionLogEventRecord[],
  options: ProjectChatMessagesOptions = {},
): SessionProjectionState {
  let state = createSessionProjectionState()
  for (const event of events) {
    if (options.upToSeq !== undefined && event.seq > options.upToSeq) break
    state = reduceSessionProjection(state, event)
  }
  return state
}

export function projectChatMessages(
  events: readonly SessionLogEventRecord[],
  options: ProjectChatMessagesOptions = {},
): ProjectChatMessagesResult {
  return materializeChatMessages(foldSessionProjection(events, options))
}

export function materializeChatMessages(state: SessionProjectionState): ProjectChatMessagesResult {
  const messages: ProjectedChatMessage[] = []
  for (const node of state.nodes) {
    if (node.hidden) continue
    messages.push(materializeNode(node))
  }
  return {
    messages,
    ...(state.activeRun ? { activeRun: state.activeRun } : {}),
  }
}

export function materializeNode(node: ProjectionNode): ProjectedChatMessage {
  switch (node.kind) {
    case 'message': return materializeMessageNode(node)
    case 'assistant': return materializeAssistantNode(node)
    case 'compacted': return materializeCompactedNode(node)
  }
}

/**
 * 一律**一次性构造**(条件展开),不"先建后逐字段改"。
 *
 * 这不只是风格:`session:gate` 的规则 B 盯的就是"对消息形状的属性赋值",
 * 而它盯的理由(P0 §4)在这里同样成立 —— 投影产出的对象转手就会被深冻结
 * 交给读门面,任何"建完再补一刀"的写法迟早会挪到冻结之后。
 */
function materializeMessageNode(node: MessageNode): ProjectedChatMessage {
  const {
    // `ChatMessage.seq` 是位置,事件坐标是身份(§3.2 它在 S2 退役)。
    // 投影不再产出位置,避免下一个人拿它当身份。
    seq: _droppedPositionSeq,
    ...carried
  } = node.message as Record<string, unknown>
  return {
    ...carried,
    ...(node.turnContext ? { turnContext: node.turnContext } : {}),
    ...node.patch,
    eventSeq: node.eventSeq,
  } as ProjectedChatMessage
}

function materializeAssistantNode(node: AssistantNode): ProjectedChatMessage {
  // G7:孤儿参数流合成的占位调用排在真调用之后 —— 它们是"还没成为调用"的东西。
  const toolCalls = [...materializeToolCalls(node), ...materializeOrphanToolCalls(node)]
  const steps = materializeSteps(node)
  const contentParts = materializeContentParts(node)
  const reasoning = materializePartText(node, 'reasoning')
  const thinkingTime = deriveThinkingTime(node)

  return {
    id: node.messageId,
    role: 'assistant',
    content: materializePartText(node, 'text'),
    timestamp: node.time,
    eventSeq: node.eventSeq,
    ...(reasoning ? { reasoning } : {}),
    ...(node.provider ? { provider: node.provider } : {}),
    ...(node.model ? { model: node.model } : {}),
    ...(node.agentId ? { agentId: node.agentId } : {}),
    ...(node.origin ? { origin: node.origin } : {}),
    ...(contentParts.length > 0 ? { contentParts } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(steps.length > 0 ? { steps } : {}),
    ...(node.usage ? { usage: node.usage } : {}),
    ...(node.skillUsed ? { skillUsed: node.skillUsed } : {}),
    ...(thinkingTime !== undefined ? { thinkingTime } : {}),
    ...(node.ended ? {} : { isStreaming: true as const }),
    ...(node.errorDetails ? { errorDetails: node.errorDetails } : {}),
    ...node.patch,
  }
}

/**
 * 今天 UI 上那条压缩卡片(`context-compact.ts:100` 的 `addMessage`)。
 *
 * 正文用 core 自己的 `buildContextCompactContent` 生成 —— 与引擎写出去的那条
 * **逐字节同源**,不在这里手抄一份 JSON(手抄的那份迟早和它分叉)。
 */
function materializeCompactedNode(node: CompactedNode): ProjectedChatMessage {
  const content = buildContextCompactContent({
    status: node.status,
    compactedMessageCount: node.compactedMessageCount,
    ...(node.status === 'completed' ? { summary: node.summary } : { summary: '' }),
    ...(node.error ? { error: node.error } : {}),
    ...(node.compactedThroughMessageId ? { compactedThroughMessageId: node.compactedThroughMessageId } : {}),
  })
  return {
    id: node.messageId,
    role: 'system',
    content,
    timestamp: node.time,
    eventSeq: node.eventSeq,
    ...node.patch,
  }
}
