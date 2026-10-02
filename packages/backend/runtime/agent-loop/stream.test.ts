import { describe, expect, it } from 'vitest'
import { streamAgentProviderTurnEvents } from './stream.js'
import type {
  AgentProvider,
  AgentTurn,
  AgentTurnRequest,
  AgentTurnStreamEvent,
} from './types.js'

/**
 * `streamAgentProviderTurnEvents` has two branches: a provider that implements
 * `streamTurn` is iterated directly, and one that only implements `runTurn`
 * gets its single-shot result adapted into the same event stream.
 *
 * Every provider shipped in this repo implements `streamTurn`, so the runTurn
 * branch is unreachable through them — these tests are its only coverage.
 * They live here rather than behind a provider because the behaviour under
 * test is core's adaptation, not any provider's wire format.
 */

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function runnableProvider(runTurn: (request: AgentTurnRequest) => Promise<AgentTurn>): AgentProvider {
  return {
    id: 'runnable-test-provider',
    capabilities: {
      capabilities: ['text-input', 'text-output', 'tool-calls'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
    },
    runTurn,
  }
}

function baseRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    turn: 1,
    ...overrides,
  }
}

async function collect(
  events: AsyncIterable<AgentTurnStreamEvent>,
): Promise<AgentTurnStreamEvent[]> {
  const collected: AgentTurnStreamEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

describe('streamAgentProviderTurnEvents — runTurn-only providers', () => {
  it('synthesizes the full event stream from a single-shot turn', async () => {
    const provider = runnableProvider(async () => ({
      message: {
        role: 'assistant',
        content: 'done',
        reasoningContent: 'thinking',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
      },
      finishReason: 'tool_calls',
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    }))

    const events = await collect(streamAgentProviderTurnEvents(provider, baseRequest()))

    expect(events.map(event => event.type)).toEqual([
      'reasoning-delta',
      'text-delta',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-done',
      'finish',
    ])
    expect(events).toContainEqual({ type: 'text-delta', turn: 1, delta: 'done' })
    expect(events).toContainEqual({ type: 'reasoning-delta', turn: 1, delta: 'thinking' })
    expect(events).toContainEqual({
      type: 'tool-call-delta',
      turn: 1,
      toolCallId: 'call-1',
      toolName: 'read_file',
      argumentsDelta: '{"path":"a.ts"}',
    })
    expect(events.at(-1)).toEqual({
      type: 'finish',
      turn: 1,
      finishReason: 'tool_calls',
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    })
  })

  it('yields onEvent deltas before the runTurn promise resolves', async () => {
    const gate = deferred<AgentTurn>()
    const provider = runnableProvider(async request => {
      request.onEvent?.({ type: 'text-delta', turn: 1, delta: 'early' })
      return gate.promise
    })

    const seen: AgentTurnStreamEvent[] = []
    const drain = (async () => {
      for await (const event of streamAgentProviderTurnEvents(provider, baseRequest())) {
        seen.push(event)
      }
    })()

    // The delta must be observable while runTurn is still pending — a buffered
    // implementation would only surface it after the turn settles.
    await waitFor(() => seen.length > 0)
    expect(seen).toEqual([{ type: 'text-delta', turn: 1, delta: 'early' }])

    gate.resolve({
      message: { role: 'assistant', content: 'early tail' },
      finishReason: 'stop',
    })
    await drain

    // 'early' was already streamed; only the missing suffix is synthesized.
    expect(seen).toEqual([
      { type: 'text-delta', turn: 1, delta: 'early' },
      { type: 'text-delta', turn: 1, delta: ' tail' },
      { type: 'finish', turn: 1, finishReason: 'stop', usage: undefined },
    ])
  })

  it('does not re-synthesize tool-call events already emitted through onEvent', async () => {
    const toolCall = { id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' }
    const provider = runnableProvider(async request => {
      request.onEvent?.({
        type: 'tool-call-start',
        turn: 1,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      })
      request.onEvent?.({
        type: 'tool-call-delta',
        turn: 1,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        argumentsDelta: toolCall.arguments,
      })
      request.onEvent?.({ type: 'tool-call-done', turn: 1, toolCall })
      return {
        message: { role: 'assistant', content: '', toolCalls: [toolCall] },
        finishReason: 'tool_calls',
      }
    })

    const events = await collect(streamAgentProviderTurnEvents(provider, baseRequest()))

    expect(events.map(event => event.type)).toEqual([
      'tool-call-start',
      'tool-call-delta',
      'tool-call-done',
      'finish',
    ])
  })

  it('ignores onEvent events belonging to another turn', async () => {
    const provider = runnableProvider(async request => {
      request.onEvent?.({ type: 'text-delta', turn: 7, delta: 'other turn' })
      return {
        message: { role: 'assistant', content: 'mine' },
        finishReason: 'stop',
      }
    })

    const events = await collect(streamAgentProviderTurnEvents(provider, baseRequest({ turn: 1 })))

    // The foreign delta is still forwarded (it is a valid stream event), but it
    // must not count as "already emitted" for turn 1 — 'mine' is synthesized whole.
    expect(events).toContainEqual({ type: 'text-delta', turn: 1, delta: 'mine' })
  })

  it('aborts a pending runTurn that never resolves', async () => {
    const controller = new AbortController()
    const started = deferred()
    const provider = runnableProvider(async () => {
      started.resolve()
      return new Promise<AgentTurn>(() => {
        // never settles — only the abort can end this turn
      })
    })

    const drain = collect(
      streamAgentProviderTurnEvents(provider, baseRequest({ abortSignal: controller.signal })),
    )

    await started.promise
    controller.abort()

    await expect(drain).rejects.toThrow(/abort/i)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    const provider = runnableProvider(async () => {
      called = true
      return { message: { role: 'assistant', content: 'x' }, finishReason: 'stop' }
    })

    await expect(
      collect(streamAgentProviderTurnEvents(provider, baseRequest({ abortSignal: controller.signal }))),
    ).rejects.toThrow(/abort/i)
    expect(called).toBe(false)
  })

  it('surfaces a runTurn rejection to the consumer', async () => {
    const provider = runnableProvider(async () => {
      throw new Error('provider exploded')
    })

    await expect(collect(streamAgentProviderTurnEvents(provider, baseRequest()))).rejects.toThrow(
      'provider exploded',
    )
  })

  it('yields nothing for a provider that implements neither streamTurn nor runTurn', async () => {
    const provider: AgentProvider = { id: 'inert' }
    expect(await collect(streamAgentProviderTurnEvents(provider, baseRequest()))).toEqual([])
  })
})
