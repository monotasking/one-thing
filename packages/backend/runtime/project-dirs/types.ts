export type ProjectId = string

export interface ProjectIndexEntry {
  id: string
  /** Primary root — the session cwd anchor. Always equals `paths[0]`. */
  path: string
  /** All roots of this project. Non-empty, deduped, primary first. */
  paths: string[]
  lastUsedAt: number
}

export interface ProjectIndex {
  projects: ProjectIndexEntry[]
}

export interface Project {
  id: string
  /** Primary root — the session cwd anchor. Always equals `paths[0]`. */
  path: string
  /** All roots of this project. Non-empty, deduped, primary first. */
  paths: string[]
  description: string
  addedAt: number
  lastUsedAt: number
}

/** Trailing-slash-insensitive form used for root equality checks. */
export function canonicalizeProjectRoot(root: string): string {
  const trimmed = root.trim()
  const stripped = trimmed.replace(/[/\\]+$/, '')
  return stripped || trimmed
}

/**
 * Normalize a root list: trim, drop empties, dedupe (trailing-slash
 * insensitive), keep first occurrence order. `primary` is forced to the
 * front. Returns null when nothing survives.
 */
export function normalizeProjectRoots(primary: string, rest: readonly string[] = []): string[] | null {
  const out: string[] = []
  const seen = new Set<string>()
  for (const candidate of [primary, ...rest]) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (!trimmed) continue
    const key = canonicalizeProjectRoot(trimmed)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out.length > 0 ? out : null
}

export function projectRootsInclude(paths: readonly string[], target: string): boolean {
  const key = canonicalizeProjectRoot(target)
  return paths.some(p => canonicalizeProjectRoot(p) === key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Legacy records carry only `path`; multi-root records add `paths`.
 * Either way the parsed shape always has both, with `path === paths[0]`.
 */
function parseRoots(value: Record<string, unknown>): string[] | null {
  if (typeof value.path !== 'string' || !value.path) return null
  const rest = Array.isArray(value.paths)
    ? value.paths.filter((p): p is string => typeof p === 'string')
    : []
  return normalizeProjectRoots(value.path, rest)
}

function parseIndexEntry(value: unknown): ProjectIndexEntry | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !value.id) return null
  if (typeof value.lastUsedAt !== 'number') return null
  const paths = parseRoots(value)
  if (!paths) return null
  return { id: value.id, path: paths[0], paths, lastUsedAt: value.lastUsedAt }
}

export function parseProjectIndex(value: unknown): ProjectIndex | null {
  if (!isRecord(value) || !Array.isArray(value.projects)) return null
  const projects = value.projects.map(parseIndexEntry).filter((e): e is ProjectIndexEntry => e !== null)
  return projects.length === value.projects.length ? { projects } : null
}

export function parseProject(value: unknown): Project | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !value.id) return null
  if (typeof value.description !== 'string') return null
  if (typeof value.addedAt !== 'number') return null
  if (typeof value.lastUsedAt !== 'number') return null
  const paths = parseRoots(value)
  if (!paths) return null
  return {
    id: value.id,
    path: paths[0],
    paths,
    description: value.description,
    addedAt: value.addedAt,
    lastUsedAt: value.lastUsedAt,
  }
}
