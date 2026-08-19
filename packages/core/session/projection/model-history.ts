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
import type { BlobRef, SessionLogEventRecord } from '../events/types.js'
import { isBlobRef } from '../events/types.js'
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
  /**
   * G8(§10.1):把事件里的 `BlobRef` 换回正文。
   *
   * 附件的 `base64Data`、图片 part 的正文在事件行里**只能**是引用(§9.1),
   * 而 provider 要的是那一坨 base64。宿主(app 层的 blob store)把读取口传进来;
   * 不传就把带 BlobRef 的附件**摘掉** —— 绝不让一个 `{hash,bytes}` 对象当成
   * base64 发出去(那是最难查的一类脏请求:请求发得出去,模型看到一句 JSON)。
   */
  resolveBlob?: (ref: BlobRef) => string | undefined
  providerDataFromContentPart?: CoreBuildHistoryMessagesOptions<TContent, CoreHistoryChatMessage>['providerDataFromContentPart']
  /**
   * 宿主在**交给 builder 之前**对消息列表做的那一遍预处理。
   *
   * 桌面端那条路不是直接 `buildHistoryMessages(messages)`,而是
   * `collapseSupersededGoalDrives(projectRoomMessagesForModel(…)).map(prepareUserMessageForModel)`
   * 之后再交给 builder(`app/engine/stream/message-helpers.ts`)。影子断言要比的
   * 是"同一条配方、两个来源",所以这一遍必须由宿主原样传进来 —— 少了它,
   * 断言比的就是两种不同的构造法,永远不等而且什么也证明不了。
   *
   * 按 surface 上的**连续非压缩段**逐段应用(压缩节点天然是段边界)。
   */
  prepareMessages?: (messages: CoreHistoryChatMessage[]) => CoreHistoryChatMessage[]
  /**
   * G9(§10.1):强制压缩后的 per-result 预算。缺省由 surface 上有没有
   * `session/compacted` 节点决定 —— 与今天同口径,不必调用方操心。
   */
  forceCompactedToolResults?: boolean
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
  const surface = state.surface.snapshot()
  const nodes: ProjectionNode[] = []
  for (const eventSeq of surface.order) {
    const node = state.byEventSeq.get(eventSeq)
    if (node) nodes.push(node)
  }

  const hasCompacted = nodes.some(node => node.kind === 'compacted')

  const buildOptions = {
    buildMessageContent: (options.buildMessageContent
      ?? (defaultHistoryMessageContent as unknown as CoreBuildHistoryMessagesOptions<TContent, CoreHistoryChatMessage>['buildMessageContent'])),
    ...(options.getAIToolName ? { getAIToolName: options.getAIToolName } : {}),
    ...(options.failureResultForAI ? { failureResultForAI: options.failureResultForAI } : {}),
    ...(options.providerDataFromContentPart
      ? { providerDataFromContentPart: options.providerDataFromContentPart }
      : {}),
    // G9:surface 上有压缩节点 = 这是一份压缩过的历史,尾部按压缩预算。
    forceCompactedToolResults: options.forceCompactedToolResults ?? hasCompacted,
  } as CoreBuildHistoryMessagesOptions<TContent, CoreHistoryChatMessage>

  const out: CoreHistoryMessage[] = []
  let group: CoreHistoryChatMessage[] = []

  const flush = (): void => {
    if (group.length === 0) return
    // 有压缩节点时 meta 的摘要**不再参与**:切点已经由 surface 表达,
    // 再让 `buildHistoryMessages` 按锚点切一次就是切两刀。
    const session = hasCompacted ? undefined : meta
    const prepared = options.prepareMessages ? options.prepareMessages(group) : group
    out.push(...buildHistoryMessages<TContent, CoreHistoryChatMessage>(prepared, session, buildOptions))
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
    group.push(resolveHistoryBlobRefs(toHistoryMessage(node, state), options.resolveBlob))
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

/**
 * G8:一条历史消息里的 `BlobRef` 全部换回正文(拿不到就摘掉那一格)。
 *
 * 只动两处 —— 附件的 `base64Data` 与图片 part 的正文。这是"落点与回放同一函数"
 * 的另一半:落盘时把大正文换成引用的是 blob store,回放时换回来的是这里,
 * 两边认的是同一个 `isBlobRef` 判据。
 */
export function resolveHistoryBlobRefs(
  message: CoreHistoryChatMessage,
  resolveBlob: ((ref: BlobRef) => string | undefined) | undefined,
): CoreHistoryChatMessage {
  const record = message as unknown as Record<string, unknown>
  const attachments = record.attachments
  const contentParts = record.contentParts

  const nextAttachments = Array.isArray(attachments)
    ? resolveBlobList(attachments, 'base64Data', resolveBlob)
    : undefined
  const nextParts = Array.isArray(contentParts)
    ? resolveBlobList(contentParts, 'blob', resolveBlob)
    : undefined

  if (nextAttachments === undefined && nextParts === undefined) return message
  return {
    ...(record as object),
    ...(nextAttachments !== undefined ? { attachments: nextAttachments } : {}),
    ...(nextParts !== undefined ? { contentParts: nextParts } : {}),
  } as CoreHistoryChatMessage
}

/** @returns undefined = 这一格没有任何 BlobRef,原样复用(不复制数组)。 */
function resolveBlobList(
  items: readonly unknown[],
  key: string,
  resolveBlob: ((ref: BlobRef) => string | undefined) | undefined,
): unknown[] | undefined {
  let changed = false
  const out: unknown[] = []
  for (const item of items) {
    const ref = (item as Record<string, unknown> | null)?.[key]
    if (!isBlobRef(ref)) {
      out.push(item)
      continue
    }
    changed = true
    const resolved = resolveBlob?.(ref)
    if (resolved === undefined) continue
    out.push(key === 'blob'
      // 图片 part 的正文回到 `data`(与落盘前同名),blob 引用撤下。
      ? { ...(item as object), blob: undefined, data: resolved }
      : { ...(item as object), [key]: resolved })
  }
  return changed ? out : undefined
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
