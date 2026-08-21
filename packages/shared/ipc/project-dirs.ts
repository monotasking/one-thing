/**
 * IPC types for the project-dirs subsystem.
 *
 * Shape mirrors the on-disk Project record minus the internal `id`
 * (clients work with `path`). New optional fields added to Project
 * propagate here as `.optional()` properties.
 */

export interface ProjectDirSummary {
  /** Primary root (`paths[0]`) — the session cwd anchor. */
  path: string
  /** All roots, primary first. */
  paths: string[]
  description: string
  lastUsedAt: number
}

export interface ProjectDirRecord {
  /** Primary root (`paths[0]`) — the session cwd anchor. */
  path: string
  /** All roots, primary first. */
  paths: string[]
  description: string
  addedAt: number
  lastUsedAt: number
  // Future: reflections?, tags?, etc.
}

/**
 * 名册 per-space(批 B4)。五件套请求都可带 `workspaceId`,**缺省 = default 空间**
 * (= `<store>/project-dirs/` 原地,零迁移)。web 宿主无 space 维度,永远走缺省。
 */
export interface ProjectDirsWorkspaceScoped {
  workspaceId?: string
}

export interface ProjectDirsListRequest extends ProjectDirsWorkspaceScoped {}

export interface ProjectDirsListResponse {
  success: boolean
  entries?: ProjectDirSummary[]
  error?: string
  code?: string
}

export interface ProjectDirsGetRequest extends ProjectDirsWorkspaceScoped {
  path: string
}
export interface ProjectDirsGetResponse {
  success: boolean
  project?: ProjectDirRecord | null
  error?: string
  code?: string
}

export interface ProjectDirsAddRequest extends ProjectDirsWorkspaceScoped {
  path: string
  paths?: string[]
  description?: string
}
export interface ProjectDirsAddResponse {
  success: boolean
  project?: ProjectDirRecord
  error?: string
  code?: string
}

export interface ProjectDirsUpdateRequest extends ProjectDirsWorkspaceScoped {
  path: string
  description?: string
  /** Full replacement root list; `paths[0]` becomes the new primary. */
  paths?: string[]
}
export interface ProjectDirsUpdateResponse {
  success: boolean
  project?: ProjectDirRecord
  error?: string
  code?: string
}

export interface ProjectDirsRemoveRequest extends ProjectDirsWorkspaceScoped {
  path: string
}
export interface ProjectDirsRemoveResponse {
  success: boolean
  error?: string
  code?: string
}

/**
 * project-dirs(项目目录名册)域 —— 结构债 P4c 第六域。
 *
 * 五件套全是**纯数据面**,判定与错误码住在 `@onething/runtime/project-dirs` 的
 * 投影里,传输面只按请求里的 `workspaceId` 取那个空间的 store。
 *
 * **迁后 web 行为会变(变对)**:被删掉的 `platform/web.ts` 那五条 REST 镜像
 * 把 `workspaceId` 收下就丢(参数名带下划线),server 那侧也没有 space 维度 ——
 * 于是浏览器里切空间等于没切,五件套永远打在 default 名册上。走 router 之后
 * `workspaceId` 真的传下去了,web 与桌面看见的是同一份 per-space 名册。
 */
import { defineRouter } from './router.js'

export type ProjectDirsRoutes = {
  list: { input: ProjectDirsListRequest; output: ProjectDirsListResponse }
  get: { input: ProjectDirsGetRequest; output: ProjectDirsGetResponse }
  add: { input: ProjectDirsAddRequest; output: ProjectDirsAddResponse }
  update: { input: ProjectDirsUpdateRequest; output: ProjectDirsUpdateResponse }
  remove: { input: ProjectDirsRemoveRequest; output: ProjectDirsRemoveResponse }
}

export const projectDirsRouter = defineRouter<ProjectDirsRoutes>('projectDirs', [
  'list',
  'get',
  'add',
  'update',
  'remove',
])
