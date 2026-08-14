import path from 'node:path'

type MaybePromise<T> = T | Promise<T>

export type OnethingFileSearchEntryType = 'file' | 'directory'
export type OnethingFileSearchEntrySource = 'workdir' | 'downloads' | 'note' | 'connected'

export interface OnethingFileSearchEntry {
  path: string
  type: OnethingFileSearchEntryType
  source?: OnethingFileSearchEntrySource
  label?: string
}

export interface OnethingListFilesRequest {
  cwd?: string
  query?: string
  limit?: number
  /**
   * 发起这次补全的会话(批 B2)。接入目录是 per-space 的,而「哪个 space」由
   * **会话归属**决定 —— 渲染层的 @ 选择器把当前会话号带上来,宿主据此解析根。
   * 缺席 = 只给全局层(诚实降级,不猜当前空间)。
   */
  sessionId?: string
}

export interface OnethingListFilesResponse {
  success: boolean
  files: string[]
  entries?: OnethingFileSearchEntry[]
  error?: string
}

export interface OnethingFileSearchRoot {
  path: string
  source: OnethingFileSearchEntrySource
  label: string
}

export interface OnethingFileSearchNoteRoots {
  userNoteDir?: string | null
  workNoteDir?: string | null
}

export interface ResolveOnethingFileSearchRootsOptions {
  cwd?: string
  homeDir: string
  downloadsDir?: string | null
  noteRoots?: OnethingFileSearchNoteRoots
  /** 用户在设置里加的「接入目录」;缺席/空数组 = 与没有这个功能时完全一致。 */
  connectedDirs?: readonly string[]
}

export interface ListOnethingFileSearchEntriesOptions extends ResolveOnethingFileSearchRootsOptions {
  query?: string
  limit?: number
  listFiles(root: OnethingFileSearchRoot): AsyncIterable<string> | Iterable<string> | MaybePromise<AsyncIterable<string> | Iterable<string>>
}

export interface OnethingFilesIpcLogger {
  error?: (...args: unknown[]) => void
}

export interface ListOnethingFileSearchEntriesForIpcOptions
  extends Omit<ListOnethingFileSearchEntriesOptions, 'noteRoots' | 'connectedDirs'> {
  getNoteRoots?(): MaybePromise<OnethingFileSearchNoteRoots>
  getConnectedDirs?(): MaybePromise<readonly string[]>
  logger?: OnethingFilesIpcLogger
}

function expandOnethingPath(input: string, homeDir: string): string {
  if (input === '~') return homeDir
  if (input.startsWith('~/')) return path.join(homeDir, input.slice(2))
  return input
}

function getNoteRootLabel(name: keyof OnethingFileSearchNoteRoots): string {
  if (name === 'workNoteDir') return 'Work notes'
  return 'Personal notes'
}

function entryMatchesQuery(entry: OnethingFileSearchEntry, lowerQuery: string): boolean {
  if (!lowerQuery) return true
  return [
    entry.path,
    path.basename(entry.path),
    entry.label || '',
    entry.source || '',
  ].some(value => value.toLowerCase().includes(lowerQuery))
}

export function resolveOnethingFileSearchRoots(
  options: ResolveOnethingFileSearchRootsOptions,
): OnethingFileSearchRoot[] {
  const roots: OnethingFileSearchRoot[] = []
  const seen = new Set<string>()

  function add(input: string | undefined | null, source: OnethingFileSearchEntrySource, label: string): void {
    if (!input) return
    const resolved = path.resolve(expandOnethingPath(input, options.homeDir))
    if (seen.has(resolved)) return
    seen.add(resolved)
    roots.push({ path: resolved, source, label })
  }

  add(options.cwd, 'workdir', 'Workspace')

  const noteRoots = options.noteRoots || {}
  const noteEntries = [
    ['userNoteDir', noteRoots.userNoteDir],
    ['workNoteDir', noteRoots.workNoteDir],
  ] as const
  for (const [name, value] of noteEntries) {
    add(value, 'note', getNoteRootLabel(name))
  }

  // 接入目录排在笔记根之后、Downloads 之前。`add` 自带去重,所以一个既是
  // 笔记根又被加进接入目录的路径只会出现一次(先到的那个标签胜出)。
  for (const dir of options.connectedDirs ?? []) {
    add(dir, 'connected', path.basename(path.resolve(expandOnethingPath(dir, options.homeDir))) || dir)
  }

  add(options.downloadsDir, 'downloads', 'Downloads')
  return roots
}

export async function listOnethingFileSearchEntries(
  options: ListOnethingFileSearchEntriesOptions,
): Promise<OnethingListFilesResponse> {
  const query = options.query || ''
  const limit = options.limit ?? 50
  const lowerQuery = query.toLowerCase()
  const searchRoots = resolveOnethingFileSearchRoots(options)
  const files: string[] = []
  const entries: OnethingFileSearchEntry[] = []
  const seen = new Set<string>()

  if (searchRoots.length === 0) {
    return { success: true, files: [], entries: [] }
  }

  for (const root of searchRoots) {
    const rootEntry: OnethingFileSearchEntry = {
      path: root.path,
      type: 'directory',
      source: root.source,
      label: root.label,
    }
    if (entryMatchesQuery(rootEntry, lowerQuery) && !seen.has(root.path)) {
      seen.add(root.path)
      entries.push(rootEntry)
    }
  }

  for (const root of searchRoots) {
    try {
      for await (const file of await options.listFiles(root)) {
        if (!query || file.toLowerCase().includes(lowerQuery)) {
          const absolutePath = path.join(root.path, file)
          if (!seen.has(absolutePath)) {
            seen.add(absolutePath)
            files.push(absolutePath)
            entries.push({
              path: absolutePath,
              type: 'file',
              source: root.source,
            })
          }

          if (entries.length >= limit) {
            break
          }
        }
      }
    } catch {
      // Configured note/work directories may have been moved or deleted.
    }

    if (entries.length >= limit) break
  }

  return {
    success: true,
    files,
    entries: entries.slice(0, limit),
  }
}

export async function listOnethingFileSearchEntriesForIpc(
  options: ListOnethingFileSearchEntriesForIpcOptions,
): Promise<OnethingListFilesResponse> {
  try {
    return await listOnethingFileSearchEntries({
      cwd: options.cwd,
      query: options.query,
      limit: options.limit,
      homeDir: options.homeDir,
      downloadsDir: options.downloadsDir,
      noteRoots: await options.getNoteRoots?.(),
      connectedDirs: await options.getConnectedDirs?.(),
      listFiles: options.listFiles,
    })
  } catch (error) {
    options.logger?.error?.('[Files IPC] Failed to list files:', error)
    return {
      success: false,
      files: [],
      error: error instanceof Error ? error.message : 'Failed to list files',
    }
  }
}
