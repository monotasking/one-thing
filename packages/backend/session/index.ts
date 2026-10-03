/**
 * 会话这个功能的**唯一入口**(`@onething/backend/session`)。
 *
 * 功能目录之外(包根、别的功能、apps、scripts、evals)只许从这里拿名字;目录里其余文件都是内部实现,
 * 目录里的文件互相按相对路径 import(`bun run entry:gate` 量这件事,规矩见
 * docs/design/server-client-split-2026-10.md §4「功能入口」)。
 *
 * 2026-10-03 起这里也是原 `session-primitives.ts`(core 时代会话内核的出口)的家:那只文件的再导出整段并进
 * 下半截后删除。上半截是产品侧(仓储、存储驱动、分支、补水 / 脱水、IPC 形状……),下半截是会话内核
 * (`Session` / `SessionManager`、事件词表与编解码、投影、轨迹、分页与 jsonl 编解码、store helpers)。
 */
export * from './branching.js'
export * from './history-messages.js'
export * from './ipc-operations.js'
export * from './renderer-sanitizer.js'
export * from './session-dehydrate.js'
/*
 * `session-message-runtime` —— **整件删除**(§17.7.1 批 3)。
 * 命令面的执行体随老 reducer 退役;用量快照那一口落在 `backend/session/session-store.ts`。
 */
export * from './session-repository.js'
export * from './storage-driver.js'
export * from './deletion-recovery.js'
export * from './session-usage.js'
export * from './stream-abort.js'
export * from './session-updates.js'
export * from './system-messages.js'
export * from './working-directory.js'
export * from './session-events.js'
export * from './resource-spec.js'
// 按路径读盘的 legacy 整份 JSON 分页。从前它不进 `storage/index.ts` 那个桶,是为了让会话内核的出口在浏览器里也
// import 得动;界面今天碰不到后端包,那条理由没了,所以外面要用就从入口拿。
export { getMessagesPageFromJsonFilePath } from './storage/json-message-page-file.js'

// ── 以下原是包根 `session/`(会话的命令面 / 读门面 / 事件账本),2026-10-03 并进本目录。外面真在用的名字逐个
// 列在这里;访问判定与读门面两只是外面整只拿去用的(命名空间 import、`typeof import`),所以整只再导出。
export * from './access.js'
export { recordSynthesizedAssistantText } from './assistant-parts.js'
// 2026-10 engine 归位:「这次执行属于谁」的固定执行上下文从 `engine/execution-context.ts` 搬来(它只吃访问判定那两个名字)。
export { fixedExecutionContext } from './session-execution-context.js'
export { runSessionBlobGc, scheduleSessionBlobGcOnStartup } from './blob-gc.js'
export type { SessionBlobGcReport } from './blob-gc.js'
export { readSessionBlob, textOrBlobForEvent } from './blob-store.js'
export { sessionCommandEvents } from './command-events.js'
export type { SessionCommandEvents } from './command-events.js'
export { sessionDeletion } from './deletion.js'
export { installSessionLedgerEventBroadcaster, uninstallSessionLedgerEventBroadcaster } from './event-broadcast.js'
export {
  acquireSessionEventLogStore,
  appendSessionEvent,
  findLastSessionEventSync,
  flushSessionEventLog,
  getSessionEventsLogPath,
  nextSessionRequestIndex,
  readSessionEvents,
  readSessionLogEvents,
  readSessionLogEventsSync,
  registerSessionLogEventAppendObserver,
  resetSessionEventLogCache,
} from './event-log.js'
export type { SessionEventLogStoreHandle } from './event-log.js'
export { countSessionEventDroppedPart, readSessionShadowStats, resetSessionEventStatsCache } from './event-stats.js'
export { resetSessionSurfaceCache } from './event-surface.js'
export { writeSessionEvent } from './event-writer.js'
export { sessionLifecycleEvents } from './lifecycle-events.js'
export { extractSessionPageResults } from './page-results.js'
export type { SessionPageResultSlot } from './page-results.js'
export { installSessionPermissionEventRecorders, uninstallSessionPermissionEventRecorders } from './permission-events.js'
export {
  deliverPresentation,
  presentationHandlerCount,
  registerPresentationHandler,
  takePresented,
} from './presentation.js'
export { foldLiveSessionLogicalDelta } from './projection-cache.js'
export { warnOnForeignCoreForEventsRead } from './read-mode.js'
export * from './reads.js'
export { canReceiveSessionRemoval } from './removal-event.js'
export {
  beginSessionRun,
  currentSessionRun,
  currentSessionRunId,
  endSessionRun,
  ensureSessionRun,
  markSessionRunOutcome,
  nextSessionRunPartIndex,
  resetSessionRuns,
  rotateSessionRun,
  setSessionRunRequestIndex,
} from './runs.js'
export type { BeginSessionRunInput } from './runs.js'
export { createSessionCommands, sessionCommands } from './session-commands.js'
export type { SessionCommands } from './session-commands.js'
export { isSafeSessionId, readSessionTrace, readSessionTraceResponseText } from './trace-reads.js'
export type { ReadSessionTraceOptions } from './trace-reads.js'
// 「当前会话」的 id(包根归位 2,2026-10-03 从包根 `stores/app-state.ts` 搬来)。
export { getCurrentSessionId, setCurrentSessionId } from './current-session.js'

// ── 会话表、会话组合根与三只挂在会话表上的件(包根归位 B,2026-10-03 进入口)。会话表从前在加载时就建仓储、
// 读存储 / 应用状态 / 设置的导出,所以这五只一度不进入口;改成首次用到时才建以后(见 `session-store.ts` 那段说明),
// import 入口不再读设置、不再建仓储。外面真在用的名字逐个列出。
//
// `landSessionAccountUsage` 在本目录有三份,签名各不相同:入口用这个名字交出的是 `store-helpers.ts` 那份(就地改一个
// 会话对象);会话表那份(按 id 把一份用量快照落进会话表)以 `landSessionAccountUsageInStore` 交出,`usage.ts` 那份
// (按 id 从会话账折叠取快照、再落进会话表)以 `landSessionAccountUsageFromAccount` 交出。
export {
  addMessageContentPart,
  addMessageStep,
  countSessionsInWorkspace,
  createBranchSession,
  createSession,
  createSessionWithoutFocus,
  deleteSession,
  findSessionIndexMeta,
  flushAllPendingSaves,
  flushSessionSave,
  getSession,
  getSessionCacheStats,
  getSessionDetails,
  getSessionMessages,
  getSessionMessagesPage,
  getSessionTokenUsage,
  getSessionUserMessageMarkers,
  getSessions,
  getSessionsList,
  inheritSessionWorkingDirectory,
  initializeSessionRepositoryIndex,
  invalidateSessionCache,
  onSessionIndexChanged,
  onSessionsDeleted,
  patchSessionFields,
  renameSession,
  resolveSessionSpaceId,
  updateMessageContent,
  updateMessageContentParts,
  updateMessageError,
  updateMessageReasoning,
  updateMessageSkill,
  updateMessageStep,
  updateMessageSteps,
  updateMessageStreaming,
  updateMessageThinkingTime,
  updateMessageToolCalls,
  updateMessageTurnContext,
  updateMessageUsage,
  updateSessionAgent,
  updateSessionArchived,
  updateSessionCollab,
  updateSessionContextSize,
  updateSessionGoal,
  updateSessionGoals,
  updateSessionModel,
  updateSessionPermissionMode,
  updateSessionPin,
  updateSessionPromptContext,
  updateSessionSummary,
  updateSessionTask,
  updateSessionTokenUsage,
  updateSessionVariables,
  updateSessionWorkingDirectory,
  updateSessionWorkingDirectoryRoots,
  updateSessionsIndexMetaForCommands,
  updateStepsUsageByTurn,
  landSessionAccountUsage as landSessionAccountUsageInStore,
} from './session-store.js'
export { createSessionLayer, ensureSessionWritable, getSessionManager } from './session-layer.js'
export type { SessionLayer } from './session-layer.js'
export { landSessionAccountUsage as landSessionAccountUsageFromAccount, updateSessionUsage } from './usage.js'
export { createSessionMemoryHolders } from './memory.js'
export { scheduleSessionListProjectionBackfillOnStartup } from './list-projection-backfill.js'

// ── 以下原是 `session-primitives.ts`(会话内核的出口),2026-10-03 并入 ─────────────────
export { Session } from './session.js'
export { SessionManager } from './session-manager.js'
export type { SessionState } from './session-state.js'
export { createEmptySessionState } from './session-state.js'
export {
  getCoreSessionManager,
  initializeCoreSessionLayer,
  isCoreSessionLayerInitialized,
  shutdownCoreSessionLayer,
} from './lifecycle.js'
export {
  formatSessionValidationResult,
  validateSessionStateConsistency,
} from './validation.js'
export type {
  CoreSessionValidationInput,
  CoreSessionValidationResult,
} from './validation.js'
export {
  deriveRetainedContextSize,
  getLatestStepUsage,
  isTokenUsage,
  repairSessionTimelineMetadata,
  sanitizeInterruptedStepRecursive,
} from './timeline.js'
export {
  sanitizeLoadedSession,
  sanitizeSessionOnStartup,
} from './commands.js'
// §17.7.1 批 2(#8b-i):会话账的折叠器。影子期只比不接,批 3 起是那几格的唯一产地。
export {
  createSessionAccountState,
  foldSessionAccount,
  reduceSessionAccount,
  SESSION_ACCOUNT_FIELDS,
} from './account.js'
export type {
  SessionAccountField,
  SessionAccountFoldContext,
  SessionAccountState,
  SessionAccountTruncationEffect,
  SessionAccountUsage,
} from './account.js'

// 事件溯源 S0(docs/design/session-event-sourcing-2026-08.md §9):
// 事件词表 + 编解码 + 两个纯投影。core 拥有类型,runtime 与 renderer 都从这里读。
export * from './events/index.js'
export * from './projection/index.js'
// U0(ui-event-stream-2026-08 §1 规则 1):part 边界只判一次 —— 落盘打包器与
// UI 小批发器共用这一台状态机。F4-c 定律二(§16.19)把它请进了编码器,
// 与打包/解包同住 `events/chunk-codec.ts`(经上面的 `events/index.js` 出口)。
// S3 只读查询面(§12):事件 → 轨迹树的纯装配器。CLI / HTTP / 轨迹面板同源。
export * from './trace/index.js'
export {
  applySessionContextSize,
  applyInheritedSessionWorkingDirectory,
  applySessionAgent,
  applySessionArchiveState,
  applySessionListProjectionToMeta,
  applySessionMessageAppendToMeta,
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
  landSessionAccountUsage,
  applySessionUpdatedAtToMeta,
  applySessionVariables,
  applySessionWorkingDirectory,
  applySessionWorkingDirectoryRoots,
  applyDefaultAgentIdToSessionMetas,
  CORE_DEFAULT_AGENT_ID,
  SESSION_LAST_MESSAGE_PREVIEW_LENGTH,
  collectChildSessionIds,
  collectSessionCascadeDeleteIds,
  createBranchSessionWithAdapters,
  createCoreBranchSessionRecord,
  createCoreSessionRecord,
  createSessionWithAdapters,
  deleteSessionWithAdapters,
  deriveSessionLastMessagePreview,
  extractSessionMeta,
  findLastPreviewableMessage,
  findSessionMeta,
  getSessionTokenUsageSnapshot,
  hasSessionUsageDetails,
  loadSessionWithAdapters,
  mergeSessionDetails,
  normalizeSessionVariables,
  normalizeWorkingDirectoryRoots,
  planSessionCascadeDelete,
  prependSessionMeta,
  resolveSessionDetailsSnapshot,
  subtractSessionMessageUsage,
  sumSessionMessageUsage,
  syncSessionSideEffectWithReadyAdapters,
  updateSessionIndexMeta,
} from './store-helpers.js'
export type {
  CoreTimelineMessage,
  CoreTimelineSession,
  CoreTimelineStep,
  CoreTokenUsage,
  CoreToolCallState,
  TimelineMetadataRepairOptions,
} from './timeline.js'
export type {
  CoreSession,
  ApplySessionSideEffectMutationWithAdaptersOptions,
  ApplySessionIndexMetaMutationWithAdaptersOptions,
  CoreContextVariableInput,
  CoreContextVariableScope,
  CoreContextVariableType,
  CoreNormalizedContextVariable,
  CoreSessionDetails,
  CoreSessionDetailsWithMessages,
  CoreSessionDeletePlan,
  CoreSessionLastTurnUsage,
  CoreSessionMetadataMutationResult,
  CoreSessionEditableMessage,
  CoreSessionIndexMessageSource,
  CoreSessionIndexTimestampSource,
  CoreSessionMessage,
  CoreSessionMessageWithId,
  CoreSessionMessageWithSteps,
  CoreSessionMessageWithUsage,
  CoreSessionMessageWithModelInfo,
  CoreSessionMeta,
  CoreSessionStepWithId,
  CoreSessionTokenUsage,
  CoreSessionWithMessageList,
  CoreSessionWithMessages,
  CoreSessionUsageFields,
  CoreSessionUsageSnapshot,
  CoreSessionCacheAdapter,
  CreateCoreBranchSessionRecordOptions,
  CreateCoreSessionRecordOptions,
  CreateBranchSessionWithAdaptersOptions,
  CreateSessionWithAdaptersOptions,
  DeleteSessionWithAdaptersOptions,
  DeleteSessionWithAdaptersResult,
  LoadSessionWithAdaptersOptions,
  LoadSessionWithAdaptersResult,
  NormalizeWorkingDirectoryRootsOptions,
  ResolveSessionDetailsSnapshotOptions,
  SessionDetailsMergeOptions,
  SyncSessionSideEffectWithReadyAdaptersOptions,
  SyncSessionSideEffectWithReadyAdaptersResult,
  SessionMetaExtractOptions,
  ApplySessionMetadataMutationWithAdaptersOptions,
  CoreSessionListProjectionUpdate,
  CoreSessionPreviewMessageSource,
} from './store-helpers.js'
export {
  buildSessionEventJumpIndex,
  buildSessionMessagesPageResponse,
  clampSessionMessagesPageLimit,
  collectTailMessages,
  DEFAULT_EVENT_CHUNK_SIZE,
  foldEventPageBackward,
  foldEventPageForward,
  isSessionEventNodeStart,
  listEventUserMessageMarkers,
  pageEventMessages,
  readLedgerWatermark,
  scanEventsBackward,
  toPagedEventMessage,
  userMarkersFromProjected,
  computeMessagesPageWindow,
  decodeJsonlLine,
  DEFAULT_TAIL_CHUNK_SIZE,
  encodeJsonlHeaderLine,
  encodeJsonlMessageLine,
  getMessagesPageFromLogSource,
  JSONL_LOG_VERSION,
  scanJsonlLog,
  decodeMessagePageCursor,
  encodeMessagePageCursor,
  getMessagesPageFromArray,
  getMessagesPageFromJson,
  getUserMessageMarkersFromArray,
  resolveSessionMessagesPage,
  resolveSessionUserMessageMarkers,
} from './storage/index.js'
export type {
  CollectTailMessagesResult,
  ComputeMessagesPageWindowOptions,
  BackwardScanOptions,
  EventPageFoldOptions,
  EventPageFoldResult,
  PageEventMessagesOptions,
  ScannedSessionEvent,
  SessionEventByteReader,
  SessionEventJumpIndex,
  SessionEventPageCursor,
  DecodedJsonlLine,
  IndexedSessionMessage,
  JsonlChunkReader,
  JsonlLogHeader,
  JsonlLogPageSource,
  JsonlLogScanResult,
  JsonlMessageEntry,
  ResolveSessionMessagesPageOptions,
  ResolveSessionUserMessageMarkersOptions,
  SessionMessagesPageWindow,
} from './storage/index.js'
export type {
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  ResolveSessionMessagesPageResult,
  ResolveSessionUserMessageMarkersResult,
  CoreSessionRepository,
  SessionMessagePageCursor,
  SessionMessagesPageAnchor,
  SessionMessagesPageDirection,
  SessionMessagesPageSource,
  SessionUserMessageMarkersSource,
  StoredChatMessage,
  TurnUsage,
  UserMessageMarker,
} from './storage/index.js'

/*
 * `applySessionCommand` / `adoptSessionCommandResult` / `SessionCommand` 一族 /
 * `CORE_STRUCTURAL_WRITE_PLAN` —— **已删除**(§17.7.1 批 3:老 reducer 退役)。
 * 留下的只有形状词汇。
 */
export type {
  CoreSessionCommandMessage,
  CoreSessionCommandSession,
  CoreSessionCommandStep,
} from './commands.js'
export { deepFreeze } from './session-deep-freeze.js'
// 以某个调用方的身份建会话 / 做一次会话操作 / 夹工作目录 / 删前校验归属(包根归位 B 从界面那条 `sessions` 域提上来,
// 界面的域与 ACP 认领远端会话共用这一份)。
export {
  authorizeSessionCascadeDelete,
  checkSessionCreateRequestAs,
  clampSessionWorkingDirectory,
  createPlainSessionAs,
  describeSessionError,
  publicCreatedSession,
  runSessionOpAs,
  sessionCallOptions,
  sessionResourceKernel,
  SessionNotFoundError,
  WORKDIR_SANDBOX_ERROR,
  type SessionCallerStorePort,
} from './session-caller-ops.js'
export {
  applyTimelineRepair,
  computeInterruptedStepRepair,
  computeInterruptedToolCallRepair,
  computeSessionRepairOnLoad,
  computeSessionTimelineMetadataRepair,
  computeStaleContextCompactContent,
} from './timeline.js'
export type {
  CoreSessionRepairMessagePatch,
  CoreSessionRepairResult,
  CoreTimelineMetadataRepair,
} from './timeline.js'

// ── providers 归位(D24,2026-10-04)从 `providers/` 搬来的两只:按「这条会话属于哪个空间」取那个空间的
// 生效设置与默认模型。`getSpaceSettings` 与设置入口的同名函数是同一个(这里原样转交),留在这里是因为
// 「会话 → 空间设置」那条换源缝的使用者从这一处取,测试也在这一处替换它。
export {
  getSessionSettings,
  getSpaceSettings,
} from './session-space-ai-settings.js'
export {
  resolveSessionSpaceDefaultSelection,
} from './session-space-defaults.js'
