import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { toJsonObject, type JsonObject, type JsonValue } from '@shared/json.js'

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>
type ThrowingAIMock = Mock<() => never>
type JsonSchemaMock = Mock<(schema: JsonValue) => JsonValue>
type AsyncIterableValue<T> = T extends AsyncIterable<infer Value> ? Value : never

const { fetchHolder, aiMocks } = vi.hoisted((): {
  fetchHolder: { current: typeof globalThis.fetch }
  aiMocks: {
    generateText: ThrowingAIMock
    streamText: ThrowingAIMock
    convertToModelMessages: ThrowingAIMock
    jsonSchema: JsonSchemaMock
  }
} => ({
  fetchHolder: {
    current: async () => new Response('', { status: 500 }),
  },
  aiMocks: {
    generateText: vi.fn(() => {
      throw new Error('AI SDK generateText should not be called for DeepSeek')
    }),
    streamText: vi.fn(() => {
      throw new Error('AI SDK streamText should not be called for DeepSeek')
    }),
    convertToModelMessages: vi.fn(() => {
      throw new Error('AI SDK convertToModelMessages should not be called for DeepSeek')
    }),
    jsonSchema: vi.fn((schema: JsonValue): JsonValue => schema),
  },
}))

vi.mock('ai', () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  convertToModelMessages: aiMocks.convertToModelMessages,
  jsonSchema: aiMocks.jsonSchema,
}))

vi.mock('../../../provider-binding/bound-fetch.js', () => ({
  createRequiredAppFetch: () => fetchHolder.current,
}))

import { generateChatResponse } from '../index.js'
import { registerAgentProviderRuntime } from '../../agent-loop/index.js'
import type { AgentTurn, AgentTurnRequest } from '@onething/core/agent-loop'

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

function sse(payload: JsonValue): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function mockFetchResponse(response: Response): FetchMock {
  return vi.fn<typeof globalThis.fetch>(async () => response)
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const record: Record<string, string> = {}
    headers.forEach((value, key) => {
      record[key] = value
    })
    return record
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }
  return { ...headers }
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function parseRequestBody(body: BodyInit | null | undefined): JsonObject {
  if (typeof body !== 'string') return {}
  return toJsonObject(JSON.parse(body) as JsonValue)
}

function jsonArrayField(object: JsonObject, key: string): JsonValue[] {
  const value = object[key]
  return Array.isArray(value) ? value : []
}

function jsonObjectField(object: JsonObject, key: string): JsonObject {
  return toJsonObject(object[key])
}

function jsonObjectAt(values: JsonValue[], index: number): JsonObject {
  return toJsonObject(values[index])
}

function firstFetchCall(fetchImpl: FetchMock) {
  const call = fetchImpl.mock.calls[0]
  if (!call) throw new Error('Expected fetch to have been called')
  const [input, init] = call
  return {
    url: requestUrl(input),
    init,
    headers: headersRecord(init?.headers),
    body: parseRequestBody(init?.body),
  }
}

function withTimeout<T>(promise: Promise<T>, message = 'timed out waiting for abort'): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), 100)),
  ])
}

describe('DeepSeek provider agent routing', () => {
  const previousDumpEnv = process.env.ONETHING_DUMP_PROVIDER_REQUESTS

  beforeEach(() => {
    process.env.ONETHING_DUMP_PROVIDER_REQUESTS = '0'
    vi.clearAllMocks()
    fetchHolder.current = mockFetchResponse(new Response('', { status: 500 }))
  })

  afterEach(() => {
    if (previousDumpEnv === undefined) {
      delete process.env.ONETHING_DUMP_PROVIDER_REQUESTS
    } else {
      process.env.ONETHING_DUMP_PROVIDER_REQUESTS = previousDumpEnv
    }
  })

  it('requires an agent runtime for utility generation', async () => {
    await expect(generateChatResponse(
      'legacy-only',
      { model: 'legacy-model' },
      [{ role: 'user', content: 'hello' }],
    )).rejects.toThrow('Provider legacy-only does not have an AgentProvider runtime for generate.')

    expect(aiMocks.generateText).not.toHaveBeenCalled()
    expect(aiMocks.streamText).not.toHaveBeenCalled()
    expect(aiMocks.convertToModelMessages).not.toHaveBeenCalled()
  })

  it('generates DeepSeek utility responses through the agent provider without the AI SDK', async () => {
    const fetchImpl = mockFetchResponse(streamResponse([
      sse({
        choices: [{ index: 0, delta: { reasoning_content: 'think ' }, finish_reason: null }],
      }),
      sse({
        choices: [{ index: 0, delta: { content: 'capture-json' }, finish_reason: 'stop' }],
      }),
      sse({
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
      }),
      'data: [DONE]\n\n',
    ]))
    fetchHolder.current = fetchImpl

    const text = await generateChatResponse(
      'deepseek',
      {
        apiKey: 'test-key',
        baseUrl: 'https://deepseek.test',
        model: 'deepseek-v4-flash',
      },
      [
        { role: 'system', content: 'daily note planner' },
        { role: 'user', content: 'Current daily note' },
      ],
      { temperature: 0.1, maxTokens: 900 },
    )

    expect(text).toBe('capture-json')
    expect(aiMocks.generateText).not.toHaveBeenCalled()
    expect(aiMocks.streamText).not.toHaveBeenCalled()
    expect(aiMocks.convertToModelMessages).not.toHaveBeenCalled()

    const request = firstFetchCall(fetchImpl)
    const body = request.body
    expect(request.url).toBe('https://deepseek.test/chat/completions')
    expect(body.model).toBe('deepseek-v4-flash')
    expect(body.max_tokens).toBe(900)
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.temperature).toBeUndefined()
    expect(body.messages).toEqual([
      { role: 'system', content: 'daily note planner' },
      { role: 'user', content: 'Current daily note' },
    ])
  })

  it('generates OpenAI-compatible utility responses through the agent provider without the AI SDK', async () => {
    const fetchImpl = mockFetchResponse(streamResponse([
      sse({
        choices: [{ index: 0, delta: { content: 'native ' }, finish_reason: null }],
      }),
      sse({
        choices: [{ index: 0, delta: { content: 'response' }, finish_reason: 'stop' }],
      }),
      sse({
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
      'data: [DONE]\n\n',
    ]))
    fetchHolder.current = fetchImpl

    const text = await generateChatResponse(
      'openai',
      {
        apiKey: 'openai-key',
        baseUrl: 'https://openai.test/v1',
        model: 'gpt-test',
      },
      [
        { role: 'system', content: 'utility rules' },
        { role: 'user', content: 'summarize' },
      ],
      { temperature: 0.2, maxTokens: 123 },
    )

    expect(text).toBe('native response')
    expect(aiMocks.generateText).not.toHaveBeenCalled()
    expect(aiMocks.streamText).not.toHaveBeenCalled()
    expect(aiMocks.convertToModelMessages).not.toHaveBeenCalled()

    const request = firstFetchCall(fetchImpl)
    const body = request.body
    expect(request.url).toBe('https://openai.test/v1/chat/completions')
    expect(request.headers.Authorization).toBe('Bearer openai-key')
    expect(body).toMatchObject({
      model: 'gpt-test',
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 123,
      temperature: 0.2,
    })
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
    expect(body.messages).toEqual([
      { role: 'system', content: 'utility rules' },
      { role: 'user', content: 'summarize' },
    ])
  })

  it('generates custom OpenAI-compatible utility responses through the agent provider without the AI SDK', async () => {
    const fetchImpl = mockFetchResponse(streamResponse([
      sse({
        choices: [{ index: 0, delta: { content: 'custom native' }, finish_reason: 'stop' }],
      }),
      sse({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
      'data: [DONE]\n\n',
    ]))
    fetchHolder.current = fetchImpl

    const text = await generateChatResponse(
      'custom-local-openai',
      {
        apiKey: 'custom-key',
        baseUrl: 'https://custom-openai.test/v1',
        model: 'custom-chat',
        apiType: 'openai',
      },
      [
        { role: 'system', content: 'utility rules' },
        { role: 'user', content: 'summarize' },
      ],
      { temperature: 0.3, maxTokens: 64 },
    )

    expect(text).toBe('custom native')
    expect(aiMocks.generateText).not.toHaveBeenCalled()
    expect(aiMocks.streamText).not.toHaveBeenCalled()
    expect(aiMocks.convertToModelMessages).not.toHaveBeenCalled()

    const request = firstFetchCall(fetchImpl)
    const body = request.body
    expect(request.url).toBe('https://custom-openai.test/v1/chat/completions')
    expect(request.headers.Authorization).toBe('Bearer custom-key')
    expect(body).toMatchObject({
      model: 'custom-chat',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
      temperature: 0.3,
    })
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })

  it('generates Claude utility responses through the agent provider without the AI SDK', async () => {
    const fetchImpl = mockFetchResponse(streamResponse([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":6,"output_tokens":1}}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"claude native"}}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ]))
    fetchHolder.current = fetchImpl

    const text = await generateChatResponse(
      'claude',
      {
        apiKey: 'anthropic-key',
        baseUrl: 'https://anthropic.test/v1',
        model: 'claude-test',
      },
      [
        { role: 'system', content: 'utility rules' },
        { role: 'user', content: 'summarize' },
      ],
      { temperature: 0.2, maxTokens: 222 },
    )

    expect(text).toBe('claude native')
    expect(aiMocks.generateText).not.toHaveBeenCalled()
    expect(aiMocks.streamText).not.toHaveBeenCalled()
    expect(aiMocks.convertToModelMessages).not.toHaveBeenCalled()

    const request = firstFetchCall(fetchImpl)
    const body = request.body
    expect(request.url).toBe('https://anthropic.test/v1/messages')
    expect(request.headers['x-api-key']).toBe('anthropic-key')
    expect(body).toMatchObject({
      model: 'claude-test',
      // Builtin claude runtime enables prompt caching: system becomes blocks
      // with a cache breakpoint on the tail.
      system: [
        { type: 'text', text: 'utility rules', cache_control: { type: 'ephemeral' } },
      ],
      max_tokens: 222,
      stream: true,
      temperature: 0.2,
    })
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'summarize', cache_control: { type: 'ephemeral' } },
        ],
      },
    ])
    expect(body.tools).toBeUndefined()
  })

  it('generates custom Anthropic-compatible utility responses through the agent provider without the AI SDK', async () => {
    const fetchImpl = mockFetchResponse(streamResponse([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":1}}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"custom claude"}}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ]))
    fetchHolder.current = fetchImpl

    const text = await generateChatResponse(
      'custom-local-anthropic',
      {
        apiKey: 'custom-anthropic-key',
        baseUrl: 'https://custom-anthropic.test/v1',
        model: 'custom-claude',
        apiType: 'anthropic',
      },
      [
        { role: 'system', content: 'utility rules' },
        { role: 'user', content: 'summarize' },
      ],
      { temperature: 0.2, maxTokens: 128 },
    )

    expect(text).toBe('custom claude')
    expect(aiMocks.generateText).not.toHaveBeenCalled()
    expect(aiMocks.streamText).not.toHaveBeenCalled()
    expect(aiMocks.convertToModelMessages).not.toHaveBeenCalled()

    const request = firstFetchCall(fetchImpl)
    const body = request.body
    expect(request.url).toBe('https://custom-anthropic.test/v1/messages')
    expect(request.headers['x-api-key']).toBe('custom-anthropic-key')
    expect(body).toMatchObject({
      model: 'custom-claude',
      system: 'utility rules',
      max_tokens: 128,
      stream: true,
      temperature: 0.2,
    })
    expect(body.messages).toEqual([{ role: 'user', content: 'summarize' }])
  })

  it('generates Gemini utility responses through the agent provider without the AI SDK', async () => {
    const fetchImpl = mockFetchResponse(streamResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"gemini native"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}\n\n',
    ]))
    fetchHolder.current = fetchImpl

    const text = await generateChatResponse(
      'gemini',
      {
        apiKey: 'gemini-key',
        baseUrl: 'https://gemini.test/v1beta',
        model: 'gemini-test',
      },
      [
        { role: 'system', content: 'utility rules' },
        { role: 'user', content: 'summarize' },
      ],
      { temperature: 0.4, maxTokens: 333 },
    )

    expect(text).toBe('gemini native')
    expect(aiMocks.generateText).not.toHaveBeenCalled()
    expect(aiMocks.streamText).not.toHaveBeenCalled()
    expect(aiMocks.convertToModelMessages).not.toHaveBeenCalled()

    const request = firstFetchCall(fetchImpl)
    const url = new URL(request.url)
    const body = request.body
    expect(url.origin + url.pathname).toBe('https://gemini.test/v1beta/models/gemini-test:streamGenerateContent')
    expect(url.searchParams.get('alt')).toBe('sse')
    expect(url.searchParams.get('key')).toBe('gemini-key')
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: 'utility rules' }] },
      generationConfig: {
        maxOutputTokens: 333,
        temperature: 0.4,
      },
    })
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'summarize' }] }])
    expect(body.tools).toBeUndefined()
  })

  it('aborts pending runTurn utility generation even when the provider does not resolve', async () => {
    const controller = new AbortController()
    const runTurn = vi.fn(async (request: AgentTurnRequest) => {
      expect(request.abortSignal).toBe(controller.signal)
      setTimeout(() => controller.abort(), 0)
      return new Promise<AgentTurn>(() => {})
    })
    const unregister = registerAgentProviderRuntime('runturn-abort-generate-test', () => ({
      id: 'runturn-abort-generate-test',
      runTurn,
    }), { replace: true })

    try {
      await expect(withTimeout(generateChatResponse(
        'runturn-abort-generate-test',
        {
          apiKey: 'test-key',
          baseUrl: 'https://runturn.test/v1',
          model: 'run-model',
        },
        [{ role: 'user', content: 'wait' }],
        { abortSignal: controller.signal },
      ))).rejects.toMatchObject({ name: 'AbortError' })

      expect(aiMocks.generateText).not.toHaveBeenCalled()
      expect(aiMocks.streamText).not.toHaveBeenCalled()
      expect(aiMocks.convertToModelMessages).not.toHaveBeenCalled()
      expect(runTurn).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })

})