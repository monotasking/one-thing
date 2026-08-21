import { describe, expect, it, vi } from 'vitest'
import { createClaudeAgentProvider } from '../providers/claude.js'

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

describe('Claude agent provider', () => {
  it('streams text, tool use, and usage through the native Messages API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1}}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a"}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":".txt\\"}"}}\n\n',
      'event: content_block_stop\n',
      'data: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ]))
    const provider = createClaudeAgentProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://anthropic.test/v1',
      fetchImpl,
    })
    const events: string[] = []

    const turn = await provider.runTurn!({
      model: 'claude-test',
      messages: [
        { role: 'system', content: 'System rules' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
          ],
        },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'toolu_prev', name: 'read', arguments: '{"path":"old.txt"}' }],
        },
        { role: 'tool', toolCallId: 'toolu_prev', content: 'old text' },
      ],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        execute: async () => ({ content: 'ok' }),
      }],
      toolChoice: 'auto',
      maxTokens: 2048,
      temperature: 0.3,
      turn: 1,
      onEvent(event) {
        events.push(event.type)
      },
    })

    const request = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://anthropic.test/v1/messages')
    expect(fetchImpl.mock.calls[0][1].headers['x-api-key']).toBe('anthropic-key')
    expect(fetchImpl.mock.calls[0][1].headers['anthropic-version']).toBe('2023-06-01')
    expect(request).toMatchObject({
      model: 'claude-test',
      system: 'System rules',
      max_tokens: 2048,
      stream: true,
      temperature: 0.3,
      tool_choice: { type: 'auto' },
    })
    expect(request.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        ],
      },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_prev',
          name: 'read',
          input: { path: 'old.txt' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_prev',
          content: 'old text',
        }],
      },
    ])
    expect(request.tools).toEqual([{
      name: 'read',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }])
    expect(turn.message.content).toBe('hello ')
    expect(turn.message.toolCalls).toEqual([{
      id: 'toolu_1',
      name: 'read',
      arguments: '{"path":"a.txt"}',
    }])
    expect(turn.finishReason).toBe('tool_calls')
    expect(turn.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 })
    expect(events).toEqual(expect.arrayContaining([
      'text-delta',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-done',
    ]))
  })

  it('does not send tools when tool choice is none', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    ]))
    const provider = createClaudeAgentProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://anthropic.test/v1',
      fetchImpl,
    })

    await provider.runTurn!({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'read',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => ({ content: 'ok' }),
      }],
      toolChoice: 'none',
      turn: 1,
    })

    const request = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(request.tools).toBeUndefined()
    expect(request.tool_choice).toBeUndefined()
  })

  it('marks failed tool results with is_error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    ]))
    const provider = createClaudeAgentProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://anthropic.test/v1',
      fetchImpl,
    })

    await provider.runTurn!({
      model: 'claude-test',
      messages: [
        {
          role: 'tool',
          toolCallId: 'toolu_fail',
          content: '{"error":"Edit failed: target text not found in app.ts.","status":"failed"}',
          isError: true,
        },
        { role: 'tool', toolCallId: 'toolu_ok', content: 'done' },
      ],
      turn: 1,
    })

    const request = JSON.parse(fetchImpl.mock.calls[0][1].body)
    // Without is_error a failure reads to the model as a successful result
    // whose text happens to describe a problem.
    expect(request.messages[0].content[0].is_error).toBe(true)
    expect(request.messages[1].content[0].is_error).toBeUndefined()
  })

  it('uses content blocks for media tool results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    ]))
    const provider = createClaudeAgentProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://anthropic.test/v1',
      fetchImpl,
    })

    await provider.runTurn!({
      model: 'claude-test',
      messages: [{
        role: 'tool',
        toolCallId: 'toolu_1',
        content: [
          { type: 'text', text: 'screenshot captured' },
          { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
          { type: 'file', data: 'pdfbase64', mediaType: 'application/pdf', filename: 'report.pdf' },
        ],
      }],
      turn: 1,
    })

    const request = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(request.messages).toEqual([{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          { type: 'text', text: 'screenshot captured' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          { type: 'text', text: '[File: report.pdf; application/pdf data omitted: 9 chars]' },
        ],
      }],
    }])
  })
})
