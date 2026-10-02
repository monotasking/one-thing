import type { Project, ProjectIndexEntry } from './types.js'

export interface ProjectDirSummary {
  path: string
  paths: string[]
  description: string
  lastUsedAt: number
}

export interface ProjectDirRecord {
  path: string
  paths: string[]
  description: string
  addedAt: number
  lastUsedAt: number
}

/**
 * 名册 per-space(批 B4):五件套都带一个可选的 `workspaceId`,**缺省 = default**
 * 空间(= 老的 `<store>/project-dirs/`,零迁移)。web 端宿主没有 space 维度,
 * 永远传缺省。
 */
export interface ProjectDirsWorkspaceScoped {
  workspaceId?: string
}

export interface ProjectDirsListRequest extends ProjectDirsWorkspaceScoped {}

export interface ProjectDirsGetRequest extends ProjectDirsWorkspaceScoped {
  path: string
}

export interface ProjectDirsAddRequest extends ProjectDirsWorkspaceScoped {
  path: string
  paths?: string[]
  description?: string
}

export interface ProjectDirsUpdateRequest extends ProjectDirsWorkspaceScoped {
  path: string
  description?: string
  /** Full replacement root list; `paths[0]` becomes the new primary. */
  paths?: string[]
}

export interface ProjectDirsRemoveRequest extends ProjectDirsWorkspaceScoped {
  path: string
}

export interface OnethingProjectDirsIpcError {
  success: false
  error: string
  code: string
}

export type OnethingProjectDirsIpcResult<TPayload extends object = {}> =
  | ({ success: true } & TPayload)
  | OnethingProjectDirsIpcError

export function projectToOnethingProjectDirRecord(project: Project): ProjectDirRecord {
  return {
    path: project.path,
    paths: [...project.paths],
    description: project.description,
    addedAt: project.addedAt,
    lastUsedAt: project.lastUsedAt,
  }
}

export function listOnethingProjectDirsForIpc(
  options: {
    /** The space is already bound into these two closures by the host. */
    listEntries(): ProjectIndexEntry[]
    getProject(path: string): Project | null
  },
): OnethingProjectDirsIpcResult<{ entries: ProjectDirSummary[] }> {
  try {
    const entries = options.listEntries().map(entry => {
      const project = options.getProject(entry.path)
      return {
        path: entry.path,
        paths: [...entry.paths],
        description: project?.description ?? '',
        lastUsedAt: entry.lastUsedAt,
      }
    })
    return { success: true, entries }
  } catch (error) {
    return projectDirsIpcError(error)
  }
}

export function getOnethingProjectDirForIpc(
  options: {
    request: ProjectDirsGetRequest
    getProject(path: string): Project | null
  },
): OnethingProjectDirsIpcResult<{ project: ProjectDirRecord | null }> {
  try {
    const project = options.getProject(options.request.path)
    return { success: true, project: project ? projectToOnethingProjectDirRecord(project) : null }
  } catch (error) {
    return projectDirsIpcError(error)
  }
}

export function addOnethingProjectDirForIpc(
  options: {
    request: ProjectDirsAddRequest
    addProject(input: ProjectDirsAddRequest): Project
  },
): OnethingProjectDirsIpcResult<{ project: ProjectDirRecord }> {
  try {
    return {
      success: true,
      project: projectToOnethingProjectDirRecord(options.addProject(options.request)),
    }
  } catch (error) {
    return projectDirsIpcError(error)
  }
}

export function updateOnethingProjectDirForIpc(
  options: {
    request: ProjectDirsUpdateRequest
    updateProject(path: string, patch: { description?: string; paths?: string[] }): Project | null
  },
): OnethingProjectDirsIpcResult<{ project: ProjectDirRecord }> {
  try {
    const { description, paths } = options.request
    if (description === undefined && paths === undefined) {
      return {
        success: false,
        error: 'update requires a description and/or paths patch',
        code: 'BAD_REQUEST',
      }
    }
    const project = options.updateProject(options.request.path, { description, paths })
    if (!project) return projectDirsNotFound(options.request.path)
    return { success: true, project: projectToOnethingProjectDirRecord(project) }
  } catch (error) {
    return projectDirsIpcError(error)
  }
}

export function removeOnethingProjectDirForIpc(
  options: {
    request: ProjectDirsRemoveRequest
    removeProject(path: string): boolean
  },
): OnethingProjectDirsIpcResult {
  try {
    if (!options.removeProject(options.request.path)) return projectDirsNotFound(options.request.path)
    return { success: true }
  } catch (error) {
    return projectDirsIpcError(error)
  }
}

function projectDirsNotFound(path: string): OnethingProjectDirsIpcError {
  return {
    success: false,
    error: `No project for path "${path}"`,
    code: 'NOT_FOUND',
  }
}

function projectDirsIpcError(error: unknown): OnethingProjectDirsIpcError {
  return {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown project-dirs error',
    code: 'INTERNAL',
  }
}
