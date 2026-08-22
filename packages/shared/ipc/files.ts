/**
 * files(文件面)域的传输契约 —— 结构债 P4c 第八批。
 *
 * 十四条数据面从手写 IPC 通道(`IPC_CHANNELS.FILES_LIST` / `FILE_*` / `DIRS_LIST`)
 * 迁到通用 `rpc:invoke` / `POST /api/rpc`。留在通道表里的只有一条**推送**:
 * `FILE_WATCH_EVENT`(router 今天没有推送面)。
 *
 * 形状取自两处**本来就一致**的定义:`@onething/runtime/files` 的投影层
 * (`Onething*Request` / `Onething*Response`)与渲染层 `types/index.ts` 上那批
 * 壳方法的返回类型。这里重写一遍而不是 re-export runtime 的类型,是因为
 * `packages/shared` 在依赖方向上位于 runtime **之下**(壳与 server 都要 import
 * 它),不能反过来指向产品层 —— 同 `themes` / `oauth` 判例。
 *
 * ## 一条不同于旧壳的口径:统一成信封
 *
 * 被删掉的壳方法有一半是**位置参数**的(`readFileContent(path, maxSize)`、
 * `renamePath(old, new)`、`statPath(path)`)。router 一律收对象:
 * `filesApi.readContent({ path, maxSize })`、`filesApi.rename({ oldPath, newPath })`。
 * 与 themes / oauth 同判例 —— 不为了少改几行调用点而在客户端包一层旧签名。
 */

export type FileEntryType = 'file' | 'directory'
export type FileSearchEntrySource = 'workdir' | 'downloads' | 'note' | 'connected'

export interface FileSearchEntry {
  path: string
  type: FileEntryType
  source?: FileSearchEntrySource
  label?: string
}

export interface FilesListRequest {
  cwd?: string
  query?: string
  limit?: number
  /**
   * 发起这次补全的会话(批 B2)。接入目录是 per-space 的,而「哪个 space」由
   * **会话归属**决定。缺席 = 只给全局层。
   */
  sessionId?: string
}

export interface FilesListResponse {
  success: boolean
  files: string[]
  entries?: FileSearchEntry[]
  error?: string
}

export interface FilesRollbackRequest {
  auditPath?: string
  filePath?: string
  originalContent?: string
  isNew?: boolean
}

export interface FilesRollbackResponse {
  success: boolean
  error?: string
  auditId?: string
  filePath?: string
  restoredExists?: boolean
}

export interface FilesListDirsRequest {
  basePath: string
  query?: string
  limit?: number
}

export interface FilesListDirsResponse {
  success: boolean
  dirs: string[]
  basePath: string
  error?: string
}

export interface FilesReadContentRequest {
  path: string
  maxSize?: number
}

export interface FilesReadContentResponse {
  success: boolean
  content?: string
  encoding?: string
  size?: number
  mtimeMs?: number
  isBinary?: boolean
  error?: string
}

export interface FilesSaveContentRequest {
  path: string
  content: string
  expectedMtimeMs?: number
}

export interface FilesSaveContentResponse {
  success: boolean
  mtimeMs?: number
  conflict?: boolean
  error?: string
}

export interface FilesDirectoryEntry {
  name: string
  path: string
  type: FileEntryType
  size?: number
  mtimeMs?: number
}

export interface FilesListDirectoryRequest {
  path: string
}

export interface FilesListDirectoryResponse {
  success: boolean
  entries?: FilesDirectoryEntry[]
  error?: string
}

export interface FilesStatRequest {
  path: string
}

export interface FilesStatResponse {
  success: boolean
  type?: FileEntryType
  size?: number
  mtimeMs?: number
  /** 实际 stat 的绝对路径(`~` 已展开);调用方后续读/开/显示都该用它。 */
  path?: string
  error?: string
}

export interface FilesCreateRequest {
  path: string
  content?: string
}

export interface FilesCreateDirectoryRequest {
  path: string
}

export interface FilesRenameRequest {
  oldPath: string
  newPath: string
}

export interface FilesDeleteRequest {
  path: string
}

export interface FilesRevealRequest {
  path: string
}

export interface FilesWatchRequest {
  root: string
}

/** 增删改 / reveal / watch 共用的结果形状。 */
export interface FilesActionResponse {
  success: boolean
  error?: string
}

/** `FILE_WATCH_EVENT` 推送的负载 —— 留在通道表里的唯一一条 files 通道。 */
export interface FilesWatchEvent {
  root: string
  path: string
  eventType: string
}

// ============================================
// Router
// ============================================

/**
 * files 域 —— 十四条方法逐条对应从前那十四条 invoke 通道。
 *
 * **这是全仓第一个逐方法带 http 夹紧的域**(#19 的安全面):
 * `transport:'ipc'`(桌面)不夹,与迁移前 `@main` handler 逐字同义;
 * `transport:'http'`(server)每条带路径的方法都夹进 `sandboxRoot`,越界回
 * 旧 server 路由原话的结构化失败。逐条口径写在
 * `packages/backend/rpc/domains/files.ts` 的文件头表里。
 */
import { defineRouter } from './router.js'

export type FilesRoutes = {
  list: { input: FilesListRequest; output: FilesListResponse }
  rollback: { input: FilesRollbackRequest; output: FilesRollbackResponse }
  listDirs: { input: FilesListDirsRequest; output: FilesListDirsResponse }
  readContent: { input: FilesReadContentRequest; output: FilesReadContentResponse }
  saveContent: { input: FilesSaveContentRequest; output: FilesSaveContentResponse }
  listDirectory: { input: FilesListDirectoryRequest; output: FilesListDirectoryResponse }
  stat: { input: FilesStatRequest; output: FilesStatResponse }
  create: { input: FilesCreateRequest; output: FilesActionResponse }
  createDirectory: { input: FilesCreateDirectoryRequest; output: FilesActionResponse }
  rename: { input: FilesRenameRequest; output: FilesActionResponse }
  delete: { input: FilesDeleteRequest; output: FilesActionResponse }
  reveal: { input: FilesRevealRequest; output: FilesActionResponse }
  watchStart: { input: FilesWatchRequest; output: FilesActionResponse }
  watchStop: { input: FilesWatchRequest; output: FilesActionResponse }
}

export const filesRouter = defineRouter<FilesRoutes>('files', [
  'list',
  'rollback',
  'listDirs',
  'readContent',
  'saveContent',
  'listDirectory',
  'stat',
  'create',
  'createDirectory',
  'rename',
  'delete',
  'reveal',
  'watchStart',
  'watchStop',
])
