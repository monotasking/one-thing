import { describe, expect, it, vi } from 'vitest'
import {
  activateOnethingSessionForIpc,
  addOnethingSystemMessageForIpc,
  createOnethingBranchSessionForIpc,
  createOnethingSessionForIpc,
  deleteOnethingSessionForIpc,
  getOnethingChatHistoryForIpc,
  getOnethingSessionForIpc,
  getOnethingSessionMessagesForIpc,
  getOnethingSessionMessagesPageForIpc,
  getOnethingSessionTokenUsageForIpc,
  listOnethingSessionsForIpc,
  listOnethingSessionUserMarkersForIpc,
  ONETHING_SESSION_NOT_FOUND,
  removeOnethingMessageForIpc,
  removeOnethingSystemMarkerMessageForIpc,
  renameOnethingSessionForIpc,
  switchOnethingSessionForIpc,
  updateOnethingMessageThinkingTimeForIpc,
  updateOnethingSessionArchivedForIpc,
  updateOnethingSessionPinForIpc,
} from '../ipc-operations.js'
import { normalizeOnethingSessionTokenUsage } from '../session-usage.js'

interface TestMessage {
  id: string
  role?: string
  content?: string
  contentParts?: Array<{ type: string; content?: string }>
}

interface TestSession {
  id: string
  messages: TestMessage[]
}

describe('session IPC operations', () => {
  it('lists and activates sessions behind host adapters', async () => {
    await expect(listOnethingSessionsForIpc({
      listSessions: () => [{ id: 's1', name: 'First' }],
    })).resolves.toEqual({
      success: true,
      sessions: [{ id: 's1', name: 'First' }],
    })

    const setCurrentSessionId = vi.fn()
    await expect(activateOnethingSessionForIpc({
      sessionId: 's1',
      getSessionDetails: () => ({ id: 's1', messageCount: 2 }),
      setCurrentSessionId,
    })).resolves.toEqual({
      success: true,
      session: { id: 's1', messageCount: 2 },
      messageCount: 2,
    })

    expect(setCurrentSessionId).toHaveBeenCalledWith('s1')
  })

  it('normalizes missing session reads without touching mutation adapters', async () => {
    const setCurrentSessionId = vi.fn()

    await expect(activateOnethingSessionForIpc({
      sessionId: 'missing',
      getSessionDetails: () => undefined,
      setCurrentSessionId,
    })).resolves.toEqual({
      success: false,
      error: ONETHING_SESSION_NOT_FOUND,
    })

    await expect(getOnethingSessionMessagesForIpc({
      sessionId: 'missing',
      getSessionMessages: () => undefined,
    })).resolves.toEqual({
      success: false,
      error: ONETHING_SESSION_NOT_FOUND,
    })

    await expect(getOnethingChatHistoryForIpc({
      sessionId: 'missing',
      getSession: () => undefined,
    })).resolves.toEqual({
      success: false,
      error: ONETHING_SESSION_NOT_FOUND,
    })

    await expect(listOnethingSessionUserMarkersForIpc({
      sessionId: 'missing',
      getSessionUserMessageMarkers: () => undefined,
    })).resolves.toEqual({
      success: false,
      error: ONETHING_SESSION_NOT_FOUND,
    })

    expect(setCurrentSessionId).not.toHaveBeenCalled()
  })

  it('sanitizes provider data from renderer-facing messages and sessions', async () => {
    const messages: TestMessage[] = [{
      id: 'm1',
      contentParts: [
        { type: 'text', content: 'hello' },
        { type: 'provider-data', content: 'hidden' },
      ],
    }]

    await expect(getOnethingSessionMessagesForIpc({
      sessionId: 's1',
      getSessionMessages: () => messages,
    })).resolves.toEqual({
      success: true,
      messages: [{
        id: 'm1',
        contentParts: [{ type: 'text', content: 'hello' }],
      }],
    })

    await expect(getOnethingChatHistoryForIpc({
      sessionId: 's1',
      getSession: () => ({ id: 's1', messages }),
    })).resolves.toEqual({
      success: true,
      messages: [{
        id: 'm1',
        contentParts: [{ type: 'text', content: 'hello' }],
      }],
    })

    await expect(getOnethingSessionMessagesPageForIpc({
      request: { sessionId: 's1' },
      getSessionMessagesPage: () => ({
        success: true,
        messages,
        nextCursor: 'next',
      }),
    })).resolves.toEqual({
      success: true,
      messages: [{
        id: 'm1',
        contentParts: [{ type: 'text', content: 'hello' }],
      }],
      nextCursor: 'next',
    })

    const session: TestSession = { id: 's1', messages }
    await expect(getOnethingSessionForIpc({
      sessionId: 's1',
      getSession: () => session,
    })).resolves.toEqual({
      success: true,
      session: {
        id: 's1',
        messages: [{
          id: 'm1',
          contentParts: [{ type: 'text', content: 'hello' }],
        }],
      },
    })
  })

  it('routes basic session mutations through adapters', async () => {
    const createSession = vi.fn((id: string, name: string): TestSession => ({ id, name, messages: [] } as TestSession))
    const setCurrentSessionId = vi.fn()
    const deleteSession = vi.fn(() => ({ parentSessionId: 'parent', deletedIds: ['s1', 'child'] }))
    const renameSession = vi.fn()
    const updateSessionPin = vi.fn()
    const updateSessionArchived = vi.fn()
    const updateMessageThinkingTime = vi.fn(() => true)
    const addMessage = vi.fn()
    const deleteMessage = vi.fn()
    const deleteMarkerMessage = vi.fn()

    await expect(createOnethingSessionForIpc({
      sessionId: 's1',
      name: '',
      createSession,
    })).resolves.toEqual({
      success: true,
      session: { id: 's1', name: 'New Chat', messages: [] },
    })
    await expect(switchOnethingSessionForIpc({
      sessionId: 's1',
      getSession: () => ({ id: 's1', messages: [] }),
      setCurrentSessionId,
    })).resolves.toEqual({
      success: true,
      session: { id: 's1', messages: [] },
    })
    await expect(deleteOnethingSessionForIpc({
      sessionId: 's1',
      deleteSession,
    })).resolves.toEqual({
      success: true,
      parentSessionId: 'parent',
      deletedCount: 2,
    })
    await expect(renameOnethingSessionForIpc({
      sessionId: 's1',
      newName: 'Renamed',
      renameSession,
    })).resolves.toEqual({ success: true })
    await expect(updateOnethingSessionPinForIpc({
      sessionId: 's1',
      isPinned: true,
      updateSessionPin,
    })).resolves.toEqual({ success: true })
    await expect(updateOnethingSessionArchivedForIpc({
      sessionId: 's1',
      isArchived: true,
      archivedAt: 123,
      updateSessionArchived,
    })).resolves.toEqual({ success: true })
    await expect(updateOnethingMessageThinkingTimeForIpc({
      sessionId: 's1',
      messageId: 'm1',
      thinkingTime: 456,
      updateMessageThinkingTime,
    })).resolves.toEqual({ success: true })
    await expect(addOnethingSystemMessageForIpc({
      sessionId: 's1',
      message: { id: 'system-1' },
      addMessage,
    })).resolves.toEqual({ success: true })
    await expect(removeOnethingMessageForIpc({
      sessionId: 's1',
      messageId: 'm1',
      deleteMessage,
    })).resolves.toEqual({ success: true })
    await expect(removeOnethingSystemMarkerMessageForIpc({
      sessionId: 's1',
      markerType: 'files-changed',
      getSession: () => ({
        id: 's1',
        messages: [{ id: 'marker-1', role: 'system', content: '{"type":"files-changed"}' }],
      }),
      deleteMessage: deleteMarkerMessage,
    })).resolves.toEqual({ success: true, removedId: 'marker-1' })

    expect(createSession).toHaveBeenCalledWith('s1', 'New Chat')
    expect(setCurrentSessionId).toHaveBeenCalledWith('s1')
    expect(deleteSession).toHaveBeenCalledWith('s1')
    expect(renameSession).toHaveBeenCalledWith('s1', 'Renamed')
    expect(updateSessionPin).toHaveBeenCalledWith('s1', true)
    expect(updateSessionArchived).toHaveBeenCalledWith('s1', true, 123)
    expect(updateMessageThinkingTime).toHaveBeenCalledWith('s1', 'm1', 456)
    expect(addMessage).toHaveBeenCalledWith('s1', { id: 'system-1' })
    expect(deleteMessage).toHaveBeenCalledWith('s1', 'm1')
    expect(deleteMarkerMessage).toHaveBeenCalledWith('s1', 'marker-1')
  })

  /**
   * 改名的端口回一个字面 `false` = 仓说「查无此会话」(仓层
   * `applySessionMetadataMutationWithAdapters` 只在拿不到 session 时回 false)。
   * 上面那条 happy path 用的是 `vi.fn()`(回 undefined)且照旧 success —— 两条一起
   * 钉住判据是**恒等于 false**,不是 falsy:「没表态」不等于「说没改到」。
   */
  it('rename:端口说 false 就是查无此会话,别的返回值一律当改到了', async () => {
    await expect(renameOnethingSessionForIpc({
      sessionId: 'missing',
      newName: 'Nope',
      renameSession: () => false,
    })).resolves.toEqual({ success: false, error: 'Session not found' })

    for (const answer of [undefined, true, null, 0, '']) {
      await expect(renameOnethingSessionForIpc({
        sessionId: 's1',
        newName: 'Renamed',
        renameSession: () => answer,
      })).resolves.toEqual({ success: true })
    }
  })

  it('normalizes session token usage for IPC callers', async () => {
    expect(normalizeOnethingSessionTokenUsage(undefined)).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      maxTokens: 128000,
      lastInputTokens: 0,
      contextSize: 0,
    })

    await expect(getOnethingSessionTokenUsageForIpc({
      sessionId: 's1',
      maxTokens: 200000,
      getSessionTokenUsage: () => ({
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalTokens: 30,
        lastInputTokens: 7,
        contextSize: 27,
      }),
    })).resolves.toEqual({
      success: true,
      usage: {
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalTokens: 30,
        maxTokens: 200000,
        lastInputTokens: 7,
        contextSize: 27,
      },
    })
  })

  it('normalizes token usage adapter failures', async () => {
    const logger = { error: vi.fn() }

    await expect(getOnethingSessionTokenUsageForIpc({
      sessionId: 's1',
      getSessionTokenUsage: () => {
        throw new Error('usage unavailable')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'usage unavailable',
    })

    expect(logger.error).toHaveBeenCalled()
  })

  it('creates branch sessions through IPC adapters and sanitizes renderer payloads', () => {
    const createBranchSession = vi.fn(input => ({
      id: input.branchId,
      name: input.branchName,
      messages: input.inheritedMessages,
    }))
    const ids = ['branch-1', 'branch-message-1']

    expect(createOnethingBranchSessionForIpc({
      parentSessionId: 'parent-1',
      branchFromMessageId: 'm1',
      adapters: {
        createId: () => ids.shift() ?? 'extra-id',
        getSession: () => ({
          id: 'parent-1',
          name: 'Parent Chat',
          messages: [{
            id: 'm1',
            contentParts: [
              { type: 'text', content: 'visible' },
              { type: 'provider-data', content: 'hidden' },
            ],
          }],
        }),
        createBranchSession,
      },
    })).toEqual({
      success: true,
      session: {
        id: 'branch-1',
        name: 'Parent Chat (Branch)',
        messages: [{
          id: 'branch-message-1',
          contentParts: [{ type: 'text', content: 'visible' }],
        }],
      },
    })
  })

  it('normalizes branch creation adapter failures for IPC callers', () => {
    const logger = { error: vi.fn() }

    expect(createOnethingBranchSessionForIpc({
      parentSessionId: 'parent-1',
      branchFromMessageId: 'm1',
      adapters: {
        createId: () => 'branch-1',
        getSession: () => ({
          id: 'parent-1',
          name: 'Parent Chat',
          messages: [{ id: 'm1' }],
        }),
        createBranchSession: () => {
          throw new Error('create failed')
        },
      },
      logger,
    })).toEqual({
      success: false,
      error: 'create failed',
    })

    expect(logger.error).toHaveBeenCalled()
  })

  it('normalizes system marker removal adapter failures', async () => {
    const logger = { error: vi.fn() }

    await expect(removeOnethingSystemMarkerMessageForIpc({
      sessionId: 's1',
      markerType: 'git-status',
      getSession: () => ({
        id: 's1',
        messages: [{ id: 'marker-1', role: 'system', content: '{"type":"git-status"}' }],
      }),
      deleteMessage: () => {
        throw new Error('delete failed')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'delete failed',
    })

    expect(logger.error).toHaveBeenCalled()
  })
})
