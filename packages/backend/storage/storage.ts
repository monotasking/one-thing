/**
 * storage:store 目录在哪、文件怎么原子地读写(层次 L0,基础件)。
 *
 * 所有落在用户 store(`ONETHING_STORE_PATH` → `~/.onething`)里的路径都从这里问,不许各自拼;
 * 读写 JSON / 文本 / 二进制、带缓存的 JSON 文件、异步保存队列、LRU 缓存这些原语也在这里。
 * 另有几样 store 级的小件:应用状态文件、单写者的 store 锁与租约、备份与恢复,以及打包资源目录的宿主注入口。
 *
 * 对外交出七类东西(下面按类分组):路径、读写原语、耐久写与文本追加、应用状态、store 锁与租约、
 * 备份与恢复、打包资源目录。
 *
 * 依赖:logging。只用具名导出;读写原语经 `storage-primitives.ts` 那个桶转交(几十只测试在那只桶上打桩,
 * 经桶转交桩才拦得住改走入口的读者),其余每个名字从声明它的那只文件转交;只交外面真在用的名字。
 */

// 1. 路径:store 根与其下各目录、各文件
export {
  ensureOnethingStoreDirs,
  getOnethingAcpRegistryCachePath,
  getOnethingAgentsPath,
  getOnethingAppStatePath,
  getOnethingAuditDir,
  getOnethingCachePath,
  getOnethingDebugDir,
  getOnethingEvalsDir,
  getOnethingEvalsFixturesAutoDir,
  getOnethingEvalsIncidentsDir,
  getOnethingEvalsOnlineRecordsPath,
  getOnethingFileMutationsDir,
  getOnethingLogDir,
  getOnethingMCPOAuthCredentialsPath,
  getOnethingMCPToolsCatalogPath,
  getOnethingMediaFilesDir,
  getOnethingMediaImagesDir,
  getOnethingMediaIndexPath,
  getOnethingPermissionsDir,
  getOnethingPetsDir,
  getOnethingPluginDataDir,
  getOnethingPromptsPath,
  getOnethingResourceAuditPath,
  getOnethingRunDir,
  getOnethingSchedulerRunsDir,
  getOnethingSchedulerTasksPath,
  getOnethingSessionPath,
  getOnethingSessionsDir,
  getOnethingSettingsPath,
  getOnethingStorePath,
  getOnethingToolOutputsDir,
  getOnethingVariablesPath,
  getOnethingWorkspacesDir,
} from './storage-paths.js'
export type { OnethingStorePathOptions } from './storage-paths.js'

// 2. 读写原语:JSON / 文本 / 二进制、目录、路径小工具、带缓存的 JSON 文件、异步保存队列、LRU 缓存、文件锁
export {
  AsyncSaveQueue,
  basenamePath,
  createCoreCachedJsonState,
  deleteJsonFile,
  dirnamePath,
  ensureDir,
  ensureDirAsync,
  extnamePath,
  getCoreCachedJsonFile,
  initializeCoreCachedJsonFile,
  invalidateCoreCachedJsonFile,
  isAbsolutePath,
  isCoreCachedJsonInitialized,
  isDirectory,
  isFile,
  joinPaths,
  listFilesUnderRoots,
  LRUCache,
  pathExists,
  pathExistsInDir,
  readBinaryFile,
  readJsonFile,
  readTextFile,
  resolvePath,
  saveCoreCachedJsonFile,
  statPath,
  updateCoreCachedJsonInMemory,
  withFileLockSync,
  writeJsonFile,
  writeJsonFileAsync,
  writeTextFile,
  writeTextFileAsync,
  writeTextFileInDir,
} from './storage-primitives.js'
export type { AsyncSaveQueueOptions, CoreCachedJsonFileOptions, CoreCachedJsonState } from './storage-primitives.js'

// 3. 耐久写与文本追加
export { syncDirectoryChain, writeDurableJson } from './storage-durable-json.js'
export { appendTextFile, writeTextFileIfMissing } from './storage-json-file.js'

// 4. 应用状态(当前会话、当前空间、界面状态)
export {
  DEFAULT_ONETHING_APP_STATE,
  getOnethingCurrentSessionId,
  getOnethingCurrentWorkspaceId,
  readOnethingAppState,
  saveOnethingUiState,
  saveOnethingUiStateForIpc,
  setOnethingCurrentSessionId,
  setOnethingCurrentWorkspaceId,
  writeOnethingAppState,
} from './storage-app-state.js'
export type { OnethingUiStatePatch } from './storage-app-state.js'

// 5. store 锁与租约(一个 store 只有一个写者)
export {
  canonicalizeStorePath,
  createStoreLease,
  inspectStoreLock,
  quarantineStoreLockForRecovery,
  StoreLock,
} from './storage-store-lock.js'
export type { StoreLease, StoreLockIdentity, StoreLockOwner } from './storage-store-lock.js'

// 6. 备份与恢复
export {
  createStoreBackup,
  restoreStoreBackup,
  STORE_RESTORE_PENDING,
  verifyStoreBackup,
} from './storage-store-backup.js'

// 7. 打包资源目录:定位规则与宿主注入口
export { findBuiltinResourcePath, getBuiltinResourcePath } from './storage-builtin-resources.js'
export { configureStorePathHost, getMacOSAutomationDocsPath, resetStorePathHost } from './storage-docs-paths.js'
export type { StorePathHost } from './storage-docs-paths.js'
