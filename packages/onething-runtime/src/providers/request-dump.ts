import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import type {
  OnethingProviderRequestDumpMode as OnethingAgentTurnRequestDumpMode,
  OnethingProviderRequestDumpValue,
} from './agent-turn.js'

const gzip = promisify(zlib.gzip)

/** Compress oldest dumps once the directory grows past this. */
export const ONETHING_PROVIDER_REQUEST_DUMP_MAX_BYTES = 100 * 1024 * 1024
/** Drop dumps older than this regardless of size. */
export const ONETHING_PROVIDER_REQUEST_DUMP_RETENTION_DAYS = 30
/** Never rescan the directory more often than this. */
const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000

export interface OnethingProviderRequestDumpPayload {
  providerId: string
  model: string
  mode: OnethingAgentTurnRequestDumpMode
  metadata?: Record<string, OnethingProviderRequestDumpValue>
  requestBody: OnethingProviderRequestDumpValue
}

export interface OnethingProviderRequestDumpLogger {
  log?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
}

export interface DumpOnethingProviderRequestOptions {
  getLogDir(): string
  env?: Record<string, string | undefined>
  logger?: OnethingProviderRequestDumpLogger
  /** Skip the size/retention sweep. Tests drive `pruneOnethingProviderRequestDumps` directly. */
  skipMaintenance?: boolean
}

export interface PruneOnethingProviderRequestDumpsOptions {
  maxBytes?: number
  retentionDays?: number
  now?: number
  logger?: OnethingProviderRequestDumpLogger
}

export interface OnethingProviderRequestDumpPruneResult {
  deleted: number
  compressed: number
  bytesBefore: number
  bytesAfter: number
}

/**
 * 调试转储归 `log/dumps/<kind>/`(§2.4 的第三类:默认关、有界、显式开),
 * 与诊断日志分家 —— janitor 用这个前缀认它。
 */
export function getOnethingProviderRequestDumpDir(logDir: string): string {
  return path.join(logDir, 'dumps', 'provider-requests')
}

/**
 * **默认关**(拍板 B)。真机上这一路曾经写出 1.1G 的请求正文(含 system 全文与
 * 全部 messages),而它默认是开的。现在两条路才打得开:
 *  - `ONETHING_DUMP_PROVIDER_REQUESTS=1`(显式 opt-in);
 *  - 设置页的「诊断模式」(装配层 `setOnethingProviderRequestDumpEnabled(true)`)。
 */
let dumpOverride: boolean | undefined

export function setOnethingProviderRequestDumpEnabled(enabled: boolean | undefined): void {
  dumpOverride = enabled
}

export function shouldDumpOnethingProviderRequests(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (dumpOverride === true) return true
  const raw = (env.ONETHING_DUMP_PROVIDER_REQUESTS ?? '').toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

export function safeOnethingProviderRequestDumpFilenamePart(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  return sanitized || 'unknown'
}

export function stringifyOnethingProviderRequestDump(value: OnethingProviderRequestDumpValue): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(
    value,
    (_key, current) => {
      if (typeof current === 'bigint') {
        return current.toString()
      }
      if (typeof current === 'function') {
        return `[Function ${current.name || 'anonymous'}]`
      }
      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
          stack: current.stack,
        }
      }
      if (current && typeof current === 'object') {
        if (seen.has(current)) {
          return '[Circular]'
        }
        seen.add(current)
      }
      return current
    },
    2,
  )
}

interface DumpEntry {
  filePath: string
  size: number
  mtimeMs: number
  compressed: boolean
}

async function readDumpEntries(dir: string): Promise<DumpEntry[]> {
  const names = await fsp.readdir(dir)
  const entries: DumpEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.json.gz')) continue
    const filePath = path.join(dir, name)
    try {
      const stat = await fsp.stat(filePath)
      if (!stat.isFile()) continue
      entries.push({
        filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        compressed: name.endsWith('.gz'),
      })
    } catch {
      // Raced with another sweep or an external delete — nothing to account for.
    }
  }
  return entries
}

/**
 * Keeps the dump directory bounded: anything past the retention window is
 * deleted, and once the directory is over budget the oldest plain dumps are
 * gzipped oldest-first until it fits again.
 *
 * Compression is the only lever for the size budget — dumps inside the
 * retention window are never deleted to make room, so a directory that is
 * still over budget after everything is compressed stays over budget.
 */
export async function pruneOnethingProviderRequestDumps(
  dir: string,
  options: PruneOnethingProviderRequestDumpsOptions = {},
): Promise<OnethingProviderRequestDumpPruneResult> {
  const maxBytes = options.maxBytes ?? ONETHING_PROVIDER_REQUEST_DUMP_MAX_BYTES
  const retentionDays = options.retentionDays ?? ONETHING_PROVIDER_REQUEST_DUMP_RETENTION_DAYS
  const now = options.now ?? Date.now()
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000

  let entries: DumpEntry[]
  try {
    entries = await readDumpEntries(dir)
  } catch (error) {
    options.logger?.warn?.('[ProviderRequestDump] failed to scan dump directory:', error)
    return { deleted: 0, compressed: 0, bytesBefore: 0, bytesAfter: 0 }
  }

  const bytesBefore = entries.reduce((total, entry) => total + entry.size, 0)
  let deleted = 0
  let compressed = 0

  const retained: DumpEntry[] = []
  for (const entry of entries) {
    if (entry.mtimeMs >= cutoff) {
      retained.push(entry)
      continue
    }
    try {
      await fsp.rm(entry.filePath, { force: true })
      deleted += 1
    } catch (error) {
      options.logger?.warn?.('[ProviderRequestDump] failed to delete expired dump:', error)
      retained.push(entry)
    }
  }

  let total = retained.reduce((sum, entry) => sum + entry.size, 0)
  if (total > maxBytes) {
    const candidates = retained
      .filter(entry => !entry.compressed)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)

    for (const entry of candidates) {
      if (total <= maxBytes) break
      try {
        const raw = await fsp.readFile(entry.filePath)
        const packed = await gzip(raw)
        const target = `${entry.filePath}.gz`
        await fsp.writeFile(target, packed)
        await fsp.utimes(target, new Date(entry.mtimeMs), new Date(entry.mtimeMs))
        await fsp.rm(entry.filePath, { force: true })
        total -= entry.size - packed.length
        compressed += 1
      } catch (error) {
        options.logger?.warn?.('[ProviderRequestDump] failed to compress dump:', error)
      }
    }
  }

  if (deleted || compressed) {
    options.logger?.log?.(
      '[ProviderRequestDump] pruned dumps:',
      { deleted, compressed, bytesBefore, bytesAfter: total },
    )
  }

  return { deleted, compressed, bytesBefore, bytesAfter: total }
}

let lastMaintenanceAt = 0
let maintenanceInFlight = false

function scheduleDumpMaintenance(
  dir: string,
  logger: OnethingProviderRequestDumpLogger | undefined,
  now = Date.now(),
): void {
  if (maintenanceInFlight) return
  if (now - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return
  lastMaintenanceAt = now
  maintenanceInFlight = true
  // Detached on purpose: a dump must never delay the provider request it traces.
  void pruneOnethingProviderRequestDumps(dir, { logger })
    .catch(error => logger?.warn?.('[ProviderRequestDump] maintenance failed:', error))
    .finally(() => {
      maintenanceInFlight = false
    })
}

/** Test seam — lets a suite re-arm the throttled sweep. */
export function resetOnethingProviderRequestDumpMaintenance(): void {
  lastMaintenanceAt = 0
  maintenanceInFlight = false
}

export async function dumpOnethingProviderRequest(
  payload: OnethingProviderRequestDumpPayload,
  options: DumpOnethingProviderRequestOptions,
): Promise<string | undefined> {
  if (!shouldDumpOnethingProviderRequests(options.env)) return undefined

  const dir = getOnethingProviderRequestDumpDir(options.getLogDir())
  const timestamp = new Date().toISOString()
  const filenameTimestamp = timestamp.replace(/[:.]/g, '-')
  const filename = [
    filenameTimestamp,
    safeOnethingProviderRequestDumpFilenamePart(payload.providerId),
    safeOnethingProviderRequestDumpFilenamePart(payload.model),
    safeOnethingProviderRequestDumpFilenamePart(payload.mode),
  ].join('__') + '.json'
  const filePath = path.join(dir, filename)

  const content = {
    metadata: {
      timestamp,
      providerId: payload.providerId,
      model: payload.model,
      mode: payload.mode,
      ...payload.metadata,
    },
    requestBody: payload.requestBody,
  }

  try {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(filePath, `${stringifyOnethingProviderRequestDump(content)}\n`, 'utf-8')
    options.logger?.log?.('[ProviderRequestDump] wrote full request body:', filePath)
    if (!options.skipMaintenance) scheduleDumpMaintenance(dir, options.logger)
    return filePath
  } catch (error) {
    options.logger?.warn?.('[ProviderRequestDump] failed to write full request body:', error)
    return undefined
  }
}
