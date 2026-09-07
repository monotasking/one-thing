import type { ChatSession } from '@shared/ipc.js'
import type { SessionLogEventRecord } from '@onething/core/session'
import type { SessionEventWriter } from './event-writer.js'
import { messageForEvent } from './command-events.js'

export interface SessionWritablePorts {
  assertActive(): void
  getSession(sessionId: string): ChatSession | undefined
  readEvents(sessionId: string): SessionLogEventRecord[]
  write: SessionEventWriter['write']
  flush(sessionId: string): Promise<void>
}

/** Materialize historical transcripts through the same writer before executing. */
export function createSessionWritable(ports: SessionWritablePorts) {
  const pending = new Map<string, Promise<void>>()
  const ensure = (sessionId: string): Promise<void> => {
    ports.assertActive()
    const previous = pending.get(sessionId)
    if (previous) return previous
    const prepare = async (): Promise<void> => {
      const session = ports.getSession(sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      // Read the transcript before creating its ledger: projection reads must not
      // replace the historical source with the newly created empty projection.
      const messages = structuredClone(session.messages)
      // The projection already includes accepted appends; finish their I/O
      // before deciding which historical messages still need an import.
      await ports.flush(sessionId)
      ports.assertActive()
      const events = ports.readEvents(sessionId)
      const recorded = new Set<string>()
      for (const event of events) {
        const data = event.data as { message?: { id?: string }; assistantMessageId?: string }
        if (data.message?.id) recorded.add(data.message.id)
        if (data.assistantMessageId) recorded.add(data.assistantMessageId)
      }
      if (events.length === 0 && !ports.write(sessionId, 'session/created', {
        sessionId,
        ...(session.kind ? { kind: session.kind } : {}),
        ...(session.workingDirectory ? { workingDirectory: session.workingDirectory } : {}),
      })) throw new Error(`Session ledger is unavailable: ${sessionId}`)
      // Search the entire log, including hidden/deleted messages. Retrying a
      // partial migration never duplicates an import or resurrects a deletion.
      for (const message of messages) {
        if (recorded.has(message.id) || message.isStreaming) continue
        if (!ports.write(sessionId, 'message/imported', {
          message: messageForEvent(sessionId, message) as never,
        }, { surfaceOp: 'append', time: message.timestamp })) {
          throw new Error(`Session ledger is unavailable: ${sessionId}`)
        }
      }
      await ports.flush(sessionId)
      ports.assertActive()
    }
    const promise = Promise.resolve().then(prepare).catch(error => { pending.delete(sessionId); throw error })
    pending.set(sessionId, promise)
    return promise
  }
  return Object.assign(ensure, { forget(sessionId: string): void { pending.delete(sessionId) } })
}
