/**
 * 内存预算表(2026-09-25,起因:用户「程序跑起来接近 2G,怎么统一集中管理内存」)。
 *
 * 在这之前,每个会攒东西的地方各定各的上限 —— 事件总线每会话 1000 条、会话 LRU
 * 10 条、活投影 8 条 / 64MB、渲染侧停靠池 8 台 —— 没有一处能回答「此刻谁占了多少」,
 * 也没有一处能在进程涨上去的时候叫它们一起松手。这里就是那一张表。
 *
 * 形状是 CLAUDE.md「能力自述、别人读表」那一条:
 *  - **持有者**(`MemoryHolder`)自己报「我攒了多少」、自己决定「松手松到哪」;
 *  - **进程探针**(`MemoryProcessProbe`)报「这个宿主有哪些进程、各占多少」
 *    (Electron 壳报 `app.getAppMetrics()`,server / CLI 只有自己一个进程);
 *  - 这张表与 `MemoryGovernor` 只读表、只调 `trim`,**不认识任何一个持有者的名字**。
 *
 * 加一个持有者 = 它自己的模块里写一只 `MemoryHolder` + 装配处一行 `registerHolder`,
 * 这里一个字不改。零依赖、零 node import —— 取样(`process.memoryUsage` 之类)由
 * 装配层注入。
 */

/** 松手的两档。`soft` = 只丢空闲且过了保鲜期的;`hard` = 凡是能重建的都丢。 */
export type MemoryPressure = 'soft' | 'hard'

export interface MemoryHolderUsage {
  /** 攒着的条数(会话数 / 缓冲条数 / 视图数……单位由 `unit` 说)。 */
  entries: number
  /** 条数的单位,给人看的,如 `'sessions'` / `'events'` / `'views'`。 */
  unit: string
  /**
   * 估算字节数。**估不出就不填** —— 宁可空着,也不编一个数:一个假的 0 会让人
   * 以为它不占内存。
   */
  bytes?: number
  /** 自己的上限(没有上限就不填 —— 这一格空着本身就是一条信息)。 */
  limit?: { entries?: number; bytes?: number }
  /** 其余给人看的计数(如「受保护几条」)。只放标量。 */
  detail?: Record<string, number | string | boolean>
}

export interface MemoryTrimResult {
  releasedEntries: number
  releasedBytes?: number
}

export interface MemoryHolder {
  /** 全表唯一,点分,如 `events.session-buffers`。 */
  readonly id: string
  /** 一句话说它是什么(给诊断输出看)。 */
  readonly label: string
  /**
   * 此刻攒了多少。**必须便宜**:只读自己记着的计数,不许为了回答这一句去扫
   * 载荷、去暖缓存 —— 调度器每个周期都会问一遍。
   */
  usage(): MemoryHolderUsage
  /**
   * 松手。只许丢**能重建**的东西(缓存、可重放的缓冲、可重建的视图),
   * 永远不许丢唯一的一份数据、不许打断一次正在跑的执行。没有可松的就不实现。
   */
  trim?(pressure: MemoryPressure): MemoryTrimResult | Promise<MemoryTrimResult>
}

export type MemoryProcessKind = 'main' | 'renderer' | 'browser' | 'gpu' | 'utility' | 'worker' | 'other'

export interface MemoryProcessSample {
  pid: number
  kind: MemoryProcessKind
  /** 进程名或页面标题。**不许带命令行参数** —— 那里面可能有凭证。 */
  name: string
  /** 字节(不是 Electron 的 KiB)。量不到就是 `null`。 */
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
  /** `usage()` 抛了就记在这里,不让一只坏持有者拖垮整张表。 */
  error?: string
}

export interface MemoryReport {
  capturedAt: number
  /** 所有探针量到的字节之和;一个都没量到就是 `null`。 */
  totalBytes: number | null
  /** 有没有进程量不到(`bytes === null`)—— `true` 时 `totalBytes` 偏小。 */
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

  /** 登记一只持有者,交回注销函数。同名重复登记是接线 bug,直接抛。 */
  registerHolder(holder: MemoryHolder): () => void {
    if (this.holderTable.has(holder.id)) throw new Error(`memory holder already registered: ${holder.id}`)
    this.holderTable.set(holder.id, holder)
    return () => { if (this.holderTable.get(holder.id) === holder) this.holderTable.delete(holder.id) }
  }

  /** 登记一只进程探针,交回注销函数。同名重复登记直接抛。 */
  registerProbe(probe: MemoryProcessProbe): () => void {
    if (this.probeTable.has(probe.id)) throw new Error(`memory probe already registered: ${probe.id}`)
    this.probeTable.set(probe.id, probe)
    return () => { if (this.probeTable.get(probe.id) === probe) this.probeTable.delete(probe.id) }
  }

  holderIds(): string[] { return [...this.holderTable.keys()] }

  /** 进程那一半。探针之间按 pid 去重(先登记的说了算)。 */
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

  /** 叫每一只持有者按这一档松手。一只抛了照样问下一只。 */
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
  /** 超过它就 `soft` 松手。 */
  softBytes: number
  /** 超过它就 `hard` 松手。 */
  hardBytes: number
}

export interface MemoryGovernorOptions {
  registry: MemoryRegistry
  budget: MemoryBudget
  /**
   * 探针一个都没量到时的兜底读数(装配层给的是本进程 RSS)。
   * 预算比的是「探针总和,量不到才退到它」。
   */
  fallbackBytes: () => number
  intervalMs?: number
  /** 两次松手之间至少隔多久 —— 松完了还没降下来,不该每个周期再砸一遍。 */
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
 * 调度器:定期量一次,超预算就叫表上的持有者松手。
 *
 * 它不猜「谁该松」:那是每只持有者自己的 `trim` 的事。它只管三件:量、比、
 * 冷却。计时器 `unref` —— 一只内存调度器不该是进程不退出的理由。
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

  /** 量一次、比一次、该松就松。同一时刻只跑一只(上一只没完就交回它)。 */
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
