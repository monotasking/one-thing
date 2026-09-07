export interface SessionDeletionPorts<TResult> {
  targets(sessionId: string): readonly string[]
  abortAndDrain(sessionId: string): Promise<void>
  flush(sessionId: string): Promise<void>
  remove(sessionId: string, expectedIds: readonly string[]): Promise<TResult>
}

type DeletionPhase = 'stopping' | 'sealed' | 'deleted'
interface Deletion<TResult> {
  ids: readonly string[]
  phase: DeletionPhase
  promise: Promise<TResult>
}

export class SessionClosingError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session is closing or deleted: ${sessionId}`)
    this.name = 'SessionClosingError'
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const set = new Set(left)
  return set.size === right.length && right.every(id => set.has(id))
}

async function settleAll(work: readonly Promise<void>[], step: string): Promise<void> {
  const outcomes = await Promise.allSettled(work)
  const errors = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, `Session deletion failed during ${step}`)
}

/** One session layer owns admission and the complete lifetime of each deletion. */
export function createSessionDeletion<TResult>(ports: SessionDeletionPorts<TResult>) {
  const deletions = new Map<string, Deletion<TResult>>()
  let disposed = false
  const assertActive = (): void => {
    if (disposed) throw new Error('Session deletion layer has been disposed')
  }
  return {
    assertAccepting(sessionId: string): void {
      assertActive()
      if (deletions.has(sessionId)) throw new SessionClosingError(sessionId)
    },
    assertWritable(sessionId: string): void {
      assertActive()
      const state = deletions.get(sessionId)
      // A cancelled run must still be allowed to record its final outcome.
      if (state && state.phase !== 'stopping') throw new SessionClosingError(sessionId)
    },
    reopen(sessionId: string): void {
      assertActive()
      const state = deletions.get(sessionId)
      if (state && state.phase !== 'deleted') throw new SessionClosingError(sessionId)
      deletions.delete(sessionId)
    },
    assertSealed(ids: readonly string[]): void {
      for (const id of ids) {
        if (deletions.get(id)?.phase !== 'sealed') throw new Error(`Session deletion has not drained: ${id}`)
      }
    },
    async drain(): Promise<void> {
      const operations = [...new Set(deletions.values())]
      await settleAll(operations.map(operation => operation.promise.then(() => undefined)), 'pending deletions')
    },
    delete(sessionId: string, authorizedIds: readonly string[], authorize: (ids: readonly string[]) => void): Promise<TResult> {
      assertActive()
      const ids = Object.freeze([...new Set(authorizedIds)])
      const verify = (): void => {
        if (!ids.includes(sessionId) || !sameIds(ports.targets(sessionId), ids)) {
          throw new Error('Session deletion targets changed; retry with the current target set')
        }
        authorize(ids)
      }
      // No cancellation, publication, or storage mutation precedes full authorization.
      verify()
      const existing = deletions.get(sessionId)
      if (existing && sameIds(existing.ids, ids)) return existing.promise
      for (const id of ids) if (deletions.has(id)) throw new SessionClosingError(id)
      const operation: Deletion<TResult> = {
        ids,
        phase: 'stopping',
        promise: Promise.resolve().then(async () => {
          await settleAll(ids.map(id => Promise.resolve().then(() => ports.abortAndDrain(id))), 'execution drain')
          await settleAll(ids.map(id => Promise.resolve().then(() => ports.flush(id))), 'persistence drain')
          verify()
          // The final target check and sealing are synchronous: late producers can
          // no longer enqueue IO while physical deletion is awaited.
          operation.phase = 'sealed'
          const result = await ports.remove(sessionId, ids)
          operation.phase = 'deleted'
          return result
        }),
      }
      for (const id of ids) deletions.set(id, operation)
      // Keep failures attached to the lifetime record; a retry must not silently
      // reopen a session whose execution or disk state is still uncertain.
      void operation.promise.catch(() => {})
      return operation.promise
    },
    dispose(): void {
      disposed = true
      deletions.clear()
    },
  }
}

/** Existing transport/store edges delegate to the layer assembled for this Backend. */
export const sessionDeletion = {
  delete(sessionId: string, authorizedIds: readonly string[], authorize: (ids: readonly string[]) => void) {
    return getCurrentBackend('sessionLayer').sessionLayer.deletion.delete(sessionId, authorizedIds, authorize)
  },
  reopen(sessionId: string): void {
    getCurrentBackend('sessionLayer').sessionLayer.deletion.reopen(sessionId)
  },
  assertSealed(ids: readonly string[]): void {
    getCurrentBackend('sessionLayer').sessionLayer.deletion.assertSealed(ids)
  },
}
import { getCurrentBackend } from '../current.js'
