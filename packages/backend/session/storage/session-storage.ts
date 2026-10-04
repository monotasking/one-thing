export {
  buildSessionMessagesPageResponse,
  clampSessionMessagesPageLimit,
  decodeMessagePageCursor,
  encodeMessagePageCursor,
  getMessagesPageFromArray,
  getUserMessageMarkersFromArray,
  resolveSessionMessagesPage,
  resolveSessionUserMessageMarkers,
} from './session-storage-pagination.js'
export type {
  IndexedSessionMessage,
  ResolveSessionMessagesPageOptions,
  ResolveSessionUserMessageMarkersOptions,
} from './session-storage-pagination.js'
export {
  decodeJsonlLine,
  encodeJsonlHeaderLine,
  encodeJsonlMessageLine,
  JSONL_LOG_VERSION,
  scanJsonlLog,
} from './jsonl/session-storage-jsonl-codec.js'
export type {
  DecodedJsonlLine,
  JsonlLogHeader,
  JsonlLogScanResult,
  JsonlMessageEntry,
} from './jsonl/session-storage-jsonl-codec.js'
export {
  collectTailMessages,
  computeMessagesPageWindow,
  DEFAULT_TAIL_CHUNK_SIZE,
  getMessagesPageFromLogSource,
} from './jsonl/session-storage-jsonl-pager.js'
export type {
  CollectTailMessagesResult,
  ComputeMessagesPageWindowOptions,
  JsonlChunkReader,
  JsonlLogPageSource,
  SessionMessagesPageWindow,
} from './jsonl/session-storage-jsonl-pager.js'
// §17.8 U1-a:桶只再导出**纯**的那一半。按路径读盘的
// `getMessagesPageFromJsonFilePath` 住 `./session-storage-json-message-page-file.js`,
// 目录内的调用方走叶子路径;外面从会话入口拿(入口本来就带 `node:fs`,这个桶保持纯)。
export { getMessagesPageFromJson } from './session-storage-json-message-page.js'
// 事件日志上的倒读分页(S2a,§3.2 / §11.1)。
export {
  buildSessionEventJumpIndex,
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
} from './events/session-storage-events.js'
export type {
  BackwardScanOptions,
  EventPageFoldOptions,
  EventPageFoldResult,
  PageEventMessagesOptions,
  ScannedSessionEvent,
  SessionEventByteReader,
  SessionEventJumpIndex,
  SessionEventPageCursor,
} from './events/session-storage-events.js'
export type {
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  ResolveSessionMessagesPageResult,
  ResolveSessionUserMessageMarkersResult,
  CoreSessionRepository,
  SessionMessagePageCursor,
  SessionMessagesPageSource,
  SessionUserMessageMarkersSource,
  SessionMessagesPageAnchor,
  SessionMessagesPageDirection,
  StoredChatMessage,
  TurnUsage,
  UserMessageMarker,
} from './session-storage-types.js'
