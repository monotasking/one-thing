export interface ToolExecutionScheduleOptions {
  /**
   * Barrier jobs wait for all earlier jobs, run exclusively, and block later jobs
   * until they settle. Use this for mutating or opaque tools.
   */
  barrier?: boolean
}

/**
 * Orders tool execution at the job level.
 *
 * Non-barrier jobs may run concurrently within the same segment. A barrier job
 * waits for all earlier jobs in the segment to settle, then runs exclusively.
 * Jobs enqueued after a barrier wait until that barrier settles.
 *
 * This is intentionally stronger than the old side-effect gate: if an edit is
 * awaiting permission, later reads remain queued instead of observing stale file
 * state before the edit is approved/rejected.
 */
export class ToolExecutionScheduler {
  private previousBarrier: Promise<void> = Promise.resolve()
  private currentSegmentJobs = new Set<Promise<void>>()

  enqueue<T>(fn: () => Promise<T>, options: ToolExecutionScheduleOptions = {}): Promise<T> {
    const waitForPreviousBarrier = this.previousBarrier.catch(() => undefined)

    if (!options.barrier) {
      const promise = waitForPreviousBarrier.then(fn)
      const settled = promise.then(
        () => undefined,
        () => undefined,
      )
      this.currentSegmentJobs.add(settled)
      settled.finally(() => {
        this.currentSegmentJobs.delete(settled)
      })
      return promise
    }

    const priorJobs = Array.from(this.currentSegmentJobs)
    this.currentSegmentJobs = new Set()

    const promise = waitForPreviousBarrier
      .then(() => Promise.allSettled(priorJobs))
      .then(() => fn())

    this.previousBarrier = promise.then(
      () => undefined,
      () => undefined,
    )

    return promise
  }
}
