import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

const missingFile = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return // File flush below includes Windows file-system metadata.
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** Temp content is complete before publication; the rename publishes one whole file. */
async function writeScratchpadAtomically(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, filePath)
    const published = await fs.open(filePath, 'r+')
    try { await published.sync() } finally { await published.close() }
    await syncDirectory(directory)
    await syncDirectory(path.dirname(directory))
  } finally { await fs.unlink(temporary).catch(error => { if (!missingFile(error)) throw error }) }
}

export interface ScratchpadDocument {
  sessionId: string
  filePath: string
  content: string
  /** The file's mtime in ms; 0 = the scratchpad has never been written. */
  version: number
  updatedAt: number
}

export interface ScratchpadChangedPayload {
  sessionId: string
  document?: ScratchpadDocument
}


const SCRATCHPADS_DIR = 'scratchpads'

/**
 * Session ids arrive over IPC and are pasted straight into a file path, so they
 * must be a single ordinary path segment — '..', a separator or an absolute
 * path would escape the scratchpad directory.
 */
function assertPathSegment(value: string, label: string): string {
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    path.isAbsolute(trimmed) ||
    path.basename(trimmed) !== trimmed
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`)
  }
  return trimmed
}

// A write the store performs itself already broadcasts through notifyChanged.
// The file watcher would see that same write land on disk and broadcast a
// second time, so self-writes are remembered briefly and skipped by the watcher.
const SELF_WRITE_TTL_MS = 2_000

export class OnethingScratchpadStore {
  private readonly selfWrites = new Map<string, number>()

  constructor(private readonly options: {
    getDefaultStorePath: () => string
    notifyChanged?: (payload: ScratchpadChangedPayload) => void
  }) {}

  private markSelfWrite(filePath: string): void {
    const now = Date.now()
    for (const [key, at] of this.selfWrites) {
      if (now - at > SELF_WRITE_TTL_MS) this.selfWrites.delete(key)
    }
    this.selfWrites.set(path.resolve(filePath), now)
  }

  wasSelfWrite(filePath: string): boolean {
    const at = this.selfWrites.get(path.resolve(filePath))
    if (at === undefined) return false
    if (Date.now() - at > SELF_WRITE_TTL_MS) {
      this.selfWrites.delete(path.resolve(filePath))
      return false
    }
    return true
  }

  getDirectory(): string {
    return path.join(this.options.getDefaultStorePath(), SCRATCHPADS_DIR)
  }

  scratchpadPath(sessionId: string): string {
    return path.join(this.getDirectory(), `${assertPathSegment(sessionId, 'sessionId')}.md`)
  }

  async read(sessionId: string): Promise<ScratchpadDocument> {
    const filePath = this.scratchpadPath(sessionId)
    try {
      const [content, stats] = await Promise.all([
        fs.readFile(filePath, 'utf-8'),
        fs.stat(filePath),
      ])
      return {
        sessionId,
        filePath,
        content,
        version: Math.round(stats.mtimeMs),
        updatedAt: Math.round(stats.mtimeMs),
      }
    } catch {
      return { sessionId, filePath, content: '', version: 0, updatedAt: 0 }
    }
  }

  async update(sessionId: string, content: string): Promise<ScratchpadDocument> {
    const filePath = this.scratchpadPath(sessionId)
    this.markSelfWrite(filePath)
    await writeScratchpadAtomically(filePath, content)
    const document = await this.read(sessionId)
    this.notifyChanged({ sessionId, document })
    return document
  }

  async remove(sessionId: string): Promise<void> {
    const filePath = this.scratchpadPath(sessionId)
    this.markSelfWrite(filePath)
    await fs.unlink(filePath).catch(() => {})
  }

  /** A draft session's scratchpad follows the session into its materialized id. */
  async adopt(fromSessionId: string, toSessionId: string): Promise<void> {
    const fromPath = this.scratchpadPath(fromSessionId)
    const toPath = this.scratchpadPath(toSessionId)
    this.markSelfWrite(fromPath)
    this.markSelfWrite(toPath)
    if (fromPath === toPath) return
    let content: string
    try { content = await fs.readFile(fromPath, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    await this.update(toSessionId, content)
    await fs.unlink(fromPath)
  }

  notifyChanged(payload: ScratchpadChangedPayload): void {
    this.options.notifyChanged?.(payload)
  }
}
