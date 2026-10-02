import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOnethingStorePath } from '../storage/paths.js'
import { spaceDir } from '../spaces/persistence.js'
import { DEFAULT_SPACE_ID, isValidSpaceId } from '../spaces/types.js'
import {
  parseProject,
  parseProjectIndex,
  type Project,
  type ProjectIndex,
} from './types.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('projects')


let rootDirOverride: string | null = null

/** Overrides the **default space's** roster root only (batch B4). */
export function setRootDirForTests(dir: string | null): void {
  rootDirOverride = dir
}

/**
 * 名册的物理住址(批 B4:per-space)。
 *
 * default space **留在 `<store>/project-dirs/` 原地** —— 零迁移,与批 B3
 * 「default space 凭证源 = settings.ai 原地」同一个模式。非 default space 住
 * `workspaces/<id>/project-dirs/`,走 spaces 自己的 `spaceDir()`,所以两个模块
 * 的测试根覆盖是同一套(spaces 的 `setRootDirForTests` 一并管住非 default 的名册)。
 *
 * 非法 id 一律落回 default:id 会成为路径片段,放行 `..` 等于放行任意路径写入
 * (与 spaces 门口同一条闸)。
 */
export function projectDirsRoot(spaceId?: string): string {
  if (!spaceId || spaceId === DEFAULT_SPACE_ID || !isValidSpaceId(spaceId)) {
    // Lazy + env-aware: headless hosts scope the store via ONETHING_STORE_PATH
    // (a hardcoded ~/.onething here once let an isolated server write into the
    // user's real store). Desktop behavior is unchanged — env unset resolves to
    // ~/.onething.
    return rootDirOverride ?? path.join(getOnethingStorePath(), 'project-dirs')
  }
  return path.join(spaceDir(spaceId), 'project-dirs')
}

function indexPath(spaceId?: string): string {
  return path.join(projectDirsRoot(spaceId), 'index.json')
}

function dataDir(spaceId?: string): string {
  return path.join(projectDirsRoot(spaceId), 'data')
}

function projectFilePath(id: string, spaceId?: string): string {
  return path.join(dataDir(spaceId), `${id}.json`)
}

function ensureDirs(spaceId?: string): void {
  fs.mkdirSync(projectDirsRoot(spaceId), { recursive: true })
  fs.mkdirSync(dataDir(spaceId), { recursive: true })
}

export function loadIndex(spaceId?: string): ProjectIndex {
  try {
    if (!fs.existsSync(indexPath(spaceId))) return { projects: [] }
    const parsed = parseProjectIndex(JSON.parse(fs.readFileSync(indexPath(spaceId), 'utf-8')))
    if (!parsed) {
      log.warn('project index schema validation failed, treating as empty', { spaceId })
      return { projects: [] }
    }
    return parsed
  } catch (err) {
    log.warn('project index read failed', { spaceId }, err)
    return { projects: [] }
  }
}

export function saveIndex(index: ProjectIndex, spaceId?: string): void {
  ensureDirs(spaceId)
  fs.writeFileSync(indexPath(spaceId), JSON.stringify(index, null, 2), 'utf-8')
}

export function loadProject(id: string, spaceId?: string): Project | null {
  const file = projectFilePath(id, spaceId)
  try {
    if (!fs.existsSync(file)) return null
    const project = parseProject(JSON.parse(fs.readFileSync(file, 'utf-8')))
    if (!project) {
      log.warn('project record schema validation failed, ignored', { projectId: id })
      return null
    }
    return project
  } catch (err) {
    log.warn('project record read failed', { projectId: id }, err)
    return null
  }
}

export function saveProject(project: Project, spaceId?: string): void {
  ensureDirs(spaceId)
  fs.writeFileSync(
    projectFilePath(project.id, spaceId),
    JSON.stringify(project, null, 2),
    'utf-8',
  )
}

export function deleteProject(id: string, spaceId?: string): void {
  const file = projectFilePath(id, spaceId)
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch (err) {
    log.warn('project record delete failed', { projectId: id }, err)
  }
}
