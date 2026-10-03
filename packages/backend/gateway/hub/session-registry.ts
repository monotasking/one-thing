import type { CoreSessionRuntime } from '@onething/backend/gateway/conversation-runtime'

export interface GatewaySession {
  coreSessionId: string
  lastActiveAt: number
}

export interface GatewaySessionRegistryOptions {
  inactiveTtlMs?: number
}

const DEFAULT_INACTIVE_TTL_MS = 24 * 60 * 60 * 1000
const FIRST_SESSION_INDEX = 1

export class GatewaySessionRegistry {
  private readonly sessions = new Map<string, GatewaySession>()
  private readonly activeSessionIds = new Map<string, string>()
  private readonly nextSessionIndexes = new Map<string, number>()
  private readonly inactiveTtlMs: number

  constructor(
    private readonly sessionRuntime: CoreSessionRuntime,
    options: GatewaySessionRegistryOptions = {},
  ) {
    this.inactiveTtlMs = options.inactiveTtlMs ?? DEFAULT_INACTIVE_TTL_MS
  }

  getOrCreate(channelId: string, userId: string): GatewaySession {
    const conversationKey = this.keyFor(channelId, userId)
    const now = Date.now()
    const activeSessionId = this.activeSessionIds.get(conversationKey)
    let session = activeSessionId ? this.sessions.get(activeSessionId) : undefined

    if (!session) {
      session = this.createSession(channelId, userId, FIRST_SESSION_INDEX, now)
      this.activeSessionIds.set(conversationKey, session.coreSessionId)
      this.nextSessionIndexes.set(conversationKey, FIRST_SESSION_INDEX + 1)
      return session
    }

    session.lastActiveAt = now
    this.sessionRuntime.ensureSession(session.coreSessionId)
    return session
  }

  startNewSession(channelId: string, userId: string): GatewaySession {
    const conversationKey = this.keyFor(channelId, userId)
    const nextIndex = this.nextSessionIndexes.get(conversationKey) ?? FIRST_SESSION_INDEX + 1
    const session = this.createSession(channelId, userId, nextIndex, Date.now())

    this.activeSessionIds.set(conversationKey, session.coreSessionId)
    this.nextSessionIndexes.set(conversationKey, nextIndex + 1)
    return session
  }

  cleanup(now = Date.now()): number {
    let removed = 0
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActiveAt <= this.inactiveTtlMs) continue
      this.sessionRuntime.destroySession(session.coreSessionId)
      this.sessions.delete(sessionId)
      this.removeActiveSessionReference(sessionId)
      removed += 1
    }
    return removed
  }

  private createSession(channelId: string, userId: string, index: number, now: number): GatewaySession {
    const coreSessionId = this.sessionIdFor(channelId, userId, index)
    this.sessionRuntime.ensureSession(coreSessionId)

    const session = {
      coreSessionId,
      lastActiveAt: now,
    }
    this.sessions.set(coreSessionId, session)
    return session
  }

  private sessionIdFor(channelId: string, userId: string, index: number): string {
    if (index === FIRST_SESSION_INDEX) return `gateway:${channelId}:${userId}`
    return `gateway:${channelId}:${userId}:session-${index}`
  }

  private removeActiveSessionReference(sessionId: string): void {
    for (const [key, activeSessionId] of this.activeSessionIds) {
      if (activeSessionId === sessionId) {
        this.activeSessionIds.delete(key)
      }
    }
  }

  private keyFor(channelId: string, userId: string): string {
    return `${channelId}:${userId}`
  }
}
