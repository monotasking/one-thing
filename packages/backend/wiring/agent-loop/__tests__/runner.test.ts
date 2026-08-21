import { describe, expect, it, vi } from 'vitest'
import { isAgentLoopPauseForConfirmationError, runAgentLoop } from '@onething/core/agent-loop'
import type {
  AgentMessage,
  AgentMessageContent,
  AgentProvider,
  AgentStreamEvent,
  AgentToolChoice,
  AgentTurn,
  AgentTurnRequest,
} from '@onething/core/agent-loop'

type MessageSnapshot = Array<{
  role: AgentMessage['role']
  content: AgentMessageContent
}>

function withTimeout<T>(promise: Promise<T>, message = 'timed out waiting for abort'): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), 100)),
  ])
}

describe('agent loop runner', () => {
  it('executes selected tools and feeds results into the next model turn', async () => {
    const seenToolNames: string[][] = []
    const provider: AgentProvider = {
      id: 'fake',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
      },
      runTurn: vi.fn(async (request: AgentTurnRequest) => {
        seenToolNames.push(request.tools?.map(tool => tool.name) ?? [])
        if (request.turn === 1) {
          request.onEvent?.({ type: 'text-delta', turn: 1, delta: 'calling' })
          return {
            message: {
              role: 'assistant',
              content: '',
              reasoningContent: 'need a tool',
              toolCalls: [{
                id: 'call_1',
                name: 'make_note',
                arguments: '{"text":"hello"}',
              }],
            },
            finishReason: 'tool_calls',
          } satisfies AgentTurn
        }

        expect(request.messages.at(-1)).toEqual({
          role: 'tool',
          toolCallId: 'call_1',
          content: 'noted: hello',
        })
        return {
          message: {
            role: 'assistant',
            content: '{"changed":true}',
          },
          finishReason: 'stop',
        } satisfies AgentTurn
      }),
    }
    const execute = vi.fn(async args => ({ content: `noted: ${args.text}` }))
    const events: string[] = []

    const result = await runAgentLoop({
      provider,
      model: 'fake-model',
      messages: [{ role: 'user', content: 'make note' }],
      tools: [
        {
          name: 'make_note',
          description: 'Create a note',
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          execute,
        },
        {
          name: 'disabled_tool',
          parameters: { type: 'object', properties: {}, required: [] },
          execute: async () => ({ content: 'nope' }),
        },
      ],
      selectedToolNames: ['make_note'],
      sessionId: 's1',
      messageId: 'm1',
      maxTurns: 4,
      onEvent(event) {
        events.push(event.type)
      },
    })

    expect(provider.runTurn).toHaveBeenCalledTimes(2)
    expect(seenToolNames[0]).toEqual(['make_note'])
    expect(execute).toHaveBeenCalledWith(
      { text: 'hello' },
      expect.objectContaining({ sessionId: 's1', messageId: 'm1', toolCallId: 'call_1' }),
    )
    expect(result.text).toBe('{"changed":true}')
    expect(result.turns).toBe(2)
    expect(result.toolResults).toHaveLength(1)
    expect(events).toContain('tool-result')
  })

  it('synthesizes missing stream events from runTurn results', async () => {
    const usage = { inputTokens: 3, outputTokens: 4, totalTokens: 7 }
    const providerData = {
      provider: 'codex',
      type: 'encrypted-reasoning',
      encryptedContent: 'encrypted-payload',
    } as const
    const provider: AgentProvider = {
      id: 'non-stream-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'reasoning'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsReasoning: true,
      },
      runTurn: vi.fn(async () => ({
        message: {
          role: 'assistant',
          content: 'final text',
          reasoningContent: 'quiet thought',
          providerData: [providerData],
        },
        finishReason: 'stop',
        usage,
      } satisfies AgentTurn)),
    }
    const events: AgentStreamEvent[] = []

    const result = await runAgentLoop({
      provider,
      model: 'non-stream-model',
      messages: [{ role: 'user', content: 'hello' }],
      sessionId: 's1',
      messageId: 'm1',
      onEvent(event) {
        events.push(event)
      },
    })

    expect(result.text).toBe('final text')
    expect(events).toEqual([
      { type: 'turn-start', turn: 1 },
      { type: 'reasoning-delta', turn: 1, delta: 'quiet thought' },
      { type: 'text-delta', turn: 1, delta: 'final text' },
      { type: 'provider-data', turn: 1, providerData },
      { type: 'finish', turn: 1, finishReason: 'stop', usage },
      { type: 'turn-end', turn: 1, finishReason: 'stop', usage },
    ])
  })

  it('completes partial runTurn stream events without duplicating emitted deltas', async () => {
    const provider: AgentProvider = {
      id: 'partially-streaming-run-turn-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output'],
        inputModalities: ['text'],
        outputModalities: ['text'],
      },
      runTurn: vi.fn(async (request: AgentTurnRequest) => {
        request.onEvent?.({ type: 'text-delta', turn: request.turn, delta: 'already ' })
        return {
          message: {
            role: 'assistant',
            content: 'already streamed',
          },
          finishReason: 'stop',
        } satisfies AgentTurn
      }),
    }
    const events: AgentStreamEvent[] = []

    await runAgentLoop({
      provider,
      model: 'partial-stream-model',
      messages: [{ role: 'user', content: 'hello' }],
      sessionId: 's1',
      messageId: 'm1',
      onEvent(event) {
        events.push(event)
      },
    })

    expect(events.filter(event => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', turn: 1, delta: 'already ' },
      { type: 'text-delta', turn: 1, delta: 'streamed' },
    ])
    expect(events.filter(event => event.type === 'finish')).toEqual([
      { type: 'finish', turn: 1, finishReason: 'stop', usage: undefined },
    ])
  })

  it('preserves structured media tool results for capable providers', async () => {
    const seenToolMessages: AgentMessage[] = []
    const provider: AgentProvider = {
      id: 'vision-tool-provider',
      capabilities: {
        capabilities: [
          'text-input',
          'vision-input',
          'file-input',
          'text-output',
          'tool-calls',
          'structured-tool-results',
        ],
        inputModalities: ['text', 'image', 'file'],
        outputModalities: ['text'],
        toolResultModalities: ['text', 'image'],
        supportsTools: true,
        supportsStructuredToolResults: true,
      },
      runTurn: vi.fn(async (request: AgentTurnRequest) => {
        if (request.turn === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call_1',
                name: 'screenshot',
                arguments: '{}',
              }],
            },
            finishReason: 'tool_calls',
          } satisfies AgentTurn
        }

        const lastMessage = request.messages.at(-1)
        if (lastMessage) seenToolMessages.push(lastMessage)
        return {
          message: {
            role: 'assistant',
            content: 'looked',
          },
          finishReason: 'stop',
        } satisfies AgentTurn
      }),
    }

    await runAgentLoop({
      provider,
      model: 'vision-tool-model',
      messages: [{ role: 'user', content: 'inspect screen' }],
      tools: [{
        name: 'screenshot',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => ({
          content: 'screenshot captured',
          data: {
            content: [
              { type: 'image', data: 'data:image/png;base64,abc' },
            ],
          },
        }),
      }],
      sessionId: 's1',
      messageId: 'm1',
    })

    expect(seenToolMessages).toEqual([{
      role: 'tool',
      toolCallId: 'call_1',
      content: [
        { type: 'text', text: 'screenshot captured' },
        { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
      ],
    }])
  })

  it('downgrades media tool results to text for text-only providers', async () => {
    const seenToolMessages: AgentMessage[] = []
    const provider: AgentProvider = {
      id: 'text-tool-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
      },
      runTurn: vi.fn(async (request: AgentTurnRequest) => {
        if (request.turn === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call_1',
                name: 'screenshot',
                arguments: '{}',
              }],
            },
            finishReason: 'tool_calls',
          } satisfies AgentTurn
        }

        const lastMessage = request.messages.at(-1)
        if (lastMessage) seenToolMessages.push(lastMessage)
        return {
          message: {
            role: 'assistant',
            content: 'summarized',
          },
          finishReason: 'stop',
        } satisfies AgentTurn
      }),
    }

    await runAgentLoop({
      provider,
      model: 'text-tool-model',
      messages: [{ role: 'user', content: 'inspect screen' }],
      tools: [{
        name: 'screenshot',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => ({
          content: 'screenshot captured',
          data: {
            content: [
              { type: 'image', data: 'data:image/png;base64,abc' },
            ],
          },
        }),
      }],
      sessionId: 's1',
      messageId: 'm1',
    })

    expect(seenToolMessages).toEqual([{
      role: 'tool',
      toolCallId: 'call_1',
      content: 'screenshot captured\n[Image: image/png data omitted: 25 chars]',
    }])
  })

  it('uses streamTurn providers with tool policy, skills, and prompt injectors', async () => {
    const seenToolNames: string[][] = []
    const seenMessageContents: AgentMessageContent[][] = []
    const seenToolChoices: Array<AgentToolChoice | undefined> = []
    const provider: AgentProvider = {
      id: 'stream-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsStreaming: true,
        supportsTools: true,
      },
      async *streamTurn(request) {
        seenToolNames.push(request.tools?.map(tool => tool.name) ?? [])
        seenMessageContents.push(request.messages.map(message => message.content))
        seenToolChoices.push(request.toolChoice)
        yield { type: 'text-delta', turn: request.turn, delta: 'ok' }
        yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
      },
    }

    const result = await runAgentLoop({
      provider,
      model: 'stream-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'enabled_tool',
          parameters: { type: 'object', properties: {}, required: [] },
          execute: async () => ({ content: 'enabled' }),
        },
        {
          name: 'blocked_tool',
          parameters: { type: 'object', properties: {}, required: [] },
          execute: async () => ({ content: 'blocked' }),
        },
        {
          name: 'read',
          parameters: { type: 'object', properties: {}, required: [] },
          execute: async () => ({ content: 'read' }),
        },
      ],
      toolPolicy: {
        allowedToolNames: ['enabled_tool', 'blocked_tool', 'read'],
        blockedToolNames: ['blocked_tool'],
      },
      skills: [{
        name: 'daily-notes',
        description: 'Keep daily notes concise',
      }],
      promptInjectors: [
        () => [{ role: 'system', content: 'dynamic context' }],
      ],
      sessionId: 's1',
      messageId: 'm1',
    })

    expect(result.text).toBe('ok')
    expect(seenToolNames).toHaveLength(1)
    expect(seenToolNames[0]).toEqual(['enabled_tool', 'read'])
    expect(seenToolChoices[0]).toBe('auto')
    expect(seenMessageContents[0]).toEqual([
      expect.stringContaining('daily-notes'),
      'dynamic context',
      'hello',
    ])
  })

  it('passes abort signal to prompt injectors and lifecycle hooks', async () => {
    const controller = new AbortController()
    const seenSignals: Array<AbortSignal | undefined> = []
    const provider: AgentProvider = {
      id: 'hook-signal-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'streaming'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsStreaming: true,
      },
      async *streamTurn(request) {
        expect(request.abortSignal).toBe(controller.signal)
        yield { type: 'text-delta', turn: request.turn, delta: 'hook ok' }
        yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
      },
    }

    const result = await runAgentLoop({
      provider,
      model: 'hook-signal-model',
      messages: [{ role: 'user', content: 'hello' }],
      promptInjectors: [
        context => {
          seenSignals.push(context.abortSignal)
          return []
        },
      ],
      beforeTurn(context) {
        seenSignals.push(context.abortSignal)
      },
      afterTurn(context) {
        seenSignals.push(context.abortSignal)
      },
      sessionId: 's1',
      messageId: 'm1',
      abortSignal: controller.signal,
    })

    expect(result.text).toBe('hook ok')
    expect(seenSignals).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
    ])
  })

  it('can disable all tools for a turn through tool policy', async () => {
    const provider: AgentProvider = {
      id: 'stream-provider',
      async *streamTurn(request) {
        expect(request.tools).toEqual([])
        expect(request.toolChoice).toBe('none')
        yield { type: 'text-delta', turn: request.turn, delta: 'no tools' }
        yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
      },
    }

    const result = await runAgentLoop({
      provider,
      model: 'stream-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'read',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => ({ content: 'read' }),
      }],
      toolPolicy: { enabled: false },
      sessionId: 's1',
      messageId: 'm1',
    })

    expect(result.text).toBe('no tools')
  })

  it('keeps function tool choice only when the requested tool is available', async () => {
    const seenRequests: Array<{
      tools: string[]
      toolChoice: AgentToolChoice | undefined
    }> = []
    const provider: AgentProvider = {
      id: 'tool-choice-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
      },
      runTurn: vi.fn(async (request: AgentTurnRequest) => {
        seenRequests.push({
          tools: request.tools?.map(tool => tool.name) ?? [],
          toolChoice: request.toolChoice,
        })
        return {
          message: { role: 'assistant', content: 'done' },
          finishReason: 'stop',
        } satisfies AgentTurn
      }),
    }

    await runAgentLoop({
      provider,
      model: 'tool-choice-model',
      messages: [{ role: 'user', content: 'lookup' }],
      tools: [
        {
          name: 'lookup',
          parameters: { type: 'object', properties: {}, required: [] },
          execute: async () => ({ content: 'lookup' }),
        },
        {
          name: 'write',
          parameters: { type: 'object', properties: {}, required: [] },
          execute: async () => ({ content: 'write' }),
        },
      ],
      selectedToolNames: ['lookup'],
      toolChoice: { type: 'function', function: { name: 'lookup' } },
      sessionId: 's1',
      messageId: 'm1',
    })

    expect(seenRequests[0]).toEqual({
      tools: ['lookup'],
      toolChoice: { type: 'function', function: { name: 'lookup' } },
    })
  })

  it('drops function tool choice when policy filters the requested tool out', async () => {
    const seenRequests: Array<{
      tools: string[]
      toolChoice: AgentToolChoice | undefined
    }> = []
    const provider: AgentProvider = {
      id: 'blocked-tool-choice-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
      },
      runTurn: vi.fn(async (request: AgentTurnRequest) => {
        seenRequests.push({
          tools: request.tools?.map(tool => tool.name) ?? [],
          toolChoice: request.toolChoice,
        })
        return {
          message: { role: 'assistant', content: 'done' },
          finishReason: 'stop',
        } satisfies AgentTurn
      }),
    }

    await runAgentLoop({
      provider,
      model: 'tool-choice-model',
      messages: [{ role: 'user', content: 'lookup' }],
      tools: [
        {
          name: 'lookup',
          parameters: { type: 'object', properties: {}, required: [] },
          execute: async () => ({ content: 'lookup' }),
        },
        {
          name: 'write',
          parameters: { type: 'object', properties: {}, required: [] },
          execute: async () => ({ content: 'write' }),
        },
      ],
      toolPolicy: {
        allowedToolNames: ['lookup', 'write'],
        blockedToolNames: ['write'],
      },
      toolChoice: { type: 'function', function: { name: 'write' } },
      sessionId: 's1',
      messageId: 'm1',
    })

    expect(seenRequests[0]).toEqual({
      tools: ['lookup'],
      toolChoice: 'none',
    })
  })

  it('passes requested output modalities to providers that support them', async () => {
    const seenOutputModalities: Array<readonly string[] | undefined> = []
    const provider: AgentProvider = {
      id: 'image-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'image-output'],
        inputModalities: ['text'],
        outputModalities: ['text'],
      },
      runTurn: vi.fn(async (request: AgentTurnRequest) => {
        seenOutputModalities.push(request.requestedOutputModalities)
        return {
          message: { role: 'assistant', content: 'image queued' },
          finishReason: 'stop',
        } satisfies AgentTurn
      }),
    }

    const result = await runAgentLoop({
      provider,
      model: 'image-model',
      messages: [{ role: 'user', content: 'draw it' }],
      requestedOutputModalities: ['image'],
      sessionId: 's1',
      messageId: 'm1',
    })

    expect(result.text).toBe('image queued')
    expect(seenOutputModalities[0]).toEqual(['image'])
  })

  it('rejects requested output modalities unsupported by the provider before provider execution', async () => {
    const provider: AgentProvider = {
      id: 'text-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output'],
        inputModalities: ['text'],
        outputModalities: ['text'],
      },
      runTurn: vi.fn(async () => ({
        message: { role: 'assistant', content: 'unreachable' },
        finishReason: 'stop',
      } satisfies AgentTurn)),
    }

    await expect(runAgentLoop({
      provider,
      model: 'text-model',
      messages: [{ role: 'user', content: 'make audio' }],
      requestedOutputModalities: ['audio'],
      sessionId: 's1',
      messageId: 'm1',
    })).rejects.toThrow('Agent provider does not support audio output')
    expect(provider.runTurn).not.toHaveBeenCalled()
  })

  it('stops before provider execution when the abort signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const provider: AgentProvider = {
      id: 'abort-provider',
      runTurn: vi.fn(async () => ({
        message: { role: 'assistant', content: 'unreachable' },
        finishReason: 'stop',
      } satisfies AgentTurn)),
    }

    await expect(runAgentLoop({
      provider,
      model: 'abort-model',
      messages: [{ role: 'user', content: 'hello' }],
      sessionId: 's1',
      messageId: 'm1',
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(provider.runTurn).not.toHaveBeenCalled()
  })

  it('aborts while provider execution is pending', async () => {
    const controller = new AbortController()
    const provider: AgentProvider = {
      id: 'pending-provider',
      runTurn: vi.fn(async (request: AgentTurnRequest) => {
        expect(request.abortSignal).toBe(controller.signal)
        setTimeout(() => controller.abort(), 0)
        return new Promise<AgentTurn>(() => {})
      }),
    }

    await expect(withTimeout(runAgentLoop({
      provider,
      model: 'pending-model',
      messages: [{ role: 'user', content: 'hello' }],
      sessionId: 's1',
      messageId: 'm1',
      abortSignal: controller.signal,
    }))).rejects.toMatchObject({ name: 'AbortError' })
    expect(provider.runTurn).toHaveBeenCalledTimes(1)
  })

  it('propagates tool aborts instead of feeding them into another model turn', async () => {
    const controller = new AbortController()
    const provider: AgentProvider = {
      id: 'tool-abort-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
      },
      runTurn: vi.fn(async (request: AgentTurnRequest) => {
        if (request.turn !== 1) {
          return {
            message: { role: 'assistant', content: 'should not continue' },
            finishReason: 'stop',
          } satisfies AgentTurn
        }
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: 'call_1',
              name: 'read',
              arguments: '{}',
            }],
          },
          finishReason: 'tool_calls',
        } satisfies AgentTurn
      }),
    }
    const events: AgentStreamEvent[] = []

    await expect(runAgentLoop({
      provider,
      model: 'tool-abort-model',
      messages: [{ role: 'user', content: 'read file' }],
      tools: [{
        name: 'read',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => {
          controller.abort()
          throw new Error('Operation aborted')
        },
      }],
      sessionId: 's1',
      messageId: 'm1',
      abortSignal: controller.signal,
      onEvent(event) {
        events.push(event)
      },
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(provider.runTurn).toHaveBeenCalledTimes(1)
    expect(events.some(event => event.type === 'tool-result')).toBe(false)
  })

  it('aborts while tool execution is pending', async () => {
    const controller = new AbortController()
    const provider: AgentProvider = {
      id: 'pending-tool-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
      },
      runTurn: vi.fn(async (request: AgentTurnRequest) => {
        if (request.turn !== 1) {
          return {
            message: { role: 'assistant', content: 'should not continue' },
            finishReason: 'stop',
          } satisfies AgentTurn
        }
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: 'call_1',
              name: 'read',
              arguments: '{}',
            }],
          },
          finishReason: 'tool_calls',
        } satisfies AgentTurn
      }),
    }
    const execute = vi.fn(async (_args, ctx) => {
      expect(ctx.abortSignal).toBe(controller.signal)
      setTimeout(() => controller.abort(), 0)
      return new Promise<never>(() => {})
    })
    const events: AgentStreamEvent[] = []

    await expect(withTimeout(runAgentLoop({
      provider,
      model: 'pending-tool-model',
      messages: [{ role: 'user', content: 'read file' }],
      tools: [{
        name: 'read',
        parameters: { type: 'object', properties: {}, required: [] },
        execute,
      }],
      sessionId: 's1',
      messageId: 'm1',
      abortSignal: controller.signal,
      onEvent(event) {
        events.push(event)
      },
    }))).rejects.toMatchObject({ name: 'AbortError' })

    expect(provider.runTurn).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(events.some(event => event.type === 'tool-result')).toBe(false)
  })

  it('can continue with messages returned by an after-turn hook', async () => {
    const seenMessages: MessageSnapshot[] = []
    const provider: AgentProvider = {
      id: 'after-turn-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'streaming'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsStreaming: true,
      },
      async *streamTurn(request) {
        seenMessages.push(request.messages.map(message => ({ role: message.role, content: message.content })))
        if (request.turn === 1) {
          yield { type: 'text-delta', turn: request.turn, delta: 'first' }
          yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
          return
        }
        yield { type: 'text-delta', turn: request.turn, delta: 'second' }
        yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
      },
    }

    const result = await runAgentLoop({
      provider,
      model: 'after-turn-model',
      messages: [{ role: 'user', content: 'hello' }],
      afterTurn({ turn, messages }) {
        if (turn !== 1) return
        return [
          ...messages,
          { role: 'user', content: 'follow up' },
        ]
      },
      sessionId: 's1',
      messageId: 'm1',
      maxTurns: 3,
    })

    expect(result.text).toBe('second')
    expect(result.turns).toBe(2)
    expect(seenMessages).toEqual([
      [{ role: 'user', content: 'hello' }],
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'first' },
        { role: 'user', content: 'follow up' },
      ],
    ])
  })

  it('disables tools when provider capabilities do not include tool calls', async () => {
    const execute = vi.fn(async () => ({ content: 'tool output' }))
    const provider: AgentProvider = {
      id: 'text-only-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'streaming'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsStreaming: true,
        supportsTools: false,
      },
      async *streamTurn(request) {
        expect(request.tools).toEqual([])
        expect(request.toolChoice).toBe('none')
        yield { type: 'text-delta', turn: request.turn, delta: 'text only' }
        yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
      },
    }

    const result = await runAgentLoop({
      provider,
      model: 'text-only-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'read',
        parameters: { type: 'object', properties: {}, required: [] },
        execute,
      }],
      sessionId: 's1',
      messageId: 'm1',
    })

    expect(result.text).toBe('text only')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects unsupported multimodal input before calling the provider', async () => {
    const provider: AgentProvider = {
      id: 'text-only-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output'],
        inputModalities: ['text'],
        outputModalities: ['text'],
      },
      runTurn: vi.fn(async () => ({
        message: { role: 'assistant', content: 'unreachable' },
        finishReason: 'stop',
      } satisfies AgentTurn)),
    }

    await expect(runAgentLoop({
      provider,
      model: 'text-only-model',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
        ],
      }],
      sessionId: 's1',
      messageId: 'm1',
    })).rejects.toThrow('does not support image input')
    expect(provider.runTurn).not.toHaveBeenCalled()
  })

  it('passes supported multimodal input through to capable providers', async () => {
    const seenMessages: AgentMessage[][] = []
    const provider: AgentProvider = {
      id: 'vision-provider',
      capabilities: {
        capabilities: ['text-input', 'vision-input', 'text-output', 'streaming'],
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        supportsStreaming: true,
      },
      async *streamTurn(request) {
        seenMessages.push(request.messages)
        yield { type: 'text-delta', turn: request.turn, delta: 'vision ok' }
        yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
      },
    }

    const imageContent = [
      { type: 'text' as const, text: 'look' },
      { type: 'image' as const, image: 'data:image/png;base64,abc', mediaType: 'image/png' },
    ]
    const result = await runAgentLoop({
      provider,
      model: 'vision-model',
      messages: [{ role: 'user', content: imageContent }],
      sessionId: 's1',
      messageId: 'm1',
    })

    expect(result.text).toBe('vision ok')
    expect(seenMessages[0][0].content).toEqual(imageContent)
  })

  it('can replace messages before a later provider turn', async () => {
    const seenMessages: MessageSnapshot[] = []
    const provider: AgentProvider = {
      id: 'compactable-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsStreaming: true,
        supportsTools: true,
      },
      async *streamTurn(request) {
        seenMessages.push(request.messages.map(message => ({
          role: message.role,
          content: message.content,
        })))
        if (request.turn === 1) {
          yield {
            type: 'tool-call-done',
            turn: 1,
            toolCall: { id: 'call_1', name: 'lookup', arguments: '{}' },
          }
          yield { type: 'finish', turn: 1, finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text-delta', turn: 2, delta: 'after compact' }
        yield { type: 'finish', turn: 2, finishReason: 'stop' }
      },
    }

    const result = await runAgentLoop({
      provider,
      model: 'compact-model',
      messages: [
        { role: 'system', content: 'old system' },
        { role: 'user', content: 'old user' },
      ],
      tools: [{
        name: 'lookup',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => ({ content: 'tool output' }),
      }],
      beforeTurn({ turn, messages }) {
        if (turn !== 2) return
        expect(messages.at(-1)).toEqual({
          role: 'tool',
          toolCallId: 'call_1',
          content: 'tool output',
        })
        return [
          { role: 'system', content: 'compacted summary' },
          ...messages.slice(-2),
        ]
      },
      sessionId: 's1',
      messageId: 'm1',
      maxTurns: 3,
    })

    expect(result.text).toBe('after compact')
    expect(seenMessages[0]).toEqual([
      { role: 'system', content: 'old system' },
      { role: 'user', content: 'old user' },
    ])
    expect(seenMessages[1]).toEqual([
      { role: 'system', content: 'compacted summary' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: 'tool output' },
    ])
  })

  it('emits tool metadata and partial result events from tool execution', async () => {
    const provider: AgentProvider = {
      id: 'tool-events-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsStreaming: true,
        supportsTools: true,
      },
      async *streamTurn(request) {
        if (request.turn === 1) {
          yield {
            type: 'tool-call-done',
            turn: 1,
            toolCall: { id: 'call_1', name: 'edit', arguments: '{}' },
          }
          yield { type: 'finish', turn: 1, finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text-delta', turn: 2, delta: 'done' }
        yield { type: 'finish', turn: 2, finishReason: 'stop' }
      },
    }
    const events: AgentStreamEvent[] = []

    await runAgentLoop({
      provider,
      model: 'tool-events-model',
      messages: [{ role: 'user', content: 'edit' }],
      tools: [{
        name: 'edit',
        parameters: { type: 'object', properties: {}, required: [] },
        async execute(_args, ctx) {
          ctx.onMetadata?.({
            title: 'Preview edit',
            metadata: { path: '/tmp/a.txt', diff: '-old\n+new', additions: 1, deletions: 1 },
          })
          ctx.onPartialResult?.({ content: [{ type: 'text', text: 'halfway' }] })
          return { content: 'edited' }
        },
      }],
      sessionId: 's1',
      messageId: 'm1',
      onEvent(event) {
        events.push(event)
      },
    })

    expect(events).toContainEqual({
      type: 'tool-metadata',
      turn: 1,
      toolCall: { id: 'call_1', name: 'edit', arguments: '{}' },
      update: {
        title: 'Preview edit',
        metadata: { path: '/tmp/a.txt', diff: '-old\n+new', additions: 1, deletions: 1 },
      },
    })
    expect(events).toContainEqual({
      type: 'tool-partial-result',
      turn: 1,
      toolCall: { id: 'call_1', name: 'edit', arguments: '{}' },
      update: { content: [{ type: 'text', text: 'halfway' }] },
    })
  })

  it('pauses instead of feeding confirmation-gated tool results into another model turn', async () => {
    const provider: AgentProvider = {
      id: 'confirmation-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
      },
      runTurn: vi.fn(async (request: AgentTurnRequest) => {
        expect(request.turn).toBe(1)
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: 'call_1',
              name: 'bash',
              arguments: '{"cmd":"rm -rf tmp"}',
            }],
          },
          finishReason: 'tool_calls',
        } satisfies AgentTurn
      }),
    }
    const events: AgentStreamEvent[] = []

    let error: Error | undefined
    try {
      await runAgentLoop({
        provider,
        model: 'confirmation-model',
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
        onEvent(event) {
          events.push(event)
        },
      })
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught))
    }

    expect(isAgentLoopPauseForConfirmationError(error)).toBe(true)

    expect(provider.runTurn).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({
      type: 'tool-result',
      turn: 1,
      toolCall: {
        id: 'call_1',
        name: 'bash',
        arguments: '{"cmd":"rm -rf tmp"}',
      },
      result: {
        content: '',
        error: 'Needs approval',
        requiresConfirmation: true,
        commandType: 'dangerous',
      },
    })
  })
})
