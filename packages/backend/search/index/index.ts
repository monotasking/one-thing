/**
 * 索引服务的桶出口(检索重建 S3a)。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位的
 * `packages/backend/search/index/` 那一段。
 *
 * **注意目录名与隔壁那个文件同名**:`search/index.ts`(检索这个功能的对外入口)与
 * `search/index/`(本目录)并存。这不是巧合也不是失误 —— 落位表就把索引服务放在
 * `search/index/`。本目录是检索的内部实现:功能目录之外不许直接引用它(2026-10-03 收口以后
 * `package.json` 里也没有指向这里的键了,从前那条 `"./runtime/search/index"` 精确键已删),
 * 目录里的文件按相对路径 import 它。
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
  DEFAULT_NOTE_EXTENSIONS,
  DEFAULT_NOTES_CAPABILITY,
  SKIPPED_VAULT_DIRECTORIES,
  VAULT_FEED_ID_PREFIX,
  VaultFeed,
  vaultFeedIdOf,
  vaultRelativeKey,
} from './vault-feed.js'
export type { VaultFeedOptions, VaultFeedSpec } from './vault-feed.js'

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
