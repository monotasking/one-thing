export interface StoredChatMessage {
  id: string
  seq?: number
  sessionId?: string
  role: string
  content: string
  timestamp: number
}

export type SessionMessagesPageDirection = 'older' | 'newer'

export interface SessionMessagesPageAnchor {
  messageId?: string
  seq?: number
  before?: number
  after?: number
}

export interface GetSessionMessagesPageRequest {
  sessionId: string
  cursor?: string | null
  limit?: number
  direction?: SessionMessagesPageDirection
  anchor?: 'tail' | SessionMessagesPageAnchor
}

export interface SessionMessagePageCursor {
  sessionId: string
  seq: number
  includeAnchor: boolean
}

export interface GetSessionMessagesPageResponse<TMessage extends StoredChatMessage = StoredChatMessage> {
  success: boolean
  messages?: TMessage[]
  nextCursor?: string | null
  backwardsCursor?: string | null
  hasMoreBefore?: boolean
  hasMoreAfter?: boolean
  totalCount?: number
  error?: string
}

export type SessionMessagesPageSource =
  | 'sqlite'
  | 'jsonl-log'
  | 'json-byte-scan'
  | 'json-full-fallback'
  | 'missing'

export interface ResolveSessionMessagesPageResult<TMessage extends StoredChatMessage = StoredChatMessage> {
  response: GetSessionMessagesPageResponse<TMessage>
  source: SessionMessagesPageSource
  shouldScheduleMigration: boolean
}

export interface UserMessageMarker {
  id: string
  seq: number
  timestamp: number
  preview: string
}

export type SessionUserMessageMarkersSource =
  | 'sqlite'
  | 'jsonl-log'
  | 'json-full-fallback'
  | 'missing'

export interface ResolveSessionUserMessageMarkersResult {
  markers?: UserMessageMarker[]
  source: SessionUserMessageMarkersSource
  shouldScheduleMigration: boolean
}

export interface TurnUsage {
  inputTokens: number
  outputTokens: number
}

export interface CoreSessionRepository<
  TSessionMeta,
  TSessionDetails,
  TSession,
  TMessage extends StoredChatMessage & { contentParts?: unknown },
  TTokenUsage,
  TContentParts = TMessage['contentParts'],
> {
  getSessionsList(): TSessionMeta[]
  getSessionDetails(sessionId: string): TSessionDetails | undefined
  getSessionMessagesPage(request: GetSessionMessagesPageRequest): GetSessionMessagesPageResponse<TMessage>
  getSessionForGeneration(sessionId: string): TSession | undefined
  getUserMessageMarkers(sessionId: string): UserMessageMarker[] | undefined
  createSession(sessionId: string, name: string): TSession
  /**
   * 追加一条消息,**返回真正入库的那一条**(F4-a,§16.12;与
   * `StreamEngineStoreAdapter.addMessage` 同一条口径,理由见那里)。
   * 宿主不改写就原样返回入参。
   */
  addMessage(sessionId: string, message: TMessage): TMessage
  updateMessage(sessionId: string, messageId: string, updates: Partial<TMessage>): boolean
  updateMessageAndTruncate(
    sessionId: string,
    messageId: string,
    newContent: string,
    options?: { contentParts?: TContentParts | null }
  ): boolean
  updateSessionTokenUsage(sessionId: string, usage: TTokenUsage, lastTurnUsage?: TurnUsage): void
  flushSessionSave(sessionId: string): Promise<void>
  flushAllPendingSaves(): Promise<void>
}
