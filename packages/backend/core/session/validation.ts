import type { SessionState } from './session-state.js'

export type CoreSessionValidationResult =
  | {
      status: 'missing-session'
      sessionId: string
    }
  | {
      status: 'missing-store-session'
      sessionId: string
    }
  | {
      status: 'missing-message'
      sessionId: string
      messageId: string | null
    }
  | {
      status: 'mismatch'
      sessionId: string
      storeContentLength: number
      eventContentLength: number
      storePreview: string
      eventPreview: string
    }
  | {
      status: 'consistent'
      sessionId: string
      eventCount: number
      chunkCount: number
      contentLength: number
    }

export interface CoreSessionValidationInput {
  sessionId: string
  state?: SessionState
  storeSessionExists: boolean
  storeMessageContent?: string
  previewLength?: number
}

export function validateSessionStateConsistency(input: CoreSessionValidationInput): CoreSessionValidationResult {
  const { sessionId, state } = input
  if (!state) {
    return { status: 'missing-session', sessionId }
  }

  if (!input.storeSessionExists) {
    return { status: 'missing-store-session', sessionId }
  }

  if (input.storeMessageContent === undefined) {
    return {
      status: 'missing-message',
      sessionId,
      messageId: state.activeMessageId,
    }
  }

  const storeContent = input.storeMessageContent
  const eventContent = state.accumulatedContent
  if (storeContent.trim() !== eventContent.trim()) {
    const previewLength = input.previewLength ?? 100
    return {
      status: 'mismatch',
      sessionId,
      storeContentLength: storeContent.length,
      eventContentLength: eventContent.length,
      storePreview: storeContent.slice(0, previewLength),
      eventPreview: eventContent.slice(0, previewLength),
    }
  }

  return {
    status: 'consistent',
    sessionId,
    eventCount: state.eventCount,
    chunkCount: state.chunkCount,
    contentLength: eventContent.length,
  }
}

export function formatSessionValidationResult(result: CoreSessionValidationResult): string {
  switch (result.status) {
    case 'missing-session':
      return `[Validation] Session ${result.sessionId} not found in SessionManager`
    case 'missing-store-session':
      return `[Validation] Session ${result.sessionId} not found in store`
    case 'missing-message':
      return `[Validation] Message ${result.messageId} not found in store for session ${result.sessionId}`
    case 'mismatch':
      return `[Validation] Content MISMATCH for session ${result.sessionId}:\n` +
        `  Store length: ${result.storeContentLength}\n` +
        `  Event length: ${result.eventContentLength}\n` +
        `  Store preview: ${result.storePreview}...\n` +
        `  Event preview: ${result.eventPreview}...`
    case 'consistent':
      return `[Validation] Session ${result.sessionId} state consistent ` +
        `(${result.eventCount} events, ${result.chunkCount} chunks, ${result.contentLength} chars)`
  }
}
