import type { EventBus, StreamChannel } from '@onething/backend/event'
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

export function initializeCoreSessionLayer(eventBus: EventBus, streamChannel: StreamChannel): SessionManager {
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
