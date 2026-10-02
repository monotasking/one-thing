/**
 * messages.jsonl 分页(纯函数,无 fs)。
 *
 * 语义与 pagination.ts 的 getMessagesPageFromArray 严格一致:
 * 窗口计算在这里做,消息读取通过 JsonlLogPageSource 注入,
 * 响应构造复用 buildSessionMessagesPageResponse。
 */

import {
  buildSessionMessagesPageResponse,
  clampSessionMessagesPageLimit,
  decodeMessagePageCursor,
  type IndexedSessionMessage,
} from '../pagination.js'
import type {
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  StoredChatMessage,
} from '../types.js'
import { decodeJsonlLine } from './codec.js'

// ============ 窗口计算 ============

export type SessionMessagesPageWindow =
  | { success: true; startSeq: number; endSeq: number }
  | { success: false; error: string }

export interface ComputeMessagesPageWindowOptions {
  request: GetSessionMessagesPageRequest
  totalCount: number
  /** anchor.messageId 形式的锚点需要 id → seq 解析;不提供则该形式报错 */
  resolveAnchorSeq?(messageId: string): number | undefined
}

/**
 * 把分页请求换算成 [startSeq, endSeq] 闭区间(可能为空区间:startSeq > endSeq)。
 */
export function computeMessagesPageWindow(
  options: ComputeMessagesPageWindowOptions,
): SessionMessagesPageWindow {
  const { request, totalCount } = options
  const limit = clampSessionMessagesPageLimit(request.limit)

  if (totalCount === 0) {
    return { success: true, startSeq: 1, endSeq: 0 }
  }

  if (request.cursor) {
    const cursor = decodeMessagePageCursor(request.cursor)
    if (!cursor || cursor.sessionId !== request.sessionId) {
      return { success: false, error: 'Invalid message page cursor' }
    }

    const direction = request.direction ?? 'older'
    if (direction === 'newer') {
      const startSeq = Math.max(1, cursor.includeAnchor ? cursor.seq : cursor.seq + 1)
      const endSeq = Math.min(totalCount, startSeq + limit - 1)
      return { success: true, startSeq, endSeq }
    }

    const endSeq = Math.min(totalCount, cursor.includeAnchor ? cursor.seq : cursor.seq - 1)
    const startSeq = Math.max(1, endSeq - limit + 1)
    return { success: true, startSeq, endSeq }
  }

  const anchor = request.anchor
  if (anchor && anchor !== 'tail') {
    const anchorSeq = anchor.seq ??
      (anchor.messageId ? options.resolveAnchorSeq?.(anchor.messageId) : undefined)
    if (!anchorSeq || anchorSeq < 1 || anchorSeq > totalCount) {
      return { success: false, error: 'Anchor message not found' }
    }
    const before = Math.max(0, anchor.before ?? Math.floor(limit / 2))
    const after = Math.max(0, anchor.after ?? Math.max(0, limit - before - 1))
    return {
      success: true,
      startSeq: Math.max(1, anchorSeq - before),
      endSeq: Math.min(totalCount, anchorSeq + after),
    }
  }

  return { success: true, startSeq: Math.max(1, totalCount - limit + 1), endSeq: totalCount }
}

// ============ 日志源分页 ============

export interface JsonlLogPageSource<TMessage extends StoredChatMessage> {
  totalCount: number
  /** 读取 [startSeq, endSeq] 闭区间的消息;空区间应返回 [];读不到(损坏等)返回 undefined */
  readRange(startSeq: number, endSeq: number): Array<IndexedSessionMessage<TMessage>> | undefined
  resolveAnchorSeq?(messageId: string): number | undefined
}

/**
 * 基于日志源的分页。返回 undefined 表示源无法服务(调用方降级到整载兜底)。
 */
export function getMessagesPageFromLogSource<TMessage extends StoredChatMessage>(
  request: GetSessionMessagesPageRequest,
  source: JsonlLogPageSource<TMessage>,
): GetSessionMessagesPageResponse<TMessage> | undefined {
  const window = computeMessagesPageWindow({
    request,
    totalCount: source.totalCount,
    resolveAnchorSeq: source.resolveAnchorSeq,
  })
  if (!window.success) {
    return { success: false, error: window.error }
  }

  if (window.startSeq > window.endSeq) {
    return buildSessionMessagesPageResponse<TMessage>(request.sessionId, [], source.totalCount)
  }

  const items = source.readRange(window.startSeq, window.endSeq)
  if (!items) return undefined

  return buildSessionMessagesPageResponse(request.sessionId, items, source.totalCount)
}

// ============ 反向分块尾读 ============

export interface JsonlChunkReader {
  /** 文件字节大小 */
  size: number
  /** 读取 [position, position+length) 的字节;越界部分截断 */
  read(position: number, length: number): Uint8Array
}

export const DEFAULT_TAIL_CHUNK_SIZE = 256 * 1024

const NEWLINE_BYTE = 0x0a

export interface CollectTailMessagesResult<TMessage> {
  /** 按 seq 升序的最后 maxCount 条完整消息 */
  items: Array<{ seq: number; message: TMessage }>
  /** 是否一直读到了 header(即已覆盖全文件) */
  reachedHead: boolean
}

/**
 * 从文件尾部反向按块读取,解析出最后 maxCount 条完整消息行,
 * 不整文件加载。与 scanJsonlLog 语义一致:文件末尾未以 \n 终止的
 * 尾段(崩溃截断)无论内容如何一律丢弃;其余位置的空行/非法行/header
 * 之外的内容视为损坏,返回 undefined 由调用方降级。
 */
export function collectTailMessages<TMessage>(
  reader: JsonlChunkReader,
  maxCount: number,
  chunkSize: number = DEFAULT_TAIL_CHUNK_SIZE,
): CollectTailMessagesResult<TMessage> | undefined {
  const decoder = new TextDecoder()
  const items: Array<{ seq: number; message: TMessage }> = []
  if (reader.size === 0) {
    return { items, reachedHead: true }
  }
  if (maxCount <= 0) {
    return { items, reachedHead: false }
  }

  const endsWithNewline = reader.read(reader.size - 1, 1)[0] === NEWLINE_BYTE
  // 首个切出的段一定终止于原始 EOF:文件以 \n 结尾时它是空段,否则是被截断的尾段——都直接丢弃。
  let eofSegmentHandled = false
  // pending 保存"当前块起点之前、终止 \n 已见但起始 \n 未见"的行尾部分
  let pending: Uint8Array = new Uint8Array(0)
  let position = reader.size

  while (position > 0) {
    const readStart = Math.max(0, position - chunkSize)
    const chunk = reader.read(readStart, position - readStart)
    position = readStart

    const merged = new Uint8Array(chunk.length + pending.length)
    merged.set(chunk, 0)
    merged.set(pending, chunk.length)

    let searchEnd = merged.length
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i] !== NEWLINE_BYTE) continue

      const lineBytes = merged.subarray(i + 1, searchEnd)
      searchEnd = i

      if (!eofSegmentHandled) {
        eofSegmentHandled = true
        if (endsWithNewline && lineBytes.length !== 0) return undefined
        continue
      }

      if (lineBytes.length === 0) return undefined

      const decoded = decodeJsonlLine<TMessage>(decoder.decode(lineBytes))
      if (!decoded) return undefined
      if (decoded.t === 'h') {
        return { items, reachedHead: true }
      }
      items.unshift({ seq: decoded.seq, message: decoded.message })
      if (items.length >= maxCount) {
        return { items, reachedHead: false }
      }
    }

    pending = merged.subarray(0, searchEnd)
  }

  // 全文件无一个 \n(header 行本身被截断)视为损坏
  if (!eofSegmentHandled) return undefined

  // 扫到文件开头:剩余的第一段应当是 header 行(其起始没有 \n 标记,循环切不出来)
  if (pending.length > 0) {
    const decoded = decodeJsonlLine<TMessage>(decoder.decode(pending))
    if (!decoded || decoded.t !== 'h') return undefined
  }
  return { items, reachedHead: true }
}
