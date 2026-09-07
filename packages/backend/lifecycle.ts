/** One resource registry per Backend; hosts register here through Backend.own. */
export type BackendShutdownPhase = 'quiesce' | 'drain' | 'resources' | 'flush' | 'endpoints' | 'release' | 'restore'

const phases: readonly BackendShutdownPhase[] = [
  'quiesce', 'drain', 'resources', 'flush', 'endpoints', 'release', 'restore',
]

interface Resource {
  label: string
  phase: BackendShutdownPhase
  run: () => void | Promise<void>
}

export interface BackendShutdownFailure {
  step: string
  cause: unknown
}

export class BackendShuttingDownError extends Error {
  constructor() {
    super('Backend is shutting down and cannot accept new work')
    this.name = 'BackendShuttingDownError'
  }
}

export class BackendShutdownError extends AggregateError {
  constructor(
    readonly reason: string,
    readonly failures: readonly BackendShutdownFailure[],
    readonly pending: readonly string[],
    readonly timedOut: boolean,
  ) {
    super(failures.map(failure => failure.cause), `Backend shutdown ${timedOut ? 'timed out' : 'failed'}: ${failures.map(failure => failure.step).join(', ')}`)
    this.name = 'BackendShutdownError'
  }
}

/** Final phases run even after a failure or the deadline; each gets this window. */
const FINAL_PHASE_GRACE_MS = 1_000
const finalPhases: readonly BackendShutdownPhase[] = ['release', 'restore']

/**
 * Preserve reverse registration order within each dependency phase. A single
 * deadline includes late registrations.
 *
 * `release` and `restore` run **unconditionally** — after any failure, and after
 * the deadline. The host process exits right behind this call, so a retained
 * lease is not "protection under live writers": it is a lock directory and a
 * discovery file left on disk by a process that no longer exists, and the next
 * launch is the one that pays. Whatever went wrong is still reported (the
 * failures reach `BackendShutdownError`), but the store is handed back first.
 * The two final phases get their own small window so one hung restore cannot
 * pin the process in the same way.
 */
export class BackendResources {
  private readonly resources: Resource[] = []
  private readonly running = new Map<Promise<void>, string>()
  private readonly failures: BackendShutdownFailure[] = []
  private closing: Promise<void> | undefined
  private started = false
  private complete = false
  private timedOut = false

  constructor(
    // Wide enough to cover the two 3 s subsystem dispose bounds (MCP + ACP) in
    // sequence; anything shorter reports a deadline that the chain itself owns.
    private readonly timeoutMs = 8_000,
    private readonly onFailure?: (failure: BackendShutdownFailure) => void,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('shutdown timeout must be positive')
  }

  get isClosing(): boolean { return this.started }
  get isComplete(): boolean { return this.complete }

  assertActive(): void {
    if (this.started) throw new BackendShuttingDownError()
  }

  own(run: Resource['run'], label = 'anonymous', phase: BackendShutdownPhase = 'resources'): void | Promise<void> {
    if (this.started) return this.invoke({ run, label, phase })
    this.resources.push({ run, label, phase })
  }

  labels(): readonly string[] { return this.resources.map(resource => resource.label) }

  dispose(reason = 'shutdown'): Promise<void> {
    if (this.closing) return this.closing
    this.started = true
    const deadline = Date.now() + this.timeoutMs
    // Assign the shared promise before invoking any reentrant disposer.
    this.closing = Promise.resolve().then(() => this.drain(reason, deadline))
    return this.closing
  }

  private fail(step: string, cause: unknown): void {
    const failure = { step, cause }
    this.failures.push(failure)
    this.onFailure?.(failure)
  }

  private invoke(resource: Resource): Promise<void> {
    let work: Promise<void>
    try {
      work = Promise.resolve(resource.run())
    } catch (error) {
      work = Promise.reject(error)
    }
    this.running.set(work, resource.label)
    // Observe immediately, including fire-and-forget late ownership. Return the
    // original promise so an awaiting owner still receives its cleanup failure.
    void work.then(
      () => { this.running.delete(work) },
      error => { this.running.delete(work); this.fail(resource.label, error) },
    )
    return work
  }

  private async waitFor(work: Promise<unknown>, deadline: number): Promise<boolean> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work.then(() => true, () => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), remaining) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async drain(reason: string, deadline: number): Promise<void> {
    for (const phase of phases) {
      const isFinal = finalPhases.includes(phase)
      // Past the deadline the remaining work phases are abandoned (their
      // resources stay registered and are reported as pending), but the store
      // is still handed back below.
      if (this.timedOut && !isFinal) continue
      const phaseDeadline = isFinal ? Math.max(deadline, Date.now() + FINAL_PHASE_GRACE_MS) : deadline
      for (let i = this.resources.length - 1; i >= 0; i -= 1) {
        const resource = this.resources[i]!
        if (resource.phase !== phase) continue
        this.resources.splice(i, 1)
        if (!await this.waitFor(this.invoke(resource), phaseDeadline)) {
          this.timedOut = true
          break
        }
      }
      // own() called while another disposer was awaiting is part of this exit.
      // Once the deadline has passed there is nothing left to learn here: work
      // still in flight is already reported as pending, and waiting again would
      // charge every remaining phase another full grace window.
      while (!this.timedOut && this.running.size) {
        if (!await this.waitFor(Promise.allSettled([...this.running.keys()]), phaseDeadline)) {
          this.timedOut = true
        }
      }
    }
    if (this.timedOut) this.fail('deadline', new Error(`Shutdown exceeded ${this.timeoutMs}ms`))
    if (this.failures.length) {
      throw new BackendShutdownError(reason, [...this.failures], [
        ...this.running.values(), ...this.resources.map(resource => resource.label),
      ], this.timedOut)
    }
    this.resources.length = 0
    this.complete = true
  }
}

/**
 * 一台会在关机时排空的子系统(工单 5 §1)。形状住在 core —— 产品层的子系统
 * (媒体库、练习、collab 摘要档)也在实现它,而它们够不着装配层。
 */
export type { Quiescible } from '@onething/core/lifecycle'
