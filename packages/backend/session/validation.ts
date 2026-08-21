/**
 * Session Validation (Dev Only)
 *
 * Subscribes to `stream:complete` across all sessions and compares
 * the Session's event-accumulated state with the store.
 *
 * Since Phase 2, the event system (EventOnlyEmitter → EventBus/StreamChannel
 * → IPCBridge) is the primary data path. This validation ensures that
 * Session's event-accumulated content matches the store mutations made
 * by the emitter and stream-processor. Mismatches indicate bugs in
 * either the event accumulation or the store mutation logic.
 *
 * Gate: only runs when NODE_ENV !== 'production'.
 */

import { sessionReads } from './reads.js'
import type { EventBus } from '../events/event-bus.js'
import type { Unsubscribe } from '../events/types.js'
import {
  formatSessionValidationResult,
  type SessionManager,
  validateSessionStateConsistency,
} from '@onething/core/session'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.validation')


const isDev = process.env.NODE_ENV !== 'production'

export function setupValidation(
  eventBus: EventBus,
  sessionManager: SessionManager
): Unsubscribe {
  if (!isDev) {
    return () => {} // No-op in production
  }

  return eventBus.onAnySession(SESSION_EVENT_TYPES.STREAM_COMPLETE, (envelope) => {
    const sessionId = envelope.sessionId
    const session = sessionManager.get(sessionId)
    if (!session) {
      log.warn('session state inconsistent', { sessionId, detail: formatSessionValidationResult(validateSessionStateConsistency({
        sessionId,
        storeSessionExists: false,
      })) })
      return
    }

    const state = session.state

    // Get the store's version of the assistant message
    const storeSession = sessionReads.getSession(sessionId)
    if (!storeSession) {
      log.warn('session state inconsistent', { sessionId, detail: formatSessionValidationResult(validateSessionStateConsistency({
        sessionId,
        state,
        storeSessionExists: false,
      })) })
      return
    }

    const storeMessage = state.activeMessageId
      ? sessionReads.getMessage(sessionId, state.activeMessageId)
      : undefined

    const result = validateSessionStateConsistency({
      sessionId,
      state,
      storeSessionExists: true,
      storeMessageContent: storeMessage ? (storeMessage.content || '') : undefined,
    })

    if (result.status === 'consistent') {
      log.debug('session state consistent', { sessionId, detail: formatSessionValidationResult(result) })
    } else {
      log.warn('session state inconsistent', { sessionId, detail: formatSessionValidationResult(result) })
    }
  }, 'Validation')
}
