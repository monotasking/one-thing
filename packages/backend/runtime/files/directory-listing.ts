import path from 'node:path'

type MaybePromise<T> = T | Promise<T>

export interface OnethingListDirsRequest {
  basePath: string
  query?: string
  limit?: number
}

export interface OnethingListDirsResponse {
  success: boolean
  dirs: string[]
  basePath: string
  error?: string
}

export interface OnethingDirectoryStatLike {
  isDirectory(): boolean
}

export interface OnethingDirectoryEntryLike {
  name: string
  isDirectory(): boolean
}

export interface ListOnethingDirectoriesForCompletionOptions extends OnethingListDirsRequest {
  homeDir: string
  stat(path: string): MaybePromise<OnethingDirectoryStatLike | null>
  readDir(path: string): MaybePromise<OnethingDirectoryEntryLike[]>
}

export interface OnethingDirectoryIpcLogger {
  error?: (...args: unknown[]) => void
}

export function expandOnethingDirectoryBasePath(basePath: string, homeDir: string): string {
  return basePath.startsWith('~') ? `${homeDir}${basePath.slice(1)}` : basePath
}

async function safeStat(
  stat: (path: string) => MaybePromise<OnethingDirectoryStatLike | null>,
  targetPath: string,
): Promise<OnethingDirectoryStatLike | null> {
  try {
    return await stat(targetPath)
  } catch {
    return null
  }
}

export async function listOnethingDirectoriesForCompletion(
  options: ListOnethingDirectoriesForCompletionOptions,
): Promise<OnethingListDirsResponse> {
  const { basePath, query = '', limit = 50 } = options

  if (!basePath) {
    return { success: false, dirs: [], basePath: '', error: 'Base path is required' }
  }

  try {
    const expandedPath = expandOnethingDirectoryBasePath(basePath, options.homeDir)
    const pathStat = await safeStat(options.stat, expandedPath)
    const dirToList = pathStat?.isDirectory()
      ? expandedPath
      : path.dirname(expandedPath)
    const filterPrefix = pathStat?.isDirectory()
      ? query.toLowerCase()
      : path.basename(expandedPath).toLowerCase()

    const dirStat = await safeStat(options.stat, dirToList)
    if (!dirStat?.isDirectory()) {
      return { success: true, dirs: [], basePath: expandedPath }
    }

    const entries = await options.readDir(dirToList)
    const dirs: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !filterPrefix.startsWith('.')) {
        continue
      }

      if (entry.isDirectory() && (!filterPrefix || entry.name.toLowerCase().startsWith(filterPrefix))) {
        dirs.push(path.join(dirToList, entry.name))

        if (dirs.length >= limit) {
          break
        }
      }
    }

    dirs.sort((a, b) => path.basename(a).localeCompare(path.basename(b)))

    return { success: true, dirs, basePath: expandedPath }
  } catch (error) {
    return {
      success: false,
      dirs: [],
      basePath: '',
      error: error instanceof Error ? error.message : 'Failed to list directories',
    }
  }
}

export async function listOnethingDirectoriesForCompletionForIpc(
  options: ListOnethingDirectoriesForCompletionOptions & {
    logger?: OnethingDirectoryIpcLogger
  },
): Promise<OnethingListDirsResponse> {
  try {
    return await listOnethingDirectoriesForCompletion(options)
  } catch (error) {
    options.logger?.error?.('[Files IPC] Failed to list directories:', error)
    return {
      success: false,
      dirs: [],
      basePath: '',
      error: error instanceof Error ? error.message : 'Failed to list directories',
    }
  }
}
