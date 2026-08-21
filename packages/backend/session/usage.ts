import type { SessionTokenUsage, TokenUsage } from '@shared/ipc.js'
import {
  clearOnethingSessionUsage,
  getOnethingSessionUsage,
  updateOnethingSessionUsage,
} from '@onething/runtime/sessions'
import * as store from '../store.js'

/**
 * Update session usage after a streamed turn finishes.
 * Persists to disk for durability across app restarts.
 */
export function updateSessionUsage(
  sessionId: string,
  usage: TokenUsage,
  lastTurnUsage?: { inputTokens: number; outputTokens: number },
): void {
  updateOnethingSessionUsage({
    sessionId,
    usage,
    lastTurnUsage,
    updateSessionTokenUsage: (id, nextUsage, nextLastTurnUsage) =>
      store.updateSessionTokenUsage(id, nextUsage, nextLastTurnUsage),
  })
}

export function getSessionUsage(sessionId: string): SessionTokenUsage {
  return getOnethingSessionUsage({
    sessionId,
    getSessionTokenUsage: id => store.getSessionTokenUsage(id),
  })
}

export function clearSessionUsage(sessionId: string): void {
  clearOnethingSessionUsage(sessionId)
}
