/**
 * `projectModelHistory(events, meta, {upToSeq?})` —— 下一次请求发出去的那一份
 * (§9.4)。
 *
 * **只走 surface**:`SurfaceIndex` 维护的有序 eventSeq 数组就是"模型可见历史",
 * compact / edit-resend / regenerate / delete / 工具结果剪枝全部是那上面的
 * replace。这条路与 `projectChatMessages` 的区别正在于此 —— 被压缩的消息在 UI
 * 上还在,在这里不在。
 *
 * 物化不自己写一遍:同一批节点交给 `core/engine/history.ts` 的
 * `buildHistoryMessages`(今天真机走的那一份),按 surface 顺序切成"连续的
 * 非压缩段",每段一次。压缩节点渲染成 `compactedHistoryPreamble` 的那条 user
 * 消息 —— 与今天按 `session.summary` 切片走出来的第一条逐字节相同。
 *
 * 老会话(全是 `message/imported`,没有 `session/compacted` 事件)的摘要仍住在
 * `meta.summary` / `meta.summaryUpToMessageId` 里:这时退回今天那条路,把 meta
 * 交给 `buildHistoryMessages` 自己切。这不是兜底,是**事实所在处不同**。
 */

import type { CoreBuildHistoryMessagesOptions, CoreHistoryChatMessage, CoreHistoryMessage } from '../../engine/history.js'
import { buildHistoryMessages, compactedHistoryPreamble } from '../../engine/history.js'
import { TurnContextLedger } from '../../engine/turn-context.js'
import type { SessionLogEventRecord } from '../events/types.js'
import { foldSessionProjection, materializeNode } from './chat-messages.js'
import type { AssistantNode, ProjectionNode, SessionProjectionState } from './reducer.js'
import type { ProjectedChatMessage } from './types.js'

export interface ProjectModelHistoryMeta {
  id?: string
  /** 老会话的压缩摘要(没有 `session/compacted` 事件时才读)。 */
  summary?: string
  summaryUpToMessageId?: string
}

export interface ProjectModelHistoryOptions<TContent = unknown> {
  upToSeq?: number
  /**
   * 消息 → provider 内容。缺省是"正文字符串 + 尾块上下文",与桌面端的
   * `buildMessageContent` 在纯文本消息上逐字节一致;多模态(附件/图片)必须由
   * 宿主传进来 —— core 不知道 provider 的多模态形状。
   */
  buildMessageContent?: CoreBuildHistoryMessagesOptions<TContent, CoreHistoryChatMessage>['buildMessageContent']
  getAIToolName?: CoreBuildHistoryMessagesOptions<TContent, CoreHistoryChatMessage>['getAIToolName']
  failureResultForAI?: CoreBuildHistoryMessagesOptions<TContent, CoreHistoryChatMessage>['failureResultForAI']
}

const turnContextLedger = new TurnContextLedger()

/**
 * 缺省 `buildMessageContent`:正文 + `<context-update>` 尾块。
 *
 * 与 `app/engine/stream/message-helpers.ts` 的 `applyTurnContextToBuiltContent`
 * 同一条落点规则(只有 user 消息带尾块),用的也是同一个 ledger 的 `applyTo`。
 */
export function defaultHistoryMessageContent(message: CoreHistoryChatMessage): string {
  const content = message.content ?? ''
  if (message.role !== 'user') return content
  const delta = TurnContextLedger.deltaOf(message as { turnContext?: { set?: Record<string, string>; removed?: string[] } })
  return delta ? turnContextLedger.applyTo(content, delta) : content
}

export function projectModelHistory<TContent = unknown>(
  events: readonly SessionLogEventRecord[],
  meta: ProjectModelHistoryMeta = {},
  options: ProjectModelHistoryOptions<TContent> = {},
): CoreHistoryMessage[] {
  const state = foldSessionProjection(events, { upToSeq: options.upToSeq })
  return materializeModelHistory(state, meta, options)
}

export function materializeModelHistory<TContent = unknown>(
  state: SessionProjectionState,
  meta: ProjectModelHistoryMeta = {},
  options: ProjectModelHistoryOptions<TContent> = {},
): CoreHistoryMessage[] {
  const buildOptions = {
    buildMessageContent: (options.buildMessageContent
      ?? (defaultHistoryMessageContent as unknown as CoreBuildHistoryMessagesOptions<TContent, CoreHistoryChatMessage>['buildMessageContent'])),
    ...(options.getAIToolName ? { getAIToolName: options.getAIToolName } : {}),
    ...(options.failureResultForAI ? { failureResultForAI: options.failureResultForAI } : {}),
  } as CoreBuildHistoryMessagesOptions<TContent, CoreHistoryChatMessage>

  const surface = state.surface.snapshot()
  const nodes: ProjectionNode[] = []
  for (const eventSeq of surface.order) {
    const node = state.byEventSeq.get(eventSeq)
    if (node) nodes.push(node)
  }

  const hasCompacted = nodes.some(node => node.kind === 'compacted')
  const out: CoreHistoryMessage[] = []
  let group: CoreHistoryChatMessage[] = []

  const flush = (): void => {
    if (group.length === 0) return
    // 有压缩节点时 meta 的摘要**不再参与**:切点已经由 surface 表达,
    // 再让 `buildHistoryMessages` 按锚点切一次就是切两刀。
    const session = hasCompacted ? undefined : meta
    out.push(...buildHistoryMessages<TContent, CoreHistoryChatMessage>(group, session, buildOptions))
    group = []
  }

  for (const node of nodes) {
    if (node.kind === 'compacted') {
      flush()
      // 失败的压缩没有摘要可发 —— 它在 UI 上是一张红卡,在模型历史里什么都不是。
      if (node.status === 'completed') {
        out.push({ role: 'user', content: buildOptions.buildMessageContent({
          id: node.messageId,
          role: 'user',
          content: compactedHistoryPreamble(node.summary),
        } as CoreHistoryChatMessage) })
      }
      continue
    }
    group.push(toHistoryMessage(node, state))
  }
  flush()

  return out
}

/**
 * 节点 → 历史消息的输入形状。
 *
 * assistant 节点这里多做一件 `projectChatMessages` 不做的事:**被 surface 遮蔽
 * 的 `tool/result` 对应的那次工具调用从历史里摘掉**。工具结果剪枝(§3.1 表里
 * 那一格)就是这么表达的 —— 结果事件被一条 replace 遮蔽,UI 上那张卡还在,
 * 下一次请求里没有它。
 */
function toHistoryMessage(node: ProjectionNode, state: SessionProjectionState): CoreHistoryChatMessage {
  const message = materializeNode(node) as ProjectedChatMessage
  if (node.kind !== 'assistant') return message as unknown as CoreHistoryChatMessage
  const pruned = pruneShadowedToolCalls(node, message, state)
  return pruned as unknown as CoreHistoryChatMessage
}

function pruneShadowedToolCalls(
  node: AssistantNode,
  message: ProjectedChatMessage,
  state: SessionProjectionState,
): ProjectedChatMessage {
  if (!message.toolCalls || message.toolCalls.length === 0) return message
  const kept = message.toolCalls.filter(toolCall => {
    const resultSeq = node.tools.get(toolCall.id)?.resultSeq
    if (resultSeq === undefined) return true
    return !state.surface.isShadowed(resultSeq)
  })
  if (kept.length === message.toolCalls.length) return message
  return { ...message, toolCalls: kept }
}
