import { describe, expect, it, vi } from 'vitest'
import { createOnethingStreamProcessor } from '../stream-processor.js'

describe('onething stream processor', () => {
  it('owns stream processor context projection over the core processor', async () => {
    const store = {
      updateMessageContent: vi.fn(),
      updateMessageReasoning: vi.fn(),
      updateMessageToolCalls: vi.fn(),
      updateMessageStreaming: vi.fn(),
      flushSessionSave: vi.fn(),
    }
    const emitter = {
      sendTextChunk: vi.fn(),
      sendReasoningChunk: vi.fn(),
      sendToolCall: vi.fn(),
      sendStepAdded: vi.fn(),
      sendToolInputStart: vi.fn(),
      sendToolInputDelta: vi.fn(),
    }
    const resolveToolIdentity = vi.fn((toolName: string) => ({
      toolId: `resolved:${toolName}`,
      displayName: `Display ${toolName}`,
      isMcp: false,
    }))

    const processor = createOnethingStreamProcessor({
      sessionId: 'session-1',
      assistantMessageId: 'assistant-1',
      initialContent: {
        content: 'Hello',
        reasoning: 'Think',
      },
      store,
      emitter,
      resolveToolIdentity,
    })

    expect(processor.handleTextChunk(' world', undefined, 2)).toBe(' world')
    processor.handleReasoningChunk(' more', undefined, 3, 'bottom')
    processor.handleToolCallChunk({
      toolCallId: 'tool-call-1',
      toolName: 'read',
      args: { path: 'a.txt' },
    })
    processor.handleToolInputStart('tool-call-2', 'write', 4)
    processor.handleToolInputDelta('tool-call-2', '{"path":"b.txt"}')
    const completedInput = processor.handleToolInputEnd('tool-call-2')
    await processor.finalize()

    expect(store.updateMessageContent).toHaveBeenCalledWith(
      'session-1',
      'assistant-1',
      'Hello world',
    )
    expect(store.updateMessageReasoning).not.toHaveBeenCalled()
    expect(emitter.sendReasoningChunk).toHaveBeenCalledWith(' more', 3, 'bottom')
    expect(store.updateMessageToolCalls).toHaveBeenCalledWith(
      'session-1',
      'assistant-1',
      expect.arrayContaining([
        expect.objectContaining({
          id: 'tool-call-1',
          toolId: 'resolved:read',
          toolName: 'Display read',
        }),
      ]),
    )
    // F4-b1(§16.16):step id = `step-<callId>`,与投影物化同一条派生规则。
    expect(emitter.sendStepAdded).toHaveBeenCalledWith(expect.objectContaining({
      id: 'step-tool-call-2',
      toolCallId: 'tool-call-2',
    }))
    expect(completedInput).toMatchObject({
      id: 'tool-call-2',
      toolId: 'resolved:write',
      toolName: 'Display write',
    })
    expect(store.updateMessageStreaming).toHaveBeenCalledWith(
      'session-1',
      'assistant-1',
      false,
    )
    expect(store.flushSessionSave).toHaveBeenCalledWith('session-1')
  })
})
