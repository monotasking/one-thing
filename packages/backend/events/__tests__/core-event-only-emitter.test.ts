import { describe, expect, it, vi } from 'vitest'
import { createCoreEventOnlyEmitter } from '@onething/core/engine'

describe('core event-only emitter', () => {
  it('routes chunks, events, and store side effects through injected adapters', async () => {
    const events: Array<{ sessionId: string; event: { type: string; [key: string]: unknown } }> = []
    const chunks: Array<{ sessionId: string; chunk: { type: string; [key: string]: unknown } }> = []
    const store = {
      addMessageStep: vi.fn(),
      updateMessageStep: vi.fn(),
      updateSessionContextSize: vi.fn(),
      updateMessageSkill: vi.fn(),
    }

    const emitter = createCoreEventOnlyEmitter({
      sessionId: 'session-1',
      assistantMessageId: 'assistant-1',
      getEventBus: () => ({
        emit: async (sessionId, event) => {
          events.push({ sessionId, event })
        },
      }),
      getStreamChannel: () => ({
        push: (sessionId, chunk) => {
          chunks.push({ sessionId, chunk })
        },
      }),
      store,
    })

    emitter.sendTextChunk('hello', 1, 'speak hello')
    emitter.sendReasoningChunk('thinking', 2, 'inline')
    emitter.sendToolInputDelta('call-1', '{"x"')
    emitter.sendToolCall({ id: 'call-1' })
    emitter.sendToolResult({ id: 'call-1', status: 'completed' })
    emitter.sendToolInputStart('call-1', 'read', { id: 'call-1' })
    emitter.sendToolExecutionStart('call-1', 'step-1', 'read', { path: 'README.md' })
    emitter.sendToolExecutionUpdate('call-1', 'step-1', { content: 'partial' })
    emitter.sendToolExecutionEnd('call-1', 'step-1', { content: 'done' }, false)
    emitter.sendContentPart({ type: 'text', text: 'content' })
    emitter.sendContinuation(3)
    emitter.sendStepAdded({ id: 'step-1', title: 'Read' })
    emitter.sendStepUpdated('step-1', { status: 'completed' })
    emitter.sendStreamComplete({ estimatedTokens: 9 })
    emitter.sendStreamError({ message: 'failed' })
    emitter.sendStreamAborted('stop')
    emitter.sendContextSizeUpdate(123)
    emitter.sendSkillActivated('review')

    await Promise.resolve()

    expect(chunks).toEqual([
      {
        sessionId: 'session-1',
        chunk: {
          type: 'text-delta',
          text: 'hello',
          turnIndex: 1,
          voiceSpeakText: 'speak hello',
        },
      },
      {
        sessionId: 'session-1',
        chunk: {
          type: 'reasoning-delta',
          reasoning: 'thinking',
          turnIndex: 2,
          placement: 'inline',
        },
      },
      {
        sessionId: 'session-1',
        chunk: {
          type: 'tool-input-delta',
          toolCallId: 'call-1',
          argsTextDelta: '{"x"',
        },
      },
    ])

    expect(events.map(entry => entry.event.type)).toEqual([
      'tool:call',
      'tool:result',
      'tool:input-start',
      'tool:execution-start',
      'tool:execution-update',
      'tool:execution-end',
      'content:part',
      'content:continuation',
      'step:added',
      'step:updated',
      'stream:complete',
      'stream:error',
      'stream:aborted',
      'context:size-updated',
      'skill:activated',
    ])
    expect(events.every(entry => entry.sessionId === 'session-1')).toBe(true)
    expect(store.addMessageStep).toHaveBeenCalledWith('session-1', 'assistant-1', { id: 'step-1', title: 'Read' })
    expect(store.updateMessageStep).toHaveBeenCalledWith('session-1', 'assistant-1', 'step-1', { status: 'completed' })
    expect(store.updateSessionContextSize).toHaveBeenCalledWith('session-1', 123)
    expect(store.updateMessageSkill).toHaveBeenCalledWith('session-1', 'assistant-1', 'review')
  })

  it('tolerates missing adapters for headless partial wiring', () => {
    const emitter = createCoreEventOnlyEmitter({
      sessionId: 'session-1',
      assistantMessageId: 'assistant-1',
    })

    expect(() => {
      emitter.sendTextChunk('hello')
      emitter.sendToolCall({ id: 'call-1' })
      emitter.sendStepAdded({ id: 'step-1' })
    }).not.toThrow()
  })
})
