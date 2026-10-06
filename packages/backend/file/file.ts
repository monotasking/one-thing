/**
 * file —— 文件:工作目录里的文件读写、改名、删除、回滚、列目录与补全、ripgrep 列文件与搜文件、
 * 工作区文件监视,以及「接入目录」(这条会话能碰哪些目录)的唯一读法与 `dir:` / `git:` 两种资源。
 *
 * 对外交出六类东西:
 * - 文件操作:读 / 存 / 建 / 删 / 改名 / 列目录 / 取状态 / 在文件管理器里定位,以及回滚一只文件;
 * - 列文件与搜索:ripgrep 列文件、装上受管的 ripgrep 下载、文件搜索与目录补全;
 * - 接入目录:这条会话(或全局)能碰哪些目录、接入目录里的技能根;
 * - 工作区监视服务与它的改动回调形状;
 * - `dir:` 与 `git:` 资源的规格与常量;
 * - 几只调试日志口的形状。
 * 依赖 settings、space、session、logging 与包根的当前实例槽。
 */

// 文件操作。
export {
  createOnethingDirectory,
  createOnethingFile,
  deleteOnethingPath,
  listOnethingDirectory,
  readOnethingFileContent,
  renameOnethingPath,
  resolveOnethingRevealTarget,
  saveOnethingFileContent,
  statOnethingPath,
} from './file-operations.js'
export type { OnethingDirectoryEntry } from './file-operations.js'
export { rollbackOnethingFile } from './file-rollback.js'

// 列文件与搜索。
export { listFiles } from './file-ripgrep.js'
export { configureAppRipgrep } from './file-ripgrep-app-fetch.js'
export { listOnethingFileSearchEntriesForIpc } from './file-search.js'
export { listOnethingDirectoriesForCompletionForIpc } from './file-directory-listing.js'

// 「接入目录」的唯一读出口(包根归位 2,2026-10-03 从包根 `stores/` 并进来):这条会话能碰哪些目录。
export {
  getConnectedDirectories,
  getConnectedDirectoriesForSession,
  listConnectedSkillRoots,
} from './file-connected-directories.js'

// 工作区监视。
export { createWorkspaceWatchService } from './file-workspace-watch.js'
export type { WorkspaceFileChangedHandler } from './file-workspace-watch.js'

// `dir:` 与 `git:` 资源。
export { DIR_RESOURCE_SCHEME, dirResourceSpec } from './file-resource-spec.js'
export {
  GIT_DIFF_MAX_BYTES,
  GIT_FILE_MAX_BYTES,
  GIT_RESOURCE_SCHEME,
  GIT_UNTRACKED_COUNT_BUDGET_BYTES,
  gitResourceSpec,
} from './file-git-resource-spec.js'

// 调试日志口。
export type { OnethingFilesIpcLogger } from './file-search.js'
export type { OnethingDirectoryIpcLogger } from './file-directory-listing.js'
