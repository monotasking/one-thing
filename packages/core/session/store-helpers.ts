import type { CoreTimelineSession } from './timeline.js'
import {
  sanitizeLoadedSession,
  sanitizeSessionOnStartup,
  type CoreSessionCommandSession,
} from './commands.js'

export const CORE_DEFAULT_AGENT_ID = 'default'

export interface CoreSessionMessage {
  id?: string
  role: string
  content?: unknown
}

export interface CoreSessionMessageWithId {
  id: string
}

export interface CoreSessionWithMessages<TMessage extends CoreSessionMessageWithId = CoreSessionMessageWithId> {
  messages: TMessage[]
}

export interface CoreSessionStepWithId {
  id: string
  title?: string
  status?: string
  toolCallId?: string
  turnIndex?: number
  usage?: unknown
}

export interface CoreSessionMessageWithSteps<TStep extends CoreSessionStepWithId = CoreSessionStepWithId>
  extends CoreSessionMessageWithId {
  steps?: TStep[]
}

export interface CoreSessionMeta {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  agentId?: string
  memoryProfileId?: string
  originIdentityKey?: string
  lastConnector?: string
  lastSentAt?: number
  parentSessionId?: string
  branchFromMessageId?: string
  lastModel?: string
  lastProvider?: string
  /** The user picked lastProvider/lastModel by hand (not the auto-stamp). */
  modelPinned?: boolean
  permissionMode?: string
  isPinned?: boolean
  isArchived?: boolean
  archivedAt?: number
  messageCount?: number
  previewText?: string
  /**
   * 会话归属的 space(workspace)。**缺席 = default** —— 读取端缺省,不做数据
   * 迁移(`docs/design/workspace-spaces-2026-08.md` 批 B)。core 只负责把它随
   * 会话记录与索引一起存下来,不解释它的语义。
   */
  workspaceId?: string
}

export type CoreSessionMetadataMutationResult<TSession> =
  | { applied: false }
  | { applied: true; session: TSession }

export interface ApplySessionMetadataMutationWithAdaptersOptions<
  TSession extends { id: string },
  TMeta extends { id: string },
> {
  sessionId: string
  getSession: (sessionId: string) => TSession | undefined
  mutateSession: (session: TSession) => void
  saveSession: (sessionId: string, session: TSession) => void
  syncSessionMetadata?: (session: TSession) => void
  updateIndexMeta?: (sessionId: string, mutate: (meta: TMeta) => void) => void
  mutateMeta?: (meta: TMeta, session: TSession) => void
}

export interface ApplySessionSideEffectMutationWithAdaptersOptions<TSession extends { id: string }> {
  sessionId: string
  getSession: (sessionId: string) => TSession | undefined
  mutateSession: (session: TSession) => void
  saveSession: (sessionId: string, session: TSession) => void
  syncSession?: (session: TSession) => void
}

export interface ApplySessionIndexMetaMutationWithAdaptersOptions<TMeta extends { id: string }> {
  sessionId: string
  loadIndex(): TMeta[]
  saveIndex(index: TMeta[]): void
  mutateMeta(meta: TMeta): void
}

export interface CoreSessionSqliteMutationAdapters<TSession> {
  isReady(sessionId: string): boolean
  scheduleMigration(sessionId: string): void
  syncMetadata(session: TSession): void
  syncUsage?(session: TSession): void
}

export interface SyncSessionSideEffectWithReadyAdaptersOptions<TSession> {
  sessionId: string
  session: TSession
  isReady(sessionId: string): boolean
  scheduleMigration(sessionId: string): void
  syncReady(session: TSession): void
  logger?: { error?: (...args: unknown[]) => void }
  errorMessage?: string
}

export type SyncSessionSideEffectWithReadyAdaptersResult = 'synced' | 'scheduled' | 'error'

export interface SanitizeSessionsOnStartupWithAdaptersOptions<
  TSession extends CoreTimelineSession,
  TMeta extends { id: string },
> {
  loadIndex(): TMeta[]
  loadSession(sessionId: string): TSession | undefined
  saveSession(sessionId: string, session: TSession): void
  syncSession?: (session: TSession) => void
  /** COW:改了返回新会话,没改返回 undefined(F4) */
  sanitizeSession?: (session: TSession) => TSession | undefined
}

export interface SanitizeSessionsOnStartupWithAdaptersResult {
  scanned: number
  sanitized: number
  missing: number
}

export interface CoreSessionCacheAdapter<TSession> {
  get(sessionId: string): TSession | undefined
  set(sessionId: string, session: TSession): void
}

export interface LoadSessionWithAdaptersOptions<
  TSession extends CoreTimelineSession & {
    workingDirectory?: string
    workingDirectoryRoots?: string[]
  },
> {
  sessionId: string
  cache?: CoreSessionCacheAdapter<TSession>
  loadSession(sessionId: string): TSession | undefined
  saveSession?(sessionId: string, session: TSession): void
  syncSession?: (session: TSession) => void
  expandPath?: (path: string) => string
  /** COW:改了返回新会话,没改返回 undefined(F4) */
  sanitizeSession?: (session: TSession) => TSession | undefined
}

export type LoadSessionWithAdaptersResult<TSession> =
  | {
      status: 'cache-hit' | 'loaded'
      session: TSession
      sanitized: boolean
    }
  | {
      status: 'missing'
      session?: undefined
      sanitized: false
    }

export interface CoreSessionIndexTimestampSource {
  updatedAt: number
}

export interface CoreSessionIndexMessageSource {
  role: string
  provider?: string
  model?: string
}

export interface CoreSessionDetails extends CoreSessionMeta {
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  variables?: unknown[]
  summary?: string
  summaryUpToMessageId?: string
  summaryCreatedAt?: number
  promptContext?: unknown | null
  totalInputTokens?: number
  totalOutputTokens?: number
  totalTokens?: number
  lastInputTokens?: number
  contextSize?: number
}

export interface CoreSessionDetailsWithMessages<TMessage = unknown> extends CoreSessionDetails {
  messages: TMessage[]
}

export interface ResolveSessionDetailsSnapshotOptions<
  TSession extends CoreSessionDetailsWithMessages = CoreSessionDetailsWithMessages,
> extends SessionDetailsMergeOptions {
  meta?: CoreSessionMeta
  sqliteDetails?: CoreSessionMeta | CoreSessionDetails
  getSession?: () => TSession | undefined
}

export interface CoreSessionTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface CoreSessionLastTurnUsage {
  inputTokens: number
  outputTokens?: number
}

export interface CoreSessionUsageFields {
  totalInputTokens?: number
  totalOutputTokens?: number
  totalTokens?: number
  lastInputTokens?: number
  contextSize?: number
}

/**
 * 与变量子系统的两个枚举同形(core 不许依赖 runtime,所以在这里各声明一份)。
 *
 * type/scope/state 都必须**原样存活到落盘**:state 决定这个变量还进不进
 * `<context-update>`,归一化时把它丢掉,本该一直在模型眼前的状态重载后就凭空
 * 消失了 —— 而它消失得静悄悄,没有任何报错。
 */
export type CoreContextVariableType = 'string' | 'number' | 'bool' | 'list' | 'map' | 'set'
export type CoreContextVariableScope = 'global' | 'session' | 'agent' | 'project'

export interface CoreContextVariableInput {
  name: string
  value: string
  values?: string[]
  type?: CoreContextVariableType
  scope?: CoreContextVariableScope
  state?: boolean
  description?: string
  updatedAt?: number
}

export interface CoreNormalizedContextVariable {
  name: string
  value: string
  values?: string[]
  type?: CoreContextVariableType
  scope?: CoreContextVariableScope
  state?: boolean
  description?: string
  updatedAt: number
}

export interface CoreSessionUsageSnapshot {
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  lastInputTokens: number
  contextSize: number
}

export interface CoreSessionMessageWithUsage extends CoreSessionMessage {
  id: string
  usage?: CoreSessionTokenUsage
}

export interface CoreSessionEditableMessage extends CoreSessionMessageWithUsage {
  content?: unknown
  contentParts?: unknown[]
  timestamp: number
}

export interface CoreSessionMessageWithModelInfo extends CoreSessionMessageWithId {
  role: string
  provider?: string
  model?: string
}

export interface CoreSessionWithMessageList<TMessage extends CoreSessionMessageWithModelInfo = CoreSessionMessageWithModelInfo> {
  id?: string
  messages: TMessage[]
  updatedAt: number
  lastProvider?: string
  lastModel?: string
  totalInputTokens?: number
  totalOutputTokens?: number
  totalTokens?: number
  lastInputTokens?: number
  contextSize?: number
  summary?: string
  summaryUpToMessageId?: string
  summaryCreatedAt?: number
}

export interface CreateCoreSessionRecordOptions {
  sessionId: string
  name: string
  defaultAgentId: string
  workingDirectory?: string
  /** 归属 space;缺席 = default(读取端缺省)。 */
  workspaceId?: string
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

export interface CoreSession<TMessage extends CoreSessionMessage = CoreSessionMessage>
  extends CoreSessionDetails {
  messages: TMessage[]
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

export interface NormalizeWorkingDirectoryRootsOptions {
  active?: string
  expandPath?: (path: string) => string
}

export interface SessionDetailsMergeOptions {
  defaultAgentId?: string
}

export interface SessionMetaExtractOptions<TMessage extends CoreSessionMessage = CoreSessionMessage> {
  defaultAgentId?: string
  previewLength?: number
  displayContentForMessage?: (message: TMessage) => string
}

export function normalizeWorkingDirectoryRoots(
  roots: unknown,
  options: NormalizeWorkingDirectoryRootsOptions = {},
): string[] | undefined {
  if (!Array.isArray(roots)) return undefined

  const expand = options.expandPath ?? ((value: string) => value)
  const activePath = options.active ? expand(options.active) : ''
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) continue
    const expanded = expand(root.trim())
    if (expanded === activePath || seen.has(expanded)) continue
    seen.add(expanded)
    normalized.push(expanded)
  }

  return normalized.length > 0 ? normalized : undefined
}

export function findSessionMeta<TMeta extends { id: string }>(
  index: TMeta[],
  sessionId: string,
): TMeta | undefined {
  return index.find(session => session.id === sessionId)
}

export function prependSessionMeta<TMeta>(
  index: TMeta[],
  meta: TMeta,
): TMeta[] {
  index.unshift(meta)
  return index
}

export function updateSessionIndexMeta<TMeta extends { id: string }>(
  index: TMeta[],
  sessionId: string,
  update: (meta: TMeta) => void,
): TMeta | undefined {
  const meta = findSessionMeta(index, sessionId)
  if (!meta) return undefined
  update(meta)
  return meta
}

export function applySessionIndexMetaMutationWithAdapters<TMeta extends { id: string }>(
  options: ApplySessionIndexMetaMutationWithAdaptersOptions<TMeta>,
): TMeta | undefined {
  const index = options.loadIndex()
  const meta = updateSessionIndexMeta(index, options.sessionId, options.mutateMeta)
  if (!meta) return undefined
  options.saveIndex(index)
  return meta
}

export function applySessionMetadataMutationWithAdapters<
  TSession extends { id: string },
  TMeta extends { id: string },
>(
  options: ApplySessionMetadataMutationWithAdaptersOptions<TSession, TMeta>,
): CoreSessionMetadataMutationResult<TSession> {
  const session = options.getSession(options.sessionId)
  if (!session) return { applied: false }

  options.mutateSession(session)
  options.saveSession(options.sessionId, session)
  options.syncSessionMetadata?.(session)
  if (options.updateIndexMeta && options.mutateMeta) {
    options.updateIndexMeta(options.sessionId, meta => options.mutateMeta?.(meta, session))
  }

  return { applied: true, session }
}

export function applySessionSideEffectMutationWithAdapters<TSession extends { id: string }>(
  options: ApplySessionSideEffectMutationWithAdaptersOptions<TSession>,
): CoreSessionMetadataMutationResult<TSession> {
  const session = options.getSession(options.sessionId)
  if (!session) return { applied: false }

  options.mutateSession(session)
  options.saveSession(options.sessionId, session)
  options.syncSession?.(session)

  return { applied: true, session }
}

export function syncSessionSideEffectWithReadyAdapters<TSession>(
  options: SyncSessionSideEffectWithReadyAdaptersOptions<TSession>,
): SyncSessionSideEffectWithReadyAdaptersResult {
  try {
    if (options.isReady(options.sessionId)) {
      options.syncReady(options.session)
      return 'synced'
    }

    options.scheduleMigration(options.sessionId)
    return 'scheduled'
  } catch (error) {
    options.logger?.error?.(options.errorMessage ?? '[Sessions] Failed to sync session side effect:', error)
    return 'error'
  }
}

export function sanitizeSessionsOnStartupWithAdapters<
  TSession extends CoreTimelineSession,
  TMeta extends { id: string },
>(
  options: SanitizeSessionsOnStartupWithAdaptersOptions<TSession, TMeta>,
): SanitizeSessionsOnStartupWithAdaptersResult {
  const index = options.loadIndex()
  const sanitize: (target: TSession) => TSession | undefined =
    options.sanitizeSession
    ?? (target => sanitizeSessionOnStartup(target as unknown as CoreSessionCommandSession) as unknown as TSession | undefined)
  const result: SanitizeSessionsOnStartupWithAdaptersResult = {
    scanned: index.length,
    sanitized: 0,
    missing: 0,
  }

  for (const meta of index) {
    const session = options.loadSession(meta.id)
    if (!session) {
      result.missing += 1
      continue
    }

    // COW:修好的是**新的会话对象**,落盘/同步都得看新的那份(F4)。
    const repaired = sanitize(session)
    if (!repaired) continue

    options.saveSession(meta.id, repaired)
    options.syncSession?.(repaired)
    result.sanitized += 1
  }

  return result
}

export function loadSessionWithAdapters<
  TSession extends CoreTimelineSession & {
    workingDirectory?: string
    workingDirectoryRoots?: string[]
  },
>(
  options: LoadSessionWithAdaptersOptions<TSession>,
): LoadSessionWithAdaptersResult<TSession> {
  const cached = options.cache?.get(options.sessionId)
  if (cached) {
    return { status: 'cache-hit', session: cached, sanitized: false }
  }

  const session = options.loadSession(options.sessionId)
  if (!session) {
    return { status: 'missing', sanitized: false }
  }

  const expand = options.expandPath
  if (session.workingDirectory && expand) {
    session.workingDirectory = expand(session.workingDirectory)
  }
  session.workingDirectoryRoots = normalizeWorkingDirectoryRoots(session.workingDirectoryRoots, {
    active: session.workingDirectory,
    expandPath: expand,
  })

  const sanitize: (target: TSession) => TSession | undefined =
    options.sanitizeSession
    ?? (target => sanitizeLoadedSession(target as unknown as CoreSessionCommandSession) as unknown as TSession | undefined)
  const repaired = sanitize(session)
  const loaded = repaired ?? session
  if (repaired) {
    options.saveSession?.(options.sessionId, repaired)
    options.syncSession?.(repaired)
  }

  options.cache?.set(options.sessionId, loaded)
  return { status: 'loaded', session: loaded, sanitized: Boolean(repaired) }
}

export function applySessionUpdatedAtToMeta<TMeta extends { updatedAt: number }>(
  meta: TMeta,
  session: CoreSessionIndexTimestampSource,
): TMeta {
  meta.updatedAt = session.updatedAt
  return meta
}

export function applySessionMessageAppendToMeta<
  TMeta extends { updatedAt: number; lastProvider?: string; lastModel?: string },
>(
  meta: TMeta,
  session: CoreSessionIndexTimestampSource,
  message: CoreSessionIndexMessageSource,
): TMeta {
  applySessionUpdatedAtToMeta(meta, session)
  if (message.role === 'assistant') {
    meta.lastProvider = message.provider ?? meta.lastProvider
    meta.lastModel = message.model ?? meta.lastModel
  }
  return meta
}

export function applySessionName<TSession extends { name: string }>(
  session: TSession,
  name: string,
): TSession {
  session.name = name
  return session
}

export function applySessionPin<TSession extends { isPinned?: boolean }>(
  session: TSession,
  isPinned: boolean,
): TSession {
  session.isPinned = isPinned
  return session
}

export function applySessionArchiveState<TSession extends { isArchived?: boolean; archivedAt?: number }>(
  session: TSession,
  isArchived: boolean,
  archivedAt?: number | null,
): TSession {
  session.isArchived = isArchived
  if (isArchived && archivedAt) {
    session.archivedAt = archivedAt
  } else if (!isArchived) {
    delete session.archivedAt
  }
  return session
}

export function applySessionPermissionMode<TMode, TSession extends { permissionMode?: TMode }>(
  session: TSession,
  permissionMode: TMode,
): TSession {
  session.permissionMode = permissionMode
  return session
}

export function applySessionWorkingDirectory<
  TSession extends { workingDirectory?: string; workingDirectoryRoots?: string[] },
>(
  session: TSession,
  workingDirectory: string | null,
  options: NormalizeWorkingDirectoryRootsOptions = {},
): TSession {
  const expand = options.expandPath ?? ((value: string) => value)
  if (workingDirectory === null || workingDirectory === '') {
    delete session.workingDirectory
  } else {
    session.workingDirectory = expand(workingDirectory)
  }
  session.workingDirectoryRoots = normalizeWorkingDirectoryRoots(session.workingDirectoryRoots, {
    ...options,
    active: session.workingDirectory,
  })
  return session
}

export function applySessionWorkingDirectoryRoots<
  TSession extends { workingDirectory?: string; workingDirectoryRoots?: string[] },
>(
  session: TSession,
  roots: string[],
  options: NormalizeWorkingDirectoryRootsOptions = {},
): TSession {
  session.workingDirectoryRoots = normalizeWorkingDirectoryRoots(roots, {
    ...options,
    active: session.workingDirectory,
  })
  return session
}

export function applyInheritedSessionWorkingDirectory<
  TSession extends { workingDirectory?: string; workingDirectoryRoots?: string[] },
>(
  session: TSession,
  workingDirectory: string,
  options: NormalizeWorkingDirectoryRootsOptions = {},
): TSession {
  const expand = options.expandPath ?? ((value: string) => value)
  session.workingDirectory = expand(workingDirectory)
  session.workingDirectoryRoots = normalizeWorkingDirectoryRoots(session.workingDirectoryRoots, {
    ...options,
    active: session.workingDirectory,
  })
  return session
}

export function normalizeSessionVariables<TVariable extends CoreContextVariableInput>(
  variables: TVariable[],
  now = Date.now(),
): CoreNormalizedContextVariable[] {
  return variables.map(variable => ({
    name: variable.name,
    value: variable.value,
    values: variable.values,
    // type/scope/state 属于变量的身份而不是装饰:少写一个,重载回来的就是
    // 另一个变量(类型退回 string、状态层的变量退回"看不见")。
    type: variable.type,
    scope: variable.scope,
    state: variable.state,
    description: variable.description,
    updatedAt: variable.updatedAt ?? now,
  }))
}

export function applySessionVariables<
  TSession extends { variables?: CoreContextVariableInput[] },
  TVariable extends CoreContextVariableInput,
>(
  session: TSession,
  variables: TVariable[],
  now = Date.now(),
): TSession {
  session.variables = normalizeSessionVariables(variables, now)
  return session
}

export function applySessionPromptContext<TSession extends { promptContext?: unknown | null }>(
  session: TSession,
  promptContext: TSession['promptContext'],
): TSession {
  session.promptContext = promptContext
  return session
}

export function applySessionSummary<
  TSession extends {
    summary?: string
    summaryUpToMessageId?: string
    summaryCreatedAt?: number
    updatedAt: number
  },
>(
  session: TSession,
  summary: string,
  summaryUpToMessageId: string,
  now = Date.now(),
): TSession {
  session.summary = summary
  session.summaryUpToMessageId = summaryUpToMessageId
  session.summaryCreatedAt = now
  session.updatedAt = now
  return session
}

/**
 * An explicit model choice — the picker, not the per-message auto-stamp. The
 * pin is what lets an agent's model binding know whether there is a user
 * decision to defer to (docs/design/agent-capability-profile.md A1.4).
 */
export function applySessionModel<
  TSession extends { lastProvider?: string; lastModel?: string; modelPinned?: boolean },
>(
  session: TSession,
  provider: string,
  model: string,
  options: { pinned?: boolean } = {},
): TSession {
  session.lastProvider = provider
  session.lastModel = model
  if (options.pinned !== undefined) session.modelPinned = options.pinned || undefined
  return session
}

export function applySessionAgent<TSession extends { agentId?: string }>(
  session: TSession,
  agentId: string,
  defaultAgentId: string,
): TSession {
  session.agentId = agentId || defaultAgentId
  return session
}

export function hasSessionUsageDetails(details: CoreSessionDetails): boolean {
  return details.contextSize !== undefined ||
    details.lastInputTokens !== undefined ||
    details.totalInputTokens !== undefined ||
    details.totalOutputTokens !== undefined ||
    details.totalTokens !== undefined
}

export function applyDefaultAgentIdToSessionMetas<TMeta extends CoreSessionMeta>(
  metas: TMeta[],
  defaultAgentId: string,
): Array<TMeta & { agentId: string }> {
  return metas.map(meta => ({
    ...meta,
    agentId: meta.agentId || defaultAgentId,
  }))
}

export function mergeSessionDetails(
  meta: CoreSessionMeta | undefined,
  details: CoreSessionMeta | CoreSessionDetails,
  options: SessionDetailsMergeOptions = {},
): CoreSessionDetails {
  const messageCount =
    details.messageCount && details.messageCount > 0
      ? details.messageCount
      : meta?.messageCount ?? details.messageCount ?? 0

  return {
    ...meta,
    ...details,
    agentId: details.agentId || meta?.agentId || options.defaultAgentId,
    messageCount,
    totalInputTokens: (details as CoreSessionDetails).totalInputTokens ?? 0,
    totalOutputTokens: (details as CoreSessionDetails).totalOutputTokens ?? 0,
    totalTokens: (details as CoreSessionDetails).totalTokens ?? 0,
    lastInputTokens: (details as CoreSessionDetails).lastInputTokens ?? 0,
    contextSize: (details as CoreSessionDetails).contextSize ?? 0,
  }
}

export function resolveSessionDetailsSnapshot<
  TSession extends CoreSessionDetailsWithMessages = CoreSessionDetailsWithMessages,
>(
  options: ResolveSessionDetailsSnapshotOptions<TSession>,
): CoreSessionDetails | undefined {
  const { meta, sqliteDetails, getSession, ...mergeOptions } = options

  if (sqliteDetails && hasSessionUsageDetails(sqliteDetails as CoreSessionDetails)) {
    return mergeSessionDetails(meta, sqliteDetails, mergeOptions)
  }

  const session = getSession?.()
  if (session) {
    const { messages, ...details } = session
    return mergeSessionDetails(meta, {
      ...details,
      messageCount: messages.length,
    }, mergeOptions)
  }

  if (sqliteDetails) {
    return mergeSessionDetails(meta, sqliteDetails, mergeOptions)
  }

  if (meta) {
    return mergeSessionDetails(undefined, meta, mergeOptions)
  }

  return undefined
}

export function extractSessionMeta<TMessage extends CoreSessionMessage>(
  session: Omit<CoreSession<TMessage>, 'messages'>,
  messages: readonly TMessage[],
  options: SessionMetaExtractOptions<TMessage> = {},
): CoreSessionMeta {
  const firstUserMessage = messages.find(message => message.role === 'user')
  const previewLength = options.previewLength ?? 100
  const previewText = firstUserMessage
    ? getDisplayContent(firstUserMessage, options).slice(0, previewLength)
    : undefined

  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    parentSessionId: session.parentSessionId,
    branchFromMessageId: session.branchFromMessageId,
    agentId: session.agentId || options.defaultAgentId,
    memoryProfileId: session.memoryProfileId,
    originIdentityKey: session.originIdentityKey,
    lastConnector: session.lastConnector,
    lastSentAt: session.lastSentAt,
    lastModel: session.lastModel,
    lastProvider: session.lastProvider,
    modelPinned: session.modelPinned,
    permissionMode: session.permissionMode,
    isPinned: session.isPinned,
    isArchived: session.isArchived,
    archivedAt: session.archivedAt,
    workspaceId: session.workspaceId,
    messageCount: messages.length,
    previewText,
  }
}

export function applySessionTokenUsage<TSession extends CoreSessionUsageFields>(
  session: TSession,
  usage: CoreSessionTokenUsage,
  lastTurnUsage?: CoreSessionLastTurnUsage,
): TSession {
  session.totalInputTokens = (session.totalInputTokens || 0) + usage.inputTokens
  session.totalOutputTokens = (session.totalOutputTokens || 0) + usage.outputTokens
  session.totalTokens = (session.totalTokens || 0) + usage.totalTokens

  if (lastTurnUsage) {
    session.lastInputTokens = Math.max(0, lastTurnUsage.inputTokens)
    session.contextSize = Math.max(0, lastTurnUsage.inputTokens)
  }
  return session
}

export function applySessionContextSize<TSession extends CoreSessionUsageFields>(
  session: TSession,
  contextSize: number,
): TSession {
  const normalized = Math.max(0, contextSize)
  session.lastInputTokens = normalized
  session.contextSize = normalized
  return session
}

export function getSessionTokenUsageSnapshot(
  session: CoreSessionUsageFields,
): CoreSessionUsageSnapshot {
  return {
    totalInputTokens: session.totalInputTokens || 0,
    totalOutputTokens: session.totalOutputTokens || 0,
    totalTokens: session.totalTokens || 0,
    lastInputTokens: session.lastInputTokens || 0,
    contextSize: session.contextSize || 0,
  }
}

export function sumSessionMessageUsage<TMessage extends CoreSessionMessageWithUsage>(
  messages: TMessage[],
): CoreSessionTokenUsage {
  return messages.reduce<CoreSessionTokenUsage>((usage, message) => {
    if (!message.usage) return usage
    usage.inputTokens += message.usage.inputTokens
    usage.outputTokens += message.usage.outputTokens
    usage.totalTokens += message.usage.totalTokens
    return usage
  }, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  })
}

export function subtractSessionMessageUsage<
  TSession extends Pick<CoreSessionUsageFields, 'totalInputTokens' | 'totalOutputTokens' | 'totalTokens'>,
  TMessage extends CoreSessionMessageWithUsage,
>(
  session: TSession,
  messages: TMessage[],
): CoreSessionTokenUsage {
  const usage = sumSessionMessageUsage(messages)
  if (usage.totalTokens <= 0) return usage

  session.totalInputTokens = Math.max(0, (session.totalInputTokens || 0) - usage.inputTokens)
  session.totalOutputTokens = Math.max(0, (session.totalOutputTokens || 0) - usage.outputTokens)
  session.totalTokens = Math.max(0, (session.totalTokens || 0) - usage.totalTokens)
  return usage
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
  } as TMeta)
  options.saveIndex(index)
  options.setCurrentSessionId?.(options.sessionId)

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

function getDisplayContent<TMessage extends CoreSessionMessage>(
  message: TMessage,
  options: SessionMetaExtractOptions<TMessage>,
): string {
  if (options.displayContentForMessage) {
    return options.displayContentForMessage(message)
  }
  return typeof message.content === 'string' ? message.content : ''
}
