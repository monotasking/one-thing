/** One Backend owns both delayed retries and already-fired asynchronous kicks. */
export class GoalRetryScheduler {
  private closed = false
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly running = new Set<Promise<void>>()

  constructor(private readonly kick: (sessionId: string) => void | Promise<void>, private readonly report: (sessionId: string, error: unknown) => void) {}

  has(sessionId: string): boolean { return this.pending.has(sessionId) }

  cancel(sessionId: string): void {
    const timer = this.pending.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.pending.delete(sessionId)
  }

  schedule(sessionId: string, attempt: number): void {
    if (this.closed || this.pending.has(sessionId)) return
    const delays = [5000, 15000, 45000]
    const delay = delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)]
    const timer = setTimeout(() => {
      this.pending.delete(sessionId)
      if (this.closed) return
      const task = Promise.resolve().then(() => { if (!this.closed) return this.kick(sessionId) })
      this.running.add(task)
      void task.then(() => this.running.delete(task), error => {
        this.running.delete(task)
        this.report(sessionId, error)
      })
    }, delay)
    timer.unref?.()
    this.pending.set(sessionId, timer)
  }

  quiesce(): void {
    this.closed = true
    for (const sessionId of this.pending.keys()) this.cancel(sessionId)
  }

  async drain(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running])
  }
}
