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
  materializeChatMessages,
  pageEventMessages,
  userMarkersFromProjected,
  type ProjectedChatMessage,
  type SessionEventByteReader,
  type SessionEventJumpIndex,
} from '@onething/core/session'
import { getSessionEventsLogPath } from './event-log.js'
import { sessionProjectionOptions } from './projection-blobs.js'
import { getLiveSessionProjection, hasLiveSessionProjection } from './projection-cache.js'

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
    const logPath = getSessionEventsLogPath(sessionId)
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

export function resetSessionEventReadCache(sessionId?: string): void {
  if (sessionId) {
    jumpIndexes.delete(sessionId)
    return
  }
  jumpIndexes.clear()
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
export function eventsListMessages(sessionId: string): ChatMessage[] | undefined {
  const state = getLiveSessionProjection(sessionId)
  if (state.nodes.length === 0) return undefined
  const messages = materializeChatMessages(state, sessionProjectionOptions(sessionId)).messages
  if (messages.length === 0) return undefined
  return messages.map(message => toChatMessage(sessionId, message))
}

/** 这条会话在事件里有历史吗(路由的短路闸)。 */
export function sessionHasEventHistory(sessionId: string): boolean {
  return getLiveSessionProjection(sessionId).nodes.length > 0
}

export function eventsCountMessages(sessionId: string): number | undefined {
  const state = getLiveSessionProjection(sessionId)
  if (state.nodes.length === 0) return undefined
  return state.nodes.filter(node => !node.hidden).length
}

export function eventsGetMessage(sessionId: string, messageId: string): ChatMessage | undefined {
  const messages = eventsListMessages(sessionId)
  return messages?.find(message => message.id === messageId)
}

export function eventsGetMessageIndex(sessionId: string, messageId: string): number | undefined {
  const messages = eventsListMessages(sessionId)
  if (!messages) return undefined
  return messages.findIndex(message => message.id === messageId)
}

export function eventsLastMessageOfRole(
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

export function eventsListUserMarkers(sessionId: string): UserMessageMarker[] | undefined {
  const state = getLiveSessionProjection(sessionId)
  if (state.nodes.length === 0) return undefined
  return userMarkersFromProjected(materializeChatMessages(state, sessionProjectionOptions(sessionId)).messages)
}

/**
 * 一页消息。
 *
 * 活投影在内存里就直接从它取(一次分页不该为了 40 条消息再读一遍文件);
 * 没有就走 core 的倒读 pager —— 那条路**不建活投影**,否则"不整份加载"这句话
 * 当场作废。
 */
export function eventsPageMessages(
  request: GetSessionMessagesPageRequest,
): GetSessionMessagesPageResponse | undefined {
  if (hasLiveSessionProjection(request.sessionId)) {
    const messages = eventsListMessages(request.sessionId)
    if (messages) return pageFromMemory(request, messages)
  }

  const paged = withEventReader(request.sessionId, reader => pageEventMessages(reader, request, {
    // A8/A9:分页与整会话读用**同一份**物化选项(见 pager 里那条注释)。
    materialize: sessionProjectionOptions(request.sessionId),
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
