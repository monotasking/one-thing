/**
 * Session State
 *
 * The in-memory state that a Session builds by reducing events.
 * Phase 1: used only for validation (compare against existing store).
 * Phase 2+: this becomes the authoritative state.
 *
 * Design: SessionState is a plain object, not a class. The Session
 * class owns the mutation logic. This makes serialization trivial
 * and keeps state separate from behavior.
 */

export interface SessionState {
  /** Session ID */
  id: string

  /** Session name (may be updated by stream:complete) */
  name: string

  /** Current assistant message ID (set by stream:start) */
  activeMessageId: string | null

  /** Accumulated text content for the current assistant message */
  accumulatedContent: string

  /** Accumulated reasoning content for the current assistant message */
  accumulatedReasoning: string

  /** Whether a stream is currently active */
  isStreaming: boolean

  /** Event count processed by this session */
  eventCount: number

  /** Chunk count processed by this session */
  chunkCount: number
}

/**
 * Create an empty session state for a given session ID.
 */
export function createEmptySessionState(sessionId: string): SessionState {
  return {
    id: sessionId,
    name: '',
    activeMessageId: null,
    accumulatedContent: '',
    accumulatedReasoning: '',
    isStreaming: false,
    eventCount: 0,
    chunkCount: 0,
  }
}
