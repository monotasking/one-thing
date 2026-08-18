import {
  addOrUpdateSessionMessageStep,
  appendSessionMessageContentPart,
  applySessionAppendMessageWithAdapters,
  applySessionDeleteMessageWithAdapters,
  applySessionInsertMessageAfterWithAdapters,
  applySessionMessageMutationWithAdapters,
  applySessionMessageStepsUsageByTurnWithAdapters,
  applySessionTruncateMessagesWithAdapters,
  applySessionUpdateMessageAndTruncateWithAdapters,
  findSessionMessage,
  getSessionTokenUsageSnapshot,
  patchSessionMessage,
  updateSessionMessageStep,
  type CoreSessionCacheAdapter,
  type CoreSessionEditableMessage,
  type CoreSessionMessageWithId,
  type CoreSessionMessageWithModelInfo,
  type CoreSessionMessageWithSteps,
  type CoreSessionMessageWithUsage,
  type CoreSessionMeta,
  type CoreSessionStepWithId,
  type CoreSessionTokenUsage,
  type CoreSessionUsageSnapshot,
  type CoreSessionWithMessageList,
} from '@onething/core/session'
import type { SessionWritePlan } from './storage-driver.js'

/**
 * IM emoji reactions as the persistence layer needs to see them (W8): one
 * entry per emoji carrying its actors. Structural on purpose — the wire-level
 * twin lives in the shared IPC contracts, and this layer stays contract-free.
 */
export type CoreSessionMessageReactions = Array<{
  emoji: string
  by: Array<{ type: 'user' | 'agent'; agentId?: string }>
}>

/**
 * IM quote-reply snapshot as the persistence layer needs to see it (W7 shape,
 * written after the fact by the coordinator since W13.2). Structural on
 * purpose — the wire-level twin lives in the shared IPC contracts.
 */
export interface CoreSessionMessageReplyTo {
  messageId: string
  authorLabel: string
  excerpt: string
}

/**
 * Identity-resolved @mentions as the persistence layer needs to see them
 * (W14a). Structural on purpose — the wire-level twin (ChatMessageMention)
 * lives in the shared IPC contracts.
 */
export type CoreSessionMessageMentions = Array<{ agentId: string; label: string }>

export interface OnethingSessionMessageRuntimeLogger {
  log?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

export interface OnethingSessionMessageRuntimeRepository<
  TSession,
  TMessage,
  TMeta,
> {
  getSession(sessionId: string): TSession | undefined
  getCachedSession?(sessionId: string): TSession | undefined
  saveSessionToFile(
    sessionId: string,
    session: TSession,
    options?: { lazy?: boolean; plan?: SessionWritePlan },
  ): void
  syncSessionToSqliteIfReady?(session: TSession): void
  updateSessionsIndexMeta(sessionId: string, update: (meta: TMeta) => void): boolean
}

export interface OnethingSessionMessageRuntimeSqliteAdapters<
  TSession,
  TMessage,
> {
  isSessionReady?(sessionId: string): boolean
  scheduleMigration?(sessionId: string): void
  syncMessage?(sessionId: string, message: TMessage, seq: number): void
  syncSessionMetadata?(session: TSession): void
  syncSessionUsage?(session: TSession): void
  deleteMessage?(sessionId: string, messageId: string): void
  deleteMessageAndAfter?(sessionId: string, messageId: string): void
  upsertMessageAndTruncate?(sessionId: string, message: TMessage, seq: number): void
}

export interface OnethingSessionMessageRuntimeOptions<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionMessageWithId & CoreSessionMessageWithModelInfo,
  TMeta extends CoreSessionMeta,
  TStep extends CoreSessionStepWithId = CoreSessionStepWithId,
  TContentPart = unknown,
  TToolCall = unknown,
> {
  repository: OnethingSessionMessageRuntimeRepository<TSession, TMessage, TMeta>
  sqlite?: OnethingSessionMessageRuntimeSqliteAdapters<TSession, TMessage>
  streamSyncThrottleMs?: number
  now?: () => number
  logger?: OnethingSessionMessageRuntimeLogger
}

export class OnethingSessionMessageRuntime<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionMessageWithId
    & CoreSessionMessageWithModelInfo
    & CoreSessionMessageWithUsage
    & CoreSessionEditableMessage
    & CoreSessionMessageWithSteps<TStep>
    & {
      contentParts?: TContentPart[]
      reasoning?: string
      isStreaming?: boolean
      usage?: CoreSessionTokenUsage
      toolCalls?: TToolCall[]
      thinkingTime?: number
      skillUsed?: string
      errorDetails?: string
      reactions?: CoreSessionMessageReactions
      replyTo?: CoreSessionMessageReplyTo
      mentions?: CoreSessionMessageMentions
    },
  TMeta extends CoreSessionMeta,
  TStep extends CoreSessionStepWithId = CoreSessionStepWithId,
  TContentPart = unknown,
  TToolCall = unknown,
> {
  private readonly pendingSqliteMessageSyncs = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly streamSyncThrottleMs: number
  private readonly now: () => number
  private readonly logger: OnethingSessionMessageRuntimeLogger

  constructor(private readonly options: OnethingSessionMessageRuntimeOptions<
    TSession,
    TMessage,
    TMeta,
    TStep,
    TContentPart,
    TToolCall
  >) {
    this.streamSyncThrottleMs = options.streamSyncThrottleMs ?? 1000
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? console
  }

  cancelPendingSqliteMessageSyncs(sessionId: string): void {
    for (const [key, timer] of this.pendingSqliteMessageSyncs) {
      if (key.startsWith(`${sessionId}:`)) {
        clearTimeout(timer)
        this.pendingSqliteMessageSyncs.delete(key)
      }
    }
  }

  getSessionTokenUsage(sessionId: string): CoreSessionUsageSnapshot | null {
    const session = this.options.repository.getSession(sessionId)
    if (!session) return null
    return getSessionTokenUsageSnapshot(session)
  }

  addMessage(sessionId: string, message: TMessage): void {
    applySessionAppendMessageWithAdapters<TSession, TMessage, TMeta>({
      sessionId,
      message,
      now: this.now(),
      getSession: id => this.options.repository.getSession(id),
      // 追加 = 从新消息的 seq 起做后缀写
      saveSession: (id, session) => this.options.repository.saveSessionToFile(id, session, {
        plan: { kind: 'message', dirtySeq: session.messages.length },
      }),
      syncMessage: (session, nextMessage) => this.syncMessageToSqliteIfReady(session, nextMessage),
      updateIndexMeta: (id, mutate) => this.options.repository.updateSessionsIndexMeta(id, mutate),
    })
  }

  insertMessageAfter(sessionId: string, afterMessageId: string, message: TMessage): boolean {
    return applySessionInsertMessageAfterWithAdapters<TSession, TMessage>({
      sessionId,
      afterMessageId,
      message,
      now: this.now(),
      getSession: id => this.options.repository.getSession(id),
      saveSession: (id, session) => this.options.repository.saveSessionToFile(id, session),
      syncSession: session => this.syncSessionToSqliteIfReady(session),
    }).applied
  }

  deleteMessage(sessionId: string, messageId: string): boolean {
    return Boolean(applySessionDeleteMessageWithAdapters<TSession, TMessage>({
      sessionId,
      messageId,
      now: this.now(),
      getSession: id => this.options.repository.getSession(id),
      saveSession: (id, session) => this.options.repository.saveSessionToFile(id, session),
      sqlite: {
        isReady: id => this.isSqliteSessionReady(id),
        scheduleMigration: id => this.scheduleSessionSqliteMigration(id),
        syncMetadata: session => this.syncSqliteSessionMetadata(session),
        deleteMessage: (id, targetMessageId) => this.deleteSqliteMessage(id, targetMessageId),
      },
      logger: this.logger,
    }))
  }

  deleteMessageAndTruncate(sessionId: string, messageId: string): boolean {
    const result = applySessionTruncateMessagesWithAdapters<TSession, TMessage>({
      sessionId,
      messageId,
      now: this.now(),
      getSession: id => this.options.repository.getSession(id),
      saveSession: (id, session) => this.options.repository.saveSessionToFile(id, session),
      sqlite: {
        isReady: id => this.isSqliteSessionReady(id),
        scheduleMigration: id => this.scheduleSessionSqliteMigration(id),
        syncMetadata: session => this.syncSqliteSessionMetadata(session),
        syncUsage: session => this.syncSqliteSessionUsage(session),
        deleteMessageAndAfter: (id, targetMessageId) => this.deleteSqliteMessageAndAfter(id, targetMessageId),
      },
      updateIndexMeta: (id, mutate) => this.options.repository.updateSessionsIndexMeta(id, meta => mutate(meta)),
      logger: this.logger,
    })
    if (!result) return false

    const session = this.options.repository.getSession(sessionId)
    if (session) this.logSubtractedMessageUsage(session, result.subtractedUsage)
    return true
  }

  updateMessageAndTruncate(
    sessionId: string,
    messageId: string,
    newContent: string,
    options?: { contentParts?: TMessage['contentParts'] | null },
  ): boolean {
    const result = applySessionUpdateMessageAndTruncateWithAdapters<TSession, TMessage>({
      sessionId,
      messageId,
      newContent,
      options: {
        hasContentParts: Boolean(options && Object.prototype.hasOwnProperty.call(options, 'contentParts')),
        contentParts: options?.contentParts,
      },
      now: this.now(),
      getSession: id => this.options.repository.getSession(id),
      saveSession: (id, session) => this.options.repository.saveSessionToFile(id, session),
      sqlite: {
        isReady: id => this.isSqliteSessionReady(id),
        scheduleMigration: id => this.scheduleSessionSqliteMigration(id),
        syncMetadata: session => this.syncSqliteSessionMetadata(session),
        syncUsage: session => this.syncSqliteSessionUsage(session),
        upsertMessageAndTruncate: (id, message, seq) => this.upsertSqliteMessageAndTruncate(id, message, seq),
      },
      updateIndexMeta: (id, mutate) => this.options.repository.updateSessionsIndexMeta(id, meta => mutate(meta)),
      logger: this.logger,
    })
    if (!result) return false

    const session = this.options.repository.getSession(sessionId)
    if (session) this.logSubtractedMessageUsage(session, result.subtractedUsage)
    return true
  }

  // 逐 token 高频路径:只更新缓存并用 lazy 档兜底落盘,避免流式期间反复全量写盘。
  updateMessageContent(sessionId: string, messageId: string, newContent: string): boolean {
    return this.patchMessage(sessionId, messageId, { content: newContent } as Partial<TMessage>, { lazy: true })
  }

  updateMessageReasoning(sessionId: string, messageId: string, reasoning: string): boolean {
    return this.patchMessage(sessionId, messageId, { reasoning } as Partial<TMessage>, { lazy: true })
  }

  updateMessageStreaming(sessionId: string, messageId: string, isStreaming: boolean): boolean {
    return this.patchMessage(sessionId, messageId, { isStreaming } as Partial<TMessage>)
  }

  updateMessageUsage(sessionId: string, messageId: string, usage: CoreSessionTokenUsage): boolean {
    return this.patchMessage(sessionId, messageId, { usage } as Partial<TMessage>)
  }

  updateMessageToolCalls(sessionId: string, messageId: string, toolCalls: TToolCall[]): boolean {
    return this.patchMessage(sessionId, messageId, { toolCalls } as Partial<TMessage>)
  }

  updateMessageContentParts(sessionId: string, messageId: string, contentParts: TMessage['contentParts']): boolean {
    return this.patchMessage(sessionId, messageId, { contentParts } as Partial<TMessage>, { lazy: true })
  }

  addMessageContentPart(sessionId: string, messageId: string, part: TContentPart): boolean {
    return this.mutateMessage(sessionId, messageId, (session, targetMessageId) =>
      appendSessionMessageContentPart<TMessage, TContentPart>(session, targetMessageId, part),
    )
  }

  updateMessageThinkingTime(sessionId: string, messageId: string, thinkingTime: number): boolean {
    return this.patchMessage(sessionId, messageId, { thinkingTime } as Partial<TMessage>, { lazy: true })
  }

  updateMessageSkill(sessionId: string, messageId: string, skillUsed: string): boolean {
    return this.patchMessage(sessionId, messageId, { skillUsed } as Partial<TMessage>)
  }

  updateMessageError(sessionId: string, messageId: string, errorDetails: string): boolean {
    return this.patchMessage(sessionId, messageId, { errorDetails } as Partial<TMessage>)
  }

  // IM reactions (W8): metadata on an already-written message, so it rides the
  // ordinary patch path — no truncation, no sort-order effect, no usage math.
  updateMessageReactions(
    sessionId: string,
    messageId: string,
    reactions: CoreSessionMessageReactions,
  ): boolean {
    return this.patchMessage(sessionId, messageId, { reactions } as Partial<TMessage>)
  }

  // IM quote reply (W13.2): the coordinator hangs a snapshot on an agent reply
  // AFTER the stream settled. Metadata on an already-written message, so it
  // rides the same ordinary patch path reactions do.
  updateMessageReplyTo(
    sessionId: string,
    messageId: string,
    replyTo: CoreSessionMessageReplyTo,
  ): boolean {
    return this.patchMessage(sessionId, messageId, { replyTo } as Partial<TMessage>)
  }

  /**
   * The turn-context delta delivered with a user message (prompt-channels
   * 2026-08-18). Written once, at request-build time, by the assembly layer's
   * `SessionTurnContext`; every later rebuild of that turn replays the stored
   * delta, which is what keeps the request bytes identical across the tool
   * loop. Metadata on an already-written message — the ordinary patch path.
   */
  updateMessageTurnContext(
    sessionId: string,
    messageId: string,
    turnContext: unknown,
  ): boolean {
    return this.patchMessage(sessionId, messageId, { turnContext } as unknown as Partial<TMessage>)
  }

  // Identity-resolved @mentions (W14a): the coordinator stamps ids onto an
  // agent reply once the stream settled — metadata on an already-written
  // message, same ordinary patch path reactions and quotes ride.
  updateMessageMentions(
    sessionId: string,
    messageId: string,
    mentions: CoreSessionMessageMentions,
  ): boolean {
    return this.patchMessage(sessionId, messageId, { mentions } as Partial<TMessage>)
  }

  addMessageStep(sessionId: string, messageId: string, step: TStep): boolean {
    return this.mutateMessage(sessionId, messageId, (session, targetMessageId) => {
      const message = findSessionMessage(session, targetMessageId)
      if (!message) return undefined
      addOrUpdateSessionMessageStep<TMessage, TStep>(message, step)
      return message
    })
  }

  updateMessageStep(sessionId: string, messageId: string, stepId: string, updates: Partial<TStep>): boolean {
    // step 存活期间的活跃计时/部分输出更新是高频的;完成态(status 变更)按边界立即调度。
    const lazy = updates.status === undefined
    return this.mutateMessage(sessionId, messageId, (session, targetMessageId) => {
      const message = findSessionMessage(session, targetMessageId)
      if (!message) return undefined
      return updateSessionMessageStep(message, stepId, updates) ? message : undefined
    }, { lazy })
  }

  updateMessageSteps(sessionId: string, messageId: string, steps: TStep[] | undefined): boolean {
    return this.patchMessage(sessionId, messageId, { steps } as Partial<TMessage>)
  }

  updateStepsUsageByTurn(
    sessionId: string,
    messageId: string,
    turnIndex: number,
    usage: CoreSessionTokenUsage,
  ): string[] {
    return applySessionMessageStepsUsageByTurnWithAdapters<TSession, TMessage, TStep>({
      sessionId,
      messageId,
      turnIndex,
      usage,
      getSession: id => this.options.repository.getSession(id),
      saveSession: (id, session) => this.options.repository.saveSessionToFile(id, session, {
        plan: this.messageWritePlan(session, messageId),
      }),
      syncMessage: (session, message) => this.syncMessageToSqliteIfReady(session, message),
    })
  }

  private patchMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<TMessage>,
    saveOptions?: { lazy?: boolean },
  ): boolean {
    return this.mutateMessage(sessionId, messageId, (session, targetMessageId) =>
      patchSessionMessage<TMessage, Partial<TMessage>>(session, targetMessageId, patch),
    saveOptions)
  }

  private messageWritePlan(session: TSession, messageId: string): SessionWritePlan {
    const index = session.messages.findIndex(item => item.id === messageId)
    return index === -1 ? { kind: 'structural' } : { kind: 'message', dirtySeq: index + 1 }
  }

  private mutateMessage(
    sessionId: string,
    messageId: string,
    mutateMessage: (
      session: TSession,
      messageId: string,
    ) => TMessage | undefined,
    saveOptions?: { lazy?: boolean },
  ): boolean {
    return applySessionMessageMutationWithAdapters<TSession, TMessage>({
      sessionId,
      messageId,
      getSession: id => this.options.repository.getSession(id),
      mutateMessage,
      saveSession: (id, session) => this.options.repository.saveSessionToFile(id, session, {
        ...saveOptions,
        plan: this.messageWritePlan(session, messageId),
      }),
      syncMessage: (session, message) => this.syncMessageToSqliteIfReady(session, message),
    }).applied
  }

  private syncSessionToSqliteIfReady(session: TSession): void {
    this.options.repository.syncSessionToSqliteIfReady?.(session)
  }

  private syncMessageToSqliteIfReady(session: TSession, message: TMessage): void {
    try {
      const seq = session.messages.findIndex(item => item.id === message.id) + 1
      if (seq <= 0) return

      const syncKey = `${session.id}:${message.id}`
      const pendingTimer = this.pendingSqliteMessageSyncs.get(syncKey)
      if (message.isStreaming) {
        if (!pendingTimer) {
          this.pendingSqliteMessageSyncs.set(syncKey, setTimeout(() => {
            this.pendingSqliteMessageSyncs.delete(syncKey)
            const latestSession = this.options.repository.getCachedSession?.(session.id)
            const latestMessage = latestSession?.messages.find(item => item.id === message.id)
            if (latestSession && latestMessage) {
              this.syncMessageToSqliteIfReady(latestSession, latestMessage)
            }
          }, this.streamSyncThrottleMs))
        }
        return
      }

      if (pendingTimer) {
        clearTimeout(pendingTimer)
        this.pendingSqliteMessageSyncs.delete(syncKey)
      }

      if (this.isSqliteSessionReady(session.id)) {
        this.syncSqliteMessage(session.id, message, seq)
        this.syncSqliteSessionMetadata(session)
      } else {
        this.scheduleSessionSqliteMigration(session.id)
      }
    } catch (error) {
      this.logger.error?.('[Sessions] Failed to sync message to SQLite:', error)
    }
  }

  private logSubtractedMessageUsage(
    session: TSession,
    tokensToSubtract: { inputTokens: number; outputTokens: number; totalTokens: number },
  ): void {
    if (tokensToSubtract.totalTokens > 0) {
      this.logger.log?.('[Sessions] Subtracted tokens from deleted messages:', tokensToSubtract, 'New session totals:', {
        totalInputTokens: (session as { totalInputTokens?: number }).totalInputTokens,
        totalOutputTokens: (session as { totalOutputTokens?: number }).totalOutputTokens,
        totalTokens: (session as { totalTokens?: number }).totalTokens,
      })
    }
  }

  private isSqliteSessionReady(sessionId: string): boolean {
    return this.options.sqlite?.isSessionReady?.(sessionId) ?? false
  }

  private scheduleSessionSqliteMigration(sessionId: string): void {
    this.options.sqlite?.scheduleMigration?.(sessionId)
  }

  private syncSqliteMessage(sessionId: string, message: TMessage, seq: number): void {
    this.options.sqlite?.syncMessage?.(sessionId, message, seq)
  }

  private syncSqliteSessionMetadata(session: TSession): void {
    this.options.sqlite?.syncSessionMetadata?.(session)
  }

  private syncSqliteSessionUsage(session: TSession): void {
    this.options.sqlite?.syncSessionUsage?.(session)
  }

  private deleteSqliteMessage(sessionId: string, messageId: string): void {
    this.options.sqlite?.deleteMessage?.(sessionId, messageId)
  }

  private deleteSqliteMessageAndAfter(sessionId: string, messageId: string): void {
    this.options.sqlite?.deleteMessageAndAfter?.(sessionId, messageId)
  }

  private upsertSqliteMessageAndTruncate(sessionId: string, message: TMessage, seq: number): void {
    this.options.sqlite?.upsertMessageAndTruncate?.(sessionId, message, seq)
  }
}

export function createOnethingSessionMessageRuntime<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionMessageWithId
    & CoreSessionMessageWithModelInfo
    & CoreSessionMessageWithUsage
    & CoreSessionEditableMessage
    & CoreSessionMessageWithSteps<TStep>
    & {
      contentParts?: TContentPart[]
      reasoning?: string
      isStreaming?: boolean
      usage?: CoreSessionTokenUsage
      toolCalls?: TToolCall[]
      thinkingTime?: number
      skillUsed?: string
      errorDetails?: string
      reactions?: CoreSessionMessageReactions
      replyTo?: CoreSessionMessageReplyTo
      mentions?: CoreSessionMessageMentions
    },
  TMeta extends CoreSessionMeta,
  TStep extends CoreSessionStepWithId = CoreSessionStepWithId,
  TContentPart = unknown,
  TToolCall = unknown,
>(
  options: OnethingSessionMessageRuntimeOptions<TSession, TMessage, TMeta, TStep, TContentPart, TToolCall>,
): OnethingSessionMessageRuntime<TSession, TMessage, TMeta, TStep, TContentPart, TToolCall> {
  return new OnethingSessionMessageRuntime(options)
}

export type OnethingSessionMessageRuntimeCacheAdapter<TSession> = CoreSessionCacheAdapter<TSession>
