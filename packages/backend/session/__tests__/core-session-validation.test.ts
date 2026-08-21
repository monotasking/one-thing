import { describe, expect, it } from 'vitest'
import {
  formatSessionValidationResult,
  validateSessionStateConsistency,
  type SessionState,
} from '@onething/core/session'

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 'session-1',
    name: '',
    activeMessageId: 'assistant-1',
    accumulatedContent: 'hello',
    accumulatedReasoning: '',
    isStreaming: false,
    eventCount: 7,
    chunkCount: 3,
    ...overrides,
  }
}

describe('core session validation', () => {
  it('reports missing event session state', () => {
    const result = validateSessionStateConsistency({
      sessionId: 'session-1',
      storeSessionExists: false,
    })

    expect(result).toEqual({
      status: 'missing-session',
      sessionId: 'session-1',
    })
    expect(formatSessionValidationResult(result)).toBe(
      '[Validation] Session session-1 not found in SessionManager'
    )
  })

  it('reports missing store session', () => {
    const result = validateSessionStateConsistency({
      sessionId: 'session-1',
      state: state(),
      storeSessionExists: false,
    })

    expect(result).toEqual({
      status: 'missing-store-session',
      sessionId: 'session-1',
    })
    expect(formatSessionValidationResult(result)).toBe(
      '[Validation] Session session-1 not found in store'
    )
  })

  it('reports missing active assistant message', () => {
    const result = validateSessionStateConsistency({
      sessionId: 'session-1',
      state: state({ activeMessageId: 'assistant-2' }),
      storeSessionExists: true,
    })

    expect(result).toEqual({
      status: 'missing-message',
      sessionId: 'session-1',
      messageId: 'assistant-2',
    })
    expect(formatSessionValidationResult(result)).toBe(
      '[Validation] Message assistant-2 not found in store for session session-1'
    )
  })

  it('allows whitespace-only differences', () => {
    const result = validateSessionStateConsistency({
      sessionId: 'session-1',
      state: state({ accumulatedContent: ' hello ' }),
      storeSessionExists: true,
      storeMessageContent: 'hello',
    })

    expect(result).toEqual({
      status: 'consistent',
      sessionId: 'session-1',
      eventCount: 7,
      chunkCount: 3,
      contentLength: 7,
    })
    expect(formatSessionValidationResult(result)).toBe(
      '[Validation] Session session-1 state consistent (7 events, 3 chunks, 7 chars)'
    )
  })

  it('reports content mismatches with previews', () => {
    const result = validateSessionStateConsistency({
      sessionId: 'session-1',
      state: state({ accumulatedContent: 'event content' }),
      storeSessionExists: true,
      storeMessageContent: 'store content',
      previewLength: 5,
    })

    expect(result).toEqual({
      status: 'mismatch',
      sessionId: 'session-1',
      storeContentLength: 13,
      eventContentLength: 13,
      storePreview: 'store',
      eventPreview: 'event',
    })
    expect(formatSessionValidationResult(result)).toContain(
      '[Validation] Content MISMATCH for session session-1'
    )
  })
})
