import { projectIdFromPath } from './id.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('projects')

import {
  deleteProject,
  loadIndex,
  loadProject,
  saveIndex,
  saveProject,
} from './persistence.js'
import { DEFAULT_SPACE_ID, isValidSpaceId } from '../spaces/types.js'
import {
  normalizeProjectRoots,
  projectRootsInclude,
  type Project,
  type ProjectIndex,
  type ProjectIndexEntry,
} from './types.js'

export class ProjectsStore {
  private index: ProjectIndex = { projects: [] }
  private initialized = false
  private listeners = new Set<() => void>()

  /**
   * 名册按 space 分家(批 B4)。一个实例只认自己那份盘上的名册,同一个目录可以
   * 在两个空间各自成项目,互不知晓。
   */
  constructor(readonly spaceId: string = DEFAULT_SPACE_ID) {}

  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    this.index = loadIndex(this.spaceId)
  }

  list(): ProjectIndexEntry[] {
    this.initialize()
    return [...this.index.projects]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map(e => ({ ...e, paths: [...e.paths] }))
  }

  /** Look up by any root, not just the primary. */
  get(path: string): Project | null {
    this.initialize()
    const entry = this.findIndexEntry(path)
    if (!entry) return null
    return loadProject(entry.id, this.spaceId)
  }

  /**
   * Upsert. When `path` (or any of `paths`) hits an existing project the hit
   * is refreshed in place — lastUsedAt bumps, an explicit description
   * replaces, extra `paths` union in, and the project's identity (id +
   * primary root) stays put. Only a full miss mints a new record, whose id
   * derives from the primary root at creation time and never changes after.
   */
  add(input: { path: string; paths?: string[]; description?: string }): Project {
    this.initialize()
    const roots = normalizeProjectRoots(input.path, input.paths ?? [])
    if (!roots) {
      throw new Error('project requires a non-empty path')
    }
    const now = Date.now()
    const existingEntry = this.findIndexEntryByAnyRoot(roots)
    const existing = existingEntry ? loadProject(existingEntry.id, this.spaceId) : null

    const project: Project = existing
      ? {
        ...existing,
        // Union: keep the existing identity/order, append newly-added roots.
        paths: normalizeProjectRoots(existing.path, [...existing.paths, ...roots]) ?? existing.paths,
        description: input.description ?? existing.description,
        lastUsedAt: now,
      }
      : {
        id: projectIdFromPath(roots[0]),
        path: roots[0],
        paths: roots,
        description: input.description ?? '',
        addedAt: now,
        lastUsedAt: now,
      }
    project.path = project.paths[0]

    saveProject(project, this.spaceId)
    this.upsertIndexEntry({
      id: project.id,
      path: project.path,
      paths: project.paths,
      lastUsedAt: project.lastUsedAt,
    })
    this.notify()
    return project
  }

  /** Bump lastUsedAt for whichever project owns `path`; register it if none does. */
  touch(path: string, fallbackDescription = ''): Project {
    this.initialize()
    const existing = this.get(path)
    if (existing) {
      // Refresh via the existing primary so a secondary-root touch never
      // rewrites the project's identity.
      return this.add({ path: existing.path })
    }
    return this.add({ path, description: fallbackDescription })
  }

  /**
   * Patch description and/or the full root list. A `paths` patch replaces the
   * list wholesale — `paths[0]` becomes the new primary — while the id stays
   * stable (moving/re-rooting a project no longer changes its identity).
   */
  update(path: string, patch: { description?: string; paths?: string[] }): Project | null {
    this.initialize()
    const entry = this.findIndexEntry(path)
    if (!entry) return null
    const existing = loadProject(entry.id, this.spaceId)
    if (!existing) return null

    let nextPaths = existing.paths
    if (patch.paths) {
      const normalized = normalizeProjectRoots(patch.paths[0] ?? '', patch.paths.slice(1))
      if (!normalized) {
        throw new Error('project requires at least one non-empty root')
      }
      nextPaths = normalized
    }

    const next: Project = {
      ...existing,
      path: nextPaths[0],
      paths: nextPaths,
      description: patch.description ?? existing.description,
    }
    saveProject(next, this.spaceId)
    this.upsertIndexEntry({ id: next.id, path: next.path, paths: next.paths, lastUsedAt: next.lastUsedAt })
    this.notify()
    return next
  }

  /** Unregister the whole project owning `path` (matched by any root). */
  remove(path: string): boolean {
    this.initialize()
    const entry = this.findIndexEntry(path)
    if (!entry) return false
    deleteProject(entry.id, this.spaceId)
    this.index = {
      projects: this.index.projects.filter(p => p.id !== entry.id),
    }
    saveIndex(this.index, this.spaceId)
    this.notify()
    return true
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  resetForTests(): void {
    this.index = { projects: [] }
    this.initialized = false
    this.listeners.clear()
  }

  private findIndexEntry(path: string): ProjectIndexEntry | undefined {
    return this.index.projects.find(p => projectRootsInclude(p.paths, path))
  }

  private findIndexEntryByAnyRoot(roots: readonly string[]): ProjectIndexEntry | undefined {
    for (const root of roots) {
      const hit = this.findIndexEntry(root)
      if (hit) return hit
    }
    return undefined
  }

  private upsertIndexEntry(entry: ProjectIndexEntry): void {
    const idx = this.index.projects.findIndex(p => p.id === entry.id)
    if (idx >= 0) {
      this.index = {
        projects: this.index.projects.map((p, i) => (i === idx ? entry : p)),
      }
    } else {
      this.index = { projects: [...this.index.projects, entry] }
    }
    saveIndex(this.index, this.spaceId)
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb()
      } catch (err) {
        log.error('project store listener failed', undefined, err)
      }
    }
  }
}

/**
 * per-space 实例表(批 B4)。进程单例从「一个」变成「一个 space 一个」——
 * 缺省 / `'default'` / 非法 id 一律映到 default 那份(= 老的 `<store>/project-dirs/`,
 * 零迁移)。仿 apps/server 的 `*ByOwner` 模式:实例常驻,不做过期回收
 * (一个空间一份索引,体量与 space 数同阶)。
 */
const stores = new Map<string, ProjectsStore>()

function normalizeStoreSpaceId(spaceId?: string | null): string {
  if (!spaceId || !isValidSpaceId(spaceId)) return DEFAULT_SPACE_ID
  return spaceId
}

export function getProjectsStore(spaceId?: string | null): ProjectsStore {
  const key = normalizeStoreSpaceId(spaceId)
  let store = stores.get(key)
  if (!store) {
    store = new ProjectsStore(key)
    stores.set(key, store)
  }
  return store
}

/** 清整表(不只是 default)。返回 default space 的新实例,与旧签名兼容。 */
export function resetProjectsStoreForTests(): ProjectsStore {
  stores.clear()
  return getProjectsStore()
}

/** 丢掉某个 space 的缓存实例 —— 删空间时连坐,免得幽灵实例把索引写回已删目录。 */
export function forgetProjectsStore(spaceId: string): void {
  stores.delete(normalizeStoreSpaceId(spaceId))
}
