import {
  sanitizeOnethingMessagesForRenderer,
  sanitizeOnethingSessionForRenderer,
  type OnethingRendererMessageLike,
  type OnethingRendererSessionLike,
} from './renderer-sanitizer.js'
import {
  createOnethingBranchSession,
  type CreateOnethingBranchSessionAdapters,
  type OnethingBranchSourceMessage,
  type OnethingBranchSourceSession,
} from './branching.js'
import {
  removeOnethingSystemMarkerMessage,
  type OnethingSystemMessageLike,
  type OnethingSystemMessageSessionLike,
  type RemoveOnethingSystemMarkerMessageResult,
} from './system-messages.js'
import {
  normalizeOnethingSessionTokenUsage,
  type OnethingSessionTokenUsageForIpc,
  type OnethingSessionTokenUsageLike,
} from './session-usage.js'

type MaybePromise<T> = T | Promise<T>

export const ONETHING_SESSION_NOT_FOUND = 'Session not found'

export interface OnethingSessionsIpcLogger {
  error?: (...args: unknown[]) => void
  info?: (...args: unknown[]) => void
}

export type OnethingSessionsIpcResult<TPayload extends object = {}> =
  | ({ success: true } & TPayload)
  | { success: false; error: string }

export interface OnethingSessionDetailsLike {
  messageCount?: number
}

export interface OnethingDeleteSessionResultLike {
  parentSessionId?: string
  deletedIds: string[]
}

export interface OnethingMessagesPageResponseLike<TMessage extends OnethingRendererMessageLike> {
  success: boolean
  messages?: TMessage[]
  error?: string
}

export async function getOnethingChatHistoryForIpc<
  TMessage extends OnethingRendererMessageLike,
  TSession extends OnethingRendererSessionLike<TMessage>,
>(
  options: {
    sessionId: string
    getSession(sessionId: string): MaybePromise<TSession | undefined | null>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult<{ messages: TMessage[] | undefined }>> {
  try {
    const session = await options.getSession(options.sessionId)
    if (!session) return { success: false, error: ONETHING_SESSION_NOT_FOUND }
    return {
      success: true,
      messages: sanitizeOnethingMessagesForRenderer(session.messages),
    }
  } catch (error) {
    return sessionIpcError(options.logger, 'get chat history', error, 'Failed to get chat history')
  }
}

export async function getOnethingSessionTokenUsageForIpc(
  options: {
    sessionId: string
    maxTokens?: number
    getSessionTokenUsage(sessionId: string): MaybePromise<OnethingSessionTokenUsageLike | undefined | null>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult<{ usage: OnethingSessionTokenUsageForIpc }>> {
  try {
    return {
      success: true,
      usage: normalizeOnethingSessionTokenUsage(
        await options.getSessionTokenUsage(options.sessionId),
        options.maxTokens,
      ),
    }
  } catch (error) {
    return sessionIpcError(options.logger, 'get session token usage', error, 'Failed to get session token usage')
  }
}

export async function listOnethingSessionsForIpc<TSession>(
  options: {
    listSessions(): MaybePromise<TSession[]>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult<{ sessions: TSession[] }>> {
  try {
    return { success: true, sessions: await options.listSessions() }
  } catch (error) {
    return sessionIpcError(options.logger, 'get sessions list', error, 'Failed to get sessions list')
  }
}

export async function activateOnethingSessionForIpc<TSession extends OnethingSessionDetailsLike>(
  options: {
    sessionId: string
    getSessionDetails(sessionId: string): MaybePromise<TSession | undefined | null>
    setCurrentSessionId(sessionId: string): MaybePromise<unknown>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult<{ session: TSession; messageCount: number }>> {
  try {
    const session = await options.getSessionDetails(options.sessionId)
    if (!session) return { success: false, error: ONETHING_SESSION_NOT_FOUND }

    await options.setCurrentSessionId(options.sessionId)
    return {
      success: true,
      session,
      messageCount: session.messageCount ?? 0,
    }
  } catch (error) {
    return sessionIpcError(options.logger, 'activate session', error, 'Failed to activate session')
  }
}

export async function getOnethingSessionMessagesForIpc<TMessage extends OnethingRendererMessageLike>(
  options: {
    sessionId: string
    getSessionMessages(sessionId: string): MaybePromise<TMessage[] | undefined | null>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult<{ messages: TMessage[] | undefined }>> {
  try {
    const messages = await options.getSessionMessages(options.sessionId)
    if (!messages) return { success: false, error: ONETHING_SESSION_NOT_FOUND }
    return {
      success: true,
      messages: sanitizeOnethingMessagesForRenderer(messages),
    }
  } catch (error) {
    return sessionIpcError(options.logger, 'get session messages', error, 'Failed to get messages')
  }
}

export async function getOnethingSessionMessagesPageForIpc<
  TMessage extends OnethingRendererMessageLike,
  TResponse extends OnethingMessagesPageResponseLike<TMessage>,
>(
  options: {
    request: unknown
    getSessionMessagesPage(request: unknown): MaybePromise<TResponse>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<TResponse | { success: false; error: string }> {
  try {
    const response = await options.getSessionMessagesPage(options.request)
    if (!response.success) return response
    return {
      ...response,
      messages: sanitizeOnethingMessagesForRenderer(response.messages),
    }
  } catch (error) {
    return sessionIpcError(options.logger, 'get session messages page', error, 'Failed to get message page')
  }
}

export async function listOnethingSessionUserMarkersForIpc<TMarker>(
  options: {
    sessionId: string
    getSessionUserMessageMarkers(sessionId: string): MaybePromise<TMarker[] | undefined | null>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult<{ markers: TMarker[] }>> {
  try {
    const markers = await options.getSessionUserMessageMarkers(options.sessionId)
    if (!markers) return { success: false, error: ONETHING_SESSION_NOT_FOUND }
    return { success: true, markers }
  } catch (error) {
    return sessionIpcError(options.logger, 'get user message markers', error, 'Failed to get user markers')
  }
}

/** renderer 生成的草稿 id 就是未来的会话 id;它会成为存储路径片段,字符集卡死。 */
const ONETHING_SESSION_UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const ONETHING_INVALID_SESSION_ID = 'Invalid session id'
export const ONETHING_SESSION_ID_ALREADY_EXISTS = 'Session id already exists'
export const ONETHING_INVALID_SESSION_KIND = 'Invalid session kind'

/**
 * 建会话请求的合法性判定 —— 三条规矩,连同它们的失败载荷一起住在运行时:
 *
 *  1. 客户端自带的 id 必须是 renderer 那种 UUID v4(它会成为存储路径片段);
 *  2. 永不认领已经存在的会话;
 *  3. `kind` 只认 `'room'` —— 'work' 会话是协调器内部的,从不走 IPC 建出来。
 *
 * 合法返回 `null`,非法直接返回可以原样 `return` 出去的失败载荷 —— 宿主因此
 * 只递形状、不留规则(boundary:`packages/onething-runtime owns session branch
 * creation orchestration`)。
 */
export async function describeInvalidOnethingCreateSessionRequestForIpc(
  options: {
    sessionId?: string
    kind?: string
    getSession(sessionId: string): MaybePromise<unknown>
  },
): Promise<{ success: false; error: string } | null> {
  if (options.sessionId !== undefined) {
    if (!ONETHING_SESSION_UUID_V4_RE.test(options.sessionId)) {
      return { success: false, error: ONETHING_INVALID_SESSION_ID }
    }
    if (await options.getSession(options.sessionId)) {
      return { success: false, error: ONETHING_SESSION_ID_ALREADY_EXISTS }
    }
  }
  if (options.kind !== undefined && options.kind !== 'room') {
    return { success: false, error: ONETHING_INVALID_SESSION_KIND }
  }
  return null
}

export async function createOnethingSessionForIpc<
  TSession extends OnethingRendererSessionLike<TMessage>,
  TMessage extends OnethingRendererMessageLike,
>(
  options: {
    sessionId: string
    name?: string
    defaultName?: string
    createSession(sessionId: string, name: string): MaybePromise<TSession>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult<{ session: TSession }>> {
  try {
    const session = await options.createSession(options.sessionId, options.name || options.defaultName || 'New Chat')
    return { success: true, session: sanitizeOnethingSessionForRenderer(session) }
  } catch (error) {
    return sessionIpcError(options.logger, 'create session', error, 'Failed to create session')
  }
}

export function createOnethingBranchSessionForIpc<
  TSession extends OnethingBranchSourceSession<TMessage>,
  TMessage extends OnethingBranchSourceMessage & OnethingRendererMessageLike,
  TBranchSession extends OnethingRendererSessionLike<TMessage>,
>(
  options: {
    parentSessionId: string
    branchFromMessageId: string
    adapters: CreateOnethingBranchSessionAdapters<TSession, TMessage, TBranchSession>
    logger?: OnethingSessionsIpcLogger
  },
): OnethingSessionsIpcResult<{ session: TBranchSession }> {
  try {
    const result = createOnethingBranchSession({
      parentSessionId: options.parentSessionId,
      branchFromMessageId: options.branchFromMessageId,
      adapters: options.adapters,
    })
    return result.success
      ? { success: true, session: sanitizeOnethingSessionForRenderer(result.session) }
      : result
  } catch (error) {
    return sessionIpcError(options.logger, 'create branch session', error, 'Failed to create branch')
  }
}

export async function switchOnethingSessionForIpc<
  TSession extends OnethingRendererSessionLike<TMessage>,
  TMessage extends OnethingRendererMessageLike,
>(
  options: {
    sessionId: string
    getSession(sessionId: string): MaybePromise<TSession | undefined | null>
    setCurrentSessionId(sessionId: string): MaybePromise<unknown>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult<{ session: TSession }>> {
  try {
    const session = await options.getSession(options.sessionId)
    if (!session) return { success: false, error: ONETHING_SESSION_NOT_FOUND }
    await options.setCurrentSessionId(options.sessionId)
    return { success: true, session: sanitizeOnethingSessionForRenderer(session) }
  } catch (error) {
    return sessionIpcError(options.logger, 'switch session', error, 'Failed to switch session')
  }
}

export async function getOnethingSessionForIpc<
  TSession extends OnethingRendererSessionLike<TMessage>,
  TMessage extends OnethingRendererMessageLike,
>(
  options: {
    sessionId: string
    getSession(sessionId: string): MaybePromise<TSession | undefined | null>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult<{ session: TSession }>> {
  try {
    const session = await options.getSession(options.sessionId)
    if (!session) return { success: false, error: ONETHING_SESSION_NOT_FOUND }
    return { success: true, session: sanitizeOnethingSessionForRenderer(session) }
  } catch (error) {
    return sessionIpcError(options.logger, 'get session', error, 'Failed to get session')
  }
}

export async function deleteOnethingSessionForIpc(
  options: {
    sessionId: string
    deleteSession(sessionId: string): MaybePromise<OnethingDeleteSessionResultLike>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult<{ parentSessionId?: string; deletedCount: number }>> {
  try {
    const result = await options.deleteSession(options.sessionId)
    return {
      success: true,
      parentSessionId: result.parentSessionId,
      deletedCount: result.deletedIds.length,
    }
  } catch (error) {
    return sessionIpcError(options.logger, 'delete session', error, 'Failed to delete session')
  }
}

export async function renameOnethingSessionForIpc(
  options: {
    sessionId: string
    newName: string
    renameSession(sessionId: string, newName: string): MaybePromise<unknown>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult> {
  try {
    await options.renameSession(options.sessionId, options.newName)
    return { success: true }
  } catch (error) {
    return sessionIpcError(options.logger, 'rename session', error, 'Failed to rename session')
  }
}

export async function updateOnethingSessionPinForIpc(
  options: {
    sessionId: string
    isPinned: boolean
    updateSessionPin(sessionId: string, isPinned: boolean): MaybePromise<unknown>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult> {
  try {
    await options.updateSessionPin(options.sessionId, options.isPinned)
    return { success: true }
  } catch (error) {
    return sessionIpcError(options.logger, 'update session pin', error, 'Failed to update session pin')
  }
}

export async function updateOnethingSessionArchivedForIpc(
  options: {
    sessionId: string
    isArchived: boolean
    archivedAt?: number
    updateSessionArchived(sessionId: string, isArchived: boolean, archivedAt?: number): MaybePromise<unknown>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult> {
  try {
    await options.updateSessionArchived(options.sessionId, options.isArchived, options.archivedAt)
    return { success: true }
  } catch (error) {
    return sessionIpcError(options.logger, 'update session archive state', error, 'Failed to update session archive state')
  }
}

export async function updateOnethingMessageThinkingTimeForIpc(
  options: {
    sessionId: string
    messageId: string
    thinkingTime: number
    updateMessageThinkingTime(sessionId: string, messageId: string, thinkingTime: number): MaybePromise<boolean>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<{ success: boolean; error?: string }> {
  try {
    return {
      success: await options.updateMessageThinkingTime(
        options.sessionId,
        options.messageId,
        options.thinkingTime,
      ),
    }
  } catch (error) {
    return sessionIpcError(options.logger, 'update message thinking time', error, 'Failed to update thinking time')
  }
}

export async function addOnethingSystemMessageForIpc<TMessage>(
  options: {
    sessionId: string
    message: TMessage
    addMessage(sessionId: string, message: TMessage): MaybePromise<unknown>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult> {
  try {
    await options.addMessage(options.sessionId, options.message)
    return { success: true }
  } catch (error) {
    return sessionIpcError(options.logger, 'add system message', error, 'Failed to add message')
  }
}

export async function removeOnethingSystemMarkerMessageForIpc<
  TMessage extends OnethingSystemMessageLike,
  TSession extends OnethingSystemMessageSessionLike<TMessage>,
>(
  options: {
    sessionId: string
    markerType: string
    getSession(sessionId: string): TSession | null | undefined
    deleteMessage(sessionId: string, messageId: string): MaybePromise<unknown>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<RemoveOnethingSystemMarkerMessageResult> {
  try {
    return await removeOnethingSystemMarkerMessage({
      sessionId: options.sessionId,
      markerType: options.markerType,
      getSession: options.getSession,
      deleteMessage: options.deleteMessage,
    })
  } catch (error) {
    return sessionIpcError(options.logger, 'remove system marker message', error, 'Failed to remove message')
  }
}

export async function removeOnethingMessageForIpc(
  options: {
    sessionId: string
    messageId: string
    deleteMessage(sessionId: string, messageId: string): MaybePromise<unknown>
    logger?: OnethingSessionsIpcLogger
  },
): Promise<OnethingSessionsIpcResult> {
  try {
    await options.deleteMessage(options.sessionId, options.messageId)
    return { success: true }
  } catch (error) {
    return sessionIpcError(options.logger, 'remove message', error, 'Failed to remove message')
  }
}

function sessionIpcError(
  logger: OnethingSessionsIpcLogger | undefined,
  label: string,
  error: unknown,
  fallback: string,
): { success: false; error: string } {
  logger?.error?.(`[Sessions] Failed to ${label}:`, error)
  return {
    success: false,
    error: error instanceof Error && error.message ? error.message : fallback,
  }
}
