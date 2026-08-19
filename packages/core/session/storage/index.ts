export {
  buildSessionMessagesPageResponse,
  clampSessionMessagesPageLimit,
  decodeMessagePageCursor,
  encodeMessagePageCursor,
  getMessagesPageFromArray,
  getUserMessageMarkersFromArray,
  resolveSessionMessagesPage,
  resolveSessionUserMessageMarkers,
} from './pagination.js'
export type {
  IndexedSessionMessage,
  ResolveSessionMessagesPageOptions,
  ResolveSessionUserMessageMarkersOptions,
} from './pagination.js'
export {
  decodeJsonlLine,
  encodeJsonlHeaderLine,
  encodeJsonlMessageLine,
  JSONL_LOG_VERSION,
  scanJsonlLog,
} from './jsonl/codec.js'
export type {
  DecodedJsonlLine,
  JsonlLogHeader,
  JsonlLogScanResult,
  JsonlMessageEntry,
} from './jsonl/codec.js'
export {
  collectTailMessages,
  computeMessagesPageWindow,
  DEFAULT_TAIL_CHUNK_SIZE,
  getMessagesPageFromLogSource,
} from './jsonl/pager.js'
export type {
  CollectTailMessagesResult,
  ComputeMessagesPageWindowOptions,
  JsonlChunkReader,
  JsonlLogPageSource,
  SessionMessagesPageWindow,
} from './jsonl/pager.js'
export {
  getMessagesPageFromJson,
  getMessagesPageFromJsonFilePath,
} from './json-message-page.js'
// 事件日志上的倒读分页(S2a,§3.2 / §11.1)。
export {
  buildSessionEventJumpIndex,
  DEFAULT_EVENT_CHUNK_SIZE,
  foldEventPageBackward,
  foldEventPageForward,
  isSessionEventNodeStart,
  listEventUserMessageMarkers,
  pageEventMessages,
  scanEventsBackward,
  toPagedEventMessage,
  userMarkersFromProjected,
} from './events/index.js'
export type {
  BackwardScanOptions,
  EventPageFoldOptions,
  EventPageFoldResult,
  PageEventMessagesOptions,
  ScannedSessionEvent,
  SessionEventByteReader,
  SessionEventJumpIndex,
  SessionEventPageCursor,
} from './events/index.js'
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
} from './types.js'
