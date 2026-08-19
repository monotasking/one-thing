import fs from 'node:fs'
import { getCoreLogger } from '../../logging/index.js'

const log = getCoreLogger('core.session')

import type {
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  StoredChatMessage,
} from './types.js'
import {
  decodeMessagePageCursor,
  encodeMessagePageCursor,
} from './pagination.js'

interface MessageSlice {
  seq: number
  start: number
  end: number
}

interface JsonMessagePageCursor {
  sessionId: string
  seq: number
  includeAnchor: boolean
  byteStart?: number
  byteEnd?: number
}

function findMessagesArrayStart(json: string): number {
  let depth = 0
  let inString = false
  let escaped = false
  let stringStart = -1

  for (let i = 0; i < json.length; i++) {
    const ch = json[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
        if (depth === 1 && json.slice(stringStart + 1, i) === 'messages') {
          let j = i + 1
          while (/\s/.test(json[j] || '')) j++
          if (json[j] !== ':') continue
          j++
          while (/\s/.test(json[j] || '')) j++
          if (json[j] === '[') return j
        }
      }
      continue
    }

    if (ch === '"') {
      inString = true
      stringStart = i
    } else if (ch === '{' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
    }
  }

  return -1
}

function findArrayEnd(json: string, arrayStart: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = arrayStart; i < json.length; i++) {
    const ch = json[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '[') {
      depth++
    } else if (ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }

  return -1
}

function collectMessageSlices(json: string, arrayStart: number, arrayEnd: number): MessageSlice[] {
  const slices: MessageSlice[] = []
  let objectDepth = 0
  let objectStart = -1
  let inString = false
  let escaped = false

  for (let i = arrayStart + 1; i < arrayEnd; i++) {
    const ch = json[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      if (objectDepth === 0) objectStart = i
      objectDepth++
    } else if (ch === '}') {
      objectDepth--
      if (objectDepth === 0 && objectStart >= 0) {
        slices.push({ seq: slices.length + 1, start: objectStart, end: i + 1 })
        objectStart = -1
      }
    }
  }

  return slices
}

function isEscapedQuote(json: string, quoteIndex: number): boolean {
  let slashCount = 0
  for (let i = quoteIndex - 1; i >= 0 && json[i] === '\\'; i--) {
    slashCount++
  }
  return slashCount % 2 === 1
}

function cursorFor(sessionId: string, slice: MessageSlice | undefined, includeAnchor: boolean): string | null {
  if (!slice) return null
  return encodeMessagePageCursor({ sessionId, seq: slice.seq, includeAnchor })
}

function jsonCursorFor(sessionId: string, slice: MessageSlice | undefined, includeAnchor: boolean): string | null {
  if (!slice) return null
  return JSON.stringify({
    sessionId,
    seq: slice.seq,
    includeAnchor,
    byteStart: slice.start,
    byteEnd: slice.end,
  } satisfies JsonMessagePageCursor)
}

function decodeJsonCursor(cursor: string): JsonMessagePageCursor | null {
  try {
    const parsed = JSON.parse(cursor) as Partial<JsonMessagePageCursor>
    if (
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.seq !== 'number' ||
      typeof parsed.includeAnchor !== 'boolean'
    ) {
      return null
    }
    return {
      sessionId: parsed.sessionId,
      seq: parsed.seq,
      includeAnchor: parsed.includeAnchor,
      byteStart: typeof parsed.byteStart === 'number' ? parsed.byteStart : undefined,
      byteEnd: typeof parsed.byteEnd === 'number' ? parsed.byteEnd : undefined,
    }
  } catch {
    return null
  }
}

function parseMessages<TMessage extends StoredChatMessage>(json: string, slices: MessageSlice[]): TMessage[] {
  const messages: TMessage[] = []
  for (const slice of slices) {
    messages.push({
      ...(JSON.parse(json.slice(slice.start, slice.end)) as TMessage),
      seq: slice.seq,
    })
  }
  return messages
}

function responseFromSlices<TMessage extends StoredChatMessage>(
  sessionId: string,
  json: string,
  slices: MessageSlice[],
  totalCount: number,
): GetSessionMessagesPageResponse<TMessage> {
  const first = slices[0]
  const last = slices[slices.length - 1]
  return {
    success: true,
    messages: parseMessages<TMessage>(json, slices),
    nextCursor: cursorFor(sessionId, first, false),
    backwardsCursor: cursorFor(sessionId, last, true),
    hasMoreBefore: first ? first.seq > 1 : false,
    hasMoreAfter: last ? last.seq < totalCount : false,
    totalCount,
  }
}

function fastResponseFromSlices<TMessage extends StoredChatMessage>(
  sessionId: string,
  json: string,
  slices: MessageSlice[],
  hasMoreBefore: boolean,
  hasMoreAfter: boolean,
): GetSessionMessagesPageResponse<TMessage> {
  const first = slices[0]
  const last = slices[slices.length - 1]
  return {
    success: true,
    messages: parseMessages<TMessage>(json, slices),
    nextCursor: jsonCursorFor(sessionId, first, false),
    backwardsCursor: jsonCursorFor(sessionId, last, true),
    hasMoreBefore,
    hasMoreAfter,
  }
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 16
  return Math.max(1, Math.min(300, Math.floor(limit)))
}

function collectSlicesBackward(
  json: string,
  fromIndex: number,
  lowerBound: number,
  limit: number,
): MessageSlice[] {
  const slices: MessageSlice[] = []
  let objectDepth = 0
  let objectEnd = -1
  let inString = false

  for (let i = fromIndex; i > lowerBound && slices.length < limit; i--) {
    const ch = json[i]

    if (ch === '"' && !isEscapedQuote(json, i)) {
      inString = !inString
      continue
    }

    if (inString) continue

    if (ch === '}') {
      if (objectDepth === 0) objectEnd = i + 1
      objectDepth++
    } else if (ch === '{') {
      objectDepth--
      if (objectDepth === 0 && objectEnd >= 0) {
        slices.push({ seq: slices.length + 1, start: i, end: objectEnd })
        objectEnd = -1
      }
    }
  }

  return slices.reverse()
}

function hasObjectBefore(json: string, arrayStart: number, byteStart: number): boolean {
  return collectSlicesBackward(json, byteStart - 1, arrayStart, 1).length > 0
}

/**
 * 统计 [arrayStart, boundary) 内已闭合的顶层消息对象数量(仅字节扫描,不做 JSON.parse)。
 * 用于把反向扫描窗口的局部 seq 还原成与全量扫描一致的全局升序 seq。
 */
function countObjectsBefore(json: string, arrayStart: number, boundary: number): number {
  let count = 0
  let objectDepth = 0
  let inString = false
  let escaped = false

  for (let i = arrayStart + 1; i < boundary; i++) {
    const ch = json[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      objectDepth++
    } else if (ch === '}') {
      objectDepth--
      if (objectDepth === 0) count++
    }
  }

  return count
}

/**
 * collectSlicesBackward 赋的是窗口内局部降序 seq(reverse 后仍非全局);
 * 这里按窗口首个对象之前的对象数,把 seq 归一成全局升序,与 collectMessageSlices 的语义一致。
 * 否则 backwardsCursor(局部 seq)+ direction:'newer' 会被慢路径当全局 seq 解释,翻回会话开头。
 */
function assignGlobalSeq(json: string, arrayStart: number, slices: MessageSlice[]): void {
  if (slices.length === 0) return
  const baseSeq = countObjectsBefore(json, arrayStart, slices[0].start) + 1
  for (let i = 0; i < slices.length; i++) {
    slices[i].seq = baseSeq + i
  }
}

function fastTailPage<TMessage extends StoredChatMessage>(
  request: GetSessionMessagesPageRequest,
  json: string,
  arrayStart: number,
  arrayEnd: number,
  limit: number,
): GetSessionMessagesPageResponse<TMessage> {
  const slices = collectSlicesBackward(json, arrayEnd - 1, arrayStart, limit)
  assignGlobalSeq(json, arrayStart, slices)
  return fastResponseFromSlices(
    request.sessionId,
    json,
    slices,
    slices.length > 0 ? hasObjectBefore(json, arrayStart, slices[0].start) : false,
    false,
  )
}

function fastOlderPage<TMessage extends StoredChatMessage>(
  request: GetSessionMessagesPageRequest,
  json: string,
  arrayStart: number,
  cursor: JsonMessagePageCursor,
  limit: number,
): GetSessionMessagesPageResponse<TMessage> | null {
  if (typeof cursor.byteStart !== 'number') return null
  const startFrom = cursor.includeAnchor
    ? (cursor.byteEnd ?? cursor.byteStart) - 1
    : cursor.byteStart - 1
  const slices = collectSlicesBackward(json, startFrom, arrayStart, limit)
  assignGlobalSeq(json, arrayStart, slices)
  return fastResponseFromSlices(
    request.sessionId,
    json,
    slices,
    slices.length > 0 ? hasObjectBefore(json, arrayStart, slices[0].start) : false,
    true,
  )
}

export function getMessagesPageFromJson<TMessage extends StoredChatMessage = StoredChatMessage>(
  request: GetSessionMessagesPageRequest,
  json: string,
): GetSessionMessagesPageResponse<TMessage> | null {
  try {
    const arrayStart = findMessagesArrayStart(json)
    if (arrayStart < 0) return null
    const arrayEnd = findArrayEnd(json, arrayStart)
    if (arrayEnd < 0) return null

    const limit = clampLimit(request.limit)

    if (request.cursor) {
      const jsonCursor = decodeJsonCursor(request.cursor)
      if (!jsonCursor || jsonCursor.sessionId !== request.sessionId) {
        return { success: false, error: 'Invalid message page cursor' }
      }
      if ((request.direction ?? 'older') === 'older') {
        const fastOlder = fastOlderPage<TMessage>(request, json, arrayStart, jsonCursor, limit)
        if (fastOlder) return fastOlder
      }
    } else if (!request.anchor || request.anchor === 'tail') {
      return fastTailPage<TMessage>(request, json, arrayStart, arrayEnd, limit)
    }

    const allSlices = collectMessageSlices(json, arrayStart, arrayEnd)
    const totalCount = allSlices.length

    if (totalCount === 0) {
      return responseFromSlices<TMessage>(request.sessionId, json, [], totalCount)
    }

    if (request.cursor) {
      const cursor = decodeMessagePageCursor(request.cursor)
      if (!cursor || cursor.sessionId !== request.sessionId) {
        return { success: false, error: 'Invalid message page cursor' }
      }

      const direction = request.direction ?? 'older'
      const selected = direction === 'newer'
        ? allSlices.filter(slice => cursor.includeAnchor ? slice.seq >= cursor.seq : slice.seq > cursor.seq).slice(0, limit)
        : allSlices.filter(slice => cursor.includeAnchor ? slice.seq <= cursor.seq : slice.seq < cursor.seq).slice(-limit)

      return responseFromSlices<TMessage>(request.sessionId, json, selected, totalCount)
    }

    const anchor = request.anchor
    if (anchor && anchor !== 'tail') {
      let anchorSeq = anchor.seq
      if (!anchorSeq && anchor.messageId) {
        for (const slice of allSlices) {
          const message = JSON.parse(json.slice(slice.start, slice.end)) as Pick<StoredChatMessage, 'id'>
          if (message.id === anchor.messageId) {
            anchorSeq = slice.seq
            break
          }
        }
      }
      if (!anchorSeq) return { success: false, error: 'Anchor message not found' }

      const before = Math.max(0, anchor.before ?? Math.floor(limit / 2))
      const after = Math.max(0, anchor.after ?? Math.max(0, limit - before - 1))
      const startSeq = Math.max(1, anchorSeq - before)
      const endSeq = Math.min(totalCount, anchorSeq + after)
      const selected = allSlices.filter(slice => slice.seq >= startSeq && slice.seq <= endSeq)
      return responseFromSlices<TMessage>(request.sessionId, json, selected, totalCount)
    }

    return responseFromSlices<TMessage>(request.sessionId, json, allSlices.slice(-limit), totalCount)
  } catch (error) {
    log.warn('message page fast-path read failed', undefined, error)
    return null
  }
}

export function getMessagesPageFromJsonFilePath<TMessage extends StoredChatMessage = StoredChatMessage>(
  request: GetSessionMessagesPageRequest,
  filePath: string,
): GetSessionMessagesPageResponse<TMessage> | null {
  if (!fs.existsSync(filePath)) return null
  const json = fs.readFileSync(filePath, 'utf-8')
  return getMessagesPageFromJson<TMessage>(request, json)
}
