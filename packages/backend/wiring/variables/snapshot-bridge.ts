import type { EventBus } from '../../events/event-bus.js'
import type { ContextVariable } from '@onething/runtime/variables'
import type { getVariableRegistry } from '@onething/runtime/variables/registry'
import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

/** One installation owns its queued refreshes, subscriptions and event target. */
export function createVariableSnapshotBridge(
  registry: Pick<ReturnType<typeof getVariableRegistry>, 'subscribe' | 'list'>,
  bus: EventBus | undefined,
  getSessionIds: () => readonly string[],
  onError: (error: unknown) => void,
): () => Promise<void> {
  let accepting = true
  let scheduled = false
  let closing: Promise<void> | undefined
  const pending = new Set<Promise<void>>()
  const track = (work: Promise<void>) => {
    pending.add(work)
    void work.then(() => pending.delete(work), error => { pending.delete(work); onError(error) })
  }
  const emit = async (sessionId: string, snapshot: ContextVariable[]) => {
    if (!accepting || !bus) return
    const workdirVariable = snapshot.find(variable => variable.name === 'workdir')
    const workingDirectory = workdirVariable?.value || undefined
    await bus.emit(sessionId, {
      type: SESSION_EVENT_TYPES.SESSION_VARIABLES_UPDATED,
      workingDirectory,
      workingDirectoryRoots: workdirVariable?.values?.slice(workingDirectory ? 1 : 0),
      variables: snapshot,
    })
  }
  const unsubscribe = registry.subscribe((context, snapshot) => {
    if (!accepting) return
    if (context.sessionId) { track(emit(context.sessionId, snapshot)); return }
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!accepting) return
      try {
        for (const sessionId of getSessionIds()) {
          track(registry.list({ sessionId }).then(snapshot => emit(sessionId, snapshot)))
        }
      } catch (error) { onError(error) }
    })
  })
  return () => {
    if (closing) return closing
    accepting = false
    unsubscribe()
    closing = Promise.allSettled([...pending]).then(() => {})
    return closing
  }
}
