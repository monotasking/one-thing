/**
 * 练习域的**产品实现**:节奏引擎 + 账本 + 配置读写(工单 5 §5,triage D8)。
 *
 * 它从前住在 `service.wiring.ts` 里,而那个文件名的意思是「这里只放跨进程词汇的
 * 接线」—— 于是产品层的其他人想用 `PracticeService` 就得去 import 一个 wiring
 * 文件,而 wiring 文件按 I3 的规矩只有别的 wiring 文件能 import 它。困在里面的
 * 唯一原因是那五个请求形状住在传输契约包的 IPC 半边(产品层禁入的那一半);它们已经
 * 归位到 `@shared/contracts`(纯可序列化形状,产品层本来就可以 import),于是这个类
 * 回到它该在的地方。
 *
 * 留在 `.wiring.ts` 的:单槽绑定 + 那一排读单槽的自由函数(它们是宿主口)。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  ONETHING_PRACTICE_DEFAULT_CONFIG, OnethingPracticeEngine, OnethingPracticeLedger,
  getOnethingPracticeSummary, normalizeOnethingPracticeConfig,
  type OnethingPracticeConfig, type OnethingPracticeEngineSnapshot,
  type OnethingPracticeLedgerRecord, type OnethingPracticePhaseEdge,
  type OnethingPracticeSummaryResult,
} from './index.js'
import type {
  OnethingPracticeEventPayload, OnethingPracticeLogRequest, OnethingPracticeSetConfigRequest,
  OnethingPracticeStartRequest, OnethingPracticeSummaryRequest,
} from '@shared/contracts/practice.js'

export type PracticeEventBroadcaster = (payload: OnethingPracticeEventPayload) => void

export class PracticeServiceClosedError extends Error {
  constructor() { super('Practice service is unavailable or shutting down'); this.name = 'PracticeServiceClosedError' }
}

export class PracticeService {
  private readonly engine = new OnethingPracticeEngine()
  private readonly ledger: OnethingPracticeLedger
  private readonly directory: string
  private readonly operations = new Set<Promise<unknown>>()
  private readonly assertOwned: () => void
  private ticker: NodeJS.Timeout | undefined
  private broadcaster: PracticeEventBroadcaster | null = null
  private accepting = true
  private startGeneration = 0
  private configWrites: Promise<void> = Promise.resolve()
  private writeFailure: unknown
  private closing: Promise<void> | undefined

  constructor(options: { storePath: string; assertOwned?: () => void }) {
    this.directory = path.join(path.resolve(options.storePath), 'practice')
    this.assertOwned = options.assertOwned ?? (() => {})
    this.ledger = new OnethingPracticeLedger({ ledgerDir: this.directory, assertOwned: this.assertOwned })
  }

  private assertActive(): void {
    if (!this.accepting) throw new PracticeServiceClosedError()
    this.assertOwned()
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation))
    return operation
  }

  setBroadcaster(broadcaster: PracticeEventBroadcaster | null): void {
    this.assertActive()
    this.broadcaster = broadcaster
  }

  getPracticeLedger(): OnethingPracticeLedger { this.assertActive(); return this.ledger }

  private async readConfig(): Promise<OnethingPracticeConfig> {
    this.assertOwned()
    try {
      const raw = await fsp.readFile(path.join(this.directory, 'config.json'), 'utf8')
      return normalizeOnethingPracticeConfig(JSON.parse(raw))
    } catch { return structuredClone(ONETHING_PRACTICE_DEFAULT_CONFIG) }
  }

  readPracticeConfig(): Promise<OnethingPracticeConfig> {
    this.assertActive()
    return this.track(this.configWrites.then(() => this.readConfig()))
  }

  writePracticeConfig(request: OnethingPracticeSetConfigRequest): Promise<OnethingPracticeConfig> {
    this.assertActive()
    const input = structuredClone(request)
    const operation = this.configWrites.then(async () => {
      const current = await this.readConfig()
      const merged = normalizeOnethingPracticeConfig({
        kegel: { ...current.kegel, ...input.config.kegel },
        pomodoro: { ...current.pomodoro, ...input.config.pomodoro },
      })
      this.assertOwned()
      await fsp.mkdir(this.directory, { recursive: true })
      await fsp.writeFile(path.join(this.directory, 'config.json'), JSON.stringify(merged, null, '\t') + '\n', 'utf8')
      return merged
    })
    this.configWrites = operation.then(() => {}, error => { this.writeFailure ??= error })
    return this.track(operation)
  }

  private pushEvent(snapshot: OnethingPracticeEngineSnapshot, edges: OnethingPracticePhaseEdge[], settled?: OnethingPracticeLedgerRecord): void {
    this.broadcaster?.({ snapshot, edges, settled })
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = undefined
  }

  private ensureTicker(): void {
    if (this.ticker || !this.accepting) return
    this.ticker = setInterval(() => {
      if (!this.accepting) return
      const result = this.engine.tick(Date.now())
      const settled = result.finished ? this.ledger.record(result.finished) : undefined
      if (result.finished) this.stopTicker()
      if (result.edges.length || result.snapshot.status !== 'idle' || settled) {
        this.pushEvent(result.snapshot, result.edges, settled)
      }
    }, 1000)
    this.ticker.unref?.()
  }

  startPractice(request: OnethingPracticeStartRequest): Promise<OnethingPracticeEngineSnapshot> {
    this.assertActive()
    const input = structuredClone(request)
    const generation = ++this.startGeneration
    return this.track((async () => {
      const config = await this.readPracticeConfig()
      this.assertActive()
      // A later stop/start supersedes a start still loading its configuration.
      if (generation !== this.startGeneration) return this.engine.getSnapshot(Date.now())
      const now = Date.now()
      const abandoned = this.engine.stop(now)
      const abandonedRecord = abandoned ? this.ledger.record(abandoned) : undefined
      const result = input.kind === 'kegel'
        ? this.engine.startKegel(config.kegel, now)
        : this.engine.startPomodoro({ minutes: config.pomodoro.minutes, category: input.category, label: input.label }, now)
      this.ensureTicker()
      this.pushEvent(result.snapshot, result.edges, abandonedRecord)
      return result.snapshot
    })())
  }

  pausePractice(): OnethingPracticeEngineSnapshot {
    this.assertActive()
    const snapshot = this.engine.pause(Date.now())
    this.pushEvent(snapshot, [])
    return snapshot
  }

  resumePractice(): OnethingPracticeEngineSnapshot {
    this.assertActive()
    const snapshot = this.engine.resume(Date.now())
    this.pushEvent(snapshot, [])
    return snapshot
  }

  stopPractice(discard = false): OnethingPracticeEngineSnapshot {
    this.assertActive()
    ++this.startGeneration
    const input = this.engine.stop(Date.now())
    this.stopTicker()
    const settled = input && !discard ? this.ledger.record(input) : undefined
    const snapshot = this.engine.getSnapshot(Date.now())
    this.pushEvent(snapshot, [], settled)
    return snapshot
  }

  getPracticeState(): OnethingPracticeEngineSnapshot {
    this.assertActive()
    return this.engine.getSnapshot(Date.now())
  }

  logPractice(request: OnethingPracticeLogRequest): OnethingPracticeLedgerRecord {
    this.assertActive()
    const name = request.name.trim()
    if (!name) throw new Error('practice log needs a name')
    return this.ledger.record({ ts: request.ts, kind: 'exercise', source: request.source,
      name, note: request.note, exercise: request.exercise })
  }

  getPracticeSummary(request: OnethingPracticeSummaryRequest): Promise<OnethingPracticeSummaryResult> {
    this.assertActive()
    return this.track(getOnethingPracticeSummary(this.ledger, { granularity: request.granularity, count: request.count }))
  }

  getRecentPracticeRecords(days = 7, limit = 50): Promise<OnethingPracticeLedgerRecord[]> {
    this.assertActive()
    const now = Date.now()
    return this.track(this.ledger.readRecordsInRange(now - days * 86_400_000, now + 60_000)
      .then(records => records.slice(-limit).reverse()))
  }

  quiesce(): void {
    if (!this.accepting) return
    this.accepting = false
    ++this.startGeneration
    this.stopTicker()
    try {
      const abandoned = this.engine.stop(Date.now())
      const settled = abandoned ? this.ledger.record(abandoned) : undefined
      if (settled) this.pushEvent(this.engine.getSnapshot(Date.now()), [], settled)
    } finally {
      this.broadcaster = null
      this.ledger.quiesce()
    }
  }

  drain(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      let shutdownFailure: unknown
      try { this.quiesce() } catch (error) { shutdownFailure = error }
      while (this.operations.size) await Promise.allSettled([...this.operations])
      await this.ledger.drain()
      if (this.writeFailure) throw this.writeFailure
      if (shutdownFailure) throw shutdownFailure
    })()
    return this.closing
  }
}
