import { isAgentExecutionCheckpointError } from './errors.js'

export interface AgentExecutionLifetime {
  track<T>(operation: () => T | Promise<T>): Promise<T>
  drain(): Promise<void>
}

/** Own the actual operations behind abort races until their promises settle. */
export function createAgentExecutionLifetime(): AgentExecutionLifetime {
  const active = new Set<Promise<unknown>>()
  const checkpointFailures = new Set<unknown>()
  return {
    track<T>(operation: () => T | Promise<T>): Promise<T> {
      const work = Promise.resolve().then(operation)
      active.add(work)
      void work.then(() => active.delete(work), error => {
        active.delete(work)
        // A cancelled observer may already have returned. Preserve a late save
        // failure, while ordinary provider errors retain their retry semantics.
        if (isAgentExecutionCheckpointError(error)) checkpointFailures.add(error)
      })
      return work
    },
    async drain(): Promise<void> {
      while (active.size) await Promise.allSettled([...active])
      if (checkpointFailures.size) throw checkpointFailures.values().next().value
    },
  }
}
