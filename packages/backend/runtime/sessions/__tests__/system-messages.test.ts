import { describe, expect, it, vi } from 'vitest'
import { removeOnethingSystemMarkerMessage } from '../system-messages.js'

describe('removeOnethingSystemMarkerMessage', () => {
  it('returns an error when the session is missing', async () => {
    await expect(removeOnethingSystemMarkerMessage({
      sessionId: 'missing-session',
      markerType: 'files-changed',
      getSession: () => undefined,
      deleteMessage: vi.fn(),
    })).resolves.toEqual({
      success: false,
      error: 'Session not found',
    })
  })

  it('returns removedId null when no marker message exists', async () => {
    const deleteMessage = vi.fn()

    await expect(removeOnethingSystemMarkerMessage({
      sessionId: 'session-1',
      markerType: 'files-changed',
      getSession: () => ({
        messages: [
          { id: 'user-1', role: 'user', content: '{"type":"files-changed"}' },
          { id: 'system-1', role: 'system', content: '{"type":"other"}' },
        ],
      }),
      deleteMessage,
    })).resolves.toEqual({
      success: true,
      removedId: null,
    })

    expect(deleteMessage).not.toHaveBeenCalled()
  })

  it('deletes the first matching system marker message', async () => {
    const deleteMessage = vi.fn()

    await expect(removeOnethingSystemMarkerMessage({
      sessionId: 'session-1',
      markerType: 'git-status',
      getSession: () => ({
        messages: [
          { id: 'system-1', role: 'system', content: '{"type":"git-status"}' },
          { id: 'system-2', role: 'system', content: '{"type":"git-status"}' },
        ],
      }),
      deleteMessage,
    })).resolves.toEqual({
      success: true,
      removedId: 'system-1',
    })

    expect(deleteMessage).toHaveBeenCalledWith('session-1', 'system-1')
  })
})
