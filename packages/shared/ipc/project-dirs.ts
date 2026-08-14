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
