import { describe, expect, it, vi } from 'vitest'
import { createCodexAgentProvider } from '@onething/runtime/agent-loop/providers'

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

describe('core Codex agent provider', () => {
  it('streams text and usage with injected fetch and dump hooks', async () => {
    const requestDumper = vi.fn().mockResolvedValue('/tmp/codex-request.json')
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}}\n\n',
      'data: [DONE]\n\n',
    ]))
    const provider = createCodexAgentProvider({
      apiKey: 'test-token',
      baseUrl: 'https://chatgpt.test/backend-api/codex',
      fetchImpl,
      requestDumper,
    })

    const events = []
    for await (const event of provider.streamTurn!({
      model: 'gpt-5.3-codex',
      messages: [{ role: 'user', content: 'say hello' }],
      turn: 1,
    })) {
      events.push(event)
    }

    expect(fetchImpl.mock.calls[0][0]).toBe('https://chatgpt.test/backend-api/codex/responses')
    expect(requestDumper).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'codex',
      mode: 'codex-http',
      model: 'gpt-5.3-codex',
    }))
    expect(events).toContainEqual({ type: 'text-delta', turn: 1, delta: 'hello' })
    expect(events).toContainEqual({
      type: 'finish',
      turn: 1,
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    })
  })
})
