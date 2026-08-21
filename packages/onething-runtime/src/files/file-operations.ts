import path from 'node:path'

type MaybePromise<T> = T | Promise<T>

export interface OnethingFileStatLike {
  isFile(): boolean
  isDirectory(): boolean
  size: number
  mtimeMs: number
}

export interface OnethingDirentLike {
  name: string
  isDirectory(): boolean
}

export interface OnethingFileReadRequest {
  path: string
  maxSize?: number
}

export interface OnethingFileReadResponse {
  success: boolean
  content?: string
  encoding?: string
  size?: number
  mtimeMs?: number
  isBinary?: boolean
  error?: string
}

export interface OnethingFileSaveRequest {
  path: string
  content: string
  expectedMtimeMs?: number
}

export interface OnethingFileSaveResponse {
  success: boolean
  mtimeMs?: number
  error?: string
  conflict?: boolean
}

export interface OnethingDirectoryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  mtimeMs?: number
}

export interface OnethingListDirectoryResponse {
  success: boolean
  entries?: OnethingDirectoryEntry[]
  error?: string
}

export interface OnethingFileStatResponse {
  success: boolean
  type?: 'file' | 'directory'
  size?: number
  mtimeMs?: number
  /** 实际 stat 的绝对路径(`~` 已展开);调用方后续读/开/显示都该用它。 */
  path?: string
  error?: string
}

export interface OnethingFileActionResponse {
  success: boolean
  error?: string
}

export interface ReadOnethingFileContentOptions extends OnethingFileReadRequest {
  stat(path: string): MaybePromise<OnethingFileStatLike>
  readBytes(path: string, byteLength: number): MaybePromise<Uint8Array>
}

export interface SaveOnethingFileContentOptions extends OnethingFileSaveRequest {
  stat(path: string): MaybePromise<OnethingFileStatLike>
  writeFile(path: string, content: string): MaybePromise<void>
}

export interface ListOnethingDirectoryOptions {
  path: string
  readDir(path: string): MaybePromise<OnethingDirentLike[]>
  stat(path: string): MaybePromise<OnethingFileStatLike | null>
}

export interface StatOnethingPathOptions {
  path: string
  /** 给了 homeDir 才展开前导 `~`;渲染端没有 home,靠这一跳把 `~/x` 变成绝对路径。 */
  homeDir?: string
  stat(path: string): MaybePromise<OnethingFileStatLike>
}

export function expandOnethingHomePath(input: string, homeDir?: string): string {
  if (!homeDir) return input
  if (input === '~') return homeDir
  if (input.startsWith('~/') || input.startsWith('~\\')) return `${homeDir}${input.slice(1)}`
  return input
}

export interface CreateOnethingFileOptions {
  path: string
  content?: string
  createFile(path: string, content: string): MaybePromise<void>
}

export interface CreateOnethingDirectoryOptions {
  path: string
  createDirectory(path: string): MaybePromise<void>
}

export interface RenameOnethingPathOptions {
  oldPath: string
  newPath: string
  renamePath(oldPath: string, newPath: string): MaybePromise<void>
}

export interface DeleteOnethingPathOptions {
  path: string
  deletePath(path: string): MaybePromise<void>
}

export interface RevealOnethingPathOptions {
  path: string
  stat(path: string): MaybePromise<unknown>
  revealPath(path: string): MaybePromise<void>
}

export function onethingBufferLooksBinary(buffer: Uint8Array): boolean {
  const sampleLength = Math.min(buffer.length, 8000)
  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function errorCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown } | undefined)?.code === 'string'
    ? (error as { code: string }).code
    : undefined
}

export async function readOnethingFileContent(
  options: ReadOnethingFileContentOptions,
): Promise<OnethingFileReadResponse> {
  const filePath = options.path
  const maxSize = options.maxSize ?? 1048576

  if (!filePath) {
    return { success: false, error: 'File path is required' }
  }

  try {
    const stats = await options.stat(filePath)
    if (!stats.isFile()) {
      return { success: false, error: 'Path is not a file' }
    }

    const byteLength = Math.min(stats.size, maxSize)
    const contentBuffer = await options.readBytes(filePath, byteLength)
    const isBinary = onethingBufferLooksBinary(contentBuffer)
    const content = isBinary ? '' : new TextDecoder('utf-8').decode(contentBuffer)

    return {
      success: true,
      content,
      encoding: 'utf-8',
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      isBinary,
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { success: false, error: 'File not found' }
    }
    if (errorCode(error) === 'EACCES') {
      return { success: false, error: 'Permission denied' }
    }

    return {
      success: false,
      error: errorMessage(error, 'Failed to read file'),
    }
  }
}

export async function saveOnethingFileContent(
  options: SaveOnethingFileContentOptions,
): Promise<OnethingFileSaveResponse> {
  const filePath = options.path
  if (!filePath) {
    return { success: false, error: 'File path is required' }
  }

  try {
    if (options.expectedMtimeMs !== undefined) {
      const stats = await options.stat(filePath)
      if (Math.abs(stats.mtimeMs - options.expectedMtimeMs) > 1) {
        return {
          success: false,
          conflict: true,
          error: 'File changed on disk. Review before saving again.',
        }
      }
    }

    await options.writeFile(filePath, options.content)
    const stats = await options.stat(filePath)
    return { success: true, mtimeMs: stats.mtimeMs }
  } catch (error) {
    if (errorCode(error) === 'EACCES') {
      return { success: false, error: 'Permission denied' }
    }
    return {
      success: false,
      error: errorMessage(error, 'Failed to save file'),
    }
  }
}

export async function listOnethingDirectory(
  options: ListOnethingDirectoryOptions,
): Promise<OnethingListDirectoryResponse> {
  const dirPath = options.path
  if (!dirPath) return { success: false, error: 'Directory path is required' }

  try {
    const entries = await options.readDir(dirPath)
    const result: OnethingDirectoryEntry[] = []

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const entryPath = path.join(dirPath, entry.name)
      const stats = await options.stat(entryPath)
      result.push({
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: stats?.size,
        mtimeMs: stats?.mtimeMs,
      })
    }

    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return { success: true, entries: result }
  } catch (error) {
    return { success: false, error: errorMessage(error, 'Failed to list directory') }
  }
}

export async function statOnethingPath(
  options: StatOnethingPathOptions,
): Promise<OnethingFileStatResponse> {
  const targetPath = expandOnethingHomePath(options.path, options.homeDir)
  try {
    const stats = await options.stat(targetPath)
    return {
      success: true,
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      path: targetPath,
    }
  } catch (error) {
    return { success: false, error: errorMessage(error, 'Failed to stat path') }
  }
}

export async function createOnethingFile(
  options: CreateOnethingFileOptions,
): Promise<OnethingFileActionResponse> {
  try {
    await options.createFile(options.path, options.content ?? '')
    return { success: true }
  } catch (error) {
    return { success: false, error: errorMessage(error, 'Failed to create file') }
  }
}

export async function createOnethingDirectory(
  options: CreateOnethingDirectoryOptions,
): Promise<OnethingFileActionResponse> {
  try {
    await options.createDirectory(options.path)
    return { success: true }
  } catch (error) {
    return { success: false, error: errorMessage(error, 'Failed to create directory') }
  }
}

export async function renameOnethingPath(
  options: RenameOnethingPathOptions,
): Promise<OnethingFileActionResponse> {
  try {
    await options.renamePath(options.oldPath, options.newPath)
    return { success: true }
  } catch (error) {
    return { success: false, error: errorMessage(error, 'Failed to rename path') }
  }
}

export async function deleteOnethingPath(
  options: DeleteOnethingPathOptions,
): Promise<OnethingFileActionResponse> {
  try {
    await options.deletePath(options.path)
    return { success: true }
  } catch (error) {
    return { success: false, error: errorMessage(error, 'Failed to delete path') }
  }
}

export async function revealOnethingPath(
  options: RevealOnethingPathOptions,
): Promise<OnethingFileActionResponse> {
  const targetPath = options.path
  if (!targetPath) return { success: false, error: 'Path is required' }

  try {
    await options.stat(targetPath)
    await options.revealPath(targetPath)
    return { success: true }
  } catch (error) {
    return { success: false, error: errorMessage(error, 'Failed to reveal path') }
  }
}
