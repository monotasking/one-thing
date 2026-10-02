import { describe, expect, it, vi } from 'vitest'
import type {
  AgentProvider,
  AgentTurnRequest,
} from '@onething/backend/core/agent-loop'
import {
  createOnethingProviderFacade,
  type OnethingProviderRequestDumpContext,
} from '../index.js'
import { createDeepSeekAgentProvider } from '../vendors/deepseek/agent-provider.js'

function fakeProvider(onRequest?: (request: AgentTurnRequest) => void): AgentProvider {
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

describe('onething provider facade', () => {
  it('injects host fetch into DeepSeek generation from the runtime facade', async () => {
    const dumps: OnethingProviderRequestDumpContext[] = []
    const fetchCalls: Array<{ url: string; body?: string }> = []
    const fetchImpl = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      fetchCalls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      return deepSeekResponse([
        '{"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}',
        '{"choices":[{"index":0,"delta":{"content":"hello"}}]}',
        '{"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
        '{"choices":[{"index":0,"finish_reason":"stop"}]}',
      ])
    })
    const facade = createOnethingProviderFacade({
      requiresOAuth: () => false,
      refreshOAuthToken: async () => ({ accessToken: 'unused' }),
      requiresSystemMerge: () => false,
      // deepseek is an ordinary agent route now — it used to have one of its
      // own, and that separation is precisely how this path lost its usage
      // reporting in the first place (see the assertion below).
      resolveRuntimeRoute: (_providerId, config) => ({
        kind: 'agent',
        provider: createDeepSeekAgentProvider({
          apiKey: String(config.apiKey ?? ''),
          baseUrl: config.baseUrl,
          fetchImpl,
        }),
      }),
      createRequiredFetch: () => fetchImpl,
      dumpProviderRequest: context => {
        dumps.push(context)
      },
      async *streamACPPrompt() {},
    })

    const usages: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> = []
    const text = await facade.generateChatResponse(
      'deepseek',
      {
        apiKey: 'api-key',
        baseUrl: 'https://deepseek.test',
        model: 'deepseek-reasoner',
      },
      [{ role: 'user', content: 'hello' }],
      {
        maxTokens: 321,
        thinking: true,
        thinkingEffort: 'xhigh',
        debugSessionId: 'session_1',
        onUsage: usage => { usages.push(usage) },
      },
    )

    // usage 必须一路带到门口(2026-08-02):`generateOnethingTextChatResponse` 靠
    // `if (result.usage) onUsage(...)` 计费,而 deepseek 这条 generate 路径此前
    // 把它丢在了最后一步 —— 于是走它的旁路调用在账本上一条都不留。
    // 走 generateChatResponse 而不是内部的 …WithReasoning:计费真正发生在这条路上。
    expect(text).toBe('hello')
    expect(usages).toEqual([{ inputTokens: 3, outputTokens: 2, totalTokens: 5 }])
    expect(fetchCalls[0].url).toBe('https://deepseek.test/chat/completions')
    expect(JSON.parse(fetchCalls[0].body ?? '{}')).toMatchObject({
      model: 'deepseek-reasoner',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 321,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
    expect(dumps[0]).toMatchObject({
      providerId: 'deepseek',
      model: 'deepseek-reasoner',
      mode: 'generate',
      metadata: {
        sessionId: 'session_1',
      },
    })
  })
})
