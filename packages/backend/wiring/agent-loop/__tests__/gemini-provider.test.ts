import { describe, expect, it, vi } from 'vitest'
import { createGeminiAgentProvider } from '../providers/gemini.js'

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

describe('Gemini agent provider', () => {
  it('streams text, thoughts, function calls, and usage through the native REST API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"think ","thought":true}]}}],"usageMetadata":{"promptTokenCount":10}}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"hello "}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"a.txt"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":6,"totalTokenCount":16}}\n\n',
    ]))
    const provider = createGeminiAgentProvider({
      apiKey: 'gemini-key',
      baseUrl: 'https://gemini.test/v1beta',
      fetchImpl,
    })
    const events: string[] = []

    const turn = await provider.runTurn!({
      model: 'gemini-test',
      messages: [
        { role: 'system', content: 'System rules' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
            { type: 'file', data: 'pdfbase64', mediaType: 'application/pdf', filename: 'doc.pdf' },
          ],
        },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_prev', name: 'read', arguments: '{"path":"old.txt"}' }],
        },
        { role: 'tool', toolCallId: 'call_prev', content: 'old text' },
      ],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        execute: async () => ({ content: 'ok' }),
      }],
      toolChoice: {
        type: 'function',
        function: { name: 'read' },
      },
      maxTokens: 1024,
      temperature: 0.1,
      turn: 2,
      onEvent(event) {
        events.push(event.type)
      },
    })

    const url = new URL(fetchImpl.mock.calls[0][0])
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(url.origin + url.pathname).toBe('https://gemini.test/v1beta/models/gemini-test:streamGenerateContent')
    expect(url.searchParams.get('alt')).toBe('sse')
    expect(url.searchParams.get('key')).toBe('gemini-key')
    expect(fetchImpl.mock.calls[0][1].headers['x-goog-api-key']).toBe('gemini-key')
    expect(request).toMatchObject({
      systemInstruction: { parts: [{ text: 'System rules' }] },
      generationConfig: {
        maxOutputTokens: 1024,
        temperature: 0.1,
      },
      toolConfig: {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['read'],
        },
      },
    })
    expect(request.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'look' },
          { inlineData: { mimeType: 'image/png', data: 'abc' } },
          { inlineData: { mimeType: 'application/pdf', data: 'pdfbase64' } },
        ],
      },
      {
        role: 'model',
        parts: [{
          functionCall: {
            name: 'read',
            args: { path: 'old.txt' },
          },
        }],
      },
      {
        role: 'function',
        parts: [{
          functionResponse: {
            name: 'read',
            response: { result: 'old text' },
          },
        }],
      },
    ])
    expect(request.tools).toEqual([{
      functionDeclarations: [{
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
    }])
    expect(turn.message.content).toBe('hello ')
    expect(turn.message.reasoningContent).toBe('think ')
    expect(turn.message.toolCalls).toEqual([{
      id: 'gemini-2-0-read',
      name: 'read',
      arguments: '{"path":"a.txt"}',
    }])
    expect(turn.finishReason).toBe('tool_calls')
    expect(turn.usage).toEqual({ inputTokens: 10, outputTokens: 6, totalTokens: 16 })
    expect(events).toEqual(expect.arrayContaining([
      'reasoning-delta',
      'text-delta',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-done',
    ]))
  })

  it('does not send tools when tool choice is none', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\n\n',
    ]))
    const provider = createGeminiAgentProvider({
      apiKey: 'gemini-key',
      baseUrl: 'https://gemini.test/v1beta',
      fetchImpl,
    })

    await provider.runTurn!({
      model: 'gemini-test',
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
    expect(request.toolConfig).toBeUndefined()
  })
})
