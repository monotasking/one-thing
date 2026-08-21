import { describe, expect, it } from 'vitest'
import type { CoreSessionRepository, TurnUsage } from '@onething/core/session'

interface TestMessage {
  id: string
  role: string
  content: string
  timestamp: number
  contentParts?: Array<{ type: string; text?: string }>
}

interface TestSession {
  id: string
  name: string
  messages: TestMessage[]
}

interface TestUsage {
  totalTokens: number
}

describe('core session repository contract', () => {
  it('describes a headless repository without main IPC types', async () => {
    const messages: TestMessage[] = []
    const repository: CoreSessionRepository<
      { id: string; name: string },
      { id: string; name: string; messageCount: number },
      TestSession,
      TestMessage,
      TestUsage
    > = {
      getSessionsList: () => [{ id: 'session-1', name: 'Test' }],
      getSessionDetails: sessionId => ({ id: sessionId, name: 'Test', messageCount: messages.length }),
      getSessionMessagesPage: request => ({
        success: true,
        messages: messages.filter(message => request.sessionId === 'session-1'),
      }),
      getSessionForGeneration: sessionId => ({ id: sessionId, name: 'Test', messages }),
      getUserMessageMarkers: () => [{ id: 'message-1', seq: 1, timestamp: 1000, preview: 'hello' }],
      createSession: (sessionId, name) => ({ id: sessionId, name, messages: [] }),
      addMessage: (_sessionId, message) => {
        messages.push(message)
      },
      updateMessage: (_sessionId, messageId, updates) => {
        const message = messages.find(item => item.id === messageId)
        if (!message) return false
        Object.assign(message, updates)
        return true
      },
      updateMessageAndTruncate: (_sessionId, messageId, newContent, options) => {
        const message = messages.find(item => item.id === messageId)
        if (!message) return false
        message.content = newContent
        message.contentParts = options?.contentParts ?? undefined
        return true
      },
      updateSessionTokenUsage: (_sessionId, _usage: TestUsage, _lastTurnUsage?: TurnUsage) => {},
      flushSessionSave: async () => {},
      flushAllPendingSaves: async () => {},
    }

    repository.addMessage('session-1', {
      id: 'message-1',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    })

    expect(repository.getSessionsList()).toEqual([{ id: 'session-1', name: 'Test' }])
    expect(repository.getSessionMessagesPage({ sessionId: 'session-1' }).messages).toHaveLength(1)
    expect(repository.updateMessageAndTruncate('session-1', 'message-1', 'updated', {
      contentParts: [{ type: 'text', text: 'updated' }],
    })).toBe(true)
    await expect(repository.flushAllPendingSaves()).resolves.toBeUndefined()
  })
})
