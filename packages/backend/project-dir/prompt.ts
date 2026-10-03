import * as os from 'node:os'
import { getProjectsStore } from './store.js'
import { canonicalizeProjectRoot, type Project, type ProjectIndexEntry } from './types.js'

export interface ActiveProjectVars {
  hasActive: boolean
  /** Primary root (the cwd anchor). */
  path?: string
  displayPath?: string
  /** Every root of the project, primary first. */
  paths?: string[]
  displayPaths?: string[]
  description?: string
}

export interface KnownProjectsVars {
  hasAny: boolean
  entries: Array<{ path: string; displayPath: string; displayPaths: string[]; description: string }>
}

export interface ProjectDirsPromptVars {
  active: ActiveProjectVars
  known: KnownProjectsVars
}

const DEFAULT_KNOWN_LIMIT = 12

/**
 * `spaceId` 是**会话归属的空间**(批 B4)。缺省 = default 空间的名册,与旧行为
 * 一致;传了就只看那个空间的名册 —— 提示词里绝不能出现别的空间的项目。
 */
export function buildProjectDirsPromptVars(
  workingDirectory: string | undefined,
  options: { knownLimit?: number; collapseHome?: boolean; spaceId?: string } = {},
): ProjectDirsPromptVars {
  const knownLimit = options.knownLimit ?? DEFAULT_KNOWN_LIMIT
  const collapseHome = options.collapseHome ?? true
  const home = collapseHome ? os.homedir() : ''

  const store = getProjectsStore(options.spaceId)
  const indexEntries = store.list()

  const activeEntry = findActiveEntry(workingDirectory, indexEntries, home)
  const active = resolveActive(activeEntry, home, options.spaceId)
  const known = resolveKnown(indexEntries, home, knownLimit, activeEntry?.id, options.spaceId)

  return { active, known }
}

function resolveActive(
  entry: ProjectIndexEntry | undefined,
  home: string,
  spaceId: string | undefined,
): ActiveProjectVars {
  if (!entry) return { hasActive: false }

  const project: Project | null = getProjectsStore(spaceId).get(entry.path)
  if (!project) return { hasActive: false }

  return {
    hasActive: true,
    path: project.path,
    displayPath: collapse(project.path, home),
    paths: [...project.paths],
    displayPaths: project.paths.map(p => collapse(p, home)),
    description: project.description,
  }
}

function resolveKnown(
  index: ProjectIndexEntry[],
  home: string,
  limit: number,
  excludeId: string | undefined,
  spaceId: string | undefined,
): KnownProjectsVars {
  const entries: KnownProjectsVars['entries'] = []
  for (const entry of index) {
    if (excludeId && entry.id === excludeId) continue
    const project = getProjectsStore(spaceId).get(entry.path)
    entries.push({
      path: entry.path,
      displayPath: collapse(entry.path, home),
      displayPaths: entry.paths.map(p => collapse(p, home)),
      description: project?.description ?? '',
    })
    if (entries.length >= limit) break
  }
  return { hasAny: entries.length > 0, entries }
}

/** The session cwd activates a project when it equals ANY of its roots. */
function findActiveEntry(
  workingDirectory: string | undefined,
  index: ProjectIndexEntry[],
  home: string,
): ProjectIndexEntry | undefined {
  if (!workingDirectory) return undefined
  const target = canonicalizeProjectRoot(workingDirectory)
  return index.find(entry => entry.paths.some(root => {
    if (canonicalizeProjectRoot(root) === target) return true
    if (!home || !root.startsWith('~')) return false
    return canonicalizeProjectRoot(home + root.slice(1)) === target
  }))
}

function collapse(p: string, home: string): string {
  if (!home) return p
  if (p.startsWith('~')) return p
  return p.startsWith(home) ? '~' + p.slice(home.length) : p
}
