import { describe, expect, it, vi } from 'vitest'
import { createDeepSeekAgentProvider } from '@onething/runtime/agent-loop/providers'

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  }), { status: 200 })
}

describe('core DeepSeek agent provider', () => {
  it('streams reasoning, tool calls, usage, and request dump without main-process imports', async () => {
    const requestDumper = vi.fn().mockResolvedValue('/tmp/deepseek-request.json')
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think "},"finish_reason":null}],"usage":null}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_time","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":null}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
      'data: [DONE]\n\n',
    ]))
    const provider = createDeepSeekAgentProvider({
      apiKey: 'test-key',
      baseUrl: 'https://deepseek.test',
      fetchImpl,
      requestDumper,
    })

    const turn = await provider.runTurn!({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'time?' }],
      tools: [{
        name: 'get_time',
        description: 'Get time',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => ({ content: 'ok' }),
      }],
      turn: 1,
    })

    expect(fetchImpl.mock.calls[0][0]).toBe('https://deepseek.test/chat/completions')
    expect(requestDumper).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      mode: 'stream',
    }))
    expect(turn.message.reasoningContent).toBe('think ')
    expect(turn.message.toolCalls).toEqual([{
      id: 'call_1',
      name: 'get_time',
      arguments: '{}',
    }])
    expect(turn.finishReason).toBe('tool_calls')
    expect(turn.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })
  })
})
