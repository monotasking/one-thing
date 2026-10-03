import type {
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  ResolveSessionMessagesPageResult,
  ResolveSessionUserMessageMarkersResult,
  SessionMessagePageCursor,
  StoredChatMessage,
  UserMessageMarker,
} from './types.js'

const DEFAULT_PAGE_LIMIT = 16
const MAX_PAGE_LIMIT = 300

export interface IndexedSessionMessage<TMessage extends StoredChatMessage> {
  message: TMessage
  seq: number
}

export function clampSessionMessagesPageLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(limit)))
}

const clampLimit = clampSessionMessagesPageLimit

export function encodeMessagePageCursor(cursor: SessionMessagePageCursor): string {
  return JSON.stringify(cursor)
}

export function decodeMessagePageCursor(cursor: string): SessionMessagePageCursor | null {
  try {
    const parsed = JSON.parse(cursor) as Partial<SessionMessagePageCursor>
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
    }
  } catch {
    return null
  }
}

function withSeq<TMessage extends StoredChatMessage>(messages: TMessage[]): IndexedSessionMessage<TMessage>[] {
  return messages.map((message, index) => ({ message, seq: index + 1 }))
}

function cursorFor<TMessage extends StoredChatMessage>(
  sessionId: string,
  item: IndexedSessionMessage<TMessage> | undefined,
  includeAnchor: boolean,
): string | null {
  if (!item) return null
  return encodeMessagePageCursor({ sessionId, seq: item.seq, includeAnchor })
}

export function buildSessionMessagesPageResponse<TMessage extends StoredChatMessage>(
  sessionId: string,
  items: IndexedSessionMessage<TMessage>[],
  totalCount: number,
): GetSessionMessagesPageResponse<TMessage> {
  const first = items[0]
  const last = items[items.length - 1]
  return {
    success: true,
    messages: items.map(item => ({ ...item.message, seq: item.seq })),
    nextCursor: cursorFor(sessionId, first, false),
    backwardsCursor: cursorFor(sessionId, last, true),
    hasMoreBefore: first ? first.seq > 1 : false,
    hasMoreAfter: last ? last.seq < totalCount : false,
    totalCount,
  }
}

export function getMessagesPageFromArray<TMessage extends StoredChatMessage>(
  messages: TMessage[],
  request: GetSessionMessagesPageRequest,
): GetSessionMessagesPageResponse<TMessage> {
  const indexed = withSeq(messages)
  const totalCount = indexed.length
  const limit = clampLimit(request.limit)

  if (totalCount === 0) {
    return buildSessionMessagesPageResponse(request.sessionId, [], totalCount)
  }

  if (request.cursor) {
    const cursor = decodeMessagePageCursor(request.cursor)
    if (!cursor || cursor.sessionId !== request.sessionId) {
      return { success: false, error: 'Invalid message page cursor' }
    }

    const direction = request.direction ?? 'older'
    const filtered = direction === 'newer'
      ? indexed.filter(item => cursor.includeAnchor ? item.seq >= cursor.seq : item.seq > cursor.seq)
      : indexed
          .filter(item => cursor.includeAnchor ? item.seq <= cursor.seq : item.seq < cursor.seq)
          .slice()
          .reverse()

    const page = filtered.slice(0, limit)
    const ordered = direction === 'older' ? page.reverse() : page
    return buildSessionMessagesPageResponse(request.sessionId, ordered, totalCount)
  }

  const anchor = request.anchor
  if (anchor && anchor !== 'tail') {
    const anchorSeq = anchor.seq ??
      indexed.find(item => item.message.id === anchor.messageId)?.seq
    if (!anchorSeq) {
      return { success: false, error: 'Anchor message not found' }
    }
    const before = Math.max(0, anchor.before ?? Math.floor(limit / 2))
    const after = Math.max(0, anchor.after ?? Math.max(0, limit - before - 1))
    const start = Math.max(1, anchorSeq - before)
    const end = Math.min(totalCount, anchorSeq + after)
    return buildSessionMessagesPageResponse(
      request.sessionId,
      indexed.filter(item => item.seq >= start && item.seq <= end),
      totalCount,
    )
  }

  const tail = indexed.slice(Math.max(0, totalCount - limit))
  return buildSessionMessagesPageResponse(request.sessionId, tail, totalCount)
}

export interface ResolveSessionMessagesPageOptions<TMessage extends StoredChatMessage = StoredChatMessage> {
  request: GetSessionMessagesPageRequest
  getJsonlLogPage?: () => GetSessionMessagesPageResponse<TMessage> | undefined
  getSqlitePage?: () => GetSessionMessagesPageResponse<TMessage> | undefined
  getJsonByteScanPage?: () => GetSessionMessagesPageResponse<TMessage> | undefined
  getSessionMessages?: () => TMessage[] | undefined
  pageFromMessages?: (
    messages: TMessage[],
    request: GetSessionMessagesPageRequest,
  ) => GetSessionMessagesPageResponse<TMessage>
}

export function resolveSessionMessagesPage<TMessage extends StoredChatMessage = StoredChatMessage>(
  options: ResolveSessionMessagesPageOptions<TMessage>,
): ResolveSessionMessagesPageResult<TMessage> {
  const jsonlLogPage = options.getJsonlLogPage?.()
  if (jsonlLogPage) {
    return {
      response: jsonlLogPage,
      source: 'jsonl-log',
      shouldScheduleMigration: false,
    }
  }

  const sqlitePage = options.getSqlitePage?.()
  if (sqlitePage) {
    return {
      response: sqlitePage,
      source: 'sqlite',
      shouldScheduleMigration: false,
    }
  }

  const jsonByteScanPage = options.getJsonByteScanPage?.()
  if (jsonByteScanPage) {
    return {
      response: jsonByteScanPage,
      source: 'json-byte-scan',
      shouldScheduleMigration: true,
    }
  }

  const messages = options.getSessionMessages?.()
  if (!messages) {
    return {
      response: { success: false, error: 'Session not found' },
      source: 'missing',
      shouldScheduleMigration: false,
    }
  }

  return {
    response: (options.pageFromMessages ?? getMessagesPageFromArray)(messages, options.request),
    source: 'json-full-fallback',
    shouldScheduleMigration: true,
  }
}

export function getUserMessageMarkersFromArray<TMessage extends StoredChatMessage>(
  messages: TMessage[],
): UserMessageMarker[] {
  return messages
    .map((message, index) => ({ message, seq: index + 1 }))
    .filter(item => item.message.role === 'user')
    .map(({ message, seq }) => ({
      id: message.id,
      seq,
      timestamp: message.timestamp,
      preview: message.content.replace(/\s+/g, ' ').trim().slice(0, 80),
    }))
}

export interface ResolveSessionUserMessageMarkersOptions<TMessage extends StoredChatMessage = StoredChatMessage> {
  getJsonlLogMarkers?: () => UserMessageMarker[] | undefined
  getSqliteMarkers?: () => UserMessageMarker[] | undefined
  getSessionMessages?: () => TMessage[] | undefined
  markersFromMessages?: (messages: TMessage[]) => UserMessageMarker[]
}

export function resolveSessionUserMessageMarkers<TMessage extends StoredChatMessage = StoredChatMessage>(
  options: ResolveSessionUserMessageMarkersOptions<TMessage>,
): ResolveSessionUserMessageMarkersResult {
  const jsonlLogMarkers = options.getJsonlLogMarkers?.()
  if (jsonlLogMarkers) {
    return {
      markers: jsonlLogMarkers,
      source: 'jsonl-log',
      shouldScheduleMigration: false,
    }
  }

  const sqliteMarkers = options.getSqliteMarkers?.()
  if (sqliteMarkers) {
    return {
      markers: sqliteMarkers,
      source: 'sqlite',
      shouldScheduleMigration: false,
    }
  }

  const messages = options.getSessionMessages?.()
  if (!messages) {
    return {
      source: 'missing',
      shouldScheduleMigration: false,
    }
  }

  return {
    markers: (options.markersFromMessages ?? getUserMessageMarkersFromArray)(messages),
    source: 'json-full-fallback',
    shouldScheduleMigration: true,
  }
}
