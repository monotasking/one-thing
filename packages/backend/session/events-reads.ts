/**
 * `events` 模式下的读实现(S2a,§11.1)。
 *
 * 它是 `sessionReads` 的另一半:同样的七个问题,答案从 `events.jsonl` 来而不是
 * `messages.jsonl`。两条路的分岔点只有一个(`read-mode.ts`),默认仍走前者。
 *
 * ## 两种读者,两条路(§3.2 的表)
 *
 *  - **整会话**(引擎激活、搜索、collab 等一切"要全部消息"的读者)→ 全量 fold。
 *    活投影已经在内存里(`projection-cache.ts`,与影子断言共用)就不读文件;
 *  - **分页**(UI 首屏 / 向上翻)→ core 的**倒读 pager**,从文件尾按块往前读,
 *    攒够一页就停,不整份加载。活投影已经在内存里时优先用它(更准也更便宜:
 *    见 pager 注释里那条"深翻页看不见更晚的遮蔽事件"的已知偏差)。
 *
 * ## 老会话怎么办
 *
 * 只有 E0 七类事件的老会话 fold 出来是**零个节点** —— 那是对的,它们的消息事实
 * 还在 `messages.jsonl` 里,要等 S2b 的迁移脚本把它们变成 `message/imported`。
 * 所以这里的每个入口在"折不出任何消息"时返回 `undefined`,由 `reads.ts` 退回
 * 消息模式。**不是兜底,是事实所在处不同**:事件里真的没有这条会话的历史。
 */

import type { ChatMessage, GetSessionMessagesPageRequest, GetSessionMessagesPageResponse, UserMessageMarker } from '@shared/ipc.js'
import fs from 'node:fs'
import {
  buildSessionEventJumpIndex,
  materializeNode,
  materializeChatMessages,
  materializeStep,
  pageEventMessages,
  readLedgerWatermark,
  userMarkersFromProjected,
  type ProjectedChatMessage,
  type SessionEventByteReader,
  type SessionEventJumpIndex,
  type ProjectionNode,
  type SessionProjectionState,
} from '@onething/core/session'
import type { SessionProjectionCache } from './projection-cache.js'
import type { sessionProjectionOptions } from './projection-blobs.js'
import { getCurrentBackend } from '../current.js'

export interface SessionEventReadPorts {
  getLogPath(sessionId: string): string
  projections: Pick<SessionProjectionCache, 'getLiveSessionProjection' | 'hasLiveSessionProjection'>
  materializeOptions: typeof sessionProjectionOptions
}

/**
 * 尾页那条读法交出去的整份快照:一页 + 水位 + 「此刻有没有一条开着的 run」。
 *
 * 三格出自**同一个快照**(判据全文在下面那只函数的注上),所以它们是一个类型
 * 而不是三个返回值。
 */
export interface SessionTailPageSnapshot {
  page: GetSessionMessagesPageResponse
  watermark: number
  activeMessageId?: string
}

export function createSessionEventReads(ports: SessionEventReadPorts) {
// ============ 字节面(core 的 fs 适配器) ============

/**
 * `events.jsonl` 的字节区间读者。core 的 pager 是纯的,fs 由这里供上 ——
 * 每次分页开一次句柄、按块 `readSync`,读完就关。
 *
 * 打不开(文件不存在 / legacy 整文件会话)返回 `undefined`。
 */
function withEventReader<T>(sessionId: string, run: (reader: SessionEventByteReader) => T): T | undefined {
  let fd: number | undefined
  try {
    const logPath = ports.getLogPath(sessionId)
    const size = fs.statSync(logPath).size
    if (size === 0) return undefined
    fd = fs.openSync(logPath, 'r')
    const handle = fd
    return run({
      size,
      read(position, length) {
        const start = Math.max(0, Math.min(position, size))
        const wanted = Math.max(0, Math.min(length, size - start))
        if (wanted === 0) return new Uint8Array(0)
        const buffer = Buffer.allocUnsafe(wanted)
        const read = fs.readSync(handle, buffer, 0, wanted, start)
        return new Uint8Array(buffer.buffer, buffer.byteOffset, read)
      },
    })
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* 关不上也不该再制造第二条错误路径 */ }
    }
  }
}

// ============ 跳转索引(每会话一次,只在内存) ============

const jumpIndexes = new Map<string, SessionEventJumpIndex>()
interface MessageViewCache {
  nodes: WeakMap<ProjectionNode, { rev: number; message: ChatMessage }>
  lists: WeakMap<SessionProjectionState, ChatMessage[]>
}

/**
 * 物化的两档 —— **正文** 还是 **引用**(工单 4 A)。
 *
 * 两档各有一份记忆:同一个节点在两档下物化出来的消息不是同一份(一个带
 * base64,一个带 `{hash,bytes}`),混用一份缓存就是"上一次谁读的决定这一次你
 * 看见什么"。缓存是 `WeakMap`,多一档不多留一份历史。
 */
type MessageBlobMode = 'inline' | 'reference'
// Owned by this read layer, one cache per session. Nodes and projection
// generations are weak keys, so eviction does not retain history.
const messageViews = new Map<string, Record<MessageBlobMode, MessageViewCache>>()
function messageView(sessionId: string, mode: MessageBlobMode): MessageViewCache {
  let caches = messageViews.get(sessionId)
  if (!caches) {
    caches = {
      inline: { nodes: new WeakMap(), lists: new WeakMap() },
      reference: { nodes: new WeakMap(), lists: new WeakMap() },
    }
    messageViews.set(sessionId, caches)
  }
  return caches[mode]
}

/** 这一档的物化选项。`reference` = 不读 blob、也不记退化(见 core 的 `blobs` 那一格)。 */
function materializeFor(sessionId: string, mode: MessageBlobMode) {
  const options = ports.materializeOptions(sessionId)
  return mode === 'reference' ? { ...options, blobs: 'reference' as const } : options
}

/**
 * `anchor.messageId` / `anchor.seq` → 文件偏移。首次跳转时正向扫一遍建表
 * (§3.2:每会话一次,**不落盘** —— 落盘的索引就是快照的影子)。
 * 文件长了就重建:事件是纯追加的,长度变了等于有新事件。
 */
function jumpIndexOf(sessionId: string): SessionEventJumpIndex | undefined {
  return withEventReader(sessionId, reader => {
    const cached = jumpIndexes.get(sessionId)
    if (cached && cached.size === reader.size) return cached
    const index = buildSessionEventJumpIndex(reader)
    jumpIndexes.set(sessionId, index)
    return index
  })
}

function resetSessionEventReadCache(sessionId?: string): void {
  if (sessionId) {
    jumpIndexes.delete(sessionId)
    messageViews.delete(sessionId)
    return
  }
  jumpIndexes.clear()
  messageViews.clear()
}

// ============ 投影 → ChatMessage ============

/**
 * 投影出的消息 → 交给上层的 `ChatMessage`:`seq` 填 **eventSeq**(§11.1)。
 *
 * A8/A9(§13.6):`BlobRef` 的回放**搬进了投影本身**(物化时就换好了),这里
 * 不再补第二刀 —— 从前每个消费者各记得一次,于是工具大结果那条新落点补上时
 * 补一处漏一处。物化选项由 `sessionProjectionOptions` 统一给。
 */
function toChatMessage(_sessionId: string, message: ProjectedChatMessage): ChatMessage {
  return {
    ...message,
    ...(message.eventSeq !== undefined ? { seq: message.eventSeq } : {}),
  } as unknown as ChatMessage
}

/** 这条会话的全部**可见**消息(投影)。折不出节点 = 事件里没有它的历史。 */
function eventsListMessages(sessionId: string): ChatMessage[] | undefined {
  return messagesFromState(sessionId, ports.projections.getLiveSessionProjection(sessionId), 'inline')
}

/**
 * 一份**已经在手**的投影 → 可见消息(工单 4 A 把它从 `eventsListMessages` 里
 * 分出来的)。
 *
 * 分出来的唯一理由是**原子性**:尾页那条读法要把「这一页」与「账本水位」
 * (`state.lastSeq`)从**同一个 state 对象**上取。让它自己去调
 * `getLiveSessionProjection` 就意味着页与水位是两次取,而"两次同步调用之间不
 * 可能有事件插进来"是一句关于 JS 事件环的**巧合**,不是这段代码说得出口的判据。
 * 收成一个参数之后,想分两拍取都做不到。
 */
function messagesFromState(
  sessionId: string,
  state: SessionProjectionState,
  mode: MessageBlobMode,
): ChatMessage[] | undefined {
  if (state.nodes.length === 0) return undefined
  const cache = messageView(sessionId, mode)
  const options = materializeFor(sessionId, mode)
  const messages: ChatMessage[] = []
  for (const node of state.nodes) {
    // Visibility is independent of rev and must be checked on every read.
    if (node.hidden) continue
    const memo = cache.nodes.get(node)
    if (memo?.rev === node.rev) { messages.push(memo.message); continue }
    let degraded = false
    const projected = materializeNode(node, { ...options, onIssue(issue) {
      degraded = true
      options.onIssue?.(issue)
    } })
    // Imported nodes share nested mutable projection objects. Detach only the
    // changed node once, before publishing or memoizing it; never clone a whole
    // cached history. Blob checks run on misses; failed reads remain retryable.
    const message = toChatMessage(sessionId, structuredClone(projected))
    if (degraded) cache.nodes.delete(node)
    else cache.nodes.set(node, { rev: node.rev, message })
    messages.push(message)
  }
  if (messages.length === 0) return undefined
  const previous = cache.lists.get(state)
  if (previous?.length === messages.length && previous.every((message, index) => message === messages[index])) return previous
  cache.lists.set(state, messages)
  return messages
}

/**
 * 这条会话的折叠产物里有这条消息吗 —— **不物化**(F4-c c4-d,§16.27)。
 *
 * 空转之后的 18 端口只剩这一个问题要答("这条消息在不在",RPC 面据此回
 * `success`)。走 `byMessageId` 这张表:O(1),不重建 parts/steps/toolCalls,
 * 也不深拷 —— 它挂在逐 token 的热路径上,`eventsGetMessage`(每次物化整会话)
 * 在这里是绝对不能用的。
 */
function eventsHasMessage(sessionId: string, messageId: string): boolean {
  const node = ports.projections.getLiveSessionProjection(sessionId).byMessageId.get(messageId)
  return node !== undefined && !node.hidden
}

/** 这条会话在事件里有历史吗(路由的短路闸)。 */
function sessionHasEventHistory(sessionId: string): boolean {
  return ports.projections.getLiveSessionProjection(sessionId).nodes.length > 0
}

function eventsCountMessages(sessionId: string): number | undefined {
  const state = ports.projections.getLiveSessionProjection(sessionId)
  if (state.nodes.length === 0) return undefined
  return state.nodes.filter(node => !node.hidden).length
}

function eventsGetMessage(sessionId: string, messageId: string): ChatMessage | undefined {
  const messages = eventsListMessages(sessionId)
  return messages?.find(message => message.id === messageId)
}

function eventsGetMessageIndex(sessionId: string, messageId: string): number | undefined {
  const messages = eventsListMessages(sessionId)
  if (!messages) return undefined
  return messages.findIndex(message => message.id === messageId)
}

function eventsLastMessageOfRole(
  sessionId: string,
  role: ChatMessage['role'],
): ChatMessage | undefined {
  const messages = eventsListMessages(sessionId)
  if (!messages) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === role) return messages[index]
  }
  return undefined
}

function eventsListUserMarkers(sessionId: string): UserMessageMarker[] | undefined {
  const state = ports.projections.getLiveSessionProjection(sessionId)
  if (state.nodes.length === 0) return undefined
  return userMarkersFromProjected(materializeChatMessages(state, ports.materializeOptions(sessionId)).messages)
}

/**
 * 一页消息。
 *
 * 活投影在内存里就直接从它取(一次分页不该为了 40 条消息再读一遍文件);
 * 没有就走 core 的倒读 pager —— 那条路**不建活投影**,否则"不整份加载"这句话
 * 当场作废。
 */
function eventsPageMessages(
  request: GetSessionMessagesPageRequest,
): GetSessionMessagesPageResponse | undefined {
  if (ports.projections.hasLiveSessionProjection(request.sessionId)) {
    const messages = eventsListMessages(request.sessionId)
    if (messages) return pageFromMemory(request, messages)
  }

  const paged = withEventReader(request.sessionId, reader => pageEventMessages(reader, request, {
    // A8/A9:分页与整会话读用**同一份**物化选项(见 pager 里那条注释)。
    materialize: ports.materializeOptions(request.sessionId),
    resolveAnchor: anchor => {
      const index = jumpIndexOf(request.sessionId)
      if (!index) return undefined
      if (anchor.messageId) return index.byMessageId.get(anchor.messageId)
      if (anchor.seq !== undefined) {
        const offset = index.offsetBySeq.get(anchor.seq)
        return offset === undefined ? undefined : { seq: anchor.seq, offset }
      }
      return undefined
    },
  }))
  if (!paged) return undefined
  if (!paged.success) return paged as unknown as GetSessionMessagesPageResponse
  if ((paged.messages?.length ?? 0) === 0 && !paged.hasMoreBefore) {
    // 折不出任何消息 = 事件里没有这条会话的历史(老会话)。交回给消息模式。
    return undefined
  }
  return {
    ...paged,
    messages: (paged.messages ?? []).map(message =>
      toChatMessage(request.sessionId, message as unknown as ProjectedChatMessage)),
  } as GetSessionMessagesPageResponse
}

/**
 * 活投影在手时的分页:坐标仍是 eventSeq,游标不带文件偏移(内存路不需要它)。
 * 与 pager 的结果**逐字段相同** —— 测试两条路互比。
 */
function pageFromMemory(
  request: GetSessionMessagesPageRequest,
  messages: readonly ChatMessage[],
): GetSessionMessagesPageResponse {
  const limit = Math.max(1, Math.min(300, Math.floor(request.limit ?? 16)))
  const seqOf = (message: ChatMessage): number => (message as { seq?: number }).seq ?? 0

  let startIndex = Math.max(0, messages.length - limit)
  let endIndex = messages.length - 1

  if (request.cursor) {
    let cursor: { sessionId?: string; seq?: number; includeAnchor?: boolean } | undefined
    try { cursor = JSON.parse(request.cursor) } catch { cursor = undefined }
    if (!cursor || cursor.sessionId !== request.sessionId || typeof cursor.seq !== 'number') {
      return { success: false, error: 'Invalid message page cursor' }
    }
    const at = messages.findIndex(message => seqOf(message) === cursor.seq)
    if (at === -1) return { success: false, error: 'Invalid message page cursor' }
    if ((request.direction ?? 'older') === 'newer') {
      startIndex = cursor.includeAnchor ? at : at + 1
      endIndex = Math.min(messages.length - 1, startIndex + limit - 1)
    } else {
      endIndex = cursor.includeAnchor ? at : at - 1
      startIndex = Math.max(0, endIndex - limit + 1)
    }
  } else if (request.anchor && request.anchor !== 'tail') {
    const anchor = request.anchor
    const at = anchor.messageId
      ? messages.findIndex(message => message.id === anchor.messageId)
      : messages.findIndex(message => seqOf(message) === anchor.seq)
    if (at === -1) return { success: false, error: 'Anchor message not found' }
    const before = Math.max(0, anchor.before ?? Math.floor(limit / 2))
    const after = Math.max(0, anchor.after ?? Math.max(0, limit - before - 1))
    startIndex = Math.max(0, at - before)
    endIndex = Math.min(messages.length - 1, at + after)
  }

  const page = startIndex > endIndex ? [] : messages.slice(startIndex, endIndex + 1)
  const first = page[0]
  const last = page[page.length - 1]
  return {
    success: true,
    messages: page as ChatMessage[],
    nextCursor: first
      ? JSON.stringify({ sessionId: request.sessionId, seq: seqOf(first), includeAnchor: false })
      : null,
    backwardsCursor: last
      ? JSON.stringify({ sessionId: request.sessionId, seq: seqOf(last), includeAnchor: true })
      : null,
    hasMoreBefore: startIndex > 0,
    hasMoreAfter: endIndex < messages.length - 1,
    totalCount: messages.length,
  }
}

/**
 * 一页消息 + 这一页对应的**账本水位**(工单 4 A)。
 *
 * ## 水位是什么,壳拿它做什么
 *
 * 水位 = 「这一页是账本折到第几条时算出来的」。壳把这一页当作首屏的底稿,然后
 * 从 SSE 上接着折 —— **只折 `seq > 水位` 的那些**。所以水位必须与这一页出自
 * **同一个快照**:
 *
 *  · 水位比页新一条 → 那一条既不在页里、也会被壳跳过 = 一条消息永远消失;
 *  · 水位比页旧一条 → 那一条在页里有、SSE 上又来一次 = 同一段正文折两遍。
 *
 * 两种都是静默的。所以这只函数不给调用方留"分两拍取"的余地:
 *
 *  · **内存路**:`getLiveSessionProjection` 只调一次,页与 `state.lastSeq` 从
 *    同一个 state 对象上取(`messagesFromState` 收 state 做参数正是为了这个);
 *  · **文件路**:`withEventReader` 只开一次 —— reader 在打开的那一刻就把 `size`
 *    定格,页与 `readLedgerWatermark` 都只看得见那些字节,后面追加的一个也看不见。
 *
 * ## blob:带引用,不带正文
 *
 * 首屏这一页走 `blobs: 'reference'`:附件的 base64、超 64KB 的工具结果一律留
 * `{hash,bytes}` 引用。判据是**这一页是拿来上屏的**,而屏幕上那几格要的是"有
 * 一张图"这件事,不是那 3MB 字节 —— 真要看内容,壳按 hash 单独取(`blobs/` 本来
 * 就是按内容寻址的)。整份抄本那条读法(`record` / `messages`)一格不动,它的
 * 读者(模型历史、导出)要的就是正文。
 */
function eventsPageMessagesAtWatermark(
  request: GetSessionMessagesPageRequest,
): SessionTailPageSnapshot | undefined {
  if (ports.projections.hasLiveSessionProjection(request.sessionId)) {
    const state = ports.projections.getLiveSessionProjection(request.sessionId)
    const messages = messagesFromState(request.sessionId, state, 'reference')
    if (messages) {
      return {
        page: pageFromMemory(request, messages),
        watermark: state.lastSeq,
        /*
         * 水位那一刻**还开着的那条 run**(工单 5 ③ 的接缝闸)。
         *
         * 壳按水位接 SSE 是「空状态上接着折」——只有 `run/start` / `user/message`
         * 这类**自己会造节点**的事件折得进去。一条**在水位之前就开张**的 run,
         * 它后面的 delta 在空状态上一条都落不下(归约器 `state.runs.get` 落空
         * 就 break),于是壳必须知道「这一次不能走页」。所以这一格不是读数,
         * 是判据。
         *
         * 文件那一支恒缺席,而那**不是漏答**:没有活投影 = 这个进程里没有引擎在
         * 跑这条会话 = 不会有属于它的 SSE 事件到达,「有没有开着的 run」这个问题
         * 在那条路上没有答案也不需要答案。
         */
        ...(state.activeRun ? { activeMessageId: state.activeRun.messageId } : {}),
      }
    }
  }

  const snapshot = withEventReader(request.sessionId, reader => ({
    page: pageEventMessages(reader, request, {
      materialize: { ...ports.materializeOptions(request.sessionId), blobs: 'reference' as const },
      resolveAnchor: anchor => {
        const index = jumpIndexOf(request.sessionId)
        if (!index) return undefined
        if (anchor.messageId) return index.byMessageId.get(anchor.messageId)
        if (anchor.seq !== undefined) {
          const offset = index.offsetBySeq.get(anchor.seq)
          return offset === undefined ? undefined : { seq: anchor.seq, offset }
        }
        return undefined
      },
    }),
    // 同一个 reader —— 见上面「原子性」那一节。
    watermark: readLedgerWatermark(reader),
  }))
  if (!snapshot) return undefined
  const { watermark } = snapshot
  const paged = snapshot.page
  if (!paged.success) return { page: paged as unknown as GetSessionMessagesPageResponse, watermark }
  if ((paged.messages?.length ?? 0) === 0 && !paged.hasMoreBefore) {
    /*
     * 折不出任何消息 —— **但这里有两件事,不是一件**(2026-09-10 工单 5 修的
     * 一条真 bug;`gate:chat-follow` 的「隔壁那片叶真的收到了流」当场红):
     *
     *  · **没有账本**(老会话,历史只在 `messages.jsonl` 化石里)—— 这条读法
     *    答不了,交回给上层;
     *  · **账本在,只是还没有消息**(刚建出来的新会话:`session/created` 已经
     *    写进去了,而它不是一条消息)—— 这条读法答得了,答案是「空页 + 账本
     *    此刻的水位」。
     *
     * 两件事一起返回 `undefined` 的代价是**壳把水位当成 0**:下一条事件是 seq 2,
     * 而 `lastSeq` 是 0,于是壳判成缺号、排一次三秒节流的重取 —— 屏幕上是
     * 「新会话里发第一句话,三秒不上屏」。
     *
     * 判据是**水位本身**:它大于 0 就证明账本在(那一条 `session/created` 就是
     * 证据)。不另问一次 `sessionHasEventHistory` —— 那是第二次开账本,而水位
     * 与这一页出自同一个 reader(见上面「原子性」那一节)。
     */
    if (watermark <= 0) return undefined
    return { page: { ...paged, messages: [] } as GetSessionMessagesPageResponse, watermark }
  }
  // `seq` ← `eventSeq`,与 `eventsPageMessages` 逐字同一句(§11.1)。
  return {
    page: {
      ...paged,
      messages: (paged.messages ?? []).map(message =>
        toChatMessage(request.sessionId, message as unknown as ProjectedChatMessage)),
    } as GetSessionMessagesPageResponse,
    watermark,
  }
}

/**
 * **一次调用的一格结果**(工单 5 ②:页里带引用的那些大结果,壳展开卡片时按这条
 * 路取正文)。
 *
 * ## 为什么它物化**一个节点**,不是整条会话
 *
 * `eventsGetMessage` 那条路每次都把整条会话物化一遍(`inline` 档有自己的一张 memo,
 * 冷开时是实打实的一次全量折)。而这条路的触发点是**人点开了一张工具卡** ——
 * 让一次展开动作付一次整会话物化,正是本单在治的那类病。所以这里按 `callId` 找到
 * 那条 run,只 `materializeStep` 它那一只工具。
 *
 * ## 三格槽与页里那张侧表逐条同源
 *
 * `result` = `toolCall.result`(`toolCalls[]` 与 `steps[].toolCall` 共用的那一格)、
 * `text` = `step.result`、`partial` = `step.partialResult`。名字与
 * `session/page-results.ts` 的 `SessionPageResultSlot` 是同一张表 —— 抽出去的是它,
 * 取回来的也得是它,两处对不上就是「同一件事两个词汇」。
 *
 * 物化走 **`inline` 档**:这一次要的正是正文(blob 换回来),与页那一次
 * (`reference`,不读不记)恰好相反 —— 两次读者不同,拿它干的事不同。
 */
function eventsToolResult(
  sessionId: string,
  toolCallId: string,
  slot: 'result' | 'text' | 'partial',
): { value: unknown } | undefined {
  const state = ports.projections.getLiveSessionProjection(sessionId)
  for (const run of state.runs.values()) {
    const tool = run.tools.get(toolCallId)
    if (!tool) continue
    const step = materializeStep(run, tool, [], materializeFor(sessionId, 'inline'))
    const value = slot === 'result'
      ? step.toolCall?.result
      : slot === 'text' ? step.result : step.partialResult
    return value === undefined ? undefined : { value }
  }
  return undefined
}

  return {
    resetSessionEventReadCache,
    eventsToolResult,
    eventsListMessages,
    eventsHasMessage,
    sessionHasEventHistory,
    eventsCountMessages,
    eventsGetMessage,
    eventsGetMessageIndex,
    eventsLastMessageOfRole,
    eventsListUserMarkers,
    eventsPageMessages,
    eventsPageMessagesAtWatermark,
    dispose() { resetSessionEventReadCache() },
  }
}

export type SessionEventReads = ReturnType<typeof createSessionEventReads>
const currentReads = (): SessionEventReads => getCurrentBackend('sessionLayer').sessionLayer.events.reads
export const resetSessionEventReadCache: SessionEventReads['resetSessionEventReadCache'] = (...args) => currentReads().resetSessionEventReadCache(...args)
export const eventsToolResult: SessionEventReads['eventsToolResult'] = (...args) => currentReads().eventsToolResult(...args)
export const eventsListMessages: SessionEventReads['eventsListMessages'] = (...args) => currentReads().eventsListMessages(...args)
export const eventsHasMessage: SessionEventReads['eventsHasMessage'] = (...args) => currentReads().eventsHasMessage(...args)
export const sessionHasEventHistory: SessionEventReads['sessionHasEventHistory'] = (...args) => currentReads().sessionHasEventHistory(...args)
export const eventsCountMessages: SessionEventReads['eventsCountMessages'] = (...args) => currentReads().eventsCountMessages(...args)
export const eventsGetMessage: SessionEventReads['eventsGetMessage'] = (...args) => currentReads().eventsGetMessage(...args)
export const eventsGetMessageIndex: SessionEventReads['eventsGetMessageIndex'] = (...args) => currentReads().eventsGetMessageIndex(...args)
export const eventsLastMessageOfRole: SessionEventReads['eventsLastMessageOfRole'] = (...args) => currentReads().eventsLastMessageOfRole(...args)
export const eventsListUserMarkers: SessionEventReads['eventsListUserMarkers'] = (...args) => currentReads().eventsListUserMarkers(...args)
export const eventsPageMessages: SessionEventReads['eventsPageMessages'] = (...args) => currentReads().eventsPageMessages(...args)
export const eventsPageMessagesAtWatermark: SessionEventReads['eventsPageMessagesAtWatermark'] = (...args) => currentReads().eventsPageMessagesAtWatermark(...args)
