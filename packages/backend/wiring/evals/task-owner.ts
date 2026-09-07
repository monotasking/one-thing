import { KeyedAdmissionGate, type KeyedWork } from '@onething/core/lifecycle'

/** Accepted eval jobs remain owned until their real model and file work settles. */
export class EvalsTaskOwner {
  /* 按键寻址的入场闸(工单 5 §1):一个 key 至多一件在途,每件自己能被取消。 */
  private readonly gate = new KeyedAdmissionGate<KeyedWork>(() => new Error('Evals is shutting down'))

  constructor(private readonly assertOwned: () => void = () => {}) {}

  has(key: string): boolean { return this.gate.has(key) }

  start<T>(key: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.gate.assertAccepting()
    this.assertOwned()
    if (this.gate.has(key)) throw new Error(key === 'run' ? 'A run is already in progress' : 'An operation is already running for this incident')
    const abort = new AbortController()
    const promise = Promise.resolve().then(() => {
      this.assertOwned()
      abort.signal.throwIfAborted()
      return work(abort.signal)
    })
    const entry: KeyedWork = { abort: reason => abort.abort(reason), settled: promise }
    this.gate.add(key, entry)
    const remove = () => { this.gate.remove(key, entry) }
    void promise.then(remove, remove)
    return promise
  }

  cancel(key: string): boolean {
    const task = this.gate.get(key)
    if (!task) return false
    task.abort()
    return true
  }

  quiesce(): void { this.gate.quiesce() }

  drain(): Promise<void> { return this.gate.drain() }
}

const binding: { current?: EvalsTaskOwner } = {}
export function configureEvalsTaskOwner(owner: EvalsTaskOwner): () => void {
  if (binding.current) throw new Error('Evals task owner is already assembled')
  binding.current = owner
  return () => { if (binding.current === owner) binding.current = undefined }
}
export function getEvalsTaskOwner(): EvalsTaskOwner {
  if (!binding.current) throw new Error('Evals task owner is not assembled')
  return binding.current
}
