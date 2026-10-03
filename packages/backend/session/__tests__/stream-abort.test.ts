import { describe, expect, it, vi } from 'vitest'
import {
  abortOnethingStreamsForIpc,
  cancelOnethingStreamingStepsForAbort,
  listOnethingActiveStreamsForIpc,
} from '../stream-abort.js'

describe('cancelOnethingStreamingStepsForAbort', () => {
  it('cancels running and awaiting-confirmation steps before completing the stream', async () => {
    const runMessage = {
      id: 'assistant-1',
      steps: [
          { id: 'step-1', status: 'running', toolCall: { id: 'tool-1', status: 'executing' } },
          {
            id: 'step-2',
            status: 'awaiting-confirmation',
            toolCall: {
              id: 'tool-2',
              status: 'pending',
              requiresConfirmation: true,
              canRespond: true,
            },
          },
          { id: 'step-3', status: 'completed' },
      ],
    }
    const updateMessageStep = vi.fn()
    const updateMessageStreaming = vi.fn()
    const flushSessionSave = vi.fn()
    const emitEvent = vi.fn()

    await expect(cancelOnethingStreamingStepsForAbort({
      sessionId: 'session-1',
      getActiveRunMessage: () => runMessage,
      updateMessageStep,
      updateMessageStreaming,
      flushSessionSave,
      emitEvent,
    })).resolves.toEqual({
      completed: true,
      cancelledSteps: 2,
      messageId: 'assistant-1',
    })

    expect(updateMessageStep).toHaveBeenCalledTimes(2)
    // 跑着的那一条:引擎的收尾修复(`finalizeLingeringAgentLoopToolWork`)也会
    // 筛到它,所以这里照它的字段写 —— 谁先跑到都留下同一份账(§10.14 第 7 类)。
    expect(updateMessageStep).toHaveBeenNthCalledWith(1, 'session-1', 'assistant-1', 'step-1', {
      status: 'cancelled',
      error: 'User cancelled',
      toolCall: {
        id: 'tool-1',
        status: 'cancelled',
        requiresConfirmation: false,
        canRespond: false,
        endTime: expect.any(Number),
        error: 'User cancelled',
      },
    })
    // 等确认的那一条不写 error:引擎的修复明确放过 `requiresConfirmation` 的调用。
    expect(updateMessageStep).toHaveBeenNthCalledWith(2, 'session-1', 'assistant-1', 'step-2', {
      status: 'cancelled',
      toolCall: {
        id: 'tool-2',
        status: 'cancelled',
        requiresConfirmation: false,
        canRespond: false,
      },
    })
    expect(updateMessageStreaming).toHaveBeenCalledWith('session-1', 'assistant-1', false)
    expect(flushSessionSave).toHaveBeenCalledWith('session-1')
    expect(emitEvent).toHaveBeenCalledWith('session-1', {
      type: 'stream:complete',
      data: { aborted: true },
    })
  })

  it('does nothing when the session has no streaming message with steps', async () => {
    const updateMessageStep = vi.fn()
    const result = await cancelOnethingStreamingStepsForAbort({
      sessionId: 'session-1',
      getActiveRunMessage: () => ({ id: 'assistant-1' }),
      updateMessageStep,
      updateMessageStreaming: vi.fn(),
      flushSessionSave: vi.fn(),
      emitEvent: vi.fn(),
    })

    expect(result).toEqual({ completed: false, cancelledSteps: 0 })
    expect(updateMessageStep).not.toHaveBeenCalled()
  })

  it('orchestrates abort for one session across legacy streams, engine, permissions, and step cleanup', async () => {
    const runMessage = {
      id: 'assistant-1',
      steps: [{ id: 'step-1', status: 'running' }],
    }
    const abortLegacyStream = vi.fn(() => true)
    const abortEngineStream = vi.fn(() => true)
    const clearPermission = vi.fn()
    const updateMessageStep = vi.fn()
    const updateMessageStreaming = vi.fn()
    const flushSessionSave = vi.fn()
    const emitEvent = vi.fn()

    await expect(abortOnethingStreamsForIpc({
      sessionId: 'session-1',
      getLegacyActiveSessionIds: () => ['session-1'],
      abortLegacyStream,
      abortEngineStream,
      abortAllEngineStreams: vi.fn(),
      clearPermission,
      getActiveRunMessage: () => runMessage,
      updateMessageStep,
      updateMessageStreaming,
      flushSessionSave,
      emitEvent,
    })).resolves.toEqual({ success: true })

    expect(abortLegacyStream).toHaveBeenCalledWith('session-1')
    expect(abortEngineStream).toHaveBeenCalledWith('session-1')
    expect(clearPermission).toHaveBeenCalledWith('session-1')
    expect(updateMessageStep).toHaveBeenCalledWith('session-1', 'assistant-1', 'step-1', {
      status: 'cancelled',
      error: 'User cancelled',
      toolCall: undefined,
    })
    expect(updateMessageStreaming).toHaveBeenCalledWith('session-1', 'assistant-1', false)
    expect(flushSessionSave).toHaveBeenCalledWith('session-1')
    expect(emitEvent).toHaveBeenCalledWith('session-1', {
      type: 'stream:complete',
      data: { aborted: true },
    })
  })

  it('orchestrates abort-all without touching session cleanup adapters', async () => {
    const abortLegacyStream = vi.fn(() => true)
    const abortAllEngineStreams = vi.fn(() => true)
    const clearPermission = vi.fn()
    const updateMessageStep = vi.fn()

    await expect(abortOnethingStreamsForIpc({
      getLegacyActiveSessionIds: () => ['session-1', 'session-2'],
      abortLegacyStream,
      abortEngineStream: vi.fn(),
      abortAllEngineStreams,
      clearPermission,
      getActiveRunMessage: vi.fn(),
      updateMessageStep,
      updateMessageStreaming: vi.fn(),
      flushSessionSave: vi.fn(),
      emitEvent: vi.fn(),
    })).resolves.toEqual({ success: true })

    expect(abortLegacyStream).toHaveBeenCalledWith('session-1')
    expect(abortLegacyStream).toHaveBeenCalledWith('session-2')
    expect(clearPermission).toHaveBeenCalledWith('session-1')
    expect(clearPermission).toHaveBeenCalledWith('session-2')
    expect(abortAllEngineStreams).toHaveBeenCalled()
    expect(updateMessageStep).not.toHaveBeenCalled()
  })

  it('lists active stream ids from legacy and engine sources with dedupe and engine fallback', () => {
    expect(listOnethingActiveStreamsForIpc({
      getLegacyActiveSessionIds: () => ['session-1', 'session-2'],
      getEngineActiveSessionIds: () => ['session-2', 'session-3'],
    })).toEqual({
      success: true,
      sessionIds: ['session-1', 'session-2', 'session-3'],
    })

    expect(listOnethingActiveStreamsForIpc({
      getLegacyActiveSessionIds: () => ['legacy-only'],
      getEngineActiveSessionIds: () => {
        throw new Error('not initialized')
      },
    })).toEqual({
      success: true,
      sessionIds: ['legacy-only'],
    })
  })
})
