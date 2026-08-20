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
import {
  buildHistoryMessages,
  canSplitHistoryTurnGroups,
  compactedHistoryPreamble,
  completedHistoryToolCalls,
} from '../../engine/history.js'
import { TurnContextLedger } from '../../engine/turn-context.js'
import type { BlobRef, SessionLogEventRecord } from '../events/types.js'
import { foldSessionProjection, materializeNode } from './chat-messages.js'
import { resolveHistoryBlobRefs, type ProjectionIssue, type ProjectionMaterializeOptions } from './blobs.js'
import type { AssistantNode, ProjectionNode, SessionProjectionState } from './reducer.js'
import type { ProjectedChatMessage } from './types.js'

export { resolveHistoryBlobRefs } from './blobs.js'

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
  /** F6(§13.2):blob 读不到时的留痕口。见 `blobs.ts`。 */
  onIssue?: (issue: ProjectionIssue) => void
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

  // F2(§13.2):**只有成功的压缩**才把这份历史切进压缩口径。
  //
  // 一次失败的压缩(真机发生过:deepseek 返回空摘要)在 UI 上是一张红卡,在模型
  // 历史里**什么都不是** —— 引擎那边它就是一条 role:'system' 的消息,被角色过滤
  // 直接跳过,整份历史一个字节不变。从前这里只看"有没有 compacted 节点",于是
  // 一次失败让:per-result 预算掉 8 倍、`session` 被置空(老摘要锚点失效整段重放)、
  // 消息组在那一点被劈成两段各自 build 一次。
  const hasCompacted = nodes.some(node => node.kind === 'compacted' && node.status === 'completed')

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
    // F1:压缩之后 providerData 只跟**最后一条**保留消息走 —— 摘要分支里那条
    // 规则,在这条路上必须由这个选项还回来(否则 codex/claude 的加密推理在
    // 压缩后的每一条消息上各带一份)。
    providerDataLastMessageOnly: hasCompacted,
  } as CoreBuildHistoryMessagesOptions<TContent, CoreHistoryChatMessage>

  // F3(§13.2):**`prepareMessages` 对整份保留序列跑一次**,而不是每段跑一次。
  //
  // 宿主那条路是 `buildHistoryMessages(prepare(全部消息), session, …)` —— prepare
  // 里的房投影会把整间房塌成一条消息,goal drive 折叠会跨消息比对"谁被谁取代了"。
  // 按段各跑一次的话,一次成功压缩就足以让它们各看半份:房投影出两条房消息、
  // 被取代的 drive 因为落在另一段而躲过折叠。从前 F2 只堵住了"失败压缩也切段"
  // 那一半,这里堵的是剩下那一半。
  //
  // 切段仍然存在(压缩前缀要插在中间),但它发生在 prepare **之后**:按每条
  // 消息在原序列里的位置归段,prepare 凭空造出来的消息(房投影的那一条)归当前段。
  const materializeOptions: ProjectionMaterializeOptions = {
    ...(options.resolveBlob ? { resolveBlob: options.resolveBlob } : {}),
    ...(options.onIssue ? { onIssue: options.onIssue } : {}),
  }
  const retained: CoreHistoryChatMessage[] = []
  /** 第 i 段的边界:retained 里下标 < boundary 的归上一段。 */
  const boundaries: Array<{ atRetainedIndex: number; preamble: CoreHistoryMessage }> = []

  for (const node of nodes) {
    if (node.kind === 'compacted') {
      // F2:失败的压缩**连段都不切**。它在引擎那边是一条被角色过滤掉的 system
      // 消息 —— 零影响,而不是"零摘要"。
      if (node.status !== 'completed') continue
      boundaries.push({
        atRetainedIndex: retained.length,
        preamble: { role: 'user', content: buildOptions.buildMessageContent({
          id: node.messageId,
          role: 'user',
          content: compactedHistoryPreamble(node.summary),
        } as CoreHistoryChatMessage) },
      })
      continue
    }
    retained.push(resolveHistoryBlobRefs(
      toHistoryMessage(node, state, materializeOptions),
      options.resolveBlob,
      options.onIssue,
    ))
  }

  const indexOfInput = new Map<string, number>()
  retained.forEach((message, index) => {
    const id = (message as unknown as { id?: unknown }).id
    if (typeof id === 'string' && !indexOfInput.has(id)) indexOfInput.set(id, index)
  })
  const prepared = options.prepareMessages ? options.prepareMessages(retained) : retained

  // 有压缩节点时 meta 的摘要**不再参与**:切点已经由 surface 表达,
  // 再让 `buildHistoryMessages` 按锚点切一次就是切两刀。
  const session = hasCompacted ? undefined : meta

  const out: CoreHistoryMessage[] = []
  let boundaryAt = 0
  let group: CoreHistoryChatMessage[] = []
  const flush = (): void => {
    if (group.length === 0) return
    out.push(...buildHistoryMessages<TContent, CoreHistoryChatMessage>(group, session, buildOptions))
    group = []
  }

  for (const message of prepared) {
    const id = (message as unknown as { id?: unknown }).id
    const position = typeof id === 'string' ? indexOfInput.get(id) : undefined
    while (boundaryAt < boundaries.length
      && position !== undefined
      && position >= boundaries[boundaryAt].atRetainedIndex) {
      flush()
      out.push(boundaries[boundaryAt].preamble)
      boundaryAt += 1
    }
    group.push(message)
  }
  flush()
  // 压缩之后一条消息都没有(刚压完还没说话):前缀照旧要在。
  for (; boundaryAt < boundaries.length; boundaryAt++) out.push(boundaries[boundaryAt].preamble)

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
function toHistoryMessage(
  node: ProjectionNode,
  state: SessionProjectionState,
  materializeOptions: ProjectionMaterializeOptions,
): CoreHistoryChatMessage {
  const message = materializeNode(node, materializeOptions) as ProjectedChatMessage
  if (node.kind !== 'assistant') return message as unknown as CoreHistoryChatMessage
  const pruned = pruneShadowedToolCalls(node, message, state)
  checkTurnSplitFallback(pruned as unknown as CoreHistoryChatMessage, materializeOptions)
  return pruned as unknown as CoreHistoryChatMessage
}

/**
 * F8(§13.2):**回合重放的硬条件在这份物化消息上成立吗?**
 *
 * `buildHistoryMessages` 里那条判据是 all-or-nothing:任何一格 text/reasoning
 * part 少了 `turnIndex`、任何一次被重放的调用查不到回合号,整条消息就退回
 * "合并成一段独白"的老口径 —— 连 reasoning 怎么进历史都跟着变。投影这边
 * `turnIndex` 是**可选字段**,于是这次退化在这条路上是完全静默的。
 *
 * 判据不抄:调的是引擎导出的那一个函数(`canSplitHistoryTurnGroups`)。
 * 这里不改任何字节 —— 退化本身是对的(两侧同一份数据、同一个函数),
 * 要的是**看得见**:多回合的消息一旦掉进 collapsed,留一条 issue。
 */
function checkTurnSplitFallback(
  message: CoreHistoryChatMessage,
  options: ProjectionMaterializeOptions,
): void {
  if (!options.onIssue) return
  const parts = message.contentParts ?? []
  const turns = new Set<number>()
  let missing = false
  for (const part of parts) {
    if (part.type !== 'text' && part.type !== 'reasoning') continue
    if (!part.content) continue
    if (typeof part.turnIndex === 'number') turns.add(part.turnIndex)
    else missing = true
  }
  // 单回合的消息本来就走 collapsed —— 那不是退化。
  if (!missing && turns.size <= 1) return
  if (canSplitHistoryTurnGroups(message, completedHistoryToolCalls(message))) return
  options.onIssue({
    kind: 'turn-split-fallback',
    where: 'history.turnGroups',
    ...(typeof (message as { id?: unknown }).id === 'string'
      ? { messageId: (message as { id: string }).id }
      : {}),
  })
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
