import { describe, expect, it, vi } from 'vitest'
import { isAgentLoopPauseForConfirmationError, streamAgentLoopProviderChunks } from '@onething/core/agent-loop'
import type { AgentProvider, AgentProviderStreamChunk, AgentTurn } from '@onething/core/agent-loop'

function withTimeout<T>(promise: Promise<T>, message = 'timed out waiting for bridge abort'): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), 100)),
  ])
}

describe('agent loop bridge', () => {
  it('streams provider-shaped chunks while running the full agent loop', async () => {
    const provider: AgentProvider = {
      id: 'bridge-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsStreaming: true,
        supportsTools: true,
      },
      async *streamTurn(request) {
        if (request.turn === 1) {
          yield { type: 'tool-call-start', turn: 1, toolCallId: 'call_1', toolName: 'lookup' }
          yield {
            type: 'tool-call-delta',
            turn: 1,
            toolCallId: 'call_1',
            toolName: 'lookup',
            argumentsDelta: '{"query":"moon"}',
          }
          yield {
            type: 'tool-call-done',
            turn: 1,
            toolCall: { id: 'call_1', name: 'lookup', arguments: '{"query":"moon"}' },
          }
          yield { type: 'finish', turn: 1, finishReason: 'tool_calls' }
          return
        }

        expect(request.messages.at(-1)).toEqual({
          role: 'tool',
          toolCallId: 'call_1',
          content: 'result: moon',
        })
        yield { type: 'text-delta', turn: 2, delta: 'done' }
        yield { type: 'finish', turn: 2, finishReason: 'stop' }
      },
    }
    const onEvent = vi.fn()
    const chunks: AgentProviderStreamChunk[] = []

    for await (const chunk of streamAgentLoopProviderChunks({
      provider,
      model: 'bridge-model',
      messages: [{ role: 'user', content: 'lookup the moon' }],
      tools: [{
        name: 'lookup',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        execute: async args => ({ content: `result: ${args.query}` }),
      }],
      sessionId: 's1',
      messageId: 'm1',
      onEvent,
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      { type: 'turn-start', turnStart: { turn: 1 } },
      { type: 'tool-input-start', toolInputStart: { toolCallId: 'call_1', toolName: 'lookup' } },
      { type: 'tool-input-delta', toolInputDelta: { toolCallId: 'call_1', argsTextDelta: '{"query":"moon"}' } },
      { type: 'tool-input-end', toolInputEnd: { toolCallId: 'call_1', finalizedBy: 'parse' } },
      {
        type: 'tool-result',
        toolResult: {
          toolCallId: 'call_1',
          result: { content: 'result: moon' },
        },
      },
      { type: 'finish', finishReason: 'tool-calls', usage: undefined },
      { type: 'turn-start', turnStart: { turn: 2 } },
      { type: 'text', text: 'done' },
      { type: 'finish', finishReason: 'stop', usage: undefined },
    ])
    expect(onEvent).toHaveBeenCalledWith({ type: 'tool-result', turn: 1, toolCall: {
      id: 'call_1',
      name: 'lookup',
      arguments: '{"query":"moon"}',
    }, result: { content: 'result: moon' } })
  })

  it('synthesizes provider-shaped chunks for runTurn-only providers', async () => {
    const provider: AgentProvider = {
      id: 'bridge-run-turn-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'tool-calls', 'reasoning'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsReasoning: true,
      },
      runTurn: vi.fn(async request => {
        if (request.turn === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              reasoningContent: 'need a lookup',
              toolCalls: [{
                id: 'call_1',
                name: 'lookup',
                arguments: '{"query":"sun"}',
              }],
            },
            finishReason: 'tool_calls',
          } satisfies AgentTurn
        }

        expect(request.messages.at(-1)).toEqual({
          role: 'tool',
          toolCallId: 'call_1',
          content: 'result: sun',
        })
        return {
          message: {
            role: 'assistant',
            content: 'done',
          },
          finishReason: 'stop',
        } satisfies AgentTurn
      }),
    }
    const chunks: AgentProviderStreamChunk[] = []

    for await (const chunk of streamAgentLoopProviderChunks({
      provider,
      model: 'bridge-model',
      messages: [{ role: 'user', content: 'lookup the sun' }],
      tools: [{
        name: 'lookup',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        execute: async args => ({ content: `result: ${args.query}` }),
      }],
      sessionId: 's1',
      messageId: 'm1',
    })) {
      chunks.push(chunk)
    }

    expect(provider.runTurn).toHaveBeenCalledTimes(2)
    expect(chunks).toEqual([
      { type: 'turn-start', turnStart: { turn: 1 } },
      { type: 'reasoning', reasoning: 'need a lookup' },
      { type: 'tool-input-start', toolInputStart: { toolCallId: 'call_1', toolName: 'lookup' } },
      { type: 'tool-input-delta', toolInputDelta: { toolCallId: 'call_1', argsTextDelta: '{"query":"sun"}' } },
      { type: 'tool-input-end', toolInputEnd: { toolCallId: 'call_1', finalizedBy: 'parse' } },
      {
        type: 'tool-result',
        toolResult: {
          toolCallId: 'call_1',
          result: { content: 'result: sun' },
        },
      },
      { type: 'finish', finishReason: 'tool-calls', usage: undefined },
      { type: 'turn-start', turnStart: { turn: 2 } },
      { type: 'text', text: 'done' },
      { type: 'finish', finishReason: 'stop', usage: undefined },
    ])
  })

  it('yields confirmation-gated tool results before surfacing the pause signal', async () => {
    const provider: AgentProvider = {
      id: 'bridge-confirmation-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsStreaming: true,
        supportsTools: true,
      },
      async *streamTurn(request) {
        expect(request.turn).toBe(1)
        yield {
          type: 'tool-call-done',
          turn: 1,
          toolCall: { id: 'call_1', name: 'bash', arguments: '{"cmd":"rm -rf tmp"}' },
        }
        yield { type: 'finish', turn: 1, finishReason: 'tool_calls' }
      },
    }
    const chunks: AgentProviderStreamChunk[] = []
    let error: Error | undefined

    try {
      for await (const chunk of streamAgentLoopProviderChunks({
        provider,
        model: 'bridge-model',
        messages: [{ role: 'user', content: 'delete tmp' }],
        tools: [{
          name: 'bash',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
          execute: async () => ({
            content: '',
            error: 'Needs approval',
            requiresConfirmation: true,
            commandType: 'dangerous',
          }),
        }],
        sessionId: 's1',
        messageId: 'm1',
      })) {
        chunks.push(chunk)
      }
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught))
    }

    expect(isAgentLoopPauseForConfirmationError(error)).toBe(true)
    expect(chunks).toEqual([
      { type: 'turn-start', turnStart: { turn: 1 } },
      {
        type: 'tool-call',
        toolCall: {
          toolCallId: 'call_1',
          toolName: 'bash',
          args: { cmd: 'rm -rf tmp' },
          finalizedBy: 'provider-done',
        },
      },
      {
        type: 'tool-result',
        toolResult: {
          toolCallId: 'call_1',
          result: {
            content: '',
            error: 'Needs approval',
            requiresConfirmation: true,
            commandType: 'dangerous',
          },
        },
      },
    ])
  })

  it('aborts runTurn-only bridge streams without hanging the event queue', async () => {
    const controller = new AbortController()
    const provider: AgentProvider = {
      id: 'bridge-run-turn-abort-provider',
      runTurn: vi.fn(async request => {
        expect(request.abortSignal).toBe(controller.signal)
        setTimeout(() => controller.abort(), 0)
        return new Promise<never>(() => {})
      }),
    }
    const chunks: AgentProviderStreamChunk[] = []
    let error: Error | undefined

    try {
      await withTimeout((async () => {
        for await (const chunk of streamAgentLoopProviderChunks({
          provider,
          model: 'bridge-model',
          messages: [{ role: 'user', content: 'wait' }],
          sessionId: 's1',
          messageId: 'm1',
          abortSignal: controller.signal,
        })) {
          chunks.push(chunk)
        }
      })())
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught))
    }

    expect(error).toMatchObject({ name: 'AbortError' })
    expect(provider.runTurn).toHaveBeenCalledTimes(1)
    expect(chunks).toEqual([
      { type: 'turn-start', turnStart: { turn: 1 } },
    ])
  })
})
