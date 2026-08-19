/**
 * Session Manager
 *
 * Manages the lifecycle of Session instances. Auto-vivifies sessions
 * when a `stream:start` event arrives via `onAnySession()`.
 *
 * Phase 1: Sessions are created on-demand and exist only in memory.
 * Phase 2+: SessionManager will coordinate persistence and recovery.
 */

import type { EventBus } from '../events/event-bus.js'
import type { StreamChannel } from '../events/stream-channel.js'
import type { Unsubscribe } from '../events/types.js'
import { Session } from './session.js'
import { getCoreLogger } from '../logging/index.js'

const log = getCoreLogger('core.session')


export class SessionManager {
  private sessions = new Map<string, Session>()
  private eventBus: EventBus<any, any>
  private streamChannel: StreamChannel<any>
  private unsubscribers: Unsubscribe[] = []

  constructor(eventBus: EventBus<any, any>, streamChannel: StreamChannel<any>) {
    this.eventBus = eventBus
    this.streamChannel = streamChannel

    // Auto-vivify sessions on stream:start
    const unsub = eventBus.onAnySession('stream:start', (envelope) => {
      const sessionId = envelope.sessionId
      if (!this.sessions.has(sessionId)) {
        log.debug('auto-creating session', { sessionId })
        const session = new Session(sessionId)
        session.attach(eventBus, streamChannel)
        this.sessions.set(sessionId, session)
        // Manually apply the stream:start event that triggered auto-vivification,
        // since the Session's per-session onAny subscription was registered AFTER
        // per-session handlers already ran in the current fanOut cycle.
        session.applyEvent(envelope)
      }
    }, 'SessionManager')
    this.unsubscribers.push(unsub)
  }

  /**
   * Get or create a Session instance.
   */
  getOrCreate(sessionId: string): Session {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = new Session(sessionId)
      session.attach(this.eventBus, this.streamChannel)
      this.sessions.set(sessionId, session)
    }
    return session
  }

  /**
   * Get a Session instance (returns undefined if not found).
   */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Destroy a session: detach, clean up EventBus/StreamChannel state.
   */
  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.detach()
      this.sessions.delete(sessionId)
    }
    this.eventBus.destroySession(sessionId)
    this.streamChannel.destroySession(sessionId)
  }

  /**
   * Shut down all sessions.
   */
  shutdown(): void {
    for (const [, session] of this.sessions) {
      session.detach()
    }
    this.sessions.clear()
    for (const unsub of this.unsubscribers) {
      unsub()
    }
    this.unsubscribers = []
  }
}
