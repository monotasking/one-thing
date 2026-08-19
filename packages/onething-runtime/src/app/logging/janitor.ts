import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * `log/` 目录的**唯一治理者**(§2.4 / P6)。
 *
 * 在它之前:app / dev 各有一套轮转、provider-requests 只压不删、daemon.log
 * 无人管、目录总量没有上限(真机 1.1G)。现在一张表说了算,五分钟扫一轮。
 *
 * 三条铁律:
 *  1. **只删归档与转储**。活动账本(`app.jsonl`、`server.jsonl`、`daemon.log`、
 *     `dev.log`)永远不动 —— 正在写的文件被删掉只会让人以为日志坏了。
 *  2. **事件账本不归它管**(`sessions/<id>/events.jsonl`、`usage/usage-*.jsonl` 等在别的
 *     目录,随所有者生命周期),janitor 的作用域就是 `log/` 这一棵。
 *  3. **不认识的东西不碰**,只在结果里报一声(`unknown`)。
 */

export interface LogFamilyPolicy {
  /** 最多留几个归档(按 mtime 新→旧)。 */
  maxArchives: number
  /** 超过这个天数的归档一律删。 */
  retentionDays: number
}

export interface LogDumpPolicy {
  retentionDays: number
  maxTotalMiB: number
}

export interface LogDirPolicy {
  families: Record<string, LogFamilyPolicy>
  dumps: Record<string, LogDumpPolicy>
  /** 目录总量上限:超了从最旧的归档开始删。 */
  totalCapMiB: number
  /**
   * 已知前缀。`agent-*`(log-monitor 插件按日自管)在名单里但**不按 family 规则
   * 删** —— 它只是不再"互不知晓":总量算它一份,清单里也认得它。
   */
  knownPrefixes: string[]
}

export const LOG_DIR_POLICY: LogDirPolicy = {
  families: {
    app: { maxArchives: 30, retentionDays: 14 },
    server: { maxArchives: 30, retentionDays: 14 },
    daemon: { maxArchives: 10, retentionDays: 7 },
    dev: { maxArchives: 20, retentionDays: 7 },
    start: { maxArchives: 20, retentionDays: 7 },
  },
  dumps: {
    'dumps/provider-requests': { retentionDays: 7, maxTotalMiB: 100 },
  },
  totalCapMiB: 512,
  knownPrefixes: ['app', 'server', 'daemon', 'dev', 'start', 'agent-'],
}

const LOG_EXTENSIONS = ['.log', '.log.gz', '.jsonl', '.jsonl.gz']
const DUMP_EXTENSIONS = ['.json', '.json.gz']
export const LOG_JANITOR_INTERVAL_MS = 5 * 60 * 1000

export interface LogJanitorResult {
  bytesBefore: number
  bytesAfter: number
  /** 相对 `log/` 的路径。 */
  deleted: string[]
  /** 既不属于某个 family、也不在已知前缀里的条目(只报不动)。 */
  unknown: string[]
}

interface FileEntry {
  relPath: string
  absPath: string
  size: number
  mtimeMs: number
}

function hasSuffix(name: string, suffixes: string[]): boolean {
  return suffixes.some(suffix => name.endsWith(suffix))
}

/** 活动账本 = `<family>.<ext>`;归档一律带 `-<timestamp>-` 这一段。 */
export function isActiveLedgerName(name: string, policy: LogDirPolicy = LOG_DIR_POLICY): boolean {
  for (const family of Object.keys(policy.families)) {
    for (const suffix of LOG_EXTENSIONS) {
      if (name === `${family}${suffix}`) return true
    }
  }
  return false
}

export function familyOf(name: string, policy: LogDirPolicy = LOG_DIR_POLICY): string | undefined {
  for (const family of Object.keys(policy.families)) {
    if (name.startsWith(`${family}-`) && hasSuffix(name, LOG_EXTENSIONS)) return family
  }
  return undefined
}

async function readDirEntries(dir: string): Promise<Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function listFiles(dir: string, base = dir): Promise<FileEntry[]> {
  const entries = await readDirEntries(dir)
  const files: FileEntry[] = []
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(absPath, base))
      continue
    }
    if (!entry.isFile()) continue
    try {
      const stat = await fsp.stat(absPath)
      files.push({
        absPath,
        relPath: path.relative(base, absPath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      })
    } catch {
      // 与另一轮清理 / 外部删除赛跑,算不到就算了。
    }
  }
  return files
}

export class LogDirJanitor {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly options: {
    logDir: string
    policy?: LogDirPolicy
    now?: () => number
    intervalMs?: number
    onError?: (error: unknown) => void
  }) {}

  /** 启动时跑一轮,之后每 5 分钟一轮。 */
  start(): void {
    if (this.timer) return
    void this.runSafely()
    this.timer = setInterval(() => void this.runSafely(), this.options.intervalMs ?? LOG_JANITOR_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private async runSafely(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.run()
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.running = false
    }
  }

  async run(): Promise<LogJanitorResult> {
    const policy = this.options.policy ?? LOG_DIR_POLICY
    const now = this.options.now?.() ?? Date.now()
    const logDir = this.options.logDir
    const files = await listFiles(logDir)
    const bytesBefore = files.reduce((total, file) => total + file.size, 0)

    const deleted: string[] = []
    const unknown: string[] = []
    const survivors: FileEntry[] = []
    /** 总量兜底时可以牺牲的候选(归档 + 转储),活动账本不在其中。 */
    const evictable: FileEntry[] = []

    // ① 各 family 的归档:保留期 + 归档数
    const byFamily = new Map<string, FileEntry[]>()
    const dumpDirs = new Map<string, FileEntry[]>()

    for (const file of files) {
      const dumpKey = Object.keys(policy.dumps).find(key => file.relPath.startsWith(`${key}${path.sep}`))
      if (dumpKey) {
        const list = dumpDirs.get(dumpKey) ?? []
        list.push(file)
        dumpDirs.set(dumpKey, list)
        continue
      }
      const name = path.basename(file.relPath)
      if (file.relPath !== name) {
        // 子目录里不认识的东西:只报,不碰。
        unknown.push(file.relPath)
        survivors.push(file)
        continue
      }
      const family = familyOf(name, policy)
      if (family) {
        const list = byFamily.get(family) ?? []
        list.push(file)
        byFamily.set(family, list)
        continue
      }
      if (isActiveLedgerName(name, policy)) {
        survivors.push(file)
        continue
      }
      if (!policy.knownPrefixes.some(prefix => name.startsWith(prefix))) unknown.push(file.relPath)
      survivors.push(file)
    }

    for (const [family, entries] of byFamily) {
      const familyPolicy = policy.families[family]
      const cutoff = now - familyPolicy.retentionDays * 86400000
      const newestFirst = [...entries].sort((left, right) => right.mtimeMs - left.mtimeMs)
      for (const [index, file] of newestFirst.entries()) {
        const tooOld = file.mtimeMs < cutoff
        const tooMany = index >= familyPolicy.maxArchives
        if (tooOld || tooMany) {
          if (await this.remove(file)) deleted.push(file.relPath)
          continue
        }
        survivors.push(file)
        evictable.push(file)
      }
    }

    // ② 调试转储目录:保留期 + 目录总量(删最旧,不再"只压不删")
    for (const [key, entries] of dumpDirs) {
      const dumpPolicy = policy.dumps[key]
      const cutoff = now - dumpPolicy.retentionDays * 86400000
      const kept: FileEntry[] = []
      for (const file of entries) {
        if (!hasSuffix(path.basename(file.relPath), DUMP_EXTENSIONS)) {
          unknown.push(file.relPath)
          survivors.push(file)
          continue
        }
        if (file.mtimeMs < cutoff) {
          if (await this.remove(file)) deleted.push(file.relPath)
          continue
        }
        kept.push(file)
      }
      let total = kept.reduce((sum, file) => sum + file.size, 0)
      const cap = dumpPolicy.maxTotalMiB * 1024 * 1024
      const oldestFirst = kept.sort((left, right) => left.mtimeMs - right.mtimeMs)
      for (const file of oldestFirst) {
        if (total <= cap) {
          survivors.push(file)
          evictable.push(file)
          continue
        }
        if (await this.remove(file)) {
          deleted.push(file.relPath)
          total -= file.size
        } else {
          survivors.push(file)
        }
      }
    }

    // ③ 目录总量兜底:超了就从最旧的归档 / 转储开始删,活动账本一律不碰
    let total = survivors.reduce((sum, file) => sum + file.size, 0)
    const cap = policy.totalCapMiB * 1024 * 1024
    if (total > cap) {
      for (const file of evictable.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
        if (total <= cap) break
        if (await this.remove(file)) {
          deleted.push(file.relPath)
          total -= file.size
        }
      }
    }

    return { bytesBefore, bytesAfter: total, deleted, unknown }
  }

  private async remove(file: FileEntry): Promise<boolean> {
    try {
      await fsp.rm(file.absPath, { force: true })
      return true
    } catch (error) {
      this.options.onError?.(error)
      return false
    }
  }
}
