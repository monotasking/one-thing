import {
  applyDefaultAgentIdToSessionMetas,
  applyInheritedSessionWorkingDirectory,
  applySessionAgent,
  applySessionArchiveState,
  applySessionContextSize,
  applySessionIndexMetaMutationWithAdapters,
  applySessionMetadataMutationWithAdapters,
  applySessionModel,
  applySessionName,
  applySessionPermissionMode,
  applySessionPin,
  applySessionPromptContext,
  applySessionSideEffectMutationWithAdapters,
  applySessionSummary,
  applySessionTokenUsage,
  applySessionUpdatedAtToMeta,
  applySessionVariables,
  applySessionWorkingDirectory,
  applySessionWorkingDirectoryRoots,
  createBranchSessionWithAdapters,
  createSessionWithAdapters,
  deleteSessionWithAdapters,
  loadSessionWithAdapters,
  normalizeWorkingDirectoryRoots,
  resolveSessionDetailsSnapshot,
  resolveSessionMessagesPage,
  resolveSessionUserMessageMarkers,
  sanitizeSessionOnStartup,
  syncSessionSideEffectWithReadyAdapters,
  type CoreSession,
  type CoreSessionDetails,
  type CoreSessionLastTurnUsage,
  type CoreSessionMessageWithModelInfo,
  type CoreSessionMessageWithUsage,
  type CoreSessionMeta,
  type CoreSessionTokenUsage,
  type CoreTimelineSession,
  type CoreContextVariableInput,
  type GetSessionMessagesPageRequest,
  type GetSessionMessagesPageResponse,
  type NormalizeWorkingDirectoryRootsOptions,
  type StoredChatMessage,
  type UserMessageMarker,
} from '@onething/core/session'
import { getMessagesPageFromJsonFilePath } from '@onething/core/session'
import { AsyncSaveQueue, LRUCache, withFileLockSync } from '@onething/core/storage'
import { dehydrateSessionForStorage, rehydrateSessionFromStorage } from './session-dehydrate.js'
import { STRUCTURAL_WRITE_PLAN, type SessionStorageDriver, type SessionWritePlan } from './storage-driver.js'

export interface OnethingSessionRepositoryLogger {
  log?(...args: unknown[]): void
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

export interface OnethingSessionRepositorySqliteAdapters<
  TSession,
  TMeta,
  TDetails,
  TMarker,
> {
  importSessionIndex?(index: TMeta[]): void
  getSessionDetails?(sessionId: string): TDetails | undefined
  getMessagesPage?(request: GetSessionMessagesPageRequest): GetSessionMessagesPageResponse | undefined
  getUserMessageMarkers?(sessionId: string): TMarker[] | undefined
  isSessionReady?(sessionId: string): boolean
  scheduleMigration?(sessionId: string): void
  syncFullSession?(session: TSession): void
  syncSession?(session: TSession): void
  syncSessionMetadata?(session: TSession): void
  syncSessionUsage?(session: TSession): void
  syncSessionVariables?(session: TSession): void
  deleteSessions?(sessionIds: string[]): void
}

export interface OnethingSessionRepositoryOptions<
  TSession extends CoreSession<TMessage> & {
    id: string
    parentSessionId?: string
    workingDirectory?: string
    workingDirectoryRoots?: string[]
  },
  TMessage extends StoredChatMessage & CoreSessionMessageWithUsage & CoreSessionMessageWithModelInfo,
  TMeta extends CoreSessionMeta & { parentSessionId?: string },
  TDetails extends CoreSessionDetails,
  TMarker extends UserMessageMarker,
> {
  cacheSize?: number
  saveThrottleMs?: number
  /** 流式 token 级更新的兜底落盘间隔;边界事件仍走 saveThrottleMs。 */
  lazySaveThrottleMs?: number
  defaultAgentId: string
  getSessionsDir(): string
  getSessionPath(sessionId: string): string
  readJsonFile<TValue>(filePath: string, fallback: TValue): TValue
  writeJsonFile(filePath: string, data: unknown): void
  writeJsonFileAsync(filePath: string, data: unknown): Promise<void>
  deleteJsonFile(filePath: string): void
  getCurrentSessionId(): string | undefined
  setCurrentSessionId(sessionId: string): void
  getDefaultWorkingDirectory?(): string | undefined
  expandPath?(path: string): string
  cancelPendingSideEffects?(sessionId: string): void
  /** 格式感知的存储驱动(legacy/jsonl 混合路由);缺省时退回整文件 JSON 直写 */
  storageDriver?: SessionStorageDriver<TSession>
  sqlite?: OnethingSessionRepositorySqliteAdapters<TSession, TMeta, TDetails, TMarker>
  logger?: OnethingSessionRepositoryLogger
}

export interface OnethingSessionCacheStats {
  size: number
  maxSize: number
  cachedSessionIds: string[]
}

export interface OnethingDeleteSessionResult {
  deletedIds: string[]
  parentSessionId?: string
}

export class OnethingSessionRepository<
  TSession extends CoreSession<TMessage> & {
    id: string
    parentSessionId?: string
    workingDirectory?: string
    workingDirectoryRoots?: string[]
  },
  TMessage extends StoredChatMessage & CoreSessionMessageWithUsage & CoreSessionMessageWithModelInfo,
  TMeta extends CoreSessionMeta & { parentSessionId?: string },
  TDetails extends CoreSessionDetails,
  TMarker extends UserMessageMarker = UserMessageMarker,
> {
  private readonly sessionCache: LRUCache<string, TSession>
  private readonly sessionSaveQueue: AsyncSaveQueue<TSession>
  /**
   * 有未落盘写入的会话的强引用快照,防止 LRU 淘汰后 getLatest 落空导致静默丢写。
   * 写入成功、重试耗尽或删除/取消时释放,保证不随触碰过的会话数无界增长。
   */
  private readonly pendingSessionValues = new Map<string, TSession>()
  /** 队列挂起期间累计的写入计划;落盘时取走,由驱动决定 meta/后缀/全量 */
  private readonly pendingWritePlans = new Map<string, SessionWritePlan>()
  /** 已删除但文件清理仍在排队的会话:读路径的同步屏障,防止从盘上复活 */
  private readonly deletionTombstones = new Set<string>()

  constructor(private readonly options: OnethingSessionRepositoryOptions<TSession, TMessage, TMeta, TDetails, TMarker>) {
    this.sessionCache = new LRUCache<string, TSession>(options.cacheSize ?? 10)
    this.sessionSaveQueue = new AsyncSaveQueue<TSession>({
      throttleMs: options.saveThrottleMs ?? 300,
      // 优先取缓存中的活对象;被 LRU 淘汰后回退到挂起快照,杜绝落空跳过。
      getLatest: sessionId => this.sessionCache.get(sessionId) ?? this.pendingSessionValues.get(sessionId),
      write: async (sessionId, session) => {
        const plan = this.takePendingWritePlan(sessionId)
        const stored = dehydrateSessionForStorage(session)
        if (this.options.storageDriver) {
          await this.options.storageDriver.write(sessionId, stored, plan)
        } else {
          await this.options.writeJsonFileAsync(this.options.getSessionPath(sessionId), stored)
        }
        // 写成功后释放快照;若期间有更新的 saveSessionToFile 换了引用则保留,交由其后续写入清理。
        if (this.pendingSessionValues.get(sessionId) === session) {
          this.pendingSessionValues.delete(sessionId)
        }
      },
      onError: (sessionId, error) => this.options.logger?.error?.(`[Sessions] async save failed for ${sessionId}:`, error),
      // 重试耗尽:释放快照避免无界增长(数据在此确实丢失,但已通过 onError 记录)。
      onRetryExhausted: sessionId => this.pendingSessionValues.delete(sessionId),
    })
  }

  async flushSessionSave(sessionId: string): Promise<void> {
    await this.sessionSaveQueue.flush(sessionId)
  }

  async flushAllPendingSaves(): Promise<void> {
    await this.sessionSaveQueue.flushAll()
  }

  cancelPendingSave(sessionId: string): void {
    this.sessionSaveQueue.cancel(sessionId)
    this.pendingWritePlans.delete(sessionId)
    this.pendingSessionValues.delete(sessionId)
    this.options.cancelPendingSideEffects?.(sessionId)
  }

  saveSessionToFile(
    sessionId: string,
    session: TSession,
    options?: { lazy?: boolean; plan?: SessionWritePlan },
  ): void {
    this.sessionCache.set(sessionId, session)
    // 保留强引用,直至该写入成功落盘(见 getLatest / write 回调),防止淘汰后丢写。
    this.pendingSessionValues.set(sessionId, session)
    this.mergePendingWritePlan(sessionId, options?.plan ?? STRUCTURAL_WRITE_PLAN)
    this.sessionSaveQueue.schedule(
      sessionId,
      options?.lazy ? (this.options.lazySaveThrottleMs ?? 5000) : undefined,
    )
  }

  private mergePendingWritePlan(sessionId: string, plan: SessionWritePlan): void {
    const existing = this.pendingWritePlans.get(sessionId)
    if (!existing) {
      this.pendingWritePlans.set(sessionId, { ...plan })
      return
    }
    if (existing.kind === 'structural' || plan.kind === 'structural') {
      this.pendingWritePlans.set(sessionId, { kind: 'structural' })
      return
    }
    if (existing.kind === 'message' || plan.kind === 'message') {
      const seqs = [existing, plan]
        .filter(p => p.kind === 'message')
        .map(p => p.dirtySeq)
      // message 计划必须带 dirtySeq;缺失按 structural 兜底
      if (seqs.some(seq => typeof seq !== 'number')) {
        this.pendingWritePlans.set(sessionId, { kind: 'structural' })
        return
      }
      this.pendingWritePlans.set(sessionId, {
        kind: 'message',
        dirtySeq: Math.min(...(seqs as number[])),
      })
      return
    }
    // 两边都是 meta,保持
  }

  private takePendingWritePlan(sessionId: string): SessionWritePlan {
    const plan = this.pendingWritePlans.get(sessionId) ?? { kind: 'structural' as const }
    this.pendingWritePlans.delete(sessionId)
    return plan
  }

  private loadStoredSession(sessionId: string): TSession | undefined {
    if (this.deletionTombstones.has(sessionId)) return undefined
    const stored = this.options.storageDriver
      ? this.options.storageDriver.load(sessionId)
      : this.options.readJsonFile<TSession | null>(this.options.getSessionPath(sessionId), null) ?? undefined
    return stored ? rehydrateSessionFromStorage(stored) : undefined
  }

  invalidateSessionCache(sessionId: string): void {
    this.sessionCache.delete(sessionId)
  }

  clearAllSessionCache(): void {
    this.sessionCache.clear()
  }

  getCachedSession(sessionId: string): TSession | undefined {
    return this.sessionCache.get(sessionId)
  }

  /**
   * 缓存里那份会话的消息(不触发加载)。P0.4:`session-message-runtime` 的
   * sqlite 流式补同步原来自己 `latestSession.messages.find(...)`,那是命令面之外
   * 的一次会话读;取数原语归位到仓库层(白名单)。
   */
  getCachedSessionMessages(sessionId: string): TMessage[] | undefined {
    return this.sessionCache.get(sessionId)?.messages
  }

  deleteCachedSession(sessionId: string): void {
    this.sessionCache.delete(sessionId)
  }

  getSessionCacheStats(): OnethingSessionCacheStats {
    const stats = this.sessionCache.getStats()
    return {
      size: stats.size,
      maxSize: stats.maxSize,
      cachedSessionIds: stats.keys,
    }
  }

  loadSessionsIndex(): TMeta[] {
    return this.options.readJsonFile<TMeta[]>(this.getSessionsIndexPath(), [])
  }

  saveSessionsIndex(index: TMeta[]): void {
    this.runWithSessionsIndexLock(() => {
      this.options.writeJsonFile(this.getSessionsIndexPath(), index)
    })
  }

  updateSessionsIndexMeta(sessionId: string, update: (meta: TMeta) => void): boolean {
    // 锁内重新读盘 + 改 + 写,避免与另一进程交错造成 last-writer-wins 丢条目。
    return this.runWithSessionsIndexLock(() => Boolean(applySessionIndexMetaMutationWithAdapters<TMeta>({
      sessionId,
      loadIndex: () => this.loadSessionsIndex(),
      saveIndex: index => this.saveSessionsIndex(index),
      mutateMeta: update,
    })))
  }

  renameSession(sessionId: string, newName: string): boolean {
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => applySessionName(session, newName),
      mutateMeta: meta => applySessionName(meta, newName),
    })
  }

  updateSessionPin(sessionId: string, isPinned: boolean): boolean {
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => applySessionPin(session, isPinned),
      mutateMeta: meta => applySessionPin(meta, isPinned),
    })
  }

  updateSessionArchived(sessionId: string, isArchived: boolean, archivedAt?: number | null): boolean {
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => applySessionArchiveState(session, isArchived, archivedAt),
      mutateMeta: meta => applySessionArchiveState(meta, isArchived, archivedAt),
    })
  }

  updateSessionPermissionMode(sessionId: string, permissionMode: string | undefined): boolean {
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => applySessionPermissionMode(
        session as TSession & { permissionMode?: string },
        permissionMode,
      ),
      mutateMeta: meta => applySessionPermissionMode(meta, permissionMode),
    })
  }

  updateSessionWorkingDirectory(sessionId: string, workingDirectory: string | null): boolean {
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => applySessionWorkingDirectory(session, workingDirectory, this.pathOptions()),
    })
  }

  updateSessionWorkingDirectoryRoots(sessionId: string, roots: string[]): boolean {
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => applySessionWorkingDirectoryRoots(session, roots, this.pathOptions()),
    })
  }

  inheritSessionWorkingDirectory(sessionId: string, workingDirectory: string): boolean {
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => applyInheritedSessionWorkingDirectory(session, workingDirectory, this.pathOptions()),
    })
  }

  updateSessionVariables<TVariable extends CoreContextVariableInput>(sessionId: string, variables: TVariable[]): boolean {
    return this.applySideEffectMutation(sessionId, {
      mutateSession: session => applySessionVariables(
        session as TSession & { variables?: CoreContextVariableInput[] },
        variables,
      ),
      syncSession: session => this.syncSessionVariablesToSqliteIfReady(session),
    })
  }

  /** Session goal is opaque to the repository; the goals module owns its shape. */
  updateSessionGoal<TGoal>(sessionId: string, goal: TGoal | null): boolean {
    return this.applySideEffectMutation(sessionId, {
      mutateSession: session => {
        const target = session as TSession & { goal?: TGoal }
        if (goal === null) {
          delete target.goal
        } else {
          target.goal = goal
        }
      },
      syncSession: () => {},
    })
  }

  /**
   * Writes the goal history plus the derived current goal in one mutation.
   *
   * `goal` (the v2 scalar) is written alongside `goals` for the transition
   * window: an older build reads only the scalar and keeps working, and the
   * read-time reconciliation in the goals module repairs whatever it wrote on
   * the way back. Both fields must move together — writing them in two passes
   * would leave a window where a crash strands them out of sync.
   */
  updateSessionGoals<TGoal>(sessionId: string, goals: TGoal[], current: TGoal | null): boolean {
    return this.applySideEffectMutation(sessionId, {
      mutateSession: session => {
        const target = session as TSession & { goal?: TGoal; goals?: TGoal[] }
        if (goals.length === 0) {
          delete target.goals
        } else {
          target.goals = goals
        }
        if (current === null) {
          delete target.goal
        } else {
          target.goal = current
        }
      },
      syncSession: () => {},
    })
  }

  updateSessionTokenUsage(
    sessionId: string,
    usage: CoreSessionTokenUsage,
    lastTurnUsage?: CoreSessionLastTurnUsage,
  ): boolean {
    return this.applySideEffectMutation(sessionId, {
      mutateSession: session => applySessionTokenUsage(session, usage, lastTurnUsage),
      syncSession: session => this.syncSessionUsageToSqliteIfReady(session, '[Sessions] Failed to sync usage to SQLite:'),
    })
  }

  updateSessionContextSize(sessionId: string, contextSize: number): boolean {
    return this.applySideEffectMutation(sessionId, {
      mutateSession: session => applySessionContextSize(session, contextSize),
      syncSession: session => this.syncSessionUsageToSqliteIfReady(session, '[Sessions] Failed to sync context size to SQLite:'),
    })
  }

  updateSessionPromptContext<TPromptContext>(sessionId: string, promptContext: TPromptContext | null): boolean {
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => applySessionPromptContext(session, promptContext),
    })
  }

  updateSessionSummary(sessionId: string, summary: string, summaryUpToMessageId: string): boolean {
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => applySessionSummary(session, summary, summaryUpToMessageId),
      mutateMeta: (meta, session) => applySessionUpdatedAtToMeta(meta, session),
    })
  }

  /**
   * `pinned` defaults to true: this method exists for the model picker, i.e.
   * a user decision. Machine-driven stamps (the collab worker applying an
   * agent's own binding) pass false so the pin keeps meaning "the user chose".
   */
  updateSessionModel(
    sessionId: string,
    provider: string,
    model: string,
    options: { pinned?: boolean } = {},
  ): boolean {
    const pinned = options.pinned ?? true
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => applySessionModel(session, provider, model, { pinned }),
      mutateMeta: meta => applySessionModel(meta, provider, model, { pinned }),
    })
  }

  updateSessionAgent(sessionId: string, agentId: string): boolean {
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => applySessionAgent(session, agentId, this.options.defaultAgentId),
      mutateMeta: meta => applySessionAgent(meta, agentId, this.options.defaultAgentId),
    })
  }

  /**
   * Collab (multi-agent room) fields — docs/design/multi-agent-collab.md.
   * kind/room/collab are opaque to the repository; the collab module owns their
   * shapes. `undefined` leaves a field untouched, `null` deletes it.
   */
  updateSessionCollab(
    sessionId: string,
    fields: { kind?: string | null; room?: unknown | null; collab?: unknown | null },
  ): boolean {
    const mutate = (target: { kind?: string; room?: unknown; collab?: unknown }) => {
      if (fields.kind !== undefined) {
        if (fields.kind === null) delete target.kind
        else target.kind = fields.kind
      }
      if (fields.room !== undefined) {
        if (fields.room === null) delete target.room
        else target.room = fields.room
      }
      if (fields.collab !== undefined) {
        if (fields.collab === null) delete target.collab
        else target.collab = fields.collab
      }
    }
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => mutate(session as TSession & { kind?: string; room?: unknown; collab?: unknown }),
      mutateMeta: meta => mutate(meta as TMeta & { kind?: string; room?: unknown; collab?: unknown }),
    })
  }

  /**
   * 派工戳(`docs/audit/self-hosting-gap-audit-2026-08-11.md` P0-3)。与 collab
   * 那三个字段同一条纪律:形状对仓库层是不透明的,写会话与写元数据一起做 ——
   * 只写会话文件的话,列表与 details 会说这条会话不是派工来的,而工具面正是
   * 按它决定看不看得见 `task`。`null` 删除。
   */
  updateSessionTask(sessionId: string, task: unknown | null): boolean {
    const mutate = (target: { task?: unknown }) => {
      if (task === null) delete target.task
      else target.task = task
    }
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => mutate(session as TSession & { task?: unknown }),
      mutateMeta: meta => mutate(meta as TMeta & { task?: unknown }),
    })
  }

  getSessions(): TSession[] {
    const sessions: TSession[] = []
    for (const meta of this.loadSessionsIndex()) {
      const session = this.getSession(meta.id)
      if (session) sessions.push(session)
    }
    return sessions
  }

  getSessionsList(): TMeta[] {
    return applyDefaultAgentIdToSessionMetas(this.loadSessionsIndex(), this.options.defaultAgentId) as TMeta[]
  }

  initializeSessionRepositoryIndex(): void {
    this.options.sqlite?.importSessionIndex?.(this.loadSessionsIndex())
  }

  getSessionDetails(sessionId: string): TDetails | undefined {
    const meta = this.loadSessionsIndex().find(session => session.id === sessionId)
    const sqliteDetails = this.getSqliteSessionDetailsSafe(sessionId)
    return resolveSessionDetailsSnapshot({
      meta,
      sqliteDetails,
      getSession: () => this.getSession(sessionId),
      defaultAgentId: this.options.defaultAgentId,
    }) as TDetails | undefined
  }

  getSessionMessages(sessionId: string): TMessage[] | undefined {
    return this.getSession(sessionId)?.messages
  }

  getSessionMessagesPage(request: GetSessionMessagesPageRequest): GetSessionMessagesPageResponse {
    const start = performance.now()
    const result = resolveSessionMessagesPage({
      request,
      getJsonlLogPage: () => {
        const page = this.options.storageDriver?.getMessagesPage(request)
        if (page?.messages) rehydrateSessionFromStorage({ messages: page.messages })
        return page as GetSessionMessagesPageResponse<TMessage & StoredChatMessage> | undefined
      },
      getSqlitePage: () => this.options.sqlite?.getMessagesPage?.(request),
      getJsonByteScanPage: () => {
        const page = getMessagesPageFromJsonFilePath(
          request,
          this.options.getSessionPath(request.sessionId),
        )
        // Byte-scan pages come straight from the dehydrated file; restore
        // the in-memory shape (step.toolCall links, final partialResult).
        if (page?.messages) rehydrateSessionFromStorage({ messages: page.messages })
        return page ?? undefined
      },
      getSessionMessages: () => this.getSession(request.sessionId)?.messages,
    })

    if (result.shouldScheduleMigration) {
      this.options.sqlite?.scheduleMigration?.(request.sessionId)
    }

    this.options.logger?.info?.('[Perf][SessionPage][runtime]', {
      sessionId: request.sessionId,
      source: result.source,
      totalMs: Math.round(performance.now() - start),
      messages: result.response.messages?.length ?? 0,
      success: result.response.success,
    })

    return result.response
  }

  getSessionUserMessageMarkers(sessionId: string): TMarker[] | undefined {
    const result = resolveSessionUserMessageMarkers({
      getJsonlLogMarkers: () => this.options.storageDriver?.getUserMessageMarkers(sessionId),
      getSqliteMarkers: () => this.options.sqlite?.getUserMessageMarkers?.(sessionId),
      getSessionMessages: () => this.getSession(sessionId)?.messages,
    })
    if (result.shouldScheduleMigration) {
      this.options.sqlite?.scheduleMigration?.(sessionId)
    }
    return result.markers as TMarker[] | undefined
  }

  getSessionRaw(sessionId: string): TSession | undefined {
    return this.loadStoredSession(sessionId)
  }

  getSession(sessionId: string): TSession | undefined {
    return loadSessionWithAdapters<TSession>({
      sessionId,
      cache: this.sessionCache,
      loadSession: id => this.loadStoredSession(id),
      saveSession: (id, session) => this.saveSessionToFile(id, session),
      syncSession: session => this.syncSessionToSqliteIfReady(session),
      // 启动不再全量扫描;冷加载时做完整修复(含中断的 step/toolCall),替代原 sanitizeAllSessionsOnStartup。
      sanitizeSession: session => sanitizeSessionOnStartup(session),
      expandPath: this.options.expandPath,
    }).session
  }

  createSession(sessionId: string, name: string, options: { workspaceId?: string } = {}): TSession {
    const workingDirectory = this.resolveDefaultWorkingDirectory()

    return this.runWithSessionsIndexLock(() => createSessionWithAdapters<TSession, TMessage, TMeta>({
      sessionId,
      name,
      defaultAgentId: this.options.defaultAgentId,
      workingDirectory,
      workspaceId: options.workspaceId,
      saveSession: (id, session) => this.saveSessionToFile(id, session),
      syncSession: session => this.syncSessionToSqliteIfReady(session),
      syncFullSession: session => this.options.sqlite?.syncFullSession?.(session),
      loadIndex: () => this.loadSessionsIndex(),
      saveIndex: index => this.saveSessionsIndex(index),
      setCurrentSessionId: sessionId => this.options.setCurrentSessionId(sessionId),
    }))
  }

  createBranchSession(
    sessionId: string,
    name: string,
    parentSessionId: string,
    branchFromMessageId: string,
    inheritedMessages: TMessage[],
  ): TSession {
    const parentSession = this.getSession(parentSessionId)
    const workingDirectory = parentSession?.workingDirectory ?? this.resolveDefaultWorkingDirectory()

    return this.runWithSessionsIndexLock(() => createBranchSessionWithAdapters<TSession, TMessage, TMeta>({
      sessionId,
      name,
      parentSessionId,
      parentSession,
      branchFromMessageId,
      inheritedMessages,
      defaultAgentId: this.options.defaultAgentId,
      workingDirectory,
      workingDirectoryRoots: normalizeWorkingDirectoryRoots(parentSession?.workingDirectoryRoots, {
        active: workingDirectory,
        expandPath: this.options.expandPath,
      }),
      saveSession: (id, session) => this.saveSessionToFile(id, session),
      syncSession: session => this.syncSessionToSqliteIfReady(session),
      syncFullSession: session => this.options.sqlite?.syncFullSession?.(session),
      loadIndex: () => this.loadSessionsIndex(),
      saveIndex: index => this.saveSessionsIndex(index),
      setCurrentSessionId: sessionId => this.options.setCurrentSessionId(sessionId),
    }))
  }

  deleteSession(sessionId: string): OnethingDeleteSessionResult {
    return this.runWithSessionsIndexLock(() => deleteSessionWithAdapters<TSession, TMeta>({
      sessionId,
      getSession: id => this.getSession(id),
      getCurrentSessionId: () => this.options.getCurrentSessionId(),
      loadIndex: () => this.loadSessionsIndex(),
      saveIndex: index => this.saveSessionsIndex(index),
      cancelPendingSave: id => this.cancelPendingSave(id),
      // 文件删除排在该会话在途异步写之后执行(与写入互斥),
      // 否则 rm 目录会与正在落盘的 meta/log 写入竞态(ENOTEMPTY);
      // tombstone 保证清理完成前读路径不会把会话从盘上复活。
      deleteSessionFile: id => {
        this.deletionTombstones.add(id)
        void this.sessionSaveQueue.runExclusive(id, () => {
          if (this.options.storageDriver) {
            this.options.storageDriver.delete(id)
            return
          }
          this.options.deleteJsonFile(this.options.getSessionPath(id))
        }).catch(error => {
          this.options.logger?.error?.(`[Sessions] failed to delete session files for ${id}:`, error)
        }).finally(() => {
          this.deletionTombstones.delete(id)
        })
      },
      deleteSessionCache: id => this.deleteCachedSession(id),
      deleteSessionsFromSqlite: ids => this.options.sqlite?.deleteSessions?.(ids),
      setCurrentSessionId: sessionId => this.options.setCurrentSessionId(sessionId),
    }))
  }

  syncSessionToSqliteIfReady(session: TSession): void {
    syncSessionSideEffectWithReadyAdapters({
      sessionId: session.id,
      session,
      isReady: sessionId => this.options.sqlite?.isSessionReady?.(sessionId) ?? false,
      scheduleMigration: sessionId => this.options.sqlite?.scheduleMigration?.(sessionId),
      syncReady: target => this.options.sqlite?.syncFullSession?.(target),
      logger: this.options.logger,
      errorMessage: '[Sessions] Failed to sync session to SQLite:',
    })
  }

  /**
   * 会话级字段的通用补丁口(P0.4)—— `saveSessionSnapshot` 后门的替代品。
   *
   * 关键差别是**写计划**:老后门走 `saveSessionToFile(id, session)`,默认
   * `structural` = 把整份 messages.jsonl 重写一遍;而 jsonl 布局里所有会话级字段
   * 都住在 `meta.json`(驱动的 `buildMeta` 就是"除 messages 之外的全部"),
   * 改名字/置顶/归档/变量根本不该动消息日志。所以这里一律 `{kind:'meta'}`。
   *
   * `patch` 里出现 `messages` 会被丢掉:消息只能走命令面。
   */
  patchSession(
    sessionId: string,
    patch: Partial<TSession>,
    mutateMeta?: (meta: TMeta, session: TSession) => void,
  ): boolean {
    const { messages: _messages, ...fields } = patch as Partial<TSession> & { messages?: unknown }
    return this.applyMetadataMutation(sessionId, {
      mutateSession: session => Object.assign(session, fields),
      ...(mutateMeta ? { mutateMeta } : {}),
    })
  }

  private applyMetadataMutation(
    sessionId: string,
    options: {
      mutateSession(session: TSession): void
      mutateMeta?(meta: TMeta, session: TSession): void
    },
  ): boolean {
    return applySessionMetadataMutationWithAdapters<TSession, TMeta>({
      sessionId,
      getSession: id => this.getSession(id),
      mutateSession: options.mutateSession,
      // 只动会话级字段,不碰消息日志
      saveSession: (id, session) => this.saveSessionToFile(id, session, { plan: { kind: 'meta' } }),
      syncSessionMetadata: session => this.syncSessionMetadataToSqliteIfReady(session),
      updateIndexMeta: options.mutateMeta
        ? (id, mutate) => this.updateSessionsIndexMeta(id, mutate)
        : undefined,
      mutateMeta: options.mutateMeta,
    }).applied
  }

  private applySideEffectMutation(
    sessionId: string,
    options: {
      mutateSession(session: TSession): void
      syncSession(session: TSession): void
    },
  ): boolean {
    return applySessionSideEffectMutationWithAdapters<TSession>({
      sessionId,
      getSession: id => this.getSession(id),
      mutateSession: options.mutateSession,
      // usage/contextSize/variables 都是会话级字段
      saveSession: (id, session) => this.saveSessionToFile(id, session, { plan: { kind: 'meta' } }),
      syncSession: options.syncSession,
    }).applied
  }

  private syncSessionMetadataToSqliteIfReady(session: TSession): void {
    this.syncSessionSideEffectToSqliteIfReady(
      session,
      target => {
        const syncMetadata = this.options.sqlite?.syncSessionMetadata
          ?? this.options.sqlite?.syncSession
          ?? this.options.sqlite?.syncFullSession
        syncMetadata?.(target)
      },
      '[Sessions] Failed to sync session metadata to SQLite:',
    )
  }

  private syncSessionUsageToSqliteIfReady(session: TSession, errorMessage: string): void {
    this.syncSessionSideEffectToSqliteIfReady(
      session,
      target => {
        const syncUsage = this.options.sqlite?.syncSessionUsage
          ?? this.options.sqlite?.syncSession
          ?? this.options.sqlite?.syncFullSession
        syncUsage?.(target)
      },
      errorMessage,
    )
  }

  private syncSessionVariablesToSqliteIfReady(session: TSession): void {
    this.syncSessionSideEffectToSqliteIfReady(
      session,
      target => {
        const syncVariables = this.options.sqlite?.syncSessionVariables
          ?? this.options.sqlite?.syncSession
          ?? this.options.sqlite?.syncFullSession
        syncVariables?.(target)
      },
      '[Sessions] Failed to sync variables to SQLite:',
    )
  }

  private syncSessionSideEffectToSqliteIfReady(
    session: TSession,
    syncReady: (session: TSession) => void,
    errorMessage: string,
  ): void {
    syncSessionSideEffectWithReadyAdapters({
      sessionId: session.id,
      session,
      isReady: sessionId => this.options.sqlite?.isSessionReady?.(sessionId) ?? false,
      scheduleMigration: sessionId => this.options.sqlite?.scheduleMigration?.(sessionId),
      syncReady,
      logger: this.options.logger,
      errorMessage,
    })
  }

  private pathOptions(): NormalizeWorkingDirectoryRootsOptions {
    return {
      expandPath: this.options.expandPath,
    }
  }

  private getSessionsIndexPath(): string {
    return `${this.options.getSessionsDir()}/index.json`
  }

  private getSessionsIndexLockPath(): string {
    return `${this.getSessionsIndexPath()}.lock`
  }

  /**
   * 在跨进程文件锁下执行 index 读-改-写,保证 Electron 主进程与 headless server
   * 并发变更 index.json 时不丢会话条目。可重入,供本类各变更方法及外部 backfill 复用。
   */
  runWithSessionsIndexLock<T>(fn: () => T): T {
    return withFileLockSync(this.getSessionsIndexLockPath(), fn, {
      owner: 'session-index',
      logger: this.options.logger,
    })
  }

  private getSqliteSessionDetailsSafe(sessionId: string): TDetails | undefined {
    try {
      return this.options.sqlite?.getSessionDetails?.(sessionId)
    } catch (error) {
      this.options.logger?.error?.('[Sessions] Failed to load SQLite session details:', error)
      return undefined
    }
  }

  private resolveDefaultWorkingDirectory(): string | undefined {
    const defaultDir = this.options.getDefaultWorkingDirectory?.()
    return defaultDir && this.options.expandPath ? this.options.expandPath(defaultDir) : defaultDir
  }
}

export function createOnethingSessionRepository<
  TSession extends CoreSession<TMessage> & {
    id: string
    parentSessionId?: string
    workingDirectory?: string
    workingDirectoryRoots?: string[]
  },
  TMessage extends StoredChatMessage & CoreSessionMessageWithUsage & CoreSessionMessageWithModelInfo,
  TMeta extends CoreSessionMeta & { parentSessionId?: string },
  TDetails extends CoreSessionDetails,
  TMarker extends UserMessageMarker = UserMessageMarker,
>(
  options: OnethingSessionRepositoryOptions<TSession, TMessage, TMeta, TDetails, TMarker>,
): OnethingSessionRepository<TSession, TMessage, TMeta, TDetails, TMarker> {
  return new OnethingSessionRepository(options)
}
