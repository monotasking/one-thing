/**
 * 内存登记表与内存调度器。
 *
 * - `MemoryHolder`:持有可重建内存的模块(缓存、缓冲)。它报告自己的用量,并在收到
 *   释放请求时自行决定释放哪些内容。
 * - `MemoryProcessProbe`:报告宿主各进程的内存。Electron 宿主报告所有 Chromium 进程,
 *   server / CLI 只报告自身进程。
 * - `MemoryRegistry` 汇总两者;`MemoryGovernor` 定期采样,超过预算时让所有持有者释放。
 *
 * 本模块不引用任何具体持有者。新增持有者只需实现 `MemoryHolder` 并在装配处注册。
 * 无外部依赖;进程内存的读取方式由装配层注入。
 */

/** 释放力度。`soft`:只释放长时间未使用的内容;`hard`:释放所有可以重建的内容。 */
export type MemoryPressure = 'soft' | 'hard'

export interface MemoryHolderUsage {
  /** 当前条目数,单位见 `unit`。 */
  entries: number
  /** 条目单位,如 `'sessions'` / `'events'` / `'views'`。 */
  unit: string
  /** 估算字节数。无法估算时不填,避免显示为 0。 */
  bytes?: number
  /** 上限;没有上限时不填。 */
  limit?: { entries?: number; bytes?: number }
  /** 其他明细计数,只放标量。 */
  detail?: Record<string, number | string | boolean>
}

export interface MemoryTrimResult {
  releasedEntries: number
  releasedBytes?: number
}

export interface MemoryHolder {
  /** 唯一标识,点分形式,如 `events.replay-buffers`。 */
  readonly id: string
  /** 显示名称。 */
  readonly label: string
  /** 当前用量。调度器每个周期都会调用,实现只能读取已有计数,不能遍历数据或加载缓存。 */
  usage(): MemoryHolderUsage
  /**
   * 按指定力度释放内存。只能释放可以重建的内容,不能丢弃唯一副本,也不能中断
   * 正在进行的任务。没有可释放内容的持有者不实现此方法。
   */
  trim?(pressure: MemoryPressure): MemoryTrimResult | Promise<MemoryTrimResult>
}

export type MemoryProcessKind = 'main' | 'renderer' | 'browser' | 'gpu' | 'utility' | 'worker' | 'other'

export interface MemoryProcessSample {
  pid: number
  kind: MemoryProcessKind
  /** 进程名或页面标题。不包含命令行参数,以免泄露凭证。 */
  name: string
  /** 字节数;无法测量时为 `null`。 */
  bytes: number | null
}

export interface MemoryProcessProbe {
  readonly id: string
  sample(): MemoryProcessSample[] | Promise<MemoryProcessSample[]>
}

export interface MemoryHolderReport extends MemoryHolderUsage {
  id: string
  label: string
  trimmable: boolean
  /** `usage()` 抛出的错误信息;单个持有者出错不影响其他行。 */
  error?: string
}

export interface MemoryReport {
  capturedAt: number
  /** 所有进程的字节数之和;没有任何进程可测量时为 `null`。 */
  totalBytes: number | null
  /** 是否有进程无法测量;为 `true` 时 `totalBytes` 偏低。 */
  partial: boolean
  processes: MemoryProcessSample[]
  holders: MemoryHolderReport[]
}

export interface MemoryTrimReport {
  pressure: MemoryPressure
  releasedEntries: number
  releasedBytes: number
  holders: Array<{ id: string } & MemoryTrimResult & { error?: string }>
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MemoryRegistry {
  private readonly holderTable = new Map<string, MemoryHolder>()
  private readonly probeTable = new Map<string, MemoryProcessProbe>()

  constructor(private readonly now: () => number = Date.now) {}

  /** 注册持有者,返回注销函数。重复的 id 会抛错。 */
  registerHolder(holder: MemoryHolder): () => void {
    if (this.holderTable.has(holder.id)) throw new Error(`memory holder already registered: ${holder.id}`)
    this.holderTable.set(holder.id, holder)
    return () => { if (this.holderTable.get(holder.id) === holder) this.holderTable.delete(holder.id) }
  }

  /** 注册进程探针,返回注销函数。重复的 id 会抛错。 */
  registerProbe(probe: MemoryProcessProbe): () => void {
    if (this.probeTable.has(probe.id)) throw new Error(`memory probe already registered: ${probe.id}`)
    this.probeTable.set(probe.id, probe)
    return () => { if (this.probeTable.get(probe.id) === probe) this.probeTable.delete(probe.id) }
  }

  holderIds(): string[] { return [...this.holderTable.keys()] }

  /** 采样所有进程。多个探针报告同一 pid 时,以先注册的为准。 */
  async sampleProcesses(): Promise<Pick<MemoryReport, 'totalBytes' | 'partial' | 'processes'>> {
    const processes: MemoryProcessSample[] = []
    const seen = new Set<number>()
    let partial = false
    for (const probe of this.probeTable.values()) {
      let rows: MemoryProcessSample[]
      try {
        rows = await probe.sample()
      } catch {
        partial = true
        continue
      }
      for (const row of rows) {
        if (seen.has(row.pid)) continue
        seen.add(row.pid)
        processes.push(row)
      }
    }
    let total = 0
    let measured = 0
    for (const row of processes) {
      if (row.bytes === null) { partial = true; continue }
      total += row.bytes
      measured++
    }
    return { totalBytes: measured > 0 ? total : null, partial, processes }
  }

  holderReports(): MemoryHolderReport[] {
    const rows: MemoryHolderReport[] = []
    for (const holder of this.holderTable.values()) {
      const base = { id: holder.id, label: holder.label, trimmable: typeof holder.trim === 'function' }
      try {
        rows.push({ ...base, ...holder.usage() })
      } catch (error) {
        rows.push({ ...base, entries: 0, unit: '?', error: describeError(error) })
      }
    }
    return rows
  }

  async report(): Promise<MemoryReport> {
    const processes = await this.sampleProcesses()
    return { capturedAt: this.now(), ...processes, holders: this.holderReports() }
  }

  /** 让所有持有者按指定力度释放。某个持有者出错不影响其他持有者。 */
  async trim(pressure: MemoryPressure): Promise<MemoryTrimReport> {
    const result: MemoryTrimReport = { pressure, releasedEntries: 0, releasedBytes: 0, holders: [] }
    for (const holder of [...this.holderTable.values()]) {
      if (!holder.trim) continue
      try {
        const released = await holder.trim(pressure)
        result.releasedEntries += released.releasedEntries
        result.releasedBytes += released.releasedBytes ?? 0
        result.holders.push({ id: holder.id, ...released })
      } catch (error) {
        result.holders.push({ id: holder.id, releasedEntries: 0, error: describeError(error) })
      }
    }
    return result
  }
}

export interface MemoryBudget {
  /** 超过此值按 `soft` 力度释放。 */
  softBytes: number
  /** 超过此值按 `hard` 力度释放。 */
  hardBytes: number
}

export interface MemoryGovernorOptions {
  registry: MemoryRegistry
  budget: MemoryBudget
  /** 所有探针都无法测量时使用的读数(通常是本进程 RSS)。 */
  fallbackBytes: () => number
  intervalMs?: number
  /** 两次释放之间的最短间隔,避免释放后内存未回落时反复释放。 */
  cooldownMs?: number
  now?: () => number
  onTrim?: (event: { pressure: MemoryPressure; beforeBytes: number; trim: MemoryTrimReport }) => void
  onError?: (error: unknown) => void
}

export interface MemoryGovernorTick {
  bytes: number
  pressure: MemoryPressure | null
  trimmed: boolean
}

/**
 * 内存调度器:定期采样总内存,超过预算时让所有持有者释放。
 *
 * 释放什么由各持有者的 `trim` 决定。计时器使用 `unref`,不会阻止进程退出。
 */
export class MemoryGovernor {
  private timer: ReturnType<typeof setInterval> | undefined
  private lastTrimAt = Number.NEGATIVE_INFINITY
  private running: Promise<MemoryGovernorTick> | undefined
  private readonly intervalMs: number
  private readonly cooldownMs: number
  private readonly now: () => number

  constructor(private readonly options: MemoryGovernorOptions) {
    this.intervalMs = options.intervalMs ?? 30_000
    this.cooldownMs = options.cooldownMs ?? 120_000
    this.now = options.now ?? Date.now
  }

  get budget(): MemoryBudget { return this.options.budget }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return
    this.timer = setInterval(() => {
      void this.tick().catch(error => this.options.onError?.(error))
    }, this.intervalMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  pressureFor(bytes: number): MemoryPressure | null {
    if (bytes >= this.options.budget.hardBytes) return 'hard'
    if (bytes >= this.options.budget.softBytes) return 'soft'
    return null
  }

  /** 执行一次采样与判断,必要时释放。上一次未完成时返回同一个 Promise。 */
  tick(): Promise<MemoryGovernorTick> {
    if (!this.running) {
      this.running = this.runTick().finally(() => { this.running = undefined })
    }
    return this.running
  }

  private async runTick(): Promise<MemoryGovernorTick> {
    const sampled = await this.options.registry.sampleProcesses()
    const bytes = sampled.totalBytes ?? this.options.fallbackBytes()
    const pressure = this.pressureFor(bytes)
    if (!pressure || this.now() - this.lastTrimAt < this.cooldownMs) {
      return { bytes, pressure, trimmed: false }
    }
    this.lastTrimAt = this.now()
    const trim = await this.options.registry.trim(pressure)
    this.options.onTrim?.({ pressure, beforeBytes: bytes, trim })
    return { bytes, pressure, trimmed: true }
  }
}
