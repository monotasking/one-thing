import { describe, expect, it } from 'vitest'
import { CODEX_BASE_URL } from '../../providers/builtin/codex.js'
import { createCodexAgentProvider } from '../providers/codex.js'
import type { AgentJsonObject, AgentStreamEvent, AgentTurnStreamEvent } from '@onething/core/agent-loop'

type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>
type FetchBody = FetchInit['body']
type FetchHeaders = FetchInit['headers']

interface CapturedCodexRequest {
  url: string
  body?: string
  headers?: Record<string, string>
}

interface CodexRequestInputItem extends AgentJsonObject {
  role?: string
}

interface CodexRequestBody extends AgentJsonObject {
  instructions?: string
  input: CodexRequestInputItem[]
  tools?: AgentJsonObject[]
}

function requestBodyText(body: FetchBody | null | undefined): string | undefined {
  return typeof body === 'string' ? body : undefined
}

function requestHeaders(headers: FetchHeaders | undefined): Record<string, string> | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

function parseCodexRequestBody(body: string | undefined): CodexRequestBody {
  const parsed = JSON.parse(body ?? '{"input":[]}') as CodexRequestBody
  return {
    ...parsed,
    input: Array.isArray(parsed.input) ? parsed.input : [],
  }
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('Codex agent provider', () => {
  it('normalizes Codex baseUrl variants to the Responses endpoint', async () => {
    const seenUrls: string[] = []
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      seenUrls.push(String(input))
      return streamResponse([
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
      ])
    }

    for (const baseUrl of [
      'https://chatgpt.com/backend-api',
      'https://chatgpt.com/backend-api/codex',
      'https://chatgpt.com/backend-api/codex/responses',
    ]) {
      const provider = createCodexAgentProvider({
        apiKey: 'access-token',
        baseUrl,
        fetchImpl,
      })
      await provider.runTurn!({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'Hi' }],
        turn: 1,
      })
    }

    expect(seenUrls).toEqual([
      'https://chatgpt.com/backend-api/codex/responses',
      'https://chatgpt.com/backend-api/codex/responses',
      'https://chatgpt.com/backend-api/codex/responses',
    ])
  })

  it('refreshes OAuth credentials once and retries when Codex returns 401', async () => {
    const authHeaders: string[] = []
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      const headers = requestHeaders(init?.headers) ?? {}
      authHeaders.push(headers.Authorization ?? '')
      if (authHeaders.length === 1) {
        return new Response(JSON.stringify({
          error: { message: 'Authentication Fails, Your api key: ****old is invalid' },
        }), { status: 401, headers: { 'content-type': 'application/json' } })
      }
      return streamResponse([
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
      ])
    }
    const refreshCalls: boolean[] = []
    const provider = createCodexAgentProvider({
      baseUrl: CODEX_BASE_URL,
      authContext: {
        kind: 'oauth',
        token: {
          accessToken: 'old-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 60 * 60 * 1000,
          tokenType: 'Bearer',
        },
        account: {},
      },
      fetchImpl,
      refreshOAuthToken: async (forceRefresh) => {
        refreshCalls.push(forceRefresh)
        return {
          accessToken: forceRefresh ? 'new-token' : 'old-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 60 * 60 * 1000,
          tokenType: 'Bearer',
        }
      },
    })

    const turn = await provider.runTurn!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'Hi' }],
      turn: 1,
    })

    expect(turn.message.content).toBe('ok')
    expect(refreshCalls).toEqual([false, true])
    expect(authHeaders).toEqual(['Bearer old-token', 'Bearer new-token'])
  })

  it('streams text, reasoning, and provider data while preserving Codex history state', async () => {
    const calls: CapturedCodexRequest[] = []
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: requestBodyText(init?.body),
        headers: requestHeaders(init?.headers),
      })
      return streamResponse([
        'data: {"type":"response.reasoning_summary_text.delta","delta":"summary"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"encrypted-next"}}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n',
      ])
    }
    const provider = createCodexAgentProvider({
      apiKey: 'access-token',
      baseUrl: CODEX_BASE_URL,
      fetchImpl,
    })
    const events: AgentStreamEvent[] = []

    const turn = await provider.runTurn!({
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'System rules' },
        {
          role: 'assistant',
          content: '',
          providerData: [{
            provider: 'codex',
            type: 'encrypted-reasoning',
            encryptedContent: 'encrypted-prev',
          }],
          toolCalls: [{ id: 'call_read', name: 'read', arguments: '{"path":"a.txt"}' }],
        },
        {
          role: 'tool',
          toolCallId: 'call_read',
          content: [
            { type: 'text', text: 'file text' },
            { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
          ],
        },
        { role: 'user', content: 'Hi' },
      ],
      turn: 1,
      onEvent(event) {
        events.push(event)
      },
    })

    const requestBody = parseCodexRequestBody(calls[0].body)
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(calls[0].headers?.Authorization).toBe('Bearer access-token')
    expect(requestBody.instructions).toBe('System rules')
    expect(requestBody.input.some(item => item.role === 'developer')).toBe(false)
    expect(requestBody.input).toEqual(expect.arrayContaining([
      {
        type: 'reasoning',
        summary: [],
        encrypted_content: 'encrypted-prev',
      },
      {
        type: 'function_call',
        name: 'read',
        arguments: '{"path":"a.txt"}',
        call_id: 'call_read',
      },
      {
        type: 'function_call_output',
        call_id: 'call_read',
        output: [
          { type: 'input_text', text: 'file text' },
          { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'auto' },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hi' }],
      },
    ]))
    expect(turn.message.content).toBe('hello')
    expect(turn.message.reasoningContent).toBe('summary')
    expect(turn.message.providerData).toEqual([{
      provider: 'codex',
      type: 'encrypted-reasoning',
      encryptedContent: 'encrypted-next',
    }])
    expect(turn.finishReason).toBe('stop')
    expect(turn.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })
    expect(events.map(event => event.type)).toContain('provider-data')
  })

  it('maps streamed Codex function calls and native image provider data', async () => {
    const imageBase64 = Buffer.from('fake-png').toString('base64')
    const calls: CapturedCodexRequest[] = []
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: requestBodyText(init?.body),
        headers: requestHeaders(init?.headers),
      })
      return streamResponse([
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_item_1","call_id":"call_1","name":"edit"}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_item_1","call_id":"call_1","delta":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"he"}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_item_1","call_id":"call_1","delta":"llo\\"}"}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_item_1","call_id":"call_1","name":"edit","arguments":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"hello\\"}"}}\n\n',
        'data: {"type":"response.output_item.added","item":{"type":"image_generation_call","id":"ig_1","status":"in_progress"}}\n\n',
        `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"ig_1","status":"completed","revised_prompt":"A clean app icon","result":"${imageBase64}"}}\n\n`,
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":4,"output_tokens":5,"total_tokens":9}}}\n\n',
      ])
    }
    const provider = createCodexAgentProvider({
      apiKey: 'access-token',
      baseUrl: CODEX_BASE_URL,
      fetchImpl,
    })
    const events: AgentTurnStreamEvent[] = []

    for await (const event of provider.streamTurn!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'Edit and generate an icon' }],
      tools: [{
        name: 'edit',
        description: 'Edit a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
        execute: async () => ({ content: 'ok' }),
      }],
      requestedOutputModalities: ['image'],
      turn: 1,
    })) {
      events.push(event)
    }

    const requestBody = parseCodexRequestBody(calls[0].body)
    expect(requestBody.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'function',
        name: 'edit',
        strict: false,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      }),
      {
        type: 'image_generation',
        output_format: 'png',
      },
    ]))
    expect(events).toEqual(expect.arrayContaining([
      { type: 'tool-call-start', turn: 1, toolCallId: 'call_1', toolName: 'edit' },
      {
        type: 'tool-call-delta',
        turn: 1,
        toolCallId: 'call_1',
        toolName: 'edit',
        argumentsDelta: '{"path":"a.txt","content":"he',
      },
      {
        type: 'tool-call-done',
        turn: 1,
        toolCall: {
          id: 'call_1',
          name: 'edit',
          arguments: '{"path":"a.txt","content":"hello"}',
        },
      },
      {
        type: 'provider-data',
        turn: 1,
        providerData: {
          provider: 'codex',
          type: 'image-generation-start',
          callId: 'ig_1',
          status: 'in_progress',
        },
      },
      {
        type: 'provider-data',
        turn: 1,
        providerData: {
          provider: 'codex',
          type: 'image-generation-result',
          callId: 'ig_1',
          status: 'completed',
          revisedPrompt: 'A clean app icon',
          result: imageBase64,
        },
      },
      {
        type: 'finish',
        turn: 1,
        finishReason: 'tool_calls',
        usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      },
    ]))
  })
})
