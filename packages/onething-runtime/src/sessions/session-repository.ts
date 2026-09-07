import {
  applyDefaultAgentIdToSessionMetas,
  applyInheritedSessionWorkingDirectory,
  applySessionAgent,
  applySessionArchiveState,
  applySessionContextSize,
  applySessionIndexMetaMutationWithAdapters,
  type ApplySessionIndexMetaMutationWithAdaptersOptions,
  type CreateSessionWithAdaptersOptions,
  type CreateBranchSessionWithAdaptersOptions,
  type DeleteSessionWithAdaptersOptions,
  applySessionMetadataMutationWithAdapters,
  applySessionModel,
  applySessionName,
  applySessionPermissionMode,
  applySessionPin,
  applySessionPromptContext,
  applySessionSideEffectMutationWithAdapters,
  applySessionSummary,
  applySessionTokenUsage,
  landSessionAccountUsage,
  applySessionUpdatedAtToMeta,
  applySessionVariables,
  applySessionWorkingDirectory,
  applySessionWorkingDirectoryRoots,
  createBranchSessionWithAdapters,
  createSessionWithAdapters,
  deleteSessionWithAdapters,
  planSessionCascadeDelete,
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
  type UserMessageMarker, type ApplySessionMetadataMutationWithAdaptersOptions, type ApplySessionSideEffectMutationWithAdaptersOptions, type SyncSessionSideEffectWithReadyAdaptersOptions, type LoadSessionWithAdaptersOptions,
} from '@onething/core/session'
// §17.8 U1-a:走**叶子路径** —— 按路径读盘的那一口带 `node:fs`,把它留在
// `@onething/core/session` 那个桶上,整条桶就在浏览器里 import 不动。
import { getMessagesPageFromJsonFilePath } from '@onething/core/session/storage/json-message-page-file'
import { AsyncSaveQueue, LRUCache, withFileLockSync, type AsyncSaveQueueOptions } from '@onething/core/storage'
import { dehydrateSessionForStorage, rehydrateSessionFromStorage } from './session-dehydrate.js'
import { STRUCTURAL_WRITE_PLAN, type SessionStorageDriver, type SessionWritePlan } from './storage-driver.js'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { writeDurableJson } from '../storage/durable-json.js'
import type { ResolveSessionMessagesPageOptions, ResolveSessionUserMessageMarkersOptions } from '@onething/core/session/storage'

export interface OnethingSessionRepositoryLogger {
  log?(...args: unknown[]): void
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

/** Trusted creator identity; workspaceId is the tenant, not a product workspace. */
export interface SessionInitialOwner { userId: string; workspaceId: string }
export interface SessionCreateOptions { workspaceId?: string; initialOwner?: SessionInitialOwner }

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
  /** Production store-owned deletion transaction; absent in isolated legacy adapters. */
  deleteSessionsDurably?(ids: readonly string[]): Promise<void>
  isSessionDeleted?(sessionId: string, storageGeneration?: string): boolean
  /**
   * **冷加载补水源**(S3w-1,`docs/design/session-event-sourcing-2026-08.md`
   * §14.4)。装上了就在冷加载时用它物化出来的消息顶掉 `messages.jsonl` 那一份
   * (外壳仍来自 meta.json);返回 `undefined` / 空数组 = 这条会话的事件里没有
   * 历史,一字不改走老路。
   *
   * 为什么是注入而不是直接 import:投影住在装配层(`backend/session/`,它认识
   * 事件文件、blob 与活投影缓存),而产品层的仓库不许反向依赖装配层 —— 仓库只
   * 知道"有没有人给我一份消息"。
   * (从前宿主那一侧还有个档位判定 `ONETHING_SESSION_HYDRATE`;F4-a 退役了它,
   * 补水无条件走投影,这一口的形状一字未变。)
   */
  hydrateMessagesFromProjection?(sessionId: string): TMessage[] | undefined
  /**
   * **物化视图**(F4-c c4-d,§16.27)—— 内存 store 的消息数组从**折叠产物**取。
   *
   * 与 `hydrateMessagesFromProjection` 的区别是**时机**,不是内容:补水那一口只
   * 在冷加载时问一次(换的是"从盘上读回来的那一份"),这一口在**每次交出会话**
   * 时问一次(换的是"此刻的那一份")。装上它 = 折叠产物成为消息数组的唯一维护者:
   * 引擎那 18 个热写端口不再需要往数组里写,老 reducer 的消息分支也随之零流量。
   *
   * 稳态成本 = 宿主那边一次 map 查询 + 一次版本号比较(宿主按活投影的失效号缓存);
   * 返回 `undefined` = 这条会话没有可用的折叠产物,保留仓库自己那一份。
   *
   * 为什么是注入而不是直接 import:与补水那一口同一条理由 —— 投影住在装配层,
   * 产品层的仓库不许反向依赖它。
   */
  materializeMessagesFromProjection?(sessionId: string): TMessage[] | undefined
  /**
   * SQLite 退役遗留:全仓零生产填充(S4 把只为它存在的那个具名口删了,形状
   * 原地保留)。下面每个成员都缺席 = 相应分支恒为 no-op。
   */
  sqlite?: {
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
  /**
   * 这个进程已经接手过的会话(读过一次 or 写过一次)。
   *
   * 崩溃收尾修复的唯一判据 —— 见 `repairOnFirstTouch`。只存 id,随触碰过的会话数
   * 增长(几百条 uuid 字符串的量级),删除会话时释放。
   */
  private readonly processOwnedSessions = new Set<string>()

  constructor(private readonly options: OnethingSessionRepositoryOptions<TSession, TMessage, TMeta, TDetails, TMarker>) {
    this.sessionCache = new LRUCache<string, TSession>(options.cacheSize ?? 10)
    const asyncSaveQueueOptions: AsyncSaveQueueOptions<TSession> = {
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
    };
    this.sessionSaveQueue = new AsyncSaveQueue<TSession>(asyncSaveQueueOptions)
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
    // 本进程写过 = 本进程接手过:此后冷加载回来的都不是崩溃残留(见 `repairOnFirstTouch`)。
    this.processOwnedSessions.add(sessionId)
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

  /**
   * 冷加载的取数口 —— **S3w-1 的岔口就在这里**
   * (`docs/design/session-event-sourcing-2026-08.md` §14.4 / §15.4)。
   *
   * 会话的**外壳**(meta.json:名字、模型、agent、工作目录、摘要…)永远来自
   * 存储驱动;换的只是**消息**这一格:补水源装上了(宿主判档,见
   * `hydrateMessagesFromProjection`)且这条会话的事件里真的折得出消息时,
   * store 的消息从投影物化;折不出(未迁移的老会话 / legacy 整文件 / 补水源
   * 没装)就一字不改地走老路。
   *
   * 换完之后照旧过 `rehydrateSessionFromStorage` —— 老路那条补水链一步不减:
   * 它重建 `step.toolCall` 链接、把终态 step 的 `partialResult` 补回来。投影
   * 侧大多已经带着这两格,于是它对投影形状是近乎恒等的一遍;真正的意义是
   * **两条路收在同一个出口**,不必有人记得"投影那条不用跑补水"。
   *
   * 启动期修复(`sanitizeSessionOnStartup`)在这之后由 `getSession` 的
   * `repairOnFirstTouch` 跑,两条路同款 —— 事件侧虽然已经有 `prepare` 合成过
   * 中断结局(两者口径由 `core/session/interrupted.ts` 统一),但 `isStreaming`
   * 与会话级时间线元数据那几格仍然只有它管。
   */
  private loadStoredSession(sessionId: string): TSession | undefined {
    if (this.deletionTombstones.has(sessionId) || this.options.isSessionDeleted?.(sessionId)) return undefined
    const stored = this.options.storageDriver
      ? this.options.storageDriver.load(sessionId)
      : this.options.readJsonFile<TSession | null>(this.options.getSessionPath(sessionId), null) ?? undefined
    if (!stored) return undefined
    if (this.options.isSessionDeleted?.(sessionId, (stored as TSession & { storageGeneration?: string }).storageGeneration)) return undefined
    const projected = this.options.hydrateMessagesFromProjection?.(sessionId)
    // 整体替换用展开(命令面 COW 的同一条纪律:`session.messages = …` 不许)。
    const hydrated = projected && projected.length > 0 ? { ...stored, messages: projected } : stored
    return rehydrateSessionFromStorage(hydrated)
  }

  invalidateSessionCache(sessionId: string): void {
    this.sessionCache.delete(sessionId)
  }

  clearAllSessionCache(): void {
    this.sessionCache.clear()
    // "全部忘掉"包括"这个进程接手过谁":下一次读又是第一次接手(测试 / 换 store)。
    this.processOwnedSessions.clear()
  }

  /**
   * **换装点**(F4-c c4-d,§16.27):把消息那一格换成折叠产物的物化。
   *
   * 全仓**唯一**一处 `session.messages = …`(`session:check` 规则 C 的具名例外)。
   * "只有一个维护者"这条不变量因此仍然成立,只是维护者从老 reducer 换成了折叠
   * 产物 —— 而 reducer 那一半随本批整批空转。
   *
   * 换的是**同一个会话对象上的那一格**,不是新建一个会话:调用方(LRU 缓存、
   * 挂起写快照、`AsyncSaveQueue.getLatest`)手里握的都是这个对象的引用,换引用
   * 会让它们指向旧的那一份。数组整体替换、逐条不动 —— 命令面 COW 的同一条纪律。
   */
  private refreshMessagesFromProjection(sessionId: string, session: TSession): TSession {
    const next = this.options.materializeMessagesFromProjection?.(sessionId)
    if (!next) return session
    if (next === session.messages) return session
    session.messages = next
    return session
  }

  getCachedSession(sessionId: string): TSession | undefined {
    const session = this.sessionCache.get(sessionId)
    return session ? this.refreshMessagesFromProjection(sessionId, session) : undefined
  }

  /**
   * 缓存里那份会话的消息(不触发加载)。P0.4:`session-message-runtime` 的
   * sqlite 流式补同步原来自己 `latestSession.messages.find(...)`,那是命令面之外
   * 的一次会话读;取数原语归位到仓库层(白名单)。
   */
  getCachedSessionMessages(sessionId: string): TMessage[] | undefined {
    // F4-c c4-d(§16.27):走同一个换装点 —— 一份缓存两种读法就是两个视图。
    return this.getCachedSession(sessionId)?.messages
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
    const index = this.options.readJsonFile<TMeta[]>(this.getSessionsIndexPath(), [])
    return this.options.isSessionDeleted
      ? index.filter(meta => !this.options.isSessionDeleted!(meta.id, (meta as TMeta & { storageGeneration?: string }).storageGeneration))
      : index
  }

  saveSessionsIndex(index: TMeta[]): void {
    this.runWithSessionsIndexLock(() => {
      // Core metadata builders intentionally know nothing about physical storage.
      // Carry the repository's immutable incarnation into their list projection.
      for (const meta of index) {
        const carried = meta as TMeta & { storageGeneration?: string; ownerUserId?: string; ownerWorkspaceId?: string }
        const cached = this.sessionCache.get(meta.id) as (TSession & { storageGeneration?: string; ownerUserId?: string; ownerWorkspaceId?: string }) | undefined
        /*
         * 工单 5 §3:身份**不许只从 LRU 取**。
         *
         * 缓存命中就用它(那是最新的一份);没命中、而这一条自己也还没带全身份时,
         * 才去问驱动读一次盘上的 meta。从前这里只有 LRU 一条路 —— 一条被挤出缓存
         * 的会话写出去的索引条目于是**没有代际**,而代际是删除墓碑唯一的判据:
         * 没有它,`isDeleted` 对这一条永远说不出话。
         *
         * 稳态零读盘:索引条目一旦带全三格就不再问驱动。
         */
        const identity = cached ?? (carried.storageGeneration && carried.ownerUserId && carried.ownerWorkspaceId
          ? undefined
          : this.options.storageDriver?.readIdentity?.(meta.id))
        if (identity?.storageGeneration) carried.storageGeneration = identity.storageGeneration
        if (identity?.ownerUserId && identity.ownerWorkspaceId) Object.assign(meta, {
          ownerUserId: identity.ownerUserId, ownerWorkspaceId: identity.ownerWorkspaceId,
        })
      }
      this.options.writeJsonFile(this.getSessionsIndexPath(), index)
    })
  }

  updateSessionsIndexMeta(sessionId: string, update: (meta: TMeta) => void): boolean {
    // 锁内重新读盘 + 改 + 写,避免与另一进程交错造成 last-writer-wins 丢条目。
    return this.runWithSessionsIndexLock(() => {
      const indexMetaMutationOptions: ApplySessionIndexMetaMutationWithAdaptersOptions<TMeta> = {
        sessionId,
        loadIndex: () => this.loadSessionsIndex(),
        saveIndex: index => this.saveSessionsIndex(index),
        mutateMeta: update,
      }
      return Boolean(applySessionIndexMetaMutationWithAdapters<TMeta>(indexMetaMutationOptions))
    })
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

  /**
   * **按账落格**(§17.7 #15):用量三格 + 上下文两格由**会话账**说了算,这里只搬运。
   * 与 `updateSessionTokenUsage`(加法)不同,它是**覆盖** —— 账已经是总量。
   */
  landSessionAccountUsage(
    sessionId: string,
    snapshot: {
      totalInputTokens: number
      totalOutputTokens: number
      totalTokens: number
      contextSize?: number
      lastInputTokens?: number
    },
  ): boolean {
    return this.applySideEffectMutation(sessionId, {
      mutateSession: session => landSessionAccountUsage(session, snapshot),
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
    const resolveSessionMessagesPageOptions: ResolveSessionMessagesPageOptions<StoredChatMessage> = {
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
    };
    const result = resolveSessionMessagesPage(resolveSessionMessagesPageOptions)

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
    const resolveSessionUserMessageMarkersOptions: ResolveSessionUserMessageMarkersOptions<TMessage> = {
      getJsonlLogMarkers: () => this.options.storageDriver?.getUserMessageMarkers(sessionId),
      getSqliteMarkers: () => this.options.sqlite?.getUserMessageMarkers?.(sessionId),
      getSessionMessages: () => this.getSession(sessionId)?.messages,
    };
    const result = resolveSessionUserMessageMarkers(resolveSessionUserMessageMarkersOptions)
    if (result.shouldScheduleMigration) {
      this.options.sqlite?.scheduleMigration?.(sessionId)
    }
    return result.markers as TMarker[] | undefined
  }

  getSessionRaw(sessionId: string): TSession | undefined {
    return this.loadStoredSession(sessionId)
  }

  getSession(sessionId: string): TSession | undefined {
    const loadSessionWithAdaptersOptions: LoadSessionWithAdaptersOptions<TSession> = {
      sessionId,
      cache: this.sessionCache,
      loadSession: id => this.loadStoredSession(id),
      saveSession: (id, session) => this.saveSessionToFile(id, session),
      syncSession: session => this.syncSessionToSqliteIfReady(session),
      // 启动不再全量扫描;冷加载时做完整修复(含中断的 step/toolCall),替代原 sanitizeAllSessionsOnStartup。
      sanitizeSession: session => this.repairOnFirstTouch(sessionId, session),
      expandPath: this.options.expandPath,
    };
    const session = loadSessionWithAdapters<TSession>(loadSessionWithAdaptersOptions).session
    // F4-c c4-d(§16.27):交出去之前换装 —— 消息那一格的维护者是折叠产物。
    return session ? this.refreshMessagesFromProjection(sessionId, session) : session
  }

  /**
   * 崩溃收尾修复**只对这个进程第一次接手的会话**做一次。
   *
   * 它修的是"上一个进程没收尾的残留"(`isStreaming` 挂着、step/toolCall 停在
   * running/pending)。这类残留只可能出现在**本进程第一次**读到这条会话的那一刻:
   * 此后盘上写的每一个字节都是本进程自己写的。
   *
   * 从前没有这个条件,于是 LRU(默认 10 条)在一次**活着的执行**中途把这条会话
   * 淘汰掉、下一次 `getSession` 冷加载回来时,修复就落在了**正在跑的那条消息**上:
   * `isStreaming` 被抹掉(于是它开始进自己的模型历史重建 —— 2026-08-20 真机
   * `5e4d2cea` 的两条 history 影子不等就是这么来的,§13.7)、正在执行的 step 与
   * toolCall 被当成"被打断"改写成 cancelled,而且这一份还被 `saveSession` 写回盘。
   *
   * 判据用"接手过没有"而不是"有没有活跃 run":读侧不该为了这件事去认识引擎,
   * 而且这条更宽 —— 一条本进程写过的会话,任何时候再被冷加载回来都不该被当成
   * 崩溃残留。写路径(`saveSessionToFile`)也记账,因为新建 / 只写过没读过的
   * 会话同样是本进程的。
   */
  private repairOnFirstTouch(sessionId: string, session: TSession): TSession | undefined {
    if (this.processOwnedSessions.has(sessionId)) return undefined
    this.processOwnedSessions.add(sessionId)
    return sanitizeSessionOnStartup(session)
  }

  createSession(sessionId: string, name: string, options: SessionCreateOptions = {}): TSession {
    const workingDirectory = this.resolveDefaultWorkingDirectory()

    return this.runWithSessionsIndexLock(() => {
      const createSessionOptions: CreateSessionWithAdaptersOptions<TSession, TMessage, TMeta> = {
        sessionId,
        name,
        defaultAgentId: this.options.defaultAgentId,
        workingDirectory,
        workspaceId: options.workspaceId,
        saveSession: (id, session) => this.saveInitialSession(id, session, options.initialOwner),
        syncSession: session => this.syncSessionToSqliteIfReady(session),
        syncFullSession: session => this.options.sqlite?.syncFullSession?.(session),
        loadIndex: () => this.loadSessionsIndex(),
        saveIndex: index => this.saveSessionsIndex(index),
        setCurrentSessionId: sessionId => this.options.setCurrentSessionId(sessionId),
      }
      return createSessionWithAdapters<TSession, TMessage, TMeta>(createSessionOptions)
    })
  }

  createBranchSession(
    sessionId: string,
    name: string,
    parentSessionId: string,
    branchFromMessageId: string,
    inheritedMessages: TMessage[],
    options: { initialOwner?: SessionInitialOwner } = {},
  ): TSession {
    const parentSession = this.getSession(parentSessionId)
    const parentOwner = parentSession as (TSession & { ownerUserId?: string; ownerWorkspaceId?: string; userId?: string }) | undefined
    const initialOwner = options.initialOwner ?? {
      userId: parentOwner?.ownerUserId ?? parentOwner?.userId ?? 'local-user',
      workspaceId: parentOwner?.ownerWorkspaceId ?? 'default',
    }
    const workingDirectory = parentSession?.workingDirectory ?? this.resolveDefaultWorkingDirectory()

    return this.runWithSessionsIndexLock(() => {
      const createBranchSessionOptions: CreateBranchSessionWithAdaptersOptions<TSession, TMessage, TMeta> = {
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
        saveSession: (id, session) => this.saveInitialSession(id, session, initialOwner),
        syncSession: session => this.syncSessionToSqliteIfReady(session),
        syncFullSession: session => this.options.sqlite?.syncFullSession?.(session),
        loadIndex: () => this.loadSessionsIndex(),
        saveIndex: index => this.saveSessionsIndex(index),
        setCurrentSessionId: sessionId => this.options.setCurrentSessionId(sessionId),
      }
      return createBranchSessionWithAdapters<TSession, TMessage, TMeta>(createBranchSessionOptions)
    })
  }

  private saveInitialSession(sessionId: string, session: TSession, initialOwner: SessionInitialOwner = { userId: 'local-user', workspaceId: 'default' }): void {
    // A branch must never inherit its parent's physical incarnation. Publish the
    // complete new metadata before cache/index observers can see the new session.
    const created = session as TSession & { storageGeneration: string }
    if (!initialOwner.userId || !initialOwner.workspaceId) throw new Error('Session creation requires a complete trusted owner')
    Object.assign(created, { ownerUserId: initialOwner.userId, ownerWorkspaceId: initialOwner.workspaceId })
    created.storageGeneration = randomUUID()
    const stored = dehydrateSessionForStorage(session) as TSession
    if (this.options.storageDriver?.initialize) this.options.storageDriver.initialize(sessionId, stored)
    // 目录屏障的上界是 `sessions/`(工单 5 §2):再往上是用户主目录与整块卷。
    else writeDurableJson(this.options.getSessionPath(sessionId), stored, this.options.getSessionsDir())
    this.saveSessionToFile(sessionId, session)
  }

  /** Await the actual file removals and preserve their original failures. */
  async deleteSession(sessionId: string): Promise<OnethingDeleteSessionResult> {
    if (this.options.deleteSessionsDurably) return this.deleteSessionDurably(sessionId)
    const pending: Promise<void>[] = []
    const failures: unknown[] = []
    let result: OnethingDeleteSessionResult | undefined
    try { result = this.beginSessionDeletion(sessionId, pending) }
    catch (error) { failures.push(error) }
    const settled = await Promise.allSettled(pending)
    for (const outcome of settled) if (outcome.status === 'rejected') failures.push(outcome.reason)
    if (failures.length) throw new AggregateError(failures, `Failed to delete session ${sessionId}`)
    return result!
  }

  private readonly durableDeletionPlans = new Map<string, {
    deletedIds: string[]; parentSessionId?: string; nextCurrentSessionId?: string
  }>()

  private async deleteSessionDurably(sessionId: string): Promise<OnethingDeleteSessionResult> {
    let plan = this.durableDeletionPlans.get(sessionId)
    if (!plan) {
      plan = this.runWithSessionsIndexLock(() => {
        // Keep the exact retry target set even while the public index suppresses
        // pending tombstones. No file hydration/recovery occurs during planning.
        const index = this.options.readJsonFile<TMeta[]>(this.getSessionsIndexPath(), [])
        const parentSessionId = index.find(meta => meta.id === sessionId)?.parentSessionId
        return { ...planSessionCascadeDelete(index, {
          sessionId, parentSessionId, currentSessionId: this.options.getCurrentSessionId(),
        }), parentSessionId }
      })
      this.durableDeletionPlans.set(sessionId, plan)
    }
    for (const id of plan.deletedIds) {
      this.deletionTombstones.add(id)
      this.processOwnedSessions.delete(id)
      this.cancelPendingSave(id)
    }
    // The application coordinator already drained the target writers; ensure no
    // adapter save remains active before the transaction captures its generations.
    await Promise.all(plan.deletedIds.map(id => this.sessionSaveQueue.runExclusive(id, async () => {})))
    await this.options.deleteSessionsDurably!(plan.deletedIds)
    for (const id of plan.deletedIds) {
      this.deleteCachedSession(id)
      this.deletionTombstones.delete(id)
    }
    this.options.sqlite?.deleteSessions?.(plan.deletedIds)
    if (plan.nextCurrentSessionId !== undefined) this.options.setCurrentSessionId(plan.nextCurrentSessionId)
    this.durableDeletionPlans.delete(sessionId)
    return { deletedIds: plan.deletedIds, parentSessionId: plan.parentSessionId }
  }

  private beginSessionDeletion(sessionId: string, pending: Promise<void>[]): OnethingDeleteSessionResult {
    return this.runWithSessionsIndexLock(() => {
      const deleteSessionOptions: DeleteSessionWithAdaptersOptions<Pick<TSession, 'parentSessionId'>, TMeta> = {
        sessionId,
        // Deletion only needs the parent id. Loading a cold session here can
        // schedule recovery writes after its execution and save queues drained.
        getSession: id => this.loadSessionsIndex().find(meta => meta.id === id),
        getCurrentSessionId: () => this.options.getCurrentSessionId(),
        loadIndex: () => this.loadSessionsIndex(),
        saveIndex: index => this.saveSessionsIndex(index),
        cancelPendingSave: id => this.cancelPendingSave(id),
        // 文件删除排在该会话在途异步写之后执行(与写入互斥),
        // 否则 rm 目录会与正在落盘的 meta/log 写入竞态(ENOTEMPTY);
        // tombstone 保证清理完成前读路径不会把会话从盘上复活。
        deleteSessionFile: id => {
          this.processOwnedSessions.delete(id)
          this.deletionTombstones.add(id)
          const deletion = this.sessionSaveQueue.runExclusive(id, () => {
            if (this.options.storageDriver) {
              this.options.storageDriver.delete(id)
              return
            }
            const filePath = this.options.getSessionPath(id)
            this.options.deleteJsonFile(filePath)
            try {
              fs.statSync(filePath)
              throw new Error(`Failed to delete legacy session file: ${filePath}`)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
          }).then(() => {
            this.deletionTombstones.delete(id)
          })
          pending.push(deletion)
          void deletion.catch(error => {
            this.options.logger?.error?.(`[Sessions] failed to delete session files for ${id}:`, error)
          })
        },
        deleteSessionCache: id => this.deleteCachedSession(id),
        deleteSessionsFromSqlite: ids => this.options.sqlite?.deleteSessions?.(ids),
        setCurrentSessionId: sessionId => this.options.setCurrentSessionId(sessionId),
      }
      return deleteSessionWithAdapters<Pick<TSession, 'parentSessionId'>, TMeta>(deleteSessionOptions)
    })
  }

  syncSessionToSqliteIfReady(session: TSession): void {
    const syncSessionSideEffectWithReadyAdaptersOptions: SyncSessionSideEffectWithReadyAdaptersOptions<TSession> = {
      sessionId: session.id,
      session,
      isReady: sessionId => this.options.sqlite?.isSessionReady?.(sessionId) ?? false,
      scheduleMigration: sessionId => this.options.sqlite?.scheduleMigration?.(sessionId),
      syncReady: target => this.options.sqlite?.syncFullSession?.(target),
      logger: this.options.logger,
      errorMessage: '[Sessions] Failed to sync session to SQLite:',
    };
    syncSessionSideEffectWithReadyAdapters(syncSessionSideEffectWithReadyAdaptersOptions)
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
    const applySessionMetadataMutationWithAdaptersOptions: ApplySessionMetadataMutationWithAdaptersOptions<TSession, TMeta> = {
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
    };
    return applySessionMetadataMutationWithAdapters<TSession, TMeta>(applySessionMetadataMutationWithAdaptersOptions).applied
  }

  private applySideEffectMutation(
    sessionId: string,
    options: {
      mutateSession(session: TSession): void
      syncSession(session: TSession): void
    },
  ): boolean {
    const applySessionSideEffectMutationWithAdaptersOptions: ApplySessionSideEffectMutationWithAdaptersOptions<TSession> = {
      sessionId,
      getSession: id => this.getSession(id),
      mutateSession: options.mutateSession,
      // usage/contextSize/variables 都是会话级字段
      saveSession: (id, session) => this.saveSessionToFile(id, session, { plan: { kind: 'meta' } }),
      syncSession: options.syncSession,
    };
    return applySessionSideEffectMutationWithAdapters<TSession>(applySessionSideEffectMutationWithAdaptersOptions).applied
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
    const syncSessionSideEffectWithReadyAdaptersOptions2: SyncSessionSideEffectWithReadyAdaptersOptions<TSession> = {
      sessionId: session.id,
      session,
      isReady: sessionId => this.options.sqlite?.isSessionReady?.(sessionId) ?? false,
      scheduleMigration: sessionId => this.options.sqlite?.scheduleMigration?.(sessionId),
      syncReady,
      logger: this.options.logger,
      errorMessage,
    };
    syncSessionSideEffectWithReadyAdapters(syncSessionSideEffectWithReadyAdaptersOptions2)
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
