import type { RuntimeRequestContext } from '@onething/core'
import {
  SessionAccessError,
  sessionOwnerOf,
  type SessionAccess,
  type SessionOwnershipRecord,
} from '../../../session/access.js'
import { fixedExecutionContext } from '../../engine/execution-context.js'

export interface CollabActorAuthorization {
  /** Internal actor activation only; this is not a request authorization API. */
  activateRoom(roomId: string, persistedRoom: SessionOwnershipRecord): Readonly<RuntimeRequestContext>
  contextForRoom(roomId: string): Readonly<RuntimeRequestContext>
  assertSessions(context: RuntimeRequestContext, sessionIds: readonly string[]): void
}

/** One room actor keeps its durable activation owner for its whole lifetime. */
export function createCollabActorAuthorization(options: {
  access: SessionAccess
  isAccepting(): boolean
}): CollabActorAuthorization {
  const owners = new Map<string, Readonly<RuntimeRequestContext>>()
  const assertSessions = (context: RuntimeRequestContext, ids: readonly string[]) => {
    if (!options.isAccepting()) throw new SessionAccessError()
    options.access.resolveAll(context, ids, 'write')
  }
  return {
    activateRoom(roomId, persistedRoom) {
      const snapshot = owners.get(roomId) ?? fixedExecutionContext(sessionOwnerOf(persistedRoom))
      assertSessions(snapshot, [roomId])
      owners.set(roomId, snapshot)
      return snapshot
    },
    contextForRoom(roomId) {
      const snapshot = owners.get(roomId)
      if (!snapshot) throw new SessionAccessError()
      assertSessions(snapshot, [roomId])
      return snapshot
    },
    assertSessions,
  }
}
