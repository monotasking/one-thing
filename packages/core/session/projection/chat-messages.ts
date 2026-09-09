/**
 * `projectChatMessages(events, {upToSeq?})` —— UI 看的那一份(§9.4)。
 *
 * 它是 `reduceSessionProjection` 上的一次 fold + 一次物化。物化独立成
 * `materializeChatMessages(state)`,所以活跃会话可以"推一条事件、重物化尾部"
 * 而不必重跑整份日志。
 *
 * 派生规则(事件里没有的东西一律**派生**,不猜、不回填):
 *  - `content` = 该 run 全部 text part 的 fold(按 partIndex);
 *  - `reasoning` = **只有** `'top'` 那一段推理(turn 1 开头那串);其余推理段是
 *    `contentParts` 里的 `reasoning` 格 —— 两个落点由引擎的
 *    `getAgentLoopReasoningPlacement` 划分,投影按 `topReasoningPartIndexes` 复刻;
 *  - `contentParts` = 同一批 part 按 partIndex 排出来(`tool-input` 与 top 推理不进);
 *  - `toolCalls` / `steps` = `tool/call|result|audit` 按到达序;
 *  - `usage` = 这次**执行**全部 `request/response.usage` 之和(steering 跨 run 时
 *    接着累加,总量只落在接手的那条消息上);
 *  - `isStreaming` = `run/start` 之后、`run/end` 之前(它不是事件字段,是状态);
 *  - `message/patched` 最后叠加(assistant 上的正文字段会被剥掉,见 reducer)。
 */

// §17.8 U1-a:走**叶子路径** —— `context-compact.ts` 为了压缩算法要
// `engine/history.js` → `agent-loop/tool-names.js`(`node:crypto`),而这里只要
// 那一个纯序列化函数。
import { buildContextCompactContent } from '../../engine/context-compact-content.js'
import type { SessionLogEventRecord } from '../events/types.js'
import { resolveHistoryBlobRefs, type ProjectionMaterializeOptions } from './blobs.js'
import type { AssistantNode, CompactedNode, MessageNode, ProjectionNode, SessionProjectionState } from './reducer.js'
import {
  createSessionProjectionState,
  deriveThinkingTime,
  materializeContentParts,
  materializeOrphanSteps,
  materializeOrphanToolCalls,
  materializePartText,
  materializeStop,
  materializeSteps,
  materializeToolCalls,
  materializeTopReasoning,
  reduceSessionProjection,
} from './reducer.js'
import type { ProjectChatMessagesResult, ProjectedChatMessage } from './types.js'

export interface ProjectChatMessagesOptions extends ProjectionMaterializeOptions {
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
  return materializeChatMessages(foldSessionProjection(events, options), options)
}

export function materializeChatMessages(
  state: SessionProjectionState,
  options: ProjectionMaterializeOptions = {},
): ProjectChatMessagesResult {
  const messages: ProjectedChatMessage[] = []
  for (const node of state.nodes) {
    if (node.hidden) continue
    messages.push(materializeNode(node, options))
  }
  return {
    messages,
    ...(state.activeRun ? { activeRun: state.activeRun } : {}),
  }
}

export function materializeNode(
  node: ProjectionNode,
  options: ProjectionMaterializeOptions = {},
): ProjectedChatMessage {
  switch (node.kind) {
    case 'message': return materializeMessageNode(node, options)
    case 'assistant': return materializeAssistantNode(node, options)
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
/**
 * A9(§13.1):附件的 `base64Data` 在事件行里是 `BlobRef` —— 交出去之前换回正文
 * (`resolveHistoryBlobRefs`,与模型历史那条路**同一个函数**)。换不回来时
 * 照实留引用并记一条 issue(F6),不静默变短。
 *
 * **交出去的消息是活对象**(§15.13):这里对 `node.message` 是浅展开,`steps` /
 * `toolCalls` / `attachments` 这些数组与其中的对象都还是活投影节点本体(顶层归约器
 * 的"线性持有"约定的自然延伸)。**任何就地写者拿到它之前必须先 clone**;
 * 补水链上真出过这一刀 —— `rehydrateSessionFromStorage` 就地给 step 补
 * `toolCall`,把事件里没有的字段写进了活投影,refold 不变量当场破掉
 * (修法见 `backend/session/hydrate.ts`、判例见
 * `sessions/session-dehydrate.ts` 的 `dehydrateProjectedMessages`)。
 */
function materializeMessageNode(
  node: MessageNode,
  options: ProjectionMaterializeOptions,
): ProjectedChatMessage {
  const {
    // `ChatMessage.seq` 是位置,事件坐标是身份(§3.2 它在 S2 退役)。
    // 投影不再产出位置,避免下一个人拿它当身份。
    seq: _droppedPositionSeq,
    ...carried
  } = node.message as Record<string, unknown>
  return resolveHistoryBlobRefs({
    ...carried,
    ...(node.turnContext ? { turnContext: node.turnContext } : {}),
    ...node.patch,
    eventSeq: node.eventSeq,
    // 消息这条路上换不回来的引用**照实留着**(A2 / provider-data 的既有口径),
    // 不像模型历史那样摘掉 —— 屏幕上那一格是个占位,而那就是事实。
  } as ProjectedChatMessage, options.resolveBlob, options.onIssue, 'keep')
}

function materializeAssistantNode(
  node: AssistantNode,
  options: ProjectionMaterializeOptions,
): ProjectedChatMessage {
  // G7:孤儿参数流合成的占位调用排在真调用之后 —— 它们是"还没成为调用"的东西。
  const toolCalls = [...materializeToolCalls(node, options), ...materializeOrphanToolCalls(node)]
  // 占位调用与占位 step 是引擎**同一行代码**建的两样东西
  // (`createCoreToolInputStartArtifacts`)—— 补一样漏一样就是投影少一条 step
  // (§10.14 第 7 类)。
  const steps = [...materializeSteps(node, options), ...materializeOrphanSteps(node)]
  const contentParts = materializeContentParts(node, options)
  // `message.reasoning` 只装 `'top'` 那一段 —— 引擎的 `updateMessageReasoning`
  // 只在 placement 是 'top' 时被调用,inline 的那些留在 contentParts 里。
  const reasoning = materializeTopReasoning(node, options)
  const thinkingTime = deriveThinkingTime(node)
  // **这一轮为什么提前结束**(2026-09-09):`request/end.stopReason` + 同一条请求的
  // 配方与用量,经 `stop-reasons.ts` 那张表筛过。流式期间与被 steering 接手的那条
  // 消息上一律缺席 —— 两道闸都在 `materializeStop` 里,判据不在这儿抄第二份。
  const stop = materializeStop(node)

  // 图片 / provider-data part 的正文也住在 blob 里 —— 与附件同一个函数换回来
  // (`{blob}` → `{data}`)。宿主从前在投影**之外**补这一刀,于是每个消费者
  // 各记得一次;现在物化出去的那一份就已经是完整的。
  return resolveHistoryBlobRefs({
    id: node.messageId,
    role: 'assistant',
    content: materializePartText(node, 'text', options),
    timestamp: node.time,
    eventSeq: node.eventSeq,
    ...(reasoning ? { reasoning } : {}),
    ...(node.provider ? { provider: node.provider } : {}),
    ...(node.model ? { model: node.model } : {}),
    ...(node.agentId ? { agentId: node.agentId } : {}),
    // §13.9:协作回合的思考记录标记(`stampCollabAgentId` 与 agentId 同一刻盖的)。
    // 它决定这条消息在房间里是"发言"还是"思考痕迹",链闸与收割都读它。
    ...(node.messageSource ? { source: node.messageSource } : {}),
    ...(node.origin ? { origin: node.origin } : {}),
    ...(contentParts.length > 0 ? { contentParts } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(steps.length > 0 ? { steps } : {}),
    // 被 steering 接手的那条消息**没有 usage**:引擎的累加器跟着
    // `assistantMessageId` 一路带到接手的那条消息上(整次执行的总量落在那里),
    // 被打断的这条从来没被写过用量。step 级的每轮用量照旧有 —— 那是 turn-end
    // 当场按 turnIndex 写进 steps 的,发生在换消息之前(§10.12 第 5 类)。
    // 用量**只在一次执行正常收尾时写一次**(`executeAgentLoopStreamLifecycle` 的
    // `updateUsage` 排在 chunk 循环之后、`completeStream` 之前)。abort / 出错
    // 那两条路是从 catch 里走的,`updateUsage` 一次都没跑 —— 消息上因此**没有**
    // usage,尽管前面几轮的 `request/response` 各自都带着 token 数(它们照旧
    // 进 `steps[].usage`,那是 turn-end 当场写的)。真机 `17b342a2…` 的
    // abort 消息就是这样(§10.14 第 7 类)。
    ...(node.usage && !node.continuedByRunId && node.outcome === 'completed'
      ? { usage: node.usage }
      : {}),
    ...(node.skillUsed ? { skillUsed: node.skillUsed } : {}),
    ...(thinkingTime !== undefined ? { thinkingTime } : {}),
    ...(node.ended ? {} : { isStreaming: true as const }),
    ...(stop ? { stop } : {}),
    ...(node.errorDetails ? { errorDetails: node.errorDetails } : {}),
    ...node.patch,
    // 消息这条路上换不回来的引用**照实留着**(A2 / provider-data 的既有口径),
    // 不像模型历史那样摘掉 —— 屏幕上那一格是个占位,而那就是事实。
  } as ProjectedChatMessage, options.resolveBlob, options.onIssue, 'keep')
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
