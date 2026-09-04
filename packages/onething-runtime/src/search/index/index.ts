/**
 * 索引服务的桶出口(检索重建 S3a)。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位的
 * `packages/onething-runtime/src/search/index/` 那一段。
 *
 * **注意目录名与隔壁那个文件同名**:`search/index.ts`(S2 的能力桶)与
 * `search/index/`(本目录)并存,`package.json` 的 `"./search/index"` 是一条**精确
 * 键**指向这里,精确键胜过 `"./search/*"` 通配。这不是巧合也不是失误 —— 落位表就
 * 把索引服务放在 `search/index/`,而 core 那边 `"./search/index": "./search/index/index.ts"`
 * 早已是同一个形。
 *
 * `worker.ts` **不**从这里出口:它是 Worker 的进程入口(顶层就 `new SqliteIndex`),
 * 被 import 一次就会去开库。宿主的构建配方直接指那个文件。
 */

export { SqliteIndex, DEFAULT_MAX_FIELD_CHARS, SQLITE_INDEX_SCHEMA_VERSION } from './sqlite-index.js'
export type { SqliteIndexOptions } from './sqlite-index.js'

export {
  DEFAULT_MESSAGE_CAPABILITY,
  DEFAULT_SESSION_CAPABILITY,
  DEFAULT_TOUCHED_FILE_ARGS,
  IndexProjector,
  REL_IN_SESSION,
  REL_TOUCHED_FILE,
} from './projector.js'
export type {
  IndexProjectorOptions,
  ProjectSessionInput,
  SessionMetaSnapshot,
  TouchedFileArgTable,
} from './projector.js'

export {
  DIRECTORY_POLL_INTERVAL_MS,
  DIRECTORY_WATCH_DEBOUNCE_MS,
  LEDGER_FEED_ID,
  LedgerFeed,
  readLastSeq,
  readSessionMeta,
} from './ledger-feed.js'
export type { LedgerFeedOptions, SubscribeAdapter } from './ledger-feed.js'

export {
  DAILY_FEED_ID,
  DEFAULT_DAILY_CAPABILITY,
  DEFAULT_DAILY_EXTENSIONS,
  DailyNotesFeed,
} from './daily-feed.js'
export type { DailyNotesFeedOptions } from './daily-feed.js'

export { defaultDocumentFilters, exclusionFilter, redactionFilter } from './filters.js'
export type { ExclusionPredicate } from './filters.js'

export { ENQUEUE_DEBOUNCE_MS, IndexWorkerCore } from './worker-core.js'
export type {
  IndexEndpoint,
  IndexKeyError,
  IndexSearchRequest,
  IndexSearchResult,
  IndexStatus,
  IndexWorkerCoreOptions,
  IndexWorkerRequest,
  IndexWorkerResponse,
  IndexWriteFace,
} from './worker-core.js'

export { IndexWorkerHost, IndexWorkerUnavailableError, MAX_CONSECUTIVE_CRASHES } from './worker-host.js'
export type { IndexWorkerFactory, IndexWorkerHandle } from './worker-host.js'

export { SearchIndexService, createSqliteLexicalRetriever } from './service.js'
export type { SearchIndexServiceOptions, SqliteLexicalRetrieverOptions } from './service.js'

export type { IndexWorkerData } from './worker-data.js'
