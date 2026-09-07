import fsp from 'node:fs/promises'
import path from 'node:path'
import type { OnethingPracticeLedgerRecord, OnethingPracticeRecordInput } from './types.js'

const MONTH_FILE_RE = /^practice-(\d{4})-(\d{2})\.jsonl$/
const PRACTICE_KINDS = new Set(['kegel', 'pomodoro', 'exercise'])

export function onethingPracticeMonthKey(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function onethingPracticeLedgerFileName(ts: number): string {
  return `practice-${onethingPracticeMonthKey(ts)}.jsonl`
}

function monthFileRange(fileName: string): { start: number; end: number } | null {
  const match = MONTH_FILE_RE.exec(fileName)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  return { start: new Date(year, month - 1, 1).getTime(), end: new Date(year, month, 1).getTime() }
}

function parsePracticeLedgerLine(line: string): OnethingPracticeLedgerRecord | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed.ts !== 'number' || typeof parsed.name !== 'string') return null
    if (!PRACTICE_KINDS.has(parsed.kind)) return null
    return parsed as OnethingPracticeLedgerRecord
  } catch {
    return null
  }
}

function makePracticeRecordId(ts: number): string {
  return `p_${ts.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export interface OnethingPracticeLedgerOptions {
  ledgerDir?: string | (() => string)
  now?: () => number
  assertOwned?: () => void
}

/**
 * Append-only practice ledger (kegel / pomodoro / exercise entries). One JSONL
 * file per calendar month (~/.onething/practice/practice-YYYY-MM.jsonl by
 * default). Writes are serialized in arrival order; aggregation is computed by
 * scanning records, never stored.
 */
export class OnethingPracticeLedger {
  private readonly ledgerDir: string
  private readonly now: () => number
  private readonly assertOwned: () => void
  private writeChain: Promise<void> = Promise.resolve()
  private lastError: string | undefined
  private writeFailure: unknown
  private closed = false
  private readonly reads = new Set<Promise<unknown>>()

  constructor(options: OnethingPracticeLedgerOptions = {}) {
    const source = options.ledgerDir ?? (() => path.join(process.cwd(), '.onething', 'practice'))
    this.ledgerDir = path.resolve(typeof source === 'function' ? source() : source)
    this.now = options.now ?? Date.now
    this.assertOwned = options.assertOwned ?? (() => {})
  }

  getLedgerDir(): string {
    return this.ledgerDir
  }

  getLastError(): string | undefined {
    return this.lastError
  }

  /** Fills id/ts defaults and queues the append. Returns the full record immediately. */
  record(input: OnethingPracticeRecordInput): OnethingPracticeLedgerRecord {
    this.assertActive()
    const ts = input.ts ?? this.now()
    const record: OnethingPracticeLedgerRecord = { id: makePracticeRecordId(ts), ...structuredClone(input), ts }
    const queued = structuredClone(record)
    this.writeChain = this.writeChain
      .then(() => this.append(queued))
      .catch(error => {
        this.writeFailure ??= error
        this.lastError = error instanceof Error ? error.message : String(error)
      })
    return record
  }

  /** Waits for queued appends to hit disk. Call before reading for consistency. */
  async flush(): Promise<void> {
    await this.writeChain
    if (this.writeFailure) throw this.writeFailure
  }

  private assertActive(): void {
    if (this.closed) throw new Error('Practice ledger is shutting down')
    this.assertOwned()
  }

  private trackRead<T>(operation: Promise<T>): Promise<T> {
    this.reads.add(operation)
    void operation.then(() => this.reads.delete(operation), () => this.reads.delete(operation))
    return operation
  }

  listLedgerFiles(): Promise<string[]> {
    this.assertActive()
    return this.trackRead(this.listFiles())
  }

  private async listFiles(): Promise<string[]> {
    this.assertOwned()
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

  /** Reads all records whose ts falls in [startTs, endTs). Scans only overlapping monthly files; bad lines are skipped. */
  readRecordsInRange(startTs: number, endTs: number): Promise<OnethingPracticeLedgerRecord[]> {
    this.assertActive()
    return this.trackRead(this.readRange(startTs, endTs))
  }

  private async readRange(startTs: number, endTs: number): Promise<OnethingPracticeLedgerRecord[]> {
    await this.flush()
    const files = await this.listFiles()
    const records: OnethingPracticeLedgerRecord[] = []
    for (const filePath of files) {
      const range = monthFileRange(path.basename(filePath))
      if (range && (range.end <= startTs || range.start >= endTs)) continue
      const text = await fsp.readFile(filePath, 'utf-8').catch(() => '')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        const record = parsePracticeLedgerLine(line)
        if (record && record.ts >= startTs && record.ts < endTs) records.push(record)
      }
    }
    records.sort((left, right) => left.ts - right.ts)
    return records
  }

  private async append(record: OnethingPracticeLedgerRecord): Promise<void> {
    this.assertOwned()
    const dir = this.getLedgerDir()
    await fsp.mkdir(dir, { recursive: true })
    await fsp.appendFile(path.join(dir, onethingPracticeLedgerFileName(record.ts)), `${JSON.stringify(record)}\n`, 'utf-8')
  }

  quiesce(): void { this.closed = true }

  async drain(): Promise<void> {
    this.quiesce()
    while (this.reads.size) await Promise.allSettled([...this.reads])
    await this.flush()
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}
