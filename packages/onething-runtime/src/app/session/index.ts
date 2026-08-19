/**
 * Session Layer — Singleton Access
 *
 * Provides a singleton SessionManager that's initialized alongside
 * the event system.
 */

import { getEventBus, getStreamChannel } from '../events/index.js'
import { setupValidation } from './validation.js'
import type { Unsubscribe } from '../events/types.js'
import {
  Session,
  SessionManager,
  createEmptySessionState,
  getCoreSessionManager,
  initializeCoreSessionLayer,
  isCoreSessionLayerInitialized,
  shutdownCoreSessionLayer,
  type SessionState,
} from '@onething/core/session'
import { getLogger } from '../logging/index.js'

const log = getLogger('sessions')


let validationUnsub: Unsubscribe | null = null

/**
 * Get the singleton SessionManager instance.
 * Throws if called before initializeSessionLayer().
 */
export function getSessionManager(): SessionManager {
  try {
    return getCoreSessionManager()
  } catch {
    throw new Error('[Session] SessionManager not initialized. Call initializeSessionLayer() first.')
  }
}

/**
 * Initialize the session layer. Called after initializeEventSystem().
 */
export function initializeSessionLayer(): void {
  if (isCoreSessionLayerInitialized()) {
    log.warn('session layer already initialized')
    return
  }

  const eventBus = getEventBus()
  const streamChannel = getStreamChannel()

  const sessionManager = initializeCoreSessionLayer(eventBus, streamChannel)
  validationUnsub = setupValidation(eventBus, sessionManager)

  log.info('session layer initialized')
}

/**
 * Shut down the session layer.
 */
export function shutdownSessionLayer(): void {
  if (validationUnsub) {
    validationUnsub()
    validationUnsub = null
  }
  shutdownCoreSessionLayer()

  log.info('session layer shut down')
}

// Re-export for direct use
export {
  Session,
  SessionManager,
  createEmptySessionState,
}
export type { SessionState }
