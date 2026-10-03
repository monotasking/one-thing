interface PendingSave {
  timer: ReturnType<typeof setTimeout> | null
  fireAt: number
  writePromise: Promise<void>
  /** 连续写失败次数;成功一次即清零。仅约束自动重试循环,不阻止后续数据驱动的写入。 */
  retries: number
}

export interface AsyncSaveQueueOptions<TValue> {
  throttleMs: number
  getLatest(id: string): TValue | undefined
  write(id: string, value: TValue): Promise<void>
  onError?: (id: string, error: unknown) => void
  /** 写失败自动重试的最大次数(退避 = retryBaseDelayMs × 尝试序号)。默认 3。 */
  maxRetries?: number
  /** 重试退避基准毫秒,实际延迟按尝试序号线性放大。默认 500。 */
  retryBaseDelayMs?: number
  /** 重试次数耗尽仍失败时回调;调用方可据此释放为该 id 保留的内存快照,避免无界增长。 */
  onRetryExhausted?: (id: string) => void
}

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 500

export class AsyncSaveQueue<TValue> {
  private pendingSaves = new Map<string, PendingSave>()

  constructor(private readonly options: AsyncSaveQueueOptions<TValue>) {}

  // 已有更早的挂起写入时,晚到的调度不会推迟它;更急的调度会把它提前。
  schedule(id: string, delayMs: number = this.options.throttleMs): void {
    const pending = this.getPendingSave(id)
    const fireAt = Date.now() + delayMs
    if (pending.timer) {
      if (fireAt >= pending.fireAt) return
      clearTimeout(pending.timer)
    }

    pending.fireAt = fireAt
    pending.timer = setTimeout(() => {
      pending.timer = null
      this.enqueueWrite(id, pending)
    }, delayMs)
  }

  async flush(id: string): Promise<void> {
    const pending = this.pendingSaves.get(id)
    if (!pending) return

    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
      this.enqueueWrite(id, pending)
    }

    try {
      await pending.writePromise
    } finally {
      if (!pending.timer) {
        this.pendingSaves.delete(id)
      }
    }
  }

  async flushAll(): Promise<void> {
    const ids = [...this.pendingSaves.keys()]
    await Promise.all(ids.map(id => this.flush(id).catch(() => {})))
  }

  cancel(id: string): void {
    const pending = this.pendingSaves.get(id)
    if (!pending) return
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
    // 保留条目(而非删除):在途写入的 promise 链是后续 schedule/runExclusive
    // 与它串行化的唯一凭据;getLatest 返回 undefined 时写入本身会跳过。
    pending.fireAt = 0
    pending.retries = 0
  }

  /**
   * 取消排队中的写入,并把 task 排在该 id 在途写入之后执行(与写入互斥)。
   * 用于删除等必须与在途写串行化的文件操作。
   */
  runExclusive(id: string, task: () => void | Promise<void>): Promise<void> {
    const pending = this.pendingSaves.get(id)
    if (!pending) {
      return Promise.resolve().then(task)
    }
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
    this.pendingSaves.delete(id)
    return pending.writePromise.then(task, task)
  }

  getPendingIds(): string[] {
    return [...this.pendingSaves.keys()]
  }

  hasPending(id: string): boolean {
    return this.pendingSaves.has(id)
  }

  private getPendingSave(id: string): PendingSave {
    let pending = this.pendingSaves.get(id)
    if (!pending) {
      pending = { timer: null, fireAt: 0, writePromise: Promise.resolve(), retries: 0 }
      this.pendingSaves.set(id, pending)
    }
    return pending
  }

  private enqueueWrite(id: string, pending: PendingSave): void {
    pending.writePromise = pending.writePromise
      .then(async () => {
        const latest = this.options.getLatest(id)
        if (latest === undefined) return
        try {
          await this.options.write(id, latest)
          pending.retries = 0
        } catch (error) {
          this.options.onError?.(id, error)
          const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES
          if (pending.retries < maxRetries) {
            pending.retries += 1
            const base = this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
            this.scheduleRetry(id, pending, base * pending.retries)
          } else {
            // 重试耗尽:通知调用方释放为该 id 保留的快照,并复位以便后续新数据仍有完整重试预算。
            pending.retries = 0
            this.options.onRetryExhausted?.(id)
          }
        }
      })
      .then(() => {
        this.cleanupIfIdle(id, pending)
      })
  }

  private scheduleRetry(id: string, pending: PendingSave, delayMs: number): void {
    // 已有更急的调度在排队时,让它接管,不再另起重试定时器。
    if (pending.timer) return
    pending.fireAt = Date.now() + delayMs
    pending.timer = setTimeout(() => {
      pending.timer = null
      this.enqueueWrite(id, pending)
    }, delayMs)
  }

  // 写入链彻底空闲(无排队定时器)时移除条目,避免 pendingSaves 随运行期触碰过的会话数无限增长。
  private cleanupIfIdle(id: string, pending: PendingSave): void {
    if (this.pendingSaves.get(id) === pending && pending.timer === null) {
      this.pendingSaves.delete(id)
    }
  }
}
