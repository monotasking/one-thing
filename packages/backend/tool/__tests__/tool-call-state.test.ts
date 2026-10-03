import { describe, expect, it, vi } from 'vitest'
import {
  type ApplyOnethingToolCallUpdateOptions,
  applyOnethingToolCallUpdate,
  applyOnethingToolCallUpdateForIpc,
  formatOnethingToolCallResult,
  mapOnethingToolCallStatusToStepStatus,
  type OnethingToolCallStateLike,
  type OnethingToolMessageStateLike,
  type OnethingToolSessionStateLike,
  type OnethingToolStepStateLike,
} from '../tool-call-state.js'

type TestToolCall = OnethingToolCallStateLike
type TestStep = OnethingToolStepStateLike<TestToolCall>
type TestMessage = OnethingToolMessageStateLike<TestToolCall, TestStep>
type TestSession = OnethingToolSessionStateLike<TestMessage>
type TestOptions = ApplyOnethingToolCallUpdateOptions<
  TestToolCall,
  TestStep,
  TestMessage,
  TestSession
>

function applyTestToolCallUpdate(options: TestOptions) {
  return applyOnethingToolCallUpdate<
    TestToolCall,
    TestStep,
    TestMessage,
    TestSession
  >(options)
}

describe('tool-call-state', () => {
  it('updates matching tool calls and projects executing status onto the matching step', async () => {
    const updateMessageToolCalls = vi.fn()
    const updateMessageStep = vi.fn()

    await expect(applyTestToolCallUpdate({
      sessionId: 'session-1',
      messageId: 'assistant-1',
      toolCallId: 'call-1',
      updates: {
        id: 'call-1',
        status: 'executing',
        result: { ok: true },
      },
      getSession: () => ({
        messages: [{
          id: 'assistant-1',
          toolCalls: [
            { id: 'call-1', status: 'pending', result: undefined },
            { id: 'call-2', status: 'pending' },
          ],
          steps: [{
            id: 'step-1',
            status: 'pending',
            toolCallId: 'call-1',
            toolCall: { id: 'call-1', status: 'pending' },
          }],
        }],
      }),
      updateMessageToolCalls,
      updateMessageStep,
    })).resolves.toEqual({ success: true })

    expect(updateMessageToolCalls).toHaveBeenCalledWith('session-1', 'assistant-1', [
      { id: 'call-1', status: 'executing', result: { ok: true } },
      { id: 'call-2', status: 'pending' },
    ])
    expect(updateMessageStep).toHaveBeenCalledTimes(1)
    expect(updateMessageStep.mock.calls[0]).toEqual([
      'session-1',
      'assistant-1',
      'step-1',
      expect.objectContaining({
        status: 'running',
        result: '{"ok":true}',
        toolCall: { id: 'call-1', status: 'executing', result: { ok: true } },
      }),
    ])
  })

  it('maps pending confirmation tool calls to awaiting confirmation steps', async () => {
    const updateMessageStep = vi.fn()

    await applyTestToolCallUpdate({
      sessionId: 'session-1',
      messageId: 'assistant-1',
      toolCallId: 'call-1',
      updates: {
        id: 'call-1',
        status: 'pending',
        requiresConfirmation: true,
      },
      getSession: () => ({
        messages: [{
          id: 'assistant-1',
          toolCalls: [{ id: 'call-1', status: 'input-streaming' }],
          steps: [{
            id: 'step-1',
            status: 'running',
            toolCallId: 'call-1',
            toolCall: { id: 'call-1', status: 'input-streaming' },
          }],
        }],
      }),
      updateMessageToolCalls: vi.fn(),
      updateMessageStep,
    })

    expect(updateMessageStep.mock.calls[0][3]).toEqual(expect.objectContaining({
      status: 'awaiting-confirmation',
      toolCall: {
        id: 'call-1',
        status: 'pending',
        requiresConfirmation: true,
      },
    }))
  })

  it('returns existing validation errors from the runtime projection boundary', async () => {
    await expect(applyTestToolCallUpdate({
      sessionId: 'missing-session',
      messageId: 'assistant-1',
      toolCallId: 'call-1',
      updates: { id: 'call-1' },
      getSession: () => undefined,
      updateMessageToolCalls: vi.fn(),
      updateMessageStep: vi.fn(),
    })).resolves.toEqual({ success: false, error: 'Session not found' })

    await expect(applyTestToolCallUpdate({
      sessionId: 'session-1',
      messageId: 'missing-message',
      toolCallId: 'call-1',
      updates: { id: 'call-1' },
      getSession: () => ({ messages: [{ id: 'assistant-1' }] }),
      updateMessageToolCalls: vi.fn(),
      updateMessageStep: vi.fn(),
    })).resolves.toEqual({
      success: false,
      error: 'Message or tool calls not found',
    })
  })

  it('keeps status and result formatting compatible with the previous IPC behavior', () => {
    expect(mapOnethingToolCallStatusToStepStatus('completed', false, 'running')).toBe('completed')
    expect(mapOnethingToolCallStatusToStepStatus('input-streaming', false, 'running')).toBe('running')
    expect(formatOnethingToolCallResult('plain')).toBe('plain')
    expect(formatOnethingToolCallResult({ value: 1 })).toBe('{"value":1}')
    expect(formatOnethingToolCallResult(false)).toBeUndefined()
  })

  it('normalizes tool call update adapter failures for IPC callers', async () => {
    const logger = { error: vi.fn() }

    await expect(applyOnethingToolCallUpdateForIpc<
      TestToolCall,
      TestStep,
      TestMessage,
      TestSession
    >({
      sessionId: 'session-1',
      messageId: 'assistant-1',
      toolCallId: 'call-1',
      updates: { id: 'call-1', status: 'completed' },
      getSession: () => ({
        messages: [{
          id: 'assistant-1',
          toolCalls: [{ id: 'call-1', status: 'running' }],
        }],
      }),
      updateMessageToolCalls: () => {
        throw new Error('update failed')
      },
      updateMessageStep: vi.fn(),
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'update failed',
    })

    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
