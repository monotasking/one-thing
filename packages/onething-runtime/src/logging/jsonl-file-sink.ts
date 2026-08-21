import { formatJsonLine, type JsonlFileSink as CoreJsonlFileSink, type LogLevel, type LogRecord } from '@onething/core/logging'
import { RollingFileLogger } from './rolling-file-logger.js'

/**
 * 诊断日志的落盘口(拍板 A:JSONL 一行一条 `LogRecord`)。
 *
 * 轮转 / gzip / 归档保留期沿用 `RollingFileLogger` 的实现 —— 换掉的只是
 * "一行长什么样":文本前缀行没了,`[object Object]` 与多行栈的根源随之消失。
 * 同一组 env 仍然管用:`ONETHING_LOG_MAX_SIZE_MB` / `MAX_ARCHIVES` /
 * `RETENTION_DAYS` / `COMPRESS`。
 */
export interface JsonlFileSinkOptions {
  logDir: string
  /** 文件名主干:`app` → `app.jsonl`;server 用 `server`。 */
  baseName?: string
  minLevel?: LogLevel
  maxFileBytes?: number
  maxArchiveFiles?: number
  retentionDays?: number
  compressArchives?: boolean
  flushIntervalMs?: number
  maintenanceIntervalMs?: number
  onInternalError?: (error: unknown) => void
}

export function readNumberEnv(name: string, fallback: number, min: number, max: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

/** 四个 env 的唯一读点(`scripts/dev-with-logging.mjs` 另有一份逐字复刻)。 */
export function readRollingFileEnvOptions(env: NodeJS.ProcessEnv = process.env): {
  maxFileBytes: number
  maxArchiveFiles: number
  retentionDays: number
  compressArchives: boolean
} {
  return {
    maxFileBytes: Math.floor(readNumberEnv('ONETHING_LOG_MAX_SIZE_MB', 8, 1, 512, env) * 1024 * 1024),
    maxArchiveFiles: readNumberEnv('ONETHING_LOG_MAX_ARCHIVES', 30, 1, 500, env),
    retentionDays: readNumberEnv('ONETHING_LOG_RETENTION_DAYS', 14, 1, 365, env),
    compressArchives: env.ONETHING_LOG_COMPRESS !== '0',
  }
}

export class JsonlFileSink implements CoreJsonlFileSink {
  readonly minLevel?: LogLevel
  private readonly file: RollingFileLogger

  constructor(options: JsonlFileSinkOptions) {
    const envDefaults = readRollingFileEnvOptions()
    this.minLevel = options.minLevel
    this.file = new RollingFileLogger({
      logDir: options.logDir,
      baseName: options.baseName ?? 'app',
      extension: 'jsonl',
      maxFileBytes: options.maxFileBytes ?? envDefaults.maxFileBytes,
      maxArchiveFiles: options.maxArchiveFiles ?? envDefaults.maxArchiveFiles,
      retentionDays: options.retentionDays ?? envDefaults.retentionDays,
      compressArchives: options.compressArchives ?? envDefaults.compressArchives,
      flushIntervalMs: options.flushIntervalMs,
      maintenanceIntervalMs: options.maintenanceIntervalMs,
      onInternalError: options.onInternalError,
    })
  }

  start(): void {
    this.file.start()
  }

  write(record: LogRecord): void {
    this.file.writeLine(formatJsonLine(record))
  }

  getActivePath(): string {
    return this.file.getActiveLogPath()
  }

  async flush(): Promise<void> {
    await this.file.flush()
  }

  flushSync(): void {
    this.file.flushSync()
  }

  async close(): Promise<void> {
    await this.file.shutdown()
  }
}
