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
  INDEX_DOCUMENT_EFFECTS,
  IndexProjector,
  REL_IN_SESSION,
  REL_TOUCHED_FILE,
  affectsIndexedDocuments,
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
  readRecordsAfter,
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

export {
  SqliteVectorIndex,
  attachVectorIndex,
  probeSqliteVecExtension,
  sqliteVecExtensionPath,
  vecTableName,
} from './sqlite-vec.js'
export type { SqliteVecOpenOptions, SqliteVectorIndexOptions } from './sqlite-vec.js'

export {
  DEFAULT_INDEX_MAINTENANCE_POLICY,
  shouldOptimizeFullText,
  shouldVacuum,
  vectorTableFamily,
} from './storage.js'
export type {
  IndexMaintenancePolicy,
  IndexMaintenanceStats,
  IndexStorageBreakdown,
} from './storage.js'

export { EMBED_BATCH_SIZE, VectorWriter } from './vector-writer.js'
export type { VectorState, VectorWriterIndexFace, VectorWriterOptions } from './vector-writer.js'

export {
  MODEL_IN_USE_ERROR,
  MODEL_NOT_DOWNLOADABLE_ERROR,
  ModelDownloader,
} from './model-download.js'
export type {
  ModelDownloadSignalSource,
  ModelDownloaderOptions,
  ModelState,
  ModelStatus,
} from './model-download.js'

export {
  ENQUEUE_DEBOUNCE_MS,
  IndexWorkerCore,
  MODEL_UNAVAILABLE_ERROR,
  WORKER_MODEL_MESSAGE_TYPE,
  isWorkerModelMessage,
} from './worker-core.js'
export type {
  IndexEndpoint,
  IndexKeyError,
  IndexModelOp,
  IndexSearchRequest,
  IndexSearchResult,
  IndexStatus,
  IndexStorage,
  IndexVectorSearchRequest,
  IndexVectorSearchResult,
  IndexWorkerCoreOptions,
  IndexWorkerRequest,
  IndexWorkerResponse,
  IndexWriteFace,
  WorkerModelMessage,
} from './worker-core.js'

export { IndexWorkerHost, IndexWorkerUnavailableError, MAX_CONSECUTIVE_CRASHES } from './worker-host.js'
export type { IndexWorkerFactory, IndexWorkerHandle } from './worker-host.js'

export {
  SearchIndexService,
  createSqliteLexicalRetriever,
  createSqliteVectorRetriever,
} from './service.js'
export type {
  SearchIndexServiceOptions,
  SqliteLexicalRetrieverOptions,
  SqliteVectorRetrieverOptions,
} from './service.js'

export type { IndexWorkerData } from './worker-data.js'
