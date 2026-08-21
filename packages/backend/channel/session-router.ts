import type { ChatSession, MessageOrigin } from '@shared/ipc.js'
import * as store from '../store.js'
import { writeAppLog } from '../logging/index.js'
import { getSessionManager } from '../session/index.js'
import { getChannelIdentityService } from './identity-service.js'
import {
  identitySessionKey,
  originConnector,
  originDisplayName,
} from './origin.js'

export interface RoutedChannelSession {
  sessionId: string
  origin: MessageOrigin
  session?: ChatSession
}

function sessionNameFor(origin: MessageOrigin, sessionId: string): string {
  const connector = originConnector(origin)
  const displayName = originDisplayName(origin)
  if (connector) return `${connector} - ${displayName}`
  if (origin.transport === 'api') return `API - ${displayName}`
  return displayName || sessionId
}

function updateSessionIdentityMetadata(session: ChatSession, origin: MessageOrigin, originIdentityKey?: string): void {
  session.originIdentityKey = originIdentityKey
  // memoryProfileId is the single source of truth for memory routing; the
  // legacy memoryScopeId field is kept readable on old sessions but no longer
  // written.
  session.memoryProfileId = origin.resolvedIdentity?.profileId || origin.resolvedIdentity?.userId
  session.lastConnector = originConnector(origin)
  session.lastSentAt = origin.receivedAt || Date.now()
}

export class ChannelSessionRouter {
  route(input: {
    sessionId: string
    origin?: MessageOrigin
    fallbackTransport?: MessageOrigin['transport']
    preserveSessionId?: boolean
  }): RoutedChannelSession {
    const identityService = getChannelIdentityService()
    const origin = identityService.resolveOrigin(
      identityService.normalizeOrigin(input.origin, input.fallbackTransport),
    )

    const originIdentityKey = identitySessionKey(origin)
    const routedSessionId = input.preserveSessionId ? input.sessionId : originIdentityKey || input.sessionId
    let session = store.getSession(routedSessionId)

    if (!session && routedSessionId !== input.sessionId && (origin.transport === 'im' || origin.transport === 'api')) {
      const currentSessionId = store.getCurrentSessionId()
      session = store.createSession(routedSessionId, sessionNameFor(origin, routedSessionId))
      if (currentSessionId) store.setCurrentSessionId(currentSessionId)
    }

    if (session) {
      updateSessionIdentityMetadata(session, origin, originIdentityKey)
    }

    try {
      getSessionManager().getOrCreate(routedSessionId)
    } catch {
      // Session manager may be unavailable in isolated unit tests.
    }

    writeAppLog('info', 'channel.session-router', 'Resolved message session route', {
      requestedSessionId: input.sessionId,
      routedSessionId,
      originIdentityKey,
      preserveSessionId: input.preserveSessionId === true,
      transport: origin.transport,
      connector: originConnector(origin),
    })

    return {
      sessionId: routedSessionId,
      origin,
      session,
    }
  }
}

let singleton: ChannelSessionRouter | null = null

export function getChannelSessionRouter(): ChannelSessionRouter {
  if (!singleton) singleton = new ChannelSessionRouter()
  return singleton
}
