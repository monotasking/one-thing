import type { EventBus } from '../events/event-bus.js'
import type { StreamChannel } from '../events/stream-channel.js'
import { SessionManager } from './session-manager.js'

let sessionManager: SessionManager | null = null

export function isCoreSessionLayerInitialized(): boolean {
  return Boolean(sessionManager)
}

export function getCoreSessionManager(): SessionManager {
  if (!sessionManager) {
    throw new Error('[CoreSession] SessionManager not initialized. Call initializeCoreSessionLayer() first.')
  }
  return sessionManager
}

export function initializeCoreSessionLayer(eventBus: EventBus<any, any>, streamChannel: StreamChannel<any>): SessionManager {
  if (sessionManager) {
    return sessionManager
  }

  sessionManager = new SessionManager(eventBus, streamChannel)
  return sessionManager
}

export function shutdownCoreSessionLayer(): void {
  if (sessionManager) {
    sessionManager.shutdown()
    sessionManager = null
  }
}
