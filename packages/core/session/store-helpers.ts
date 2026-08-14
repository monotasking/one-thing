import {
  repairSessionTimelineMetadata,
  sanitizeLoadedSession,
  sanitizeSessionOnStartup,
  type CoreTimelineSession,
} from './timeline.js'

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

export type CoreSessionMessageMutationResult<TSession, TMessage> =
  | { applied: false }
  | { applied: true; session: TSession; message: TMessage }

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

export interface ApplySessionMessageMutationWithAdaptersOptions<
  TSession extends { id: string },
  TMessage extends CoreSessionMessageWithId,
> {
  sessionId: string
  messageId: string
  getSession: (sessionId: string) => (TSession & CoreSessionWithMessages<TMessage>) | undefined
  mutateMessage: (
    session: TSession & CoreSessionWithMessages<TMessage>,
    messageId: string,
  ) => TMessage | undefined
  saveSession: (sessionId: string, session: TSession & CoreSessionWithMessages<TMessage>) => void
  syncMessage?: (session: TSession & CoreSessionWithMessages<TMessage>, message: TMessage) => void
}

export interface ApplySessionAppendMessageWithAdaptersOptions<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionMessageWithModelInfo,
  TMeta extends { updatedAt: number; lastProvider?: string; lastModel?: string },
> {
  sessionId: string
  message: TMessage
  now?: number
  getSession: (sessionId: string) => TSession | undefined
  saveSession: (sessionId: string, session: TSession) => void
  syncMessage?: (session: TSession, message: TMessage) => void
  updateIndexMeta?: (sessionId: string, mutate: (meta: TMeta) => void) => void
}

export interface ApplySessionInsertMessageAfterWithAdaptersOptions<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionMessageWithModelInfo,
> {
  sessionId: string
  afterMessageId: string
  message: TMessage
  now?: number
  getSession: (sessionId: string) => TSession | undefined
  saveSession: (sessionId: string, session: TSession) => void
  syncSession?: (session: TSession) => void
}

export interface ApplySessionMessageStepsUsageByTurnWithAdaptersOptions<
  TSession extends { id: string },
  TMessage extends CoreSessionMessageWithSteps<TStep>,
  TStep extends CoreSessionStepWithId,
> {
  sessionId: string
  messageId: string
  turnIndex: number
  usage: unknown
  getSession: (sessionId: string) => (TSession & CoreSessionWithMessages<TMessage>) | undefined
  saveSession: (sessionId: string, session: TSession & CoreSessionWithMessages<TMessage>) => void
  syncMessage?: (session: TSession & CoreSessionWithMessages<TMessage>, message: TMessage) => void
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
  sanitizeSession?: (session: TSession) => boolean
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
  sanitizeSession?: (session: TSession) => boolean
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

export interface ApplySessionDeleteMessageWithAdaptersOptions<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionMessageWithModelInfo,
> {
  sessionId: string
  messageId: string
  now?: number
  getSession(sessionId: string): TSession | undefined
  saveSession(sessionId: string, session: TSession): void
  sqlite?: CoreSessionSqliteMutationAdapters<TSession> & {
    deleteMessage(sessionId: string, messageId: string): void
  }
  logger?: { error?: (...args: unknown[]) => void }
}

export interface ApplySessionTruncateMessagesWithAdaptersOptions<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionMessageWithModelInfo & CoreSessionMessageWithUsage,
> {
  sessionId: string
  messageId: string
  now?: number
  getSession(sessionId: string): TSession | undefined
  saveSession(sessionId: string, session: TSession): void
  sqlite?: CoreSessionSqliteMutationAdapters<TSession> & {
    deleteMessageAndAfter(sessionId: string, messageId: string): void
  }
  updateIndexMeta?: (sessionId: string, mutate: (meta: CoreSessionIndexTimestampSource) => void) => void
  logger?: { error?: (...args: unknown[]) => void }
}

export interface ApplySessionUpdateMessageAndTruncateWithAdaptersOptions<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionEditableMessage & CoreSessionMessageWithModelInfo,
> {
  sessionId: string
  messageId: string
  newContent: string
  options?: CoreSessionUpdateAndTruncateOptions
  now?: number
  getSession(sessionId: string): TSession | undefined
  saveSession(sessionId: string, session: TSession): void
  sqlite?: CoreSessionSqliteMutationAdapters<TSession> & {
    upsertMessageAndTruncate(sessionId: string, message: TMessage, nextSequence: number): void
  }
  updateIndexMeta?: (sessionId: string, mutate: (meta: CoreSessionIndexTimestampSource) => void) => void
  logger?: { error?: (...args: unknown[]) => void }
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

export interface CoreSessionDeleteMessageResult<TMessage> {
  index: number
  deletedMessage: TMessage
}

export interface CoreSessionTruncateResult<TMessage> {
  index: number
  deletedMessages: TMessage[]
  subtractedUsage: CoreSessionTokenUsage
}

export interface CoreSessionUpdateAndTruncateOptions {
  contentParts?: unknown[] | null
  hasContentParts?: boolean
}

export interface CoreSessionUpdateAndTruncateResult<TMessage> extends CoreSessionTruncateResult<TMessage> {
  updatedMessage: TMessage
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
  const sanitize = options.sanitizeSession ?? sanitizeSessionOnStartup
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

    if (!sanitize(session)) continue

    options.saveSession(meta.id, session)
    options.syncSession?.(session)
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

  const sanitize = options.sanitizeSession ?? sanitizeLoadedSession
  const sanitized = sanitize(session)
  if (sanitized) {
    options.saveSession?.(options.sessionId, session)
    options.syncSession?.(session)
  }

  options.cache?.set(options.sessionId, session)
  return { status: 'loaded', session, sanitized }
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
  session: CoreSession<TMessage>,
  options: SessionMetaExtractOptions<TMessage> = {},
): CoreSessionMeta {
  const firstUserMessage = session.messages.find(message => message.role === 'user')
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
    messageCount: session.messages.length,
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

export function appendSessionMessage<
  TMessage extends CoreSessionMessageWithModelInfo,
>(
  session: CoreSessionWithMessageList,
  message: TMessage,
  now = Date.now(),
): TMessage {
  session.messages.push(message)
  if (message.role === 'assistant') {
    if (message.provider) {
      session.lastProvider = message.provider
    }
    if (message.model) {
      session.lastModel = message.model
    }
  }
  session.updatedAt = now
  return message
}

export function insertSessionMessageAfter<
  TMessage extends CoreSessionMessageWithModelInfo,
>(
  session: CoreSessionWithMessageList,
  afterMessageId: string,
  message: TMessage,
  now = Date.now(),
): TMessage {
  const index = session.messages.findIndex(item => item.id === afterMessageId)
  if (index === -1) {
    session.messages.push(message)
  } else {
    session.messages.splice(index + 1, 0, message)
  }
  if (message.role === 'assistant') {
    if (message.provider) {
      session.lastProvider = message.provider
    }
    if (message.model) {
      session.lastModel = message.model
    }
  }
  session.updatedAt = now
  return message
}

export function deleteSessionMessage<
  TSession extends CoreSessionWithMessageList<TMessage>,
  TMessage extends CoreSessionMessageWithModelInfo,
>(
  session: TSession,
  messageId: string,
  now = Date.now(),
): CoreSessionDeleteMessageResult<TMessage> | undefined {
  const index = session.messages.findIndex(message => message.id === messageId)
  if (index === -1) return undefined

  const [deletedMessage] = session.messages.splice(index, 1)
  session.updatedAt = now
  return { index, deletedMessage }
}

export function truncateSessionMessagesFrom<
  TSession extends CoreSessionWithMessageList<TMessage>,
  TMessage extends CoreSessionMessageWithModelInfo & CoreSessionMessageWithUsage,
>(
  session: TSession,
  messageId: string,
  now = Date.now(),
): CoreSessionTruncateResult<TMessage> | undefined {
  const index = session.messages.findIndex(message => message.id === messageId)
  if (index === -1) return undefined

  const deletedMessages = session.messages.slice(index)
  const subtractedUsage = subtractSessionMessageUsage(session, deletedMessages)
  session.messages = session.messages.slice(0, index)
  repairSessionTimelineMetadata(session as Parameters<typeof repairSessionTimelineMetadata>[0], {
    recomputeContextSize: true,
  })
  session.updatedAt = now
  return {
    index,
    deletedMessages,
    subtractedUsage,
  }
}

export function updateSessionMessageAndTruncateAfter<
  TSession extends CoreSessionWithMessageList<TMessage>,
  TMessage extends CoreSessionEditableMessage & CoreSessionMessageWithModelInfo,
>(
  session: TSession,
  messageId: string,
  newContent: string,
  options: CoreSessionUpdateAndTruncateOptions = {},
  now = Date.now(),
): CoreSessionUpdateAndTruncateResult<TMessage> | undefined {
  const index = session.messages.findIndex(message => message.id === messageId)
  if (index === -1) return undefined

  const deletedMessages = session.messages.slice(index + 1)
  const subtractedUsage = subtractSessionMessageUsage(session, deletedMessages)
  const updatedMessage = session.messages[index]
  updatedMessage.content = newContent
  if (options.hasContentParts) {
    if (options.contentParts && options.contentParts.length > 0) {
      updatedMessage.contentParts = options.contentParts
    } else {
      delete updatedMessage.contentParts
    }
  }
  updatedMessage.timestamp = now

  session.messages = session.messages.slice(0, index + 1)
  repairSessionTimelineMetadata(session as Parameters<typeof repairSessionTimelineMetadata>[0], {
    recomputeContextSize: true,
  })
  session.updatedAt = now
  return {
    index,
    updatedMessage,
    deletedMessages,
    subtractedUsage,
  }
}

export function applySessionDeleteMessageWithAdapters<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionMessageWithModelInfo,
>(
  options: ApplySessionDeleteMessageWithAdaptersOptions<TSession, TMessage>,
): CoreSessionDeleteMessageResult<TMessage> | undefined {
  const session = options.getSession(options.sessionId)
  if (!session) return undefined

  const result = deleteSessionMessage<TSession, TMessage>(session, options.messageId, options.now)
  if (!result) return undefined

  options.saveSession(options.sessionId, session)

  try {
    if (options.sqlite) {
      if (options.sqlite.isReady(options.sessionId)) {
        options.sqlite.deleteMessage(options.sessionId, options.messageId)
        options.sqlite.syncMetadata(session)
      } else {
        options.sqlite.scheduleMigration(options.sessionId)
      }
    }
  } catch (error) {
    options.logger?.error?.('[Sessions] Failed to delete message from SQLite:', error)
  }

  return result
}

export function applySessionTruncateMessagesWithAdapters<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionMessageWithModelInfo & CoreSessionMessageWithUsage,
>(
  options: ApplySessionTruncateMessagesWithAdaptersOptions<TSession, TMessage>,
): CoreSessionTruncateResult<TMessage> | undefined {
  const session = options.getSession(options.sessionId)
  if (!session) return undefined

  const result = truncateSessionMessagesFrom<TSession, TMessage>(session, options.messageId, options.now)
  if (!result) return undefined

  options.saveSession(options.sessionId, session)

  try {
    if (options.sqlite) {
      if (options.sqlite.isReady(options.sessionId)) {
        options.sqlite.deleteMessageAndAfter(options.sessionId, options.messageId)
        options.sqlite.syncMetadata(session)
        options.sqlite.syncUsage?.(session)
      } else {
        options.sqlite.scheduleMigration(options.sessionId)
      }
    }
  } catch (error) {
    options.logger?.error?.('[Sessions] Failed to truncate messages in SQLite:', error)
  }

  options.updateIndexMeta?.(options.sessionId, meta => applySessionUpdatedAtToMeta(meta, session))

  return result
}

export function applySessionUpdateMessageAndTruncateWithAdapters<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionEditableMessage & CoreSessionMessageWithModelInfo,
>(
  options: ApplySessionUpdateMessageAndTruncateWithAdaptersOptions<TSession, TMessage>,
): CoreSessionUpdateAndTruncateResult<TMessage> | undefined {
  const session = options.getSession(options.sessionId)
  if (!session) return undefined

  const result = updateSessionMessageAndTruncateAfter<TSession, TMessage>(
    session,
    options.messageId,
    options.newContent,
    options.options,
    options.now,
  )
  if (!result) return undefined

  options.saveSession(options.sessionId, session)

  try {
    if (options.sqlite) {
      if (options.sqlite.isReady(options.sessionId)) {
        options.sqlite.upsertMessageAndTruncate(options.sessionId, result.updatedMessage, result.index + 1)
        options.sqlite.syncMetadata(session)
        options.sqlite.syncUsage?.(session)
      } else {
        options.sqlite.scheduleMigration(options.sessionId)
      }
    }
  } catch (error) {
    options.logger?.error?.('[Sessions] Failed to update+truncate messages in SQLite:', error)
  }

  options.updateIndexMeta?.(options.sessionId, meta => applySessionUpdatedAtToMeta(meta, session))

  return result
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

export function findSessionMessage<TMessage extends CoreSessionMessageWithId>(
  session: CoreSessionWithMessages<TMessage>,
  messageId: string,
): TMessage | undefined {
  return session.messages.find(message => message.id === messageId)
}

export function patchSessionMessage<
  TMessage extends CoreSessionMessageWithId,
  TPatch extends Partial<TMessage>,
>(
  session: CoreSessionWithMessages<TMessage>,
  messageId: string,
  patch: TPatch,
): TMessage | undefined {
  const message = findSessionMessage(session, messageId)
  if (!message) return undefined
  Object.assign(message, patch)
  return message
}

export function applySessionMessageMutationWithAdapters<
  TSession extends { id: string },
  TMessage extends CoreSessionMessageWithId,
>(
  options: ApplySessionMessageMutationWithAdaptersOptions<TSession, TMessage>,
): CoreSessionMessageMutationResult<TSession & CoreSessionWithMessages<TMessage>, TMessage> {
  const session = options.getSession(options.sessionId)
  if (!session) return { applied: false }

  const message = options.mutateMessage(session, options.messageId)
  if (!message) return { applied: false }

  options.saveSession(options.sessionId, session)
  options.syncMessage?.(session, message)

  return { applied: true, session, message }
}

export function applySessionAppendMessageWithAdapters<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionMessageWithModelInfo,
  TMeta extends { updatedAt: number; lastProvider?: string; lastModel?: string },
>(
  options: ApplySessionAppendMessageWithAdaptersOptions<TSession, TMessage, TMeta>,
): CoreSessionMessageMutationResult<TSession, TMessage> {
  const session = options.getSession(options.sessionId)
  if (!session) return { applied: false }

  const message = appendSessionMessage(session, options.message, options.now)
  options.saveSession(options.sessionId, session)
  options.syncMessage?.(session, message)
  options.updateIndexMeta?.(options.sessionId, meta => applySessionMessageAppendToMeta(meta, session, message))

  return { applied: true, session, message }
}

export function applySessionInsertMessageAfterWithAdapters<
  TSession extends CoreSessionWithMessageList<TMessage> & { id: string },
  TMessage extends CoreSessionMessageWithModelInfo,
>(
  options: ApplySessionInsertMessageAfterWithAdaptersOptions<TSession, TMessage>,
): CoreSessionMessageMutationResult<TSession, TMessage> {
  const session = options.getSession(options.sessionId)
  if (!session) return { applied: false }

  const message = insertSessionMessageAfter(session, options.afterMessageId, options.message, options.now)
  options.saveSession(options.sessionId, session)
  options.syncSession?.(session)

  return { applied: true, session, message }
}

export function appendSessionMessageContentPart<
  TMessage extends CoreSessionMessageWithId & { contentParts?: TPart[] },
  TPart,
>(
  session: CoreSessionWithMessages<TMessage>,
  messageId: string,
  part: TPart,
): TMessage | undefined {
  const message = findSessionMessage(session, messageId)
  if (!message) return undefined
  if (!message.contentParts) {
    message.contentParts = []
  }
  message.contentParts.push(part)
  return message
}

export function findSessionStepById<TStep extends CoreSessionStepWithId>(
  steps: TStep[],
  stepId: string,
): TStep | undefined {
  return steps.find(step => step.id === stepId)
}

export function addOrUpdateSessionMessageStep<
  TMessage extends CoreSessionMessageWithSteps<TStep>,
  TStep extends CoreSessionStepWithId,
>(
  message: TMessage,
  step: TStep,
): TStep {
  if (!message.steps) {
    message.steps = []
  }

  const existingIndex = message.steps.findIndex(existing =>
    Boolean(existing.toolCallId && existing.toolCallId === step.toolCallId),
  )
  if (existingIndex >= 0) {
    message.steps[existingIndex] = { ...message.steps[existingIndex], ...step }
    return message.steps[existingIndex]
  }

  message.steps.push(step)
  return step
}

export function updateSessionMessageStep<
  TMessage extends CoreSessionMessageWithSteps<TStep>,
  TStep extends CoreSessionStepWithId,
>(
  message: TMessage,
  stepId: string,
  updates: Partial<TStep>,
): TStep | undefined {
  if (!message.steps) return undefined
  const step = findSessionStepById(message.steps, stepId)
  if (!step) return undefined
  Object.assign(step, updates)
  return step
}

export function updateSessionMessageStepsUsageByTurn<
  TMessage extends CoreSessionMessageWithSteps<TStep>,
  TStep extends CoreSessionStepWithId,
>(
  message: TMessage,
  turnIndex: number,
  usage: unknown,
): string[] {
  if (!message.steps) return []
  const updatedStepIds: string[] = []
  for (const step of message.steps) {
    if (step.turnIndex === turnIndex) {
      step.usage = usage
      updatedStepIds.push(step.id)
    }
  }
  return updatedStepIds
}

export function applySessionMessageStepsUsageByTurnWithAdapters<
  TSession extends { id: string },
  TMessage extends CoreSessionMessageWithSteps<TStep>,
  TStep extends CoreSessionStepWithId,
>(
  options: ApplySessionMessageStepsUsageByTurnWithAdaptersOptions<TSession, TMessage, TStep>,
): string[] {
  const session = options.getSession(options.sessionId)
  if (!session) return []

  const message = findSessionMessage(session, options.messageId)
  if (!message) return []

  const updatedStepIds = updateSessionMessageStepsUsageByTurn(message, options.turnIndex, options.usage)
  if (updatedStepIds.length > 0) {
    options.saveSession(options.sessionId, session)
    options.syncMessage?.(session, message)
  }

  return updatedStepIds
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
