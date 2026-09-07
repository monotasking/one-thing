import { AdmissionGate } from '@onething/core/lifecycle'

/** All work started by one music generation, including promises behind UI timeouts. */
export class MusicWorkOwner {
  /* 「accepting 闸 + 取消源 + 在途集」不再手抄一份(工单 5 §1)。 */
  private readonly gate = new AdmissionGate(() => new Error('Music service is shutting down'))
  readonly signal = this.gate.signal

  constructor(private readonly assertOwned: () => void = () => {}) {}

  assertActive(): void {
    this.gate.assertAccepting()
    this.assertOwned()
  }

  track<T>(work: Promise<T>): Promise<T> {
    return this.gate.track(work)
  }

  wrap<T extends (...args: any[]) => any>(operation: T): T {
    return ((...args: Parameters<T>) => {
      this.assertActive()
      const result = operation(...args)
      return result && typeof result.then === 'function' ? this.track(result) : result
    }) as T
  }

  sleep(ms: number): Promise<void> {
    this.assertActive()
    return this.track(new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(new Error('Music service is shutting down')) }
      const timer = setTimeout(() => { this.signal.removeEventListener('abort', aborted); resolve() }, ms)
      this.signal.addEventListener('abort', aborted, { once: true })
    }))
  }

  quiesce(): void { this.gate.quiesce() }

  async drain(): Promise<void> {
    this.quiesce()
    await this.gate.drain()
  }
}
