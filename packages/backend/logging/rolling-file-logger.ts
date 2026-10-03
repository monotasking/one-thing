import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { gzip, gzipSync } from 'node:zlib'
import { promisify } from 'node:util'

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AppLogRecord {
  level: AppLogLevel
  source: string
  message: string
  timestamp?: number
  metadata?: Record<string, unknown>
}

export interface RollingFileLoggerOptions {
  logDir: string
  baseName?: string
  /**
   * 活动文件与归档的扩展名(不含点)。`log` = 迁移期的文本行,`jsonl` = L1 之后
   * 的结构化记录(拍板 A)。归档识别、压缩、清理三处都跟着它走。
   */
  extension?: string
  maxFileBytes?: number
  maxArchiveFiles?: number
  retentionDays?: number
  flushIntervalMs?: number
  maintenanceIntervalMs?: number
  compressArchives?: boolean
  onInternalError?: (error: unknown) => void
}

const gzipAsync = promisify(gzip)

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_ARCHIVE_FILES = 30
const DEFAULT_RETENTION_DAYS = 14
const DEFAULT_FLUSH_INTERVAL_MS = 250
const DEFAULT_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000
const MAX_BATCH_LINES = 1000

function dayKey(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

function safeReason(reason: string): string {
  return reason.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'rotate'
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ unserializable: true })
  }
}

function normalizeMessage(message: string): string {
  return message.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function formatRecord(record: AppLogRecord): string {
  const timestamp = new Date(record.timestamp ?? Date.now()).toISOString()
  const level = record.level.toUpperCase().padEnd(5, ' ')
  const prefix = `${timestamp} [${record.source}] ${level}`
  const metadata = record.metadata && Object.keys(record.metadata).length > 0
    ? ` ${safeJson(record.metadata)}`
    : ''
  const body = `${normalizeMessage(record.message)}${metadata}`
  return `${prefix} ${body.replace(/\n/g, `\n${prefix} `)}\n`
}

export class RollingFileLogger {
  private readonly logDir: string
  private readonly baseName: string
  private readonly extension: string
  private readonly maxFileBytes: number
  private readonly maxArchiveFiles: number
  private readonly retentionDays: number
  private readonly flushIntervalMs: number
  private readonly maintenanceIntervalMs: number
  private readonly compressArchives: boolean
  private readonly onInternalError?: (error: unknown) => void

  private buffer: string[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private maintenanceTimer: NodeJS.Timeout | null = null
  private flushPromise: Promise<void> | null = null
  private started = false
  private closed = false
  private currentSize = 0
  private currentDay = dayKey()
  private archiveCounter = 0

  constructor(options: RollingFileLoggerOptions) {
    this.logDir = options.logDir
    this.baseName = options.baseName ?? 'app'
    this.extension = (options.extension ?? 'log').replace(/^\.+/, '') || 'log'
    this.maxFileBytes = Math.max(1024, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
    this.maxArchiveFiles = Math.max(1, options.maxArchiveFiles ?? DEFAULT_MAX_ARCHIVE_FILES)
    this.retentionDays = Math.max(1, options.retentionDays ?? DEFAULT_RETENTION_DAYS)
    this.flushIntervalMs = Math.max(25, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS)
    this.maintenanceIntervalMs = Math.max(1000, options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS)
    this.compressArchives = options.compressArchives ?? true
    this.onInternalError = options.onInternalError
  }

  getActiveLogPath(): string {
    return path.join(this.logDir, `${this.baseName}.${this.extension}`)
  }

  start(): void {
    if (this.started) return
    fs.mkdirSync(this.logDir, { recursive: true })
    this.refreshActiveFileState()
    this.started = true
    this.maintenanceTimer = setInterval(() => {
      void this.runMaintenance().catch(error => this.reportInternalError(error))
    }, this.maintenanceIntervalMs)
    this.maintenanceTimer.unref?.()
  }

  log(record: AppLogRecord): void {
    this.writeLine(formatRecord(record))
  }

  /**
   * 落一行**已经成形**的文本(JSONL sink 用):轮转 / 压缩 / 保留期与 `log()`
   * 共用同一套实现,只是不经过文本格式化。行尾没有换行就补一个。
   */
  writeLine(line: string): void {
    if (this.closed) return
    if (!this.started) this.start()
    this.buffer.push(line.endsWith('\n') ? line : `${line}\n`)
    this.scheduleFlush(this.buffer.length >= MAX_BATCH_LINES ? 0 : this.flushIntervalMs)
  }

  async flush(): Promise<void> {
    if (this.closed && this.buffer.length === 0 && !this.flushPromise) return
    if (!this.started) this.start()
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    while (true) {
      if (this.flushPromise) {
        await this.flushPromise
      } else {
        this.flushPromise = this.flushLoop()
        try {
          await this.flushPromise
        } finally {
          this.flushPromise = null
        }
      }
      if (this.buffer.length === 0) return
    }
  }

  flushSync(): void {
    if (this.closed && this.buffer.length === 0) return
    if (!this.started) this.start()
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    while (this.buffer.length > 0) {
      const lines = this.buffer.splice(0, MAX_BATCH_LINES)
      const chunk = Buffer.from(lines.join(''), 'utf-8')
      this.rotateIfNeededSync(chunk.byteLength)
      fs.appendFileSync(this.getActiveLogPath(), chunk)
      this.currentSize += chunk.byteLength
      this.currentDay = dayKey()
    }
  }

  async rotateNow(reason = 'manual'): Promise<string | undefined> {
    await this.flush()
    return this.rotateActiveFile(reason)
  }

  async cleanupArchives(): Promise<string[]> {
    await fsp.mkdir(this.logDir, { recursive: true })
    const entries = await this.listArchiveEntries()
    const cutoff = Date.now() - this.retentionDays * 86400000
    const newestFirst = [...entries].sort((left, right) => right.mtimeMs - left.mtimeMs)
    const keep = new Set(newestFirst.slice(0, this.maxArchiveFiles).map(entry => entry.filePath))
    const removed: string[] = []

    for (const entry of entries) {
      if (entry.mtimeMs >= cutoff && keep.has(entry.filePath)) continue
      try {
        await fsp.unlink(entry.filePath)
        removed.push(path.basename(entry.filePath))
      } catch (error) {
        if (!isNodeErrorCode(error, 'ENOENT')) throw error
      }
    }

    return removed
  }

  async shutdown(): Promise<void> {
    this.closed = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer)
      this.maintenanceTimer = null
    }
    await this.flush()
  }

  private refreshActiveFileState(): void {
    try {
      const stat = fs.statSync(this.getActiveLogPath())
      this.currentSize = stat.size
      this.currentDay = dayKey(stat.mtime)
    } catch (error) {
      if (!isNodeErrorCode(error, 'ENOENT')) this.reportInternalError(error)
      this.currentSize = 0
      this.currentDay = dayKey()
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush().catch(error => this.reportInternalError(error))
    }, delayMs)
    this.flushTimer.unref?.()
  }

  private async flushLoop(): Promise<void> {
    while (this.buffer.length > 0) {
      const lines = this.buffer.splice(0, MAX_BATCH_LINES)
      const chunk = Buffer.from(lines.join(''), 'utf-8')
      await this.rotateIfNeeded(chunk.byteLength)
      await fsp.appendFile(this.getActiveLogPath(), chunk)
      this.currentSize += chunk.byteLength
      this.currentDay = dayKey()
    }
  }

  private async runMaintenance(): Promise<void> {
    if (this.closed) return
    if (!this.started) this.start()
    await this.flush()
    await this.rotateIfNeeded(0)
    await this.compressUncompressedArchives()
    await this.cleanupArchives()
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    const today = dayKey()
    if (this.currentSize > 0 && today !== this.currentDay) {
      await this.rotateActiveFile('date')
      return
    }
    if (this.currentSize > 0 && this.currentSize + incomingBytes > this.maxFileBytes) {
      await this.rotateActiveFile('size')
    }
  }

  private rotateIfNeededSync(incomingBytes: number): void {
    const today = dayKey()
    if (this.currentSize > 0 && today !== this.currentDay) {
      this.rotateActiveFileSync('date')
      return
    }
    if (this.currentSize > 0 && this.currentSize + incomingBytes > this.maxFileBytes) {
      this.rotateActiveFileSync('size')
    }
  }

  private async rotateActiveFile(reason: string): Promise<string | undefined> {
    const activePath = this.getActiveLogPath()
    let stat: fs.Stats
    try {
      stat = await fsp.stat(activePath)
    } catch (error) {
      if (!isNodeErrorCode(error, 'ENOENT')) throw error
      this.currentSize = 0
      this.currentDay = dayKey()
      return undefined
    }

    if (stat.size === 0) {
      this.currentSize = 0
      this.currentDay = dayKey()
      return undefined
    }

    const archiveName = [
      this.baseName,
      timestampForFilename(),
      String(++this.archiveCounter).padStart(3, '0'),
      safeReason(reason),
    ].join('-') + `.${this.extension}`
    const archivePath = path.join(this.logDir, archiveName)
    await fsp.rename(activePath, archivePath)
    this.currentSize = 0
    this.currentDay = dayKey()

    const finalPath = this.compressArchives
      ? await this.compressArchive(archivePath)
      : archivePath
    await this.cleanupArchives()
    return finalPath
  }

  private rotateActiveFileSync(reason: string): string | undefined {
    const activePath = this.getActiveLogPath()
    let stat: fs.Stats
    try {
      stat = fs.statSync(activePath)
    } catch (error) {
      if (!isNodeErrorCode(error, 'ENOENT')) throw error
      this.currentSize = 0
      this.currentDay = dayKey()
      return undefined
    }

    if (stat.size === 0) {
      this.currentSize = 0
      this.currentDay = dayKey()
      return undefined
    }

    const archiveName = [
      this.baseName,
      timestampForFilename(),
      String(++this.archiveCounter).padStart(3, '0'),
      safeReason(reason),
    ].join('-') + `.${this.extension}`
    const archivePath = path.join(this.logDir, archiveName)
    fs.renameSync(activePath, archivePath)
    this.currentSize = 0
    this.currentDay = dayKey()

    return this.compressArchives
      ? this.compressArchiveSync(archivePath)
      : archivePath
  }

  private async compressArchive(filePath: string): Promise<string> {
    const gzPath = `${filePath}.gz`
    try {
      const source = await fsp.readFile(filePath)
      const compressed = await gzipAsync(source, { level: 9 })
      await fsp.writeFile(gzPath, compressed)
      await fsp.unlink(filePath)
      return gzPath
    } catch (error) {
      this.reportInternalError(error)
      return filePath
    }
  }

  private compressArchiveSync(filePath: string): string {
    const gzPath = `${filePath}.gz`
    try {
      const source = fs.readFileSync(filePath)
      const compressed = gzipSync(source, { level: 9 })
      fs.writeFileSync(gzPath, compressed)
      fs.unlinkSync(filePath)
      return gzPath
    } catch (error) {
      this.reportInternalError(error)
      return filePath
    }
  }

  private async compressUncompressedArchives(): Promise<void> {
    if (!this.compressArchives) return
    const entries = await fsp.readdir(this.logDir, { withFileTypes: true }).catch(error => {
      if (isNodeErrorCode(error, 'ENOENT')) return []
      throw error
    })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.startsWith(`${this.baseName}-`) || !entry.name.endsWith(`.${this.extension}`)) continue
      await this.compressArchive(path.join(this.logDir, entry.name))
    }
  }

  private async listArchiveEntries(): Promise<Array<{ filePath: string; mtimeMs: number }>> {
    const entries = await fsp.readdir(this.logDir, { withFileTypes: true }).catch(error => {
      if (isNodeErrorCode(error, 'ENOENT')) return []
      throw error
    })
    const archives: Array<{ filePath: string; mtimeMs: number }> = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.startsWith(`${this.baseName}-`)) continue
      if (!entry.name.endsWith(`.${this.extension}`) && !entry.name.endsWith(`.${this.extension}.gz`)) continue
      const filePath = path.join(this.logDir, entry.name)
      const stat = await fsp.stat(filePath)
      archives.push({ filePath, mtimeMs: stat.mtimeMs })
    }
    return archives
  }

  private reportInternalError(error: unknown): void {
    this.onInternalError?.(error)
  }
}
