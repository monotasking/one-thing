// 建会话与删会话(从 `session-store-helpers.ts` 拆出,拆分批 1,D226):新会话与分支会话的初始记录怎么造、
// 经适配器怎么落盘,删一条会话时连带要删哪些子会话、按什么顺序删。
// 不叫 `session-lifecycle.ts`:那个名字已经有一只文件(会话运行期的生命周期)。
import { type CoreSessionMessageWithUsage, sumSessionMessageUsage } from './session-usage-fold.js'
import type { CoreSession, CoreSessionDetails } from './session-details.js'
import { type CoreSessionMeta, prependSessionMeta } from './session-meta.js'

export interface CoreSessionEditableMessage extends CoreSessionMessageWithUsage {
  content?: unknown
  contentParts?: unknown[]
  timestamp: number
}

export interface CreateCoreSessionRecordOptions {
  sessionId: string
  name: string
  defaultAgentId: string
  workingDirectory?: string
  /** 归属 space;缺席 = default(读取端缺省)。 */
  workspaceId?: string
  /** 归属应用(见 `CoreSessionMeta.app`);缺席 = 人开的会话。 */
  app?: string
  now?: number
}

export interface CreateCoreBranchSessionRecordOptions<TMessage extends CoreSessionMessageWithUsage> {
  sessionId: string
  name: string
  parentSessionId: string
  parentSession?: Partial<CoreSessionDetails> | null
  branchFromMessageId: string
  inheritedMessages: TMessage[]
  defaultAgentId: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  now?: number
}

export interface CreateSessionWithAdaptersOptions<
  TSession extends CoreSession<TMessage>,
  TMessage extends CoreSessionMessageWithUsage,
  TMeta extends CoreSessionMeta,
> extends CreateCoreSessionRecordOptions {
  saveSession(sessionId: string, session: TSession): void
  syncSession?(session: TSession): void
  syncFullSession?(session: TSession): void
  loadIndex(): TMeta[]
  saveIndex(index: TMeta[]): void
  setCurrentSessionId?(sessionId: string): void
}

export interface CreateBranchSessionWithAdaptersOptions<
  TSession extends CoreSession<TMessage>,
  TMessage extends CoreSessionMessageWithUsage,
  TMeta extends CoreSessionMeta,
> extends CreateCoreBranchSessionRecordOptions<TMessage> {
  saveSession(sessionId: string, session: TSession): void
  syncSession?(session: TSession): void
  syncFullSession?(session: TSession): void
  loadIndex(): TMeta[]
  saveIndex(index: TMeta[]): void
  setCurrentSessionId?(sessionId: string): void
}

export interface CoreSessionDeletePlan {
  deletedIds: string[]
  nextCurrentSessionId?: string
}

export interface DeleteSessionWithAdaptersResult {
  deletedIds: string[]
  parentSessionId?: string
}

export interface DeleteSessionWithAdaptersOptions<
  TSession extends { parentSessionId?: string },
  TMeta extends Pick<CoreSessionMeta, 'id' | 'parentSessionId'>,
> {
  sessionId: string
  getSession(sessionId: string): TSession | undefined
  getCurrentSessionId(): string | undefined
  loadIndex(): TMeta[]
  saveIndex(index: TMeta[]): void
  cancelPendingSave?(sessionId: string): void
  deleteSessionFile(sessionId: string): void
  deleteSessionCache?(sessionId: string): void
  deleteSessionsFromSqlite?(sessionIds: string[]): void
  setCurrentSessionId?(sessionId: string): void
}

export function createCoreSessionRecord<TMessage extends CoreSessionMessageWithUsage = CoreSessionMessageWithUsage>(
  options: CreateCoreSessionRecordOptions,
): CoreSession<TMessage> {
  const now = options.now ?? Date.now()
  return {
    id: options.sessionId,
    name: options.name,
    messages: [],
    createdAt: now,
    updatedAt: now,
    agentId: options.defaultAgentId,
    workingDirectory: options.workingDirectory,
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.app ? { app: options.app } : {}),
  }
}

export function createCoreBranchSessionRecord<TMessage extends CoreSessionMessageWithUsage>(
  options: CreateCoreBranchSessionRecordOptions<TMessage>,
): CoreSession<TMessage> {
  const now = options.now ?? Date.now()
  const usage = sumSessionMessageUsage(options.inheritedMessages)
  return {
    id: options.sessionId,
    name: options.name,
    messages: options.inheritedMessages,
    createdAt: now,
    updatedAt: now,
    parentSessionId: options.parentSessionId,
    branchFromMessageId: options.branchFromMessageId,
    agentId: options.parentSession?.agentId || options.defaultAgentId,
    workingDirectory: options.workingDirectory,
    workingDirectoryRoots: options.workingDirectoryRoots,
    totalInputTokens: usage.inputTokens,
    totalOutputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  }
}

export function createSessionWithAdapters<
  TSession extends CoreSession<TMessage>,
  TMessage extends CoreSessionMessageWithUsage = CoreSessionMessageWithUsage,
  TMeta extends CoreSessionMeta = CoreSessionMeta,
>(
  options: CreateSessionWithAdaptersOptions<TSession, TMessage, TMeta>,
): TSession {
  const session = createCoreSessionRecord<TMessage>(options) as TSession

  options.saveSession(options.sessionId, session)
  options.syncSession?.(session)
  options.syncFullSession?.(session)

  const index = options.loadIndex()
  prependSessionMeta(index, {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    agentId: session.agentId || options.defaultAgentId,
    // 索引也带上归属,左栏按 space 过滤才不必逐个会话读盘。
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    // 应用归属同理进索引:列表 / 检索按它过滤时不必逐个会话读盘。
    ...(session.app ? { app: session.app } : {}),
  } as TMeta)
  options.saveIndex(index)
  // 应用自己开的会话不顶成「当前会话」:没人在看它,把界面切过去是抢屏。
  if (!session.app) options.setCurrentSessionId?.(options.sessionId)

  return session
}

export function createBranchSessionWithAdapters<
  TSession extends CoreSession<TMessage>,
  TMessage extends CoreSessionMessageWithUsage,
  TMeta extends CoreSessionMeta = CoreSessionMeta,
>(
  options: CreateBranchSessionWithAdaptersOptions<TSession, TMessage, TMeta>,
): TSession {
  const session = createCoreBranchSessionRecord<TMessage>(options) as TSession

  options.saveSession(options.sessionId, session)
  options.syncSession?.(session)
  options.syncFullSession?.(session)

  const index = options.loadIndex()
  prependSessionMeta(index, {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    parentSessionId: options.parentSessionId,
    branchFromMessageId: options.branchFromMessageId,
    agentId: session.agentId || options.defaultAgentId,
  } as TMeta)
  options.saveIndex(index)
  options.setCurrentSessionId?.(options.sessionId)

  return session
}

export function collectChildSessionIds(
  index: Array<Pick<CoreSessionMeta, 'id' | 'parentSessionId'>>,
  parentId: string,
): string[] {
  const children = index.filter(session => session.parentSessionId === parentId)
  const ids: string[] = []
  for (const child of children) {
    ids.push(child.id)
    ids.push(...collectChildSessionIds(index, child.id))
  }
  return ids
}

export function collectSessionCascadeDeleteIds(
  index: Array<Pick<CoreSessionMeta, 'id' | 'parentSessionId'>>,
  sessionId: string,
): string[] {
  return [sessionId, ...collectChildSessionIds(index, sessionId)]
}

export function planSessionCascadeDelete(
  index: Array<Pick<CoreSessionMeta, 'id' | 'parentSessionId'>>,
  input: {
    sessionId: string
    currentSessionId?: string
    parentSessionId?: string
  },
): CoreSessionDeletePlan {
  const deletedIds = collectSessionCascadeDeleteIds(index, input.sessionId)
  const remaining = index.filter(session => !deletedIds.includes(session.id))
  let nextCurrentSessionId: string | undefined

  if (input.currentSessionId && deletedIds.includes(input.currentSessionId)) {
    if (input.parentSessionId && remaining.some(session => session.id === input.parentSessionId)) {
      nextCurrentSessionId = input.parentSessionId
    } else {
      nextCurrentSessionId = remaining[0]?.id || ''
    }
  }

  return {
    deletedIds,
    ...(nextCurrentSessionId !== undefined ? { nextCurrentSessionId } : {}),
  }
}

export function deleteSessionWithAdapters<
  TSession extends { parentSessionId?: string },
  TMeta extends Pick<CoreSessionMeta, 'id' | 'parentSessionId'>,
>(
  options: DeleteSessionWithAdaptersOptions<TSession, TMeta>,
): DeleteSessionWithAdaptersResult {
  const session = options.getSession(options.sessionId)
  const parentSessionId = session?.parentSessionId
  const originalIndex = options.loadIndex()
  const plan = planSessionCascadeDelete(originalIndex, {
    sessionId: options.sessionId,
    currentSessionId: options.getCurrentSessionId(),
    parentSessionId,
  })
  const deletedIds = plan.deletedIds

  for (const id of deletedIds) {
    options.cancelPendingSave?.(id)
    options.deleteSessionFile(id)
    options.deleteSessionCache?.(id)
  }
  options.deleteSessionsFromSqlite?.(deletedIds)

  options.saveIndex(originalIndex.filter(sessionMeta => !deletedIds.includes(sessionMeta.id)))

  if (plan.nextCurrentSessionId !== undefined) {
    options.setCurrentSessionId?.(plan.nextCurrentSessionId)
  }

  return { deletedIds, parentSessionId }
}
