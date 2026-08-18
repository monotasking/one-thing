import { describe, expect, it } from 'vitest'
import type {
  AgentProvider,
  AgentTurnRequest,
  AgentTurnStreamEvent,
} from '@onething/core/agent-loop'
import {
  runOnethingUtilityAgentTurn,
  type OnethingProviderRequestDumpContext,
} from '../agent-turn.js'

function fakeProvider(
  onRequest?: (request: AgentTurnRequest) => void,
): AgentProvider {
  return {
    id: 'fake',
    async *streamTurn(request) {
      onRequest?.(request)
      yield { type: 'reasoning-delta', turn: request.turn, delta: 'think' }
      yield { type: 'text-delta', turn: request.turn, delta: 'hello' }
      if (request.toolChoice === 'auto') {
        yield { type: 'tool-call-start', turn: request.turn, toolCallId: 'call_1', toolName: 'read' }
        yield { type: 'tool-call-delta', turn: request.turn, toolCallId: 'call_1', toolName: 'read', argumentsDelta: '{"path":"a' }
        yield { type: 'tool-call-delta', turn: request.turn, toolCallId: 'call_1', toolName: 'read', argumentsDelta: '.txt"}' }
        yield {
          type: 'tool-call-done',
          turn: request.turn,
          toolCall: {
            id: 'call_1',
            name: 'read',
            arguments: '{"path":"a.txt"}',
          },
        }
      }
      yield {
        type: 'finish',
        turn: request.turn,
        finishReason: request.toolChoice === 'auto' ? 'tool_calls' : 'stop',
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      }
    },
  }
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}

function deepSeekResponse(lines: string[]): Response {
  return new Response([
    ...lines.map(line => `data: ${line}\n\n`),
    'data: [DONE]\n\n',
  ].join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('onething provider agent turn runners', () => {
  it('sends no max_tokens when the caller set none — no hidden 4096 (2026-08-15)', async () => {
    let request: AgentTurnRequest | undefined
    const dumps: OnethingProviderRequestDumpContext[] = []
    const result = await runOnethingUtilityAgentTurn({
      providerId: 'openai',
      provider: fakeProvider(next => { request = next }),
      config: { model: 'gpt-test' },
      messages: [{ role: 'user', content: 'hello' }],
      mode: 'generate',
      options: {},
      onRequestPrepared(context) { dumps.push(context) },
    })
    expect(request?.maxTokens).toBeUndefined()
    expect((dumps[0]?.requestBody as { max_tokens?: unknown }).max_tokens).toBeUndefined()
    // and the stop reason rides along so callers can tell a full answer from a cut one
    expect(result?.finishReason).toBe('stop')
  })

  it('runs utility agent turns through core agent-loop primitives', async () => {
    let request: AgentTurnRequest | undefined
    const dumps: OnethingProviderRequestDumpContext[] = []

    const result = await runOnethingUtilityAgentTurn({
      providerId: 'openai',
      provider: fakeProvider(next => { request = next }),
      config: { model: 'gpt-test' },
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'hello' },
      ],
      mode: 'stream-reasoning',
      options: {
        temperature: 0.2,
        maxTokens: 123,
        thinking: true,
        thinkingEffort: 'xhigh',
        debugPurpose: 'test',
        debugSessionId: 'session_1',
      },
      onRequestPrepared(context) {
        dumps.push(context)
      },
    })

    expect(request).toMatchObject({
      model: 'gpt-test',
      toolChoice: 'none',
      maxTokens: 123,
      temperature: 0.2,
      thinking: 'enabled',
      reasoningEffort: 'max',
      turn: 1,
    })
    expect(dumps[0]).toMatchObject({
      providerId: 'openai',
      model: 'gpt-test',
      mode: 'stream-reasoning',
      metadata: {
        purpose: 'test',
        sessionId: 'session_1',
        transport: 'agent-provider',
      },
      requestBody: {
        model: 'gpt-test',
        stream: true,
        tool_choice: 'none',
        max_tokens: 123,
        thinking: 'enabled',
        reasoning_effort: 'max',
      },
    })
    expect(result).toEqual({
      text: 'hello',
      reasoning: 'think',
      toolCalls: undefined,
      // Carried out so side-line callers (title, memory) can bill the call —
      // the generate path used to drop it while the stream twin kept it.
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      // Stop reason rides along too (2026-08-15): compaction refuses a
      // 'length'-truncated summary instead of storing half of one.
      finishReason: 'stop',
    })
  })

})
