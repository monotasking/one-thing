import path from 'node:path'

type MaybePromise<T> = T | Promise<T>

export type OnethingFileSearchEntryType = 'file' | 'directory'
/** `picked` = 调用方在 `roots` 里点名的根(见 `ResolveOnethingFileSearchRootsOptions.roots`)。 */
export type OnethingFileSearchEntrySource = 'workdir' | 'downloads' | 'note' | 'connected' | 'picked'

export interface OnethingFileSearchEntry {
  path: string
  type: OnethingFileSearchEntryType
  source?: OnethingFileSearchEntrySource
  label?: string
  /** 这一条是从哪个搜索根里找到的(绝对路径)。 */
  root?: string
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
  /** 只搜这几个根。语义见 `ResolveOnethingFileSearchRootsOptions.roots`。 */
  roots?: string[]
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
  /**
   * **调用方点名的根**(09-18,正本 `apps/desktop-react/docs/composer-open-dir-mentions-2026-09.md` §2.4)。
   *
   * 非空 = 搜索根**恰是**它们,按给的顺序;`cwd` / 笔记根 / 接入目录 / 下载目录一概不并 ——
   * 问的人已经说清了「在哪儿找」,再并别的根就是答非所问(08-31 真机走查:在会话里敲 `@`,
   * 第二行候选是下载目录里的东西)。名额按根保底分,见 `listOnethingFileSearchEntries`。
   * 缺席 / 空数组 = 老口径,逐字节不变。
   */
  roots?: readonly string[]
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

  if (options.roots && options.roots.length > 0) {
    for (const input of options.roots) {
      if (!input) continue
      const resolved = path.resolve(expandOnethingPath(input, options.homeDir))
      if (seen.has(resolved)) continue
      seen.add(resolved)
      roots.push({ path: resolved, source: 'picked', label: path.basename(resolved) || resolved })
    }
    return roots
  }

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
  if (options.roots && options.roots.length > 0) {
    return listPickedRootEntries(options, searchRoots, lowerQuery, limit)
  }
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

/**
 * 点名根那一档:**每根保底**。
 *
 * 老口径按根顺序填满 `limit` 就停 —— 那是「一个主根 + 几个附带根」时代的形,主根一个就能吃光
 * 名额。点名的根是**并列**的(会话工作目录 + 用户开着的目录),所以名额先平分:每根先拿
 * `floor(limit / n)` 条(至少 1 条),剩下的名额再按根序从各根多出来的命中里补。
 *
 * 每根最多只收 `limit` 条命中就停止枚举(补位永远用不到更多),所以代价上界与老口径相同量级。
 * 根本身作为一条 `directory` 候选排在它自己那份的最前面(与老口径的 rootEntry 同一件事)。
 */
async function listPickedRootEntries(
  options: ListOnethingFileSearchEntriesOptions,
  searchRoots: OnethingFileSearchRoot[],
  lowerQuery: string,
  limit: number,
): Promise<OnethingListFilesResponse> {
  if (searchRoots.length === 0 || limit <= 0) return { success: true, files: [], entries: [] }
  const seen = new Set<string>()
  const perRoot: OnethingFileSearchEntry[][] = []

  for (const root of searchRoots) {
    const bucket: OnethingFileSearchEntry[] = []
    perRoot.push(bucket)
    const rootEntry: OnethingFileSearchEntry = {
      path: root.path,
      type: 'directory',
      source: root.source,
      label: root.label,
      root: root.path,
    }
    if (entryMatchesQuery(rootEntry, lowerQuery) && !seen.has(root.path)) {
      seen.add(root.path)
      bucket.push(rootEntry)
    }
    if (bucket.length >= limit) continue
    try {
      for await (const file of await options.listFiles(root)) {
        if (lowerQuery && !file.toLowerCase().includes(lowerQuery)) continue
        const absolutePath = path.join(root.path, file)
        if (seen.has(absolutePath)) continue
        seen.add(absolutePath)
        bucket.push({ path: absolutePath, type: 'file', source: root.source, root: root.path })
        if (bucket.length >= limit) break
      }
    } catch {
      // 点名的根可能已被移走 / 删掉 —— 与老口径同一条:这一根交白卷,别的根照常。
    }
  }

  const quota = Math.max(1, Math.floor(limit / searchRoots.length))
  const taken = perRoot.map((bucket) => bucket.slice(0, quota))
  let count = taken.reduce((sum, list) => sum + list.length, 0)
  for (let i = 0; i < perRoot.length && count < limit; i += 1) {
    const extra = perRoot[i].slice(taken[i].length, taken[i].length + (limit - count))
    taken[i].push(...extra)
    count += extra.length
  }
  const entries = taken.flat().slice(0, limit)
  return {
    success: true,
    files: entries.filter((entry) => entry.type === 'file').map((entry) => entry.path),
    entries,
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
      roots: options.roots,
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
