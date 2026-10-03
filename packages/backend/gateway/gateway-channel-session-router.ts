import type { ChatSession, MessageOrigin } from '@shared/ipc.js'
import * as store from '@onething/backend/session'
import { writeAppLog } from '@onething/backend/logging/configure-logging'
// 临时留着的深层引用(会话归位 B,2026-10-03 起):这份路由的测试把 `session-layer.js` 整只换成只有 `getSessionManager`
// 的替身,走会话入口会碰到入口再导出的另外两个名字。2026-10-04 包根归位 B 把这只路由从包根 `channel/` 搬进 gateway、
// 会话名字改从会话入口拿(兼容桶 store.ts 删了),测试里 `configure-logging` 的替身也改成展开真模块 —— 当年那半个理由已经没了,
// 剩下这一处等那份测试的 `session-layer` 替身改成展开真模块时一起收。
import { getSessionManager } from '../session/session-layer.js'
import { getChannelIdentityService } from './gateway-channel-identity-service.js'
import {
  identitySessionKey,
  originConnector,
  originDisplayName,
} from '@onething/backend/agent-loop'

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
