import { describe, expect, it, vi } from 'vitest'
import {
  emitCoreSessionCommandForIpc,
  emitCoreSessionEventSafely,
} from '../ipc-operations.js'
import { SESSION_COMMAND_TYPES } from '../session-command-types.js'

describe('core event IPC operations', () => {
  it('emits a session command through the provided event bus adapter', async () => {
    const emit = vi.fn(async () => ({ envelope: { sequence: 1 } }))

    await expect(emitCoreSessionCommandForIpc({
      sessionId: 'session-1',
      command: { type: SESSION_COMMAND_TYPES.SEND_MESSAGE },
      eventBus: { emit },
    })).resolves.toEqual({
      success: true,
      result: { envelope: { sequence: 1 } },
    })

    expect(emit).toHaveBeenCalledWith('session-1', { type: SESSION_COMMAND_TYPES.SEND_MESSAGE })
  })

  it('normalizes event bus failures for IPC callers', async () => {
    const logger = { error: vi.fn() }

    await expect(emitCoreSessionCommandForIpc({
      sessionId: 'session-1',
      command: { type: SESSION_COMMAND_TYPES.SEND_MESSAGE },
      eventBus: {
        emit: () => {
          throw new Error('emit failed')
        },
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'emit failed',
    })

    expect(logger.error).toHaveBeenCalled()
  })

  it('safely emits session events through the provided event bus adapter', async () => {
    const emit = vi.fn(async () => ({ envelope: { sequence: 2 } }))

    await expect(emitCoreSessionEventSafely({
      sessionId: 'session-1',
      event: { type: 'stream:error' },
      eventBus: { emit },
    })).resolves.toEqual({ envelope: { sequence: 2 } })

    expect(emit).toHaveBeenCalledWith('session-1', { type: 'stream:error' })
  })

  it('logs and suppresses safe session event emit failures', async () => {
    const logger = { error: vi.fn() }

    await expect(emitCoreSessionEventSafely({
      sessionId: 'session-1',
      event: { type: 'stream:error' },
      eventBus: {
        emit: () => {
          throw new Error('emit failed')
        },
      },
      logger,
      errorLabel: '[Test] emit failed:',
    })).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith('[Test] emit failed:', expect.any(Error))
  })
})
