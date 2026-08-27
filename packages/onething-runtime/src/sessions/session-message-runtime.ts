import {
  adoptSessionCommandResult,
  applySessionCommand,
  applySessionMessageAppendToMeta,
  applySessionUpdatedAtToMeta,
  getSessionTokenUsageSnapshot,
  type CoreSessionCommandMessage,
  type CoreSessionCommandSession,
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
  type SessionCommand,
  type SessionCommandResult,
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
  /** 缓存里那份会话的消息(不触发加载);缺席时流式期的 sqlite 补同步跳过 */
  getCachedSessionMessages?(sessionId: string): TMessage[] | undefined
  saveSessionToFile(
    sessionId: string,
    session: TSession,
    options?: { lazy?: boolean; plan?: SessionWritePlan },
  ): void
  syncSessionToSqliteIfReady?(session: TSession): void
  updateSessionsIndexMeta(sessionId: string, update: (meta: TMeta) => void): boolean
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
  /**
   * SQLite 退役遗留:全仓零生产填充(S4 把只为它存在的那个具名口删了,形状
   * 原地保留)。
   */
  sqlite?: {
    isSessionReady?(sessionId: string): boolean
    scheduleMigration?(sessionId: string): void
    syncMessage?(sessionId: string, message: TMessage, seq: number): void
    syncSessionMetadata?(session: TSession): void
    syncSessionUsage?(session: TSession): void
    deleteMessage?(sessionId: string, messageId: string): void
    deleteMessageAndAfter?(sessionId: string, messageId: string): void
    upsertMessageAndTruncate?(sessionId: string, message: TMessage, seq: number): void
  }
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
  /*
   * `TStep` / `TContentPart` / `TToolCall` —— #8a 之后**类体里不再有方法用到它们**
   * (用它们的那 15 口删了),但它们是这个类**已声明的形状**的一部分:上面
   * `TMessage` 的约束(`CoreSessionMessageWithSteps<TStep>` / `contentParts?:
   * TContentPart[]` / `toolCalls?: TToolCall[]`)与构造参数的
   * `OnethingSessionMessageRuntimeOptions<…>` 都吃它们,两处生产构造点
   * (`backend/stores/sessions.ts` / `backend/server/runtime.ts`)都按 6 个类型参数写。
   * 删它们 = 改形状,不在本批范围 —— 留着,eslint 的三条 unused 警告是已知的。
   */
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

  /**
   * P0.1 绞杀(docs/design/session-commands-p0-2026-08.md §5):22 个 mutator 不再
   * 各自算写计划/各自改对象,统一走 `applySessionCommand` —— 语义、COW、写计划、
   * lazy 档只有那一份。这里剩下的只有"命令之外"的事:落盘、sqlite、index meta。
   *
   * 会话容器身份保持不变(`adoptSessionCommandResult`),见那个函数的注释。
   */
  private run(
    sessionId: string,
    command: SessionCommand<CoreSessionCommandMessage>,
  ): { session: TSession; result: SessionCommandResult<TSession, CoreSessionCommandMessage> } | undefined {
    const session = this.options.repository.getSession(sessionId)
    if (!session) return undefined
    const result = applySessionCommand(
      session as unknown as CoreSessionCommandSession,
      command,
    ) as unknown as SessionCommandResult<TSession, CoreSessionCommandMessage>
    if (!result.changed) return undefined
    adoptSessionCommandResult(session, result)
    this.options.repository.saveSessionToFile(sessionId, session, {
      ...(result.lazy ? { lazy: true } : {}),
      plan: result.writePlan as SessionWritePlan,
    })
    return { session, result }
  }

  private commandMessage(result: SessionCommandResult<TSession, CoreSessionCommandMessage>): TMessage {
    return result.meta!.message as unknown as TMessage
  }

  /**
   * 单条消息的 seq(1 起)—— 直接取命令自己算出来的写计划,不再回头
   * `session.messages.findIndex`(那是命令面之外的一次会话读)。写计划不是
   * `message` 档(结构性写)时返回 0,调用方跳过"同步这一条"。
   */
  private commandMessageSeq(result: SessionCommandResult<TSession, CoreSessionCommandMessage>): number {
    const plan = result.writePlan as SessionWritePlan | undefined
    return plan?.kind === 'message' ? (plan.dirtySeq ?? 0) : 0
  }

  addMessage(sessionId: string, message: TMessage): void {
    const applied = this.run(sessionId, {
      type: 'appendMessage',
      message: message as unknown as CoreSessionCommandMessage,
      now: this.now(),
    })
    if (!applied) return
    this.syncMessageToSqliteIfReady(applied.session, message, this.commandMessageSeq(applied.result))
    this.options.repository.updateSessionsIndexMeta(sessionId, meta =>
      applySessionMessageAppendToMeta(meta, applied.session, message))
  }

  deleteMessage(sessionId: string, messageId: string): boolean {
    return this.runDeleteMessage(sessionId, { type: 'deleteMessage', messageId, now: this.now() })
  }

  /**
   * `deleteMessage` 的两种形态(按 id / 按谓词)共用的收尾:sqlite 清一条 + E4 的
   * index 元数据补盖。被删的那条由 reducer 从 `meta.deletedMessage` 带回来 ——
   * 谓词形态不再自己先 `find` 一遍(那是命令面之外的一次会话读)。
   */
  private runDeleteMessage(
    sessionId: string,
    command: SessionCommand<CoreSessionCommandMessage>,
  ): boolean {
    const applied = this.run(sessionId, command)
    if (!applied) return false
    const deletedId = (applied.result.meta?.deletedMessage as CoreSessionCommandMessage | undefined)?.id

    try {
      if (this.isSqliteSessionReady(sessionId)) {
        if (deletedId) this.deleteSqliteMessage(sessionId, deletedId)
        this.syncSqliteSessionMetadata(applied.session)
      } else {
        this.scheduleSessionSqliteMigration(sessionId)
      }
    } catch (error) {
      this.logger.error?.('[Sessions] Failed to delete message from SQLite:', error)
    }

    // E4:老路径漏了这一步,列表里的 updatedAt 因此停在删除之前。
    if (applied.result.indexMetaChanged) {
      this.options.repository.updateSessionsIndexMeta(sessionId, meta =>
        applySessionUpdatedAtToMeta(meta, applied.session))
    }
    return true
  }

  deleteMessageAndTruncate(
    sessionId: string,
    messageId: string,
    /**
     * `subtractedUsage`(§16.25 钥匙③):这次截断要从会话总账扣回去的用量,由命令面
     * 从**折叠产物**算好递进来。不传则归约器按老算法自取(老调用点一字未动)。
     */
    options?: { subtractedUsage?: { inputTokens: number; outputTokens: number; totalTokens: number } },
  ): boolean {
    const applied = this.run(sessionId, {
      type: 'truncateFrom',
      messageId,
      inclusive: true,
      now: this.now(),
      ...(options?.subtractedUsage ? { subtractedUsage: options.subtractedUsage } : {}),
    })
    if (!applied) return false

    try {
      if (this.isSqliteSessionReady(sessionId)) {
        this.deleteSqliteMessageAndAfter(sessionId, messageId)
        this.syncSqliteSessionMetadata(applied.session)
        this.syncSqliteSessionUsage(applied.session)
      } else {
        this.scheduleSessionSqliteMigration(sessionId)
      }
    } catch (error) {
      this.logger.error?.('[Sessions] Failed to truncate messages in SQLite:', error)
    }

    this.options.repository.updateSessionsIndexMeta(sessionId, meta =>
      applySessionUpdatedAtToMeta(meta, applied.session))

    const session = this.options.repository.getSession(sessionId)
    if (session) this.logSubtractedMessageUsage(session, applied.result.meta!.subtractedUsage!)
    return true
  }

  updateMessageAndTruncate(
    sessionId: string,
    messageId: string,
    newContent: string,
    /**
     * `now`:调用方指定这次改写盖上去的时刻。**编辑重发是唯一一条由归约器合成
     * 消息字段的命令**(它给被改写的那条盖新 `timestamp`),而事件账本那一侧也要
     * 记同一个数 —— 让两边各读一次表就是让恒等门去比两个时钟。
     * 不传则本实现自取(老调用点一字未变)。
     */
    options?: {
      contentParts?: TMessage['contentParts'] | null
      now?: number
      /** §16.25 钥匙③:用量结算的那一份,见 `deleteMessageAndTruncate`。 */
      subtractedUsage?: { inputTokens: number; outputTokens: number; totalTokens: number }
    },
  ): boolean {
    const applied = this.run(sessionId, {
      type: 'truncateFrom',
      messageId,
      inclusive: false,
      newContent,
      hasContentParts: Boolean(options && Object.prototype.hasOwnProperty.call(options, 'contentParts')),
      contentParts: options?.contentParts as unknown[] | null | undefined,
      now: options?.now ?? this.now(),
      ...(options?.subtractedUsage ? { subtractedUsage: options.subtractedUsage } : {}),
    })
    if (!applied) return false

    const meta = applied.result.meta!
    try {
      if (this.isSqliteSessionReady(sessionId)) {
        this.upsertSqliteMessageAndTruncate(
          sessionId,
          meta.updatedMessage as unknown as TMessage,
          meta.index! + 1,
        )
        this.syncSqliteSessionMetadata(applied.session)
        this.syncSqliteSessionUsage(applied.session)
      } else {
        this.scheduleSessionSqliteMigration(sessionId)
      }
    } catch (error) {
      this.logger.error?.('[Sessions] Failed to update+truncate messages in SQLite:', error)
    }

    this.options.repository.updateSessionsIndexMeta(sessionId, m =>
      applySessionUpdatedAtToMeta(m, applied.session))

    const session = this.options.repository.getSession(sessionId)
    if (session) this.logSubtractedMessageUsage(session, meta.subtractedUsage!)
    return true
  }

  /*
   * **15 个热写端口 —— 已删除**(§17.7 #8a,2026-08-28)。
   *
   * `updateMessageContent` / `Reasoning` / `Streaming` / `Usage` / `ToolCalls` /
   * `ContentParts` / `addMessageContentPart` / `ThinkingTime` / `Skill` /
   * `Error` / `TurnContext` / `addMessageStep` / `updateMessageStep` /
   * `updateMessageSteps` / `updateStepsUsageByTurn`。
   *
   * F4-c c4-d(§16.27)把引擎侧那 15 个同名口整批空转之后,**这一层的实现零调用点**
   * ——引擎的写路早已不经过这里(它的事实产地全在事件流上:`assistant/chunks` 的
   * 逻辑 delta、`tool/call|annotate|result`、`request/response.usage`、
   * `skill/activated`、`run/end.error`、`context/turn-update`),而命令面从来没有
   * 调过它们。留着只会让人以为"往这里写还能影响 store"。
   *
   * **它们不是 §16.27 纪律 13 说的"端口签名冻结"的对象**:那条冻的是**引擎侧**
   * 那 15 个口(`backend/stores/sessions.ts`)的形状 —— 因为四条 A 类事实断言
   * (usage / skillUsed / errorDetails / turnContext)与 contentPart 守卫是挂在
   * **那里**的采样点。本层这 15 个方法上一条断言都没有,整口删除属于退役、不属于
   * 改形状,引擎侧签名一个字未动。
   *
   * 命令面还在用的 9 口(add / upsert / patchFields / delete×2 / truncate×2 /
   * replaceAll / repairOnLoad)照旧,私有的 `patchMessage` 也留任 —— 它是
   * `patchMessageFields` 的实现。
   */

  /**
   * `upsertMessage` 命令:按 id 存在就整条替换(后缀写),不存在就追加(与
   * `addMessage` 同路)。server 的"写一条已存在的消息"走这里,不再自己拼。
   */
  upsertMessage(sessionId: string, message: TMessage): boolean {
    const applied = this.run(sessionId, {
      type: 'upsertMessage',
      message: message as unknown as CoreSessionCommandMessage,
      now: this.now(),
    })
    if (!applied) return false
    this.syncMessageToSqliteIfReady(applied.session, message, this.commandMessageSeq(applied.result))
    if (applied.result.indexMetaChanged) {
      this.options.repository.updateSessionsIndexMeta(sessionId, meta =>
        applySessionMessageAppendToMeta(meta, applied.session, message))
    }
    return true
  }

  /** `patchMessage` 命令的公开入口(命令面用;老 mutator 走同一条私有路径)。 */
  patchMessageFields(
    sessionId: string,
    messageId: string,
    patch: Partial<TMessage>,
    hint?: 'stream' | 'settle',
  ): boolean {
    return this.patchMessage(sessionId, messageId, patch, hint)
  }

  /** `deleteMessage` 命令的"按内容找"形态(system marker 的删除口径)。 */
  deleteMessageWhere(sessionId: string, matchMarker: (message: TMessage) => boolean): boolean {
    return this.runDeleteMessage(sessionId, {
      type: 'deleteMessage',
      matchMarker: matchMarker as unknown as (message: CoreSessionCommandMessage) => boolean,
      now: this.now(),
    })
  }

  /**
   * `replaceAll` 命令:整份消息日志换掉(清空 / 归一化 / 协作侧整体替换)。
   * structural 写 —— 后缀写只会往后追,换整份不在它的语义里。
   * 留档/刷盘/索引计数由调用方(`sessionCommands.replaceAll`)负责。
   */
  replaceAllMessages(
    sessionId: string,
    messages: TMessage[],
    reason: 'clear' | 'replaced' | 'normalize',
  ): boolean {
    const applied = this.run(sessionId, {
      type: 'replaceAll',
      messages: messages as unknown as CoreSessionCommandMessage[],
      reason,
      now: this.now(),
    })
    return Boolean(applied)
  }

  /**
   * `repairOnLoad` 命令:冷加载/启动期的收尾修复(中断的 step/toolCall、卡死的
   * compact 消息、isStreaming、summary 元数据)。返回是否有改动。
   */
  repairOnLoad(sessionId: string, policy: 'startup' | 'loaded' = 'startup'): boolean {
    return Boolean(this.run(sessionId, { type: 'repairOnLoad', policy, now: this.now() }))
  }

  private patchMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<TMessage>,
    hint: 'stream' | 'settle' = 'settle',
  ): boolean {
    const applied = this.run(sessionId, {
      type: 'patchMessage',
      messageId,
      patch: patch as unknown as Partial<CoreSessionCommandMessage>,
      hint,
    })
    if (!applied) return false
    this.syncMessageToSqliteIfReady(applied.session, this.commandMessage(applied.result), this.commandMessageSeq(applied.result))
    return true
  }

  private syncSessionToSqliteIfReady(session: TSession): void {
    this.options.repository.syncSessionToSqliteIfReady?.(session)
  }

  private syncMessageToSqliteIfReady(session: TSession, message: TMessage, seq: number): void {
    try {
      if (seq <= 0) return

      const syncKey = `${session.id}:${message.id}`
      const pendingTimer = this.pendingSqliteMessageSyncs.get(syncKey)
      if (message.isStreaming) {
        if (!pendingTimer) {
          this.pendingSqliteMessageSyncs.set(syncKey, setTimeout(() => {
            this.pendingSqliteMessageSyncs.delete(syncKey)
            const latestSession = this.options.repository.getCachedSession?.(session.id)
            // 消息从仓库层的取数原语拿(P0.4:不再自己持有 session.messages)
            const latestMessages = this.options.repository.getCachedSessionMessages?.(session.id)
            const latestIndex = latestMessages?.findIndex(item => item.id === message.id) ?? -1
            if (latestSession && latestMessages && latestIndex >= 0) {
              this.syncMessageToSqliteIfReady(latestSession, latestMessages[latestIndex]!, latestIndex + 1)
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
