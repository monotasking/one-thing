import { describe, expect, it, vi } from 'vitest'
import { buildOnethingSystemPromptSnapshotForIpc } from '../system-prompt-snapshot.js'

describe('system prompt snapshot IPC facade', () => {
  it('wraps snapshot assembly in the renderer-facing success shape', async () => {
    const buildSnapshot = vi.fn(async () => ({ sessionId: 's1', systemPrompt: 'hello' }))

    await expect(buildOnethingSystemPromptSnapshotForIpc({
      sessionId: 's1',
      buildSnapshot,
    })).resolves.toEqual({
      success: true,
      snapshot: { sessionId: 's1', systemPrompt: 'hello' },
    })

    expect(buildSnapshot).toHaveBeenCalledWith('s1')
  })

  it('normalizes snapshot assembly errors for IPC callers', async () => {
    const logger = { error: vi.fn() }

    await expect(buildOnethingSystemPromptSnapshotForIpc({
      sessionId: 's1',
      buildSnapshot: async () => {
        throw new Error('provider missing')
      },
      errorMessage: (error, fallback) =>
        error instanceof Error ? `detail: ${error.message}` : fallback,
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'detail: provider missing',
    })

    expect(logger.error).toHaveBeenCalled()
  })
})
