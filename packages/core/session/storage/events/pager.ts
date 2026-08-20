/**
 * 事件日志上的**倒读分页**(S2a,`docs/design/session-event-sourcing-2026-08.md`
 * §3.2 / §11.1)。
 *
 * 没有快照,所以"看最后 40 条"不能靠索引,只能从文件尾往前读:逐块倒读 →
 * 逐行 decode → 折成投影 → 攒够 N 条**可见**消息就停。纯函数,不碰 fs ——
 * 字节由调用方注入的 `SessionEventByteReader` 给(app 层那份是 `fs.readSync`),
 * core 因此仍是零依赖。
 *
 * ## 为什么倒读是安全的(而且不需要先看全文件)
 *
 * 事件日志是纯追加的,于是有一条铁的时序:**任何"让一条消息不再显示"的事件,
 * 一定晚于那条消息自己的事件**(删除、编辑重发的截断、清空,无一例外)。
 * 所以对任意后缀 [k, EOF]:落在后缀里的节点,它的全部遮蔽事件也在后缀里 ——
 * 折这一段得到的 `hidden` 与折整份文件**相同**。这就是"倒读一页 ≡ 全量 fold
 * 取尾一页"能成立的理由(合同测试每条场景都钉了这一条)。
 *
 * 三个例外要显式处理,否则这条不变量会破:
 *
 *  1. `user/message-edited` 遮蔽的是"从被编辑那条(含)到它自己"的一整段 ——
 *     被编辑的那条可能在后缀之外。于是倒读时遇到它就把 messageId 记进
 *     `pendingEditTargets`,**没找到之前不许停**;
 *  2. `session/cleared` 遮蔽它之前的一切 —— 遇到它就是头(再往前读没有任何
 *     可见消息),直接收工;
 *  3. `message/deleted` 只遮蔽一条,那条若在后缀之外,本来也不在这一页里;
 *  4. `run/start.continuesRunId`(steering)—— 接手的那条 run 的回合号与用量
 *     累加器都**接着**被接手那条走(§10.12 第 5 类)。被接手的 `run/start`
 *     不在后缀里,这一页里那条消息的 `turnIndex` / 推理落点 / usage 就都是错的。
 *     同 1 的治法:`pendingContinuedRuns` 没清空之前不许停。
 *
 * ## 游标
 *
 * `{sessionId, seq, includeAnchor, offset}`:`seq` 是页首/页尾消息的 **eventSeq**
 * (身份,不是位置),`offset` 是那条事件在文件里的**行首字节**。往上翻 =
 * 从 `offset` 之前继续倒读;往下翻 = 从 `offset` 起正读(含)。两个方向都只
 * 需要行首偏移,所以游标里不必记行长。
 *
 * **已知偏差**(S2b 待裁):带游标往上翻时,比游标更晚的那些遮蔽事件不在扫描
 * 窗口里 —— 一条"很久以前的消息在今天被删掉了"在深翻页时会照旧显示。首屏
 * (从 EOF 倒读)永远是准的;app 层在活投影在内存里时也不走这条路。
 */

import { decodeSessionLogEventLine } from '../../events/codec.js'
import type { SessionLogEventRecord, SessionLogEventType } from '../../events/types.js'
import { foldSessionProjection, materializeChatMessages } from '../../projection/chat-messages.js'
import type { ProjectionMaterializeOptions } from '../../projection/blobs.js'
import type { ProjectedChatMessage } from '../../projection/types.js'
import { clampSessionMessagesPageLimit, encodeMessagePageCursor } from '../pagination.js'
import type {
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  SessionMessagePageCursor,
  StoredChatMessage,
  UserMessageMarker,
} from '../types.js'

/** 注入的字节面 —— 与 `JsonlChunkReader` 同形(app 层那份实现同时喂两边)。 */
export interface SessionEventByteReader {
  /** 文件字节数。 */
  size: number
  /** 读 `[position, position+length)`,越界截断。 */
  read(position: number, length: number): Uint8Array
}

export interface SessionEventPageCursor extends SessionMessagePageCursor {
  /** 这条事件在文件里的行首字节偏移。 */
  offset?: number
}

export const DEFAULT_EVENT_CHUNK_SIZE = 256 * 1024

const NEWLINE_BYTE = 0x0a

/** 产生一个投影节点的事件类型 —— 倒读的"够了没有"按它数。 */
const NODE_START_TYPES = new Set<SessionLogEventType>([
  'user/message',
  'system/message',
  'message/imported',
  'user/message-edited',
  'session/compacted',
  'run/start',
])

export function isSessionEventNodeStart(type: SessionLogEventType): boolean {
  return NODE_START_TYPES.has(type)
}

// ============ 逐行扫描(倒读 / 正读) ============

/** 一条扫出来的记录及其行首偏移。 */
export interface ScannedSessionEvent {
  record: SessionLogEventRecord
  offset: number
}

export interface BackwardScanOptions {
  /** 从这个偏移(**不含**)往前读;缺省 = EOF。 */
  fromOffset?: number
  chunkSize?: number
}

/**
 * 倒读逐行。`visit` 返回 `true` 表示"到此为止"。
 *
 * 解不开的行(崩溃截断的半行 / 未来版本的新类型)一律跳过 —— 与
 * `parseSessionLogEventLog` 同口径,读侧永不回写"清理"。
 */
export function scanEventsBackward(
  reader: SessionEventByteReader,
  options: BackwardScanOptions,
  visit: (event: ScannedSessionEvent) => boolean | void,
): { reachedHead: boolean } {
  const decoder = new TextDecoder()
  const chunkSize = options.chunkSize ?? DEFAULT_EVENT_CHUNK_SIZE
  let position = Math.max(0, Math.min(options.fromOffset ?? reader.size, reader.size))
  let tail = new Uint8Array(0)

  while (position > 0) {
    const readStart = Math.max(0, position - chunkSize)
    const chunk = reader.read(readStart, position - readStart)
    const merged = new Uint8Array(chunk.length + tail.length)
    merged.set(chunk, 0)
    merged.set(tail, chunk.length)
    position = readStart

    let end = merged.length
    for (let index = merged.length - 1; index >= 0; index--) {
      if (merged[index] !== NEWLINE_BYTE) continue
      const lineBytes = merged.subarray(index + 1, end)
      const offset = readStart + index + 1
      end = index
      if (lineBytes.length === 0) continue
      const record = decodeSessionLogEventLine(decoder.decode(lineBytes))
      if (!record) continue
      if (visit({ record, offset }) === true) return { reachedHead: false }
    }
    tail = merged.subarray(0, end)
  }

  // 扫到文件头:剩下的这一段是第一行(它前面没有 \n,循环切不出来)。
  if (tail.length > 0) {
    const record = decodeSessionLogEventLine(decoder.decode(tail))
    if (record && visit({ record, offset: 0 }) === true) return { reachedHead: false }
  }
  return { reachedHead: true }
}

interface ForwardScanOptions {
  /** 从这个偏移(**含**)往后读。 */
  fromOffset?: number
  chunkSize?: number
}

/** 正读逐行。`visit` 返回 `true` 表示停。 */
function scanEventsForward(
  reader: SessionEventByteReader,
  options: ForwardScanOptions,
  visit: (event: ScannedSessionEvent) => boolean | void,
): { reachedTail: boolean } {
  const decoder = new TextDecoder()
  const chunkSize = options.chunkSize ?? DEFAULT_EVENT_CHUNK_SIZE
  let position = Math.max(0, Math.min(options.fromOffset ?? 0, reader.size))
  let head = new Uint8Array(0)
  let headOffset = position

  while (position < reader.size) {
    const chunk = reader.read(position, chunkSize)
    if (chunk.length === 0) break
    const merged = new Uint8Array(head.length + chunk.length)
    merged.set(head, 0)
    merged.set(chunk, head.length)
    position += chunk.length

    let start = 0
    for (let index = 0; index < merged.length; index++) {
      if (merged[index] !== NEWLINE_BYTE) continue
      const lineBytes = merged.subarray(start, index)
      const offset = headOffset + start
      start = index + 1
      if (lineBytes.length === 0) continue
      const record = decodeSessionLogEventLine(decoder.decode(lineBytes))
      if (!record) continue
      if (visit({ record, offset }) === true) return { reachedTail: false }
    }
    head = merged.subarray(start)
    headOffset += start
  }

  if (head.length > 0) {
    const record = decodeSessionLogEventLine(decoder.decode(head))
    if (record && visit({ record, offset: headOffset }) === true) return { reachedTail: false }
  }
  return { reachedTail: true }
}

// ============ 折一页 ============

export interface EventPageFoldOptions {
  /** 要几条可见消息。 */
  limit: number
  /** 倒读从这个偏移(不含)开始;正读从这个偏移(含)开始。 */
  fromOffset?: number
  chunkSize?: number
  /**
   * A8/A9(§13.6):物化时把 `BlobRef` 换回正文的那个口。
   *
   * 分页与整会话读**必须给同一份**:少给它,翻上去的那一页里附件就没有 base64
   * (而当前页有)—— 同一条消息在两个入口下不是同一条。
   */
  materialize?: ProjectionMaterializeOptions
}

export interface EventPageFoldResult {
  /** 升序(呈现序)的可见消息,长度 ≤ limit。 */
  messages: ProjectedChatMessage[]
  /** 页首消息那条事件的行首偏移(游标用)。 */
  startOffset?: number
  /** 页尾消息那条事件的行首偏移(游标用)。 */
  endOffset?: number
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  /** 是否读到了文件头(或 `session/cleared` 这个等价的头)。 */
  reachedHead: boolean
  /** 是否读到了文件尾。 */
  reachedTail: boolean
  /** 扫过的事件条数 —— 量测与自证用。 */
  scannedEvents: number
}

function offsetsOf(
  collected: readonly ScannedSessionEvent[],
): Map<number, number> {
  const map = new Map<number, number>()
  for (const entry of collected) map.set(entry.record.seq, entry.offset)
  return map
}

function foldVisible(
  collected: readonly ScannedSessionEvent[],
  materialize: ProjectionMaterializeOptions = {},
): ProjectedChatMessage[] {
  return materializeChatMessages(
    foldSessionProjection(collected.map(entry => entry.record)),
    materialize,
  ).messages
}

/**
 * 从尾(或游标)往前折出一页。
 *
 * 停止条件三选一:攒够 `limit + 1` 条**可见**消息(多的那条只用来回答
 * `hasMoreBefore`)、撞上 `session/cleared`(它就是头)、读到文件头。
 */
export function foldEventPageBackward(
  reader: SessionEventByteReader,
  options: EventPageFoldOptions,
): EventPageFoldResult {
  const limit = Math.max(0, options.limit)
  const collected: ScannedSessionEvent[] = []
  const pendingEditTargets = new Set<string>()
  /**
   * 例外 4(§10.12 第 5 类):steering 接手的那条 run 要**接着**被接手那条数
   * 回合号、接着加用量。被接手的 `run/start` 还没进窗口就停,这一页里那条消息的
   * `turnIndex` / 推理落点 / usage 三样全错 —— 与 `pendingEditTargets` 同一条
   * 治法:记下来,没找到之前不许停。
   */
  const pendingContinuedRuns = new Set<string>()
  let candidates = 0
  let target = limit + 1
  let clearedBoundary = false
  let visible: ProjectedChatMessage[] | undefined

  const { reachedHead } = scanEventsBackward(
    reader,
    { ...(options.fromOffset !== undefined ? { fromOffset: options.fromOffset } : {}), ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}) },
    entry => {
      collected.push(entry)
      const { record } = entry

      if (record.type === 'user/message-edited') {
        // 它遮蔽"被编辑那条(含)到自己"的一整段 —— 被编辑那条没进窗口之前
        // 不能停,否则这一页会把本该消失的消息照旧显示出来。
        pendingEditTargets.add(record.data.messageId)
      }
      if (record.type === 'user/message' || record.type === 'system/message' || record.type === 'message/imported') {
        pendingEditTargets.delete(record.data.message.id)
      }
      if (record.type === 'session/compacted') pendingEditTargets.delete(record.data.messageId)
      if (record.type === 'run/start') {
        pendingEditTargets.delete(record.data.assistantMessageId)
        pendingContinuedRuns.delete(record.data.runId)
        if (record.data.continuesRunId) pendingContinuedRuns.add(record.data.continuesRunId)
      }

      if (isSessionEventNodeStart(record.type)) candidates += 1

      if (record.type === 'session/cleared') {
        // 它之前的一切都不可见 —— 这就是这条会话"现在的头"。
        clearedBoundary = true
        return true
      }

      if (candidates < target || pendingEditTargets.size > 0 || pendingContinuedRuns.size > 0) return undefined

      visible = foldVisible([...collected].reverse(), options.materialize)
      if (visible.length > limit) return true
      // 攒够了节点却不够可见消息(中间有被删/被遮蔽的):把门槛抬高再读一段。
      target = candidates + Math.max(4, limit)
      visible = undefined
      return undefined
    },
  )

  const ordered = [...collected].reverse()
  if (!visible) visible = foldVisible(ordered, options.materialize)

  const head = reachedHead || clearedBoundary
  const hasMoreBefore = visible.length > limit || (!head && visible.length >= limit)
  const page = visible.length > limit ? visible.slice(visible.length - limit) : visible
  const offsets = offsetsOf(collected)

  return {
    messages: page,
    ...(page.length > 0 && page[0].eventSeq !== undefined && offsets.has(page[0].eventSeq)
      ? { startOffset: offsets.get(page[0].eventSeq) }
      : {}),
    ...(page.length > 0 && page[page.length - 1].eventSeq !== undefined && offsets.has(page[page.length - 1].eventSeq!)
      ? { endOffset: offsets.get(page[page.length - 1].eventSeq!) }
      : {}),
    hasMoreBefore,
    hasMoreAfter: options.fromOffset !== undefined && options.fromOffset < reader.size,
    reachedHead: head,
    reachedTail: options.fromOffset === undefined,
    scannedEvents: collected.length,
  }
}

/** 从某个偏移(含)往后折一页 —— "往下翻" / 锚点之后的那半页。 */
export function foldEventPageForward(
  reader: SessionEventByteReader,
  options: EventPageFoldOptions,
): EventPageFoldResult {
  const limit = Math.max(0, options.limit)
  const collected: ScannedSessionEvent[] = []
  let candidates = 0
  let target = limit + 1
  let visible: ProjectedChatMessage[] | undefined

  const { reachedTail } = scanEventsForward(
    reader,
    { ...(options.fromOffset !== undefined ? { fromOffset: options.fromOffset } : {}), ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}) },
    entry => {
      collected.push(entry)
      if (isSessionEventNodeStart(entry.record.type)) candidates += 1
      if (candidates < target) return undefined
      visible = foldVisible(collected, options.materialize)
      if (visible.length > limit) return true
      target = candidates + Math.max(4, limit)
      visible = undefined
      return undefined
    },
  )

  if (!visible) visible = foldVisible(collected, options.materialize)

  const hasMoreAfter = visible.length > limit || (!reachedTail && visible.length >= limit)
  const page = visible.length > limit ? visible.slice(0, limit) : visible
  const offsets = offsetsOf(collected)

  return {
    messages: page,
    ...(page.length > 0 && page[0].eventSeq !== undefined && offsets.has(page[0].eventSeq)
      ? { startOffset: offsets.get(page[0].eventSeq) }
      : {}),
    ...(page.length > 0 && page[page.length - 1].eventSeq !== undefined && offsets.has(page[page.length - 1].eventSeq!)
      ? { endOffset: offsets.get(page[page.length - 1].eventSeq!) }
      : {}),
    hasMoreBefore: (options.fromOffset ?? 0) > 0,
    hasMoreAfter,
    reachedHead: (options.fromOffset ?? 0) === 0,
    reachedTail: reachedTail && !hasMoreAfter,
    scannedEvents: collected.length,
  }
}

// ============ 跳转索引(每会话一次,只在内存) ============

export interface SessionEventJumpIndex {
  /** 建索引时的文件字节数 —— 文件长了就该重建。 */
  size: number
  /** messageId → 它那条节点事件的 `{seq, offset}`。 */
  byMessageId: Map<string, { seq: number; offset: number }>
  /** eventSeq → 行首偏移(全部事件,不止节点)。 */
  offsetBySeq: Map<number, number>
}

/**
 * 正向扫一遍建索引(§3.2:"首次跳转时正向扫一遍建**内存**索引,之后 O(1)")。
 *
 * 不落盘 —— 落盘的索引就是快照的影子(拍板 6)。
 */
export function buildSessionEventJumpIndex(
  reader: SessionEventByteReader,
  options: { chunkSize?: number } = {},
): SessionEventJumpIndex {
  const byMessageId = new Map<string, { seq: number; offset: number }>()
  const offsetBySeq = new Map<number, number>()

  scanEventsForward(reader, { ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}) }, ({ record, offset }) => {
    offsetBySeq.set(record.seq, offset)
    const messageId = nodeMessageIdOf(record)
    // 后写的覆盖先写的:编辑重发之后,同一个 messageId 的新那一格才是可见的。
    if (messageId) byMessageId.set(messageId, { seq: record.seq, offset })
    return undefined
  })

  return { size: reader.size, byMessageId, offsetBySeq }
}

function nodeMessageIdOf(record: SessionLogEventRecord): string | undefined {
  switch (record.type) {
    case 'user/message':
    case 'system/message':
    case 'message/imported':
    case 'user/message-edited':
      return record.data.message.id
    case 'run/start':
      return record.data.assistantMessageId
    case 'session/compacted':
      return record.data.messageId
    default:
      return undefined
  }
}

// ============ 分页响应 ============

export interface PageEventMessagesOptions {
  chunkSize?: number
  /** 见 `EventPageFoldOptions.materialize`。 */
  materialize?: ProjectionMaterializeOptions
  /** 锚点解析(`anchor.messageId` / `anchor.seq`)—— app 层用跳转索引喂。 */
  resolveAnchor?(anchor: { messageId?: string; seq?: number }): { seq: number; offset: number } | undefined
}

function decodeEventCursor(raw: string, sessionId: string): SessionEventPageCursor | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionEventPageCursor>
    if (parsed.sessionId !== sessionId) return null
    if (typeof parsed.seq !== 'number' || typeof parsed.includeAnchor !== 'boolean') return null
    return {
      sessionId,
      seq: parsed.seq,
      includeAnchor: parsed.includeAnchor,
      ...(typeof parsed.offset === 'number' ? { offset: parsed.offset } : {}),
    }
  } catch {
    return null
  }
}

function cursorOf(
  sessionId: string,
  message: ProjectedChatMessage | undefined,
  offset: number | undefined,
  includeAnchor: boolean,
): string | null {
  if (!message || message.eventSeq === undefined) return null
  return encodeMessagePageCursor({
    sessionId,
    seq: message.eventSeq,
    includeAnchor,
    ...(offset !== undefined ? { offset } : {}),
  } as SessionMessagePageCursor)
}

/** 投影出的消息 → 分页响应里的消息:`seq` 填 `eventSeq`(§11.1)。 */
export function toPagedEventMessage(message: ProjectedChatMessage): StoredChatMessage {
  return { ...message, seq: message.eventSeq } as unknown as StoredChatMessage
}

function respond(
  sessionId: string,
  fold: EventPageFoldResult,
  totalCount: number | undefined,
): GetSessionMessagesPageResponse {
  const first = fold.messages[0]
  const last = fold.messages[fold.messages.length - 1]
  return {
    success: true,
    messages: fold.messages.map(toPagedEventMessage),
    nextCursor: cursorOf(sessionId, first, fold.startOffset, false),
    backwardsCursor: cursorOf(sessionId, last, fold.endOffset, true),
    hasMoreBefore: fold.hasMoreBefore,
    hasMoreAfter: fold.hasMoreAfter,
    ...(totalCount !== undefined ? { totalCount } : {}),
  }
}

/**
 * 一页消息(事件模式)。语义与 `getMessagesPageFromArray` 对齐,坐标换成
 * `eventSeq`:`hasMoreBefore/hasMoreAfter` 由扫描自己回答,而不是
 * `seq < totalCount`(事件坐标不是位置,那个比较在这里没有意义)。
 *
 * `totalCount` **只在真的数得出来时才给**(整份文件都折过了):48MB 的会话
 * 为了一个计数全量扫一遍,正是 §3.2 拒绝的那件事。renderer 在缺席时退回
 * "已加载条数",而 `hasMoreBefore` 才是它真正的判据。
 */
export function pageEventMessages(
  reader: SessionEventByteReader,
  request: GetSessionMessagesPageRequest,
  options: PageEventMessagesOptions = {},
): GetSessionMessagesPageResponse {
  const limit = clampSessionMessagesPageLimit(request.limit)
  const chunk = {
    ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
    ...(options.materialize ? { materialize: options.materialize } : {}),
  }

  if (request.cursor) {
    const cursor = decodeEventCursor(request.cursor, request.sessionId)
    if (!cursor) return { success: false, error: 'Invalid message page cursor' }
    if (cursor.offset === undefined) return { success: false, error: 'Invalid message page cursor' }

    if ((request.direction ?? 'older') === 'newer') {
      const fold = foldEventPageForward(reader, {
        limit,
        fromOffset: cursor.includeAnchor ? cursor.offset : cursor.offset + 1,
        ...chunk,
      })
      return respond(request.sessionId, fold, undefined)
    }

    const fold = foldEventPageBackward(reader, { limit, fromOffset: cursor.offset, ...chunk })
    return respond(request.sessionId, { ...fold, hasMoreAfter: true }, undefined)
  }

  const anchor = request.anchor
  if (anchor && anchor !== 'tail') {
    const resolved = options.resolveAnchor?.({
      ...(anchor.messageId !== undefined ? { messageId: anchor.messageId } : {}),
      ...(anchor.seq !== undefined ? { seq: anchor.seq } : {}),
    })
    if (!resolved) return { success: false, error: 'Anchor message not found' }
    const before = Math.max(0, anchor.before ?? Math.floor(limit / 2))
    const after = Math.max(0, anchor.after ?? Math.max(0, limit - before - 1))

    const older = before > 0
      ? foldEventPageBackward(reader, { limit: before, fromOffset: resolved.offset, ...chunk })
      : undefined
    const newer = foldEventPageForward(reader, { limit: after + 1, fromOffset: resolved.offset, ...chunk })

    const merged: EventPageFoldResult = {
      messages: [...(older?.messages ?? []), ...newer.messages],
      ...(older?.startOffset !== undefined ? { startOffset: older.startOffset } : { startOffset: newer.startOffset }),
      ...(newer.endOffset !== undefined ? { endOffset: newer.endOffset } : {}),
      hasMoreBefore: older ? older.hasMoreBefore : resolved.offset > 0,
      hasMoreAfter: newer.hasMoreAfter,
      reachedHead: older?.reachedHead ?? false,
      reachedTail: newer.reachedTail,
      scannedEvents: (older?.scannedEvents ?? 0) + newer.scannedEvents,
    }
    return respond(request.sessionId, merged, undefined)
  }

  const fold = foldEventPageBackward(reader, { limit, ...chunk })
  // 整份文件都折过了才数得出总数(见函数注释)。
  const totalCount = fold.reachedHead && !fold.hasMoreBefore ? fold.messages.length : undefined
  return respond(request.sessionId, { ...fold, hasMoreAfter: false }, totalCount)
}

/**
 * 用户消息锚点(会话目录 / 跳转)。**全量正读一遍** —— 目录本来就是"全部
 * 用户消息",没有尾部可取巧的地方;它与今天 `getUserMessageMarkersFromArray`
 * 的口径逐字一致,只是 `seq` 换成 eventSeq。
 */
export function listEventUserMessageMarkers(
  reader: SessionEventByteReader,
  options: { chunkSize?: number } = {},
): UserMessageMarker[] {
  const records: SessionLogEventRecord[] = []
  scanEventsForward(reader, { ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}) }, ({ record }) => {
    records.push(record)
    return undefined
  })
  return userMarkersFromProjected(materializeChatMessages(foldSessionProjection(records)).messages)
}

export function userMarkersFromProjected(messages: readonly ProjectedChatMessage[]): UserMessageMarker[] {
  return messages
    .filter(message => message.role === 'user')
    .map(message => ({
      id: message.id,
      seq: message.eventSeq ?? 0,
      timestamp: message.timestamp,
      preview: String(message.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    }))
}
