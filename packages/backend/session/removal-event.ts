import { ownsSessionRecord, sessionOwnerOf, type SessionAccessContext, type SessionOwnershipRecord } from './access.js'
import { SESSION_EVENT_TYPES } from '@onething/core/events'

// Internal provenance only. JSON/RPC cannot mint this key and serialization omits it.
const removalOwner = Symbol('session removal owner')
type RemovalEvent = { type: typeof SESSION_EVENT_TYPES.SESSION_REMOVED; sessionId: string }

export function withSessionRemovalOwner<T extends RemovalEvent>(event: T, record: SessionOwnershipRecord): T {
  const owner = sessionOwnerOf(record)
  return Object.defineProperty(event, removalOwner, {
    value: Object.freeze({ sessionId: event.sessionId, ownerUserId: owner.userId, ownerWorkspaceId: owner.workspaceId }),
    enumerable: false,
  })
}

/** Undefined means an ordinary event, whose current audience still applies. */
export function canReceiveSessionRemoval(context: SessionAccessContext, sessionId: string, event: unknown): boolean | undefined {
  if (!event || typeof event !== 'object' || !('type' in event) || event.type !== SESSION_EVENT_TYPES.SESSION_REMOVED) return undefined
  const captured = (event as { [removalOwner]?: SessionOwnershipRecord & { sessionId: string } })[removalOwner]
  return Boolean(captured && captured.sessionId === sessionId && ownsSessionRecord(captured, context))
}
