import fsp from 'node:fs/promises'
import path from 'node:path'
import { buildOnethingUsageLedgerRecord } from './pricing.js'
import type { OnethingUsageLedgerRecord, OnethingUsageRecordInput } from './types.js'

export type { OnethingUsageLedgerRecord, OnethingUsageRecordInput } from './types.js'
export { buildOnethingUsageLedgerRecord, computeOnethingUsageCostUSD, resolveOnethingUsageBillingMode } from './pricing.js'

const FLUSH_INTERVAL_MS = 500
const MONTH_FILE_RE = /^usage-(\d{4})-(\d{2})\.jsonl$/

export function onethingUsageMonthKey(ts: number): string {
  const date = new Date(ts)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

export function onethingUsageLedgerFileName(ts: number): string {
  return `usage-${onethingUsageMonthKey(ts)}.jsonl`
}

function monthKeyToRange(monthKey: string): { start: number; end: number } | null {
  const match = MONTH_FILE_RE.exec(`usage-${monthKey}.jsonl`)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const start = new Date(year, month - 1, 1).getTime()
  const end = new Date(year, month, 1).getTime()
  return { start, end }
}

function parseUsageLedgerLine(line: string): OnethingUsageLedgerRecord | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed.ts !== 'number' || typeof parsed.providerId !== 'string') return null
    return parsed as OnethingUsageLedgerRecord
  } catch {
    return null
  }
}

function safeJsonLine(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ unserializable: true })
  }
}

export interface OnethingUsageLedgerOptions {
  /**
   * 账本目录 —— **一个字符串,创建那一刻定死**(工单 4 C7)。
   *
   * 从前签名是 `string | (() => string)`,而构造函数当场就把函数调掉了:惰性的
   * 签名 + 立即的求值 = 一个骗人的类型。调用方会以为「每次写都重新问一次目录」
   * 于是把切库写成传个 getter,实际上换库对它毫无作用。想换目录就换一台账本。
   */
  ledgerDir?: string
  now?: () => number
  assertOwned?: () => void
}

/**
 * Append-only per-turn usage ledger. One JSONL file per calendar month
 * (~/.onething/usage/usage-YYYY-MM.jsonl by default); day/week/month
 * aggregation is computed by scanning records, not stored separately.
 */
export class OnethingUsageLedger {
  private readonly ledgerDir: string
  private readonly now: () => number
  private readonly assertOwned: () => void
  private writeBuffer: string[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private lastError: string | undefined
  private pendingFlush: Promise<void> | null = null
  private closed = false
  private closing: Promise<void> | null = null
  private failure: unknown

  constructor(options: OnethingUsageLedgerOptions = {}) {
    this.ledgerDir = options.ledgerDir ?? path.join(process.cwd(), '.onething', 'usage')
    this.now = options.now ?? Date.now
    this.assertOwned = options.assertOwned ?? (() => {})
  }

  getLedgerDir(): string {
    return this.ledgerDir
  }

  /** Builds the full record (cost calc, defaults) and queues it for append. */
  assertWritable(): void {
    if (this.closed) throw new Error('Usage ledger is closed')
    this.assertOwned()
    if (this.failure) throw this.failure
  }

  /**
   * 记一笔。**会抛**:账本已关、不归这台拥有、或先前一次落盘失败留下的粘住错误。
   *
   * 抛是对的 —— 悄悄吞掉的账等于账错了。它成立的前提是**每一个调用方都接得住**,
   * 这一条 2026-09-07 逐个核实过:`recordUsage` 的四条真路(chat 流
   * `agent-loop-executor`、side-line 计费 `bill-side-line`、协作摘要 `digest-runner`、
   * 评估 `provider-adapter`)全部包在 try/catch 里并记 `record usage failed`,
   * 计费失败不会打断聊天流。新加调用方要么照做,要么把这里降回 warn。
   */
  record(input: OnethingUsageRecordInput): OnethingUsageLedgerRecord {
    this.assertWritable()
    const record = buildOnethingUsageLedgerRecord(input, this.now)
    this.queueWrite(record)
    return record
  }

  /** Waits for any buffered writes to hit disk. Call before reading for consistency. */
  flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const task = (this.pendingFlush ?? Promise.resolve()).then(async () => {
      if (this.failure) throw this.failure
      await this.flushNow()
    })
    this.pendingFlush = task
    void task.catch(error => {
      this.failure = error
      this.lastError = error instanceof Error ? error.message : String(error)
    })
    return task
  }

  /** Close only after producers have drained; accepted records are still flushed. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = this.flush()
    return this.closing
  }

  getLastError(): string | undefined {
    return this.lastError
  }

  async listLedgerFiles(): Promise<string[]> {
    const dir = this.getLedgerDir()
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      return entries
        .filter(entry => entry.isFile() && MONTH_FILE_RE.test(entry.name))
        .map(entry => path.join(dir, entry.name))
        .sort()
    } catch (error) {
      if (isNodeErrorCode(error, 'ENOENT')) return []
      throw error
    }
  }

  /** Reads all records whose ts falls in [startTs, endTs). Scans only overlapping monthly files. */
  async readRecordsInRange(startTs: number, endTs: number): Promise<OnethingUsageLedgerRecord[]> {
    await this.flush()
    const files = await this.listLedgerFiles()
    const records: OnethingUsageLedgerRecord[] = []
    for (const filePath of files) {
      const monthKey = path.basename(filePath).match(MONTH_FILE_RE)
      if (!monthKey) continue
      const range = monthKeyToRange(`${monthKey[1]}-${monthKey[2]}`)
      if (range && (range.end <= startTs || range.start >= endTs)) continue
      const text = await fsp.readFile(filePath, 'utf-8').catch(() => '')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        const record = parseUsageLedgerLine(line)
        if (record && record.ts >= startTs && record.ts < endTs) records.push(record)
      }
    }
    records.sort((left, right) => left.ts - right.ts)
    return records
  }

  private queueWrite(record: OnethingUsageLedgerRecord): void {
    this.writeBuffer.push(safeJsonLine(record))
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        void this.flush().catch(() => {})
      }, FLUSH_INTERVAL_MS)
      this.flushTimer.unref?.()
    }
  }

  private async flushNow(): Promise<void> {
    if (this.writeBuffer.length) this.assertOwned()
    const lines = this.writeBuffer.splice(0)
    if (lines.length === 0) return
    const byFile = new Map<string, string[]>()
    for (const line of lines) {
      const ts = JSON.parse(line).ts as number
      const fileName = onethingUsageLedgerFileName(ts)
      const bucket = byFile.get(fileName) ?? []
      bucket.push(line)
      byFile.set(fileName, bucket)
    }
    const dir = this.getLedgerDir()
    await fsp.mkdir(dir, { recursive: true })
    for (const [fileName, fileLines] of byFile) {
      this.assertOwned()
      await fsp.appendFile(path.join(dir, fileName), `${fileLines.join('\n')}\n`, 'utf-8')
    }
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

export function usageLedgerPathFor(ledgerDir: string, ts: number): string {
  return path.join(ledgerDir, onethingUsageLedgerFileName(ts))
}
