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

// 事件溯源 S0(docs/design/session-event-sourcing-2026-08.md §9):
// 事件词表 + 编解码 + 两个纯投影。core 拥有类型,runtime 与 renderer 都从这里读。
export * from './events/index.js'
export * from './projection/index.js'
// R-a(§13.6):崩溃收口的单一口径(prepare / sanitize / 投影三处共用)。
export * from './interrupted.js'
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
  applySessionUpdatedAtToMeta,
  applySessionVariables,
  applySessionWorkingDirectory,
  applySessionWorkingDirectoryRoots,
  applyDefaultAgentIdToSessionMetas,
  CORE_DEFAULT_AGENT_ID,
  collectChildSessionIds,
  collectSessionCascadeDeleteIds,
  createBranchSessionWithAdapters,
  createCoreBranchSessionRecord,
  createCoreSessionRecord,
  createSessionWithAdapters,
  deleteSessionWithAdapters,
  extractSessionMeta,
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
  getMessagesPageFromJsonFilePath,
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

export {
  adoptSessionCommandResult,
  applySessionCommand,
  CORE_STRUCTURAL_WRITE_PLAN,
} from './commands.js'
export type {
  CoreSessionCommandMessage,
  CoreSessionCommandSession,
  CoreSessionCommandStep,
  CoreSessionWritePlan,
  SessionCommand,
  SessionCommandMeta,
  SessionCommandRepairPatches,
  SessionCommandResult,
  SessionCommandWriteHint,
} from './commands.js'
export { deepFreeze } from '../freeze.js'
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
