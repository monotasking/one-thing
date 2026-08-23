import { toJsonObject, type JsonObject, type JsonValue } from '@onething/core'
import { describe, expect, it } from 'vitest'
import {
  buildOnethingCodexRequest,
  buildOnethingCodexHeaders,
  buildOnethingCodexModelsUrl,
  codexModelInfoToOnethingOpenRouterModel,
  collectOnethingCodexGenerateResult,
  collectOnethingCodexReasoningSummaryText,
  createOnethingCodexApiError,
  decodeOnethingCodexSseEventData,
  extractOnethingCodexOutputText,
  extractOnethingCodexReasoningSummaryText,
  fetchOnethingCodexModels,
  fetchOnethingCodexUsage,
  hasMeaningfulOnethingCodexUsage,
  getOnethingCodexFallbackModel,
  getOnethingCodexFallbackModels,
  normalizeOnethingCodexReasoningEffort,
  normalizeOnethingCodexResponsesBody,
  normalizeOnethingCodexUsagePayload,
  onethingCodexUsageFromResponse,
  ONETHING_CODEX_CLIENT_VERSION,
  ONETHING_CODEX_DEFAULT_MODEL,
  ONETHING_CODEX_USAGE_URL,
  parseOnethingCodexSseStream,
  repairOnethingCodexRejectedBody,
  requestOnethingCodexStream,
  streamOnethingCodexSseEvents,
  summarizeOnethingCodexRequestBody,
  type OnethingCodexStreamRequestContext,
  type OnethingCodexSseEvent,
  type OnethingCodexStreamPart,
} from '../codex.js'

function codexMetadata(model: { providerMetadata?: object | null } | null | undefined): JsonObject {
  return toJsonObject(toJsonObject(model?.providerMetadata).codex)
}

function jsonArrayField(object: JsonObject, key: string): JsonValue[] {
  const value = object[key]
  return Array.isArray(value) ? value : []
}

function fieldValues(items: JsonValue[], key: string): JsonValue[] {
  return items.map(item => toJsonObject(item)[key] ?? null)
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
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
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

function bodyText(body: BodyInit | null | undefined): string | undefined {
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  return undefined
}

async function collectCodexStreamParts(
  events: OnethingCodexSseEvent[],
): Promise<OnethingCodexStreamPart[]> {
  const parts: OnethingCodexStreamPart[] = []
  for await (const part of streamOnethingCodexSseEvents(events, {
    modelId: 'gpt-5.5',
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  })) {
    parts.push(part)
  }
  return parts
}

async function readCodexRuntimeStream(
  stream: ReadableStream<OnethingCodexStreamPart>,
): Promise<OnethingCodexStreamPart[]> {
  const reader = stream.getReader()
  const chunks: OnethingCodexStreamPart[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return chunks
}

describe('onething Codex provider helpers', () => {
  it('builds ChatGPT subscription auth headers in runtime', () => {
    const headers = buildOnethingCodexHeaders({
      accessToken: 'access-token',
      accountId: 'acct_123',
      isFedrampAccount: true,
    })

    expect(headers.Authorization).toBe('Bearer access-token')
    expect(headers.originator).toBe('codex_cli_rs')
    expect(headers.version).toBe(ONETHING_CODEX_CLIENT_VERSION)
    expect(headers['ChatGPT-Account-ID']).toBe('acct_123')
    expect(headers['X-OpenAI-Fedramp']).toBe('true')
  })

  it('adds the Codex client version query to model refreshes', () => {
    const url = new URL(buildOnethingCodexModelsUrl())

    expect(url.pathname).toBe('/backend-api/codex/models')
    expect(url.searchParams.get('client_version')).toBe(ONETHING_CODEX_CLIENT_VERSION)
  })

  it('fetches Codex models through injected fetch and falls back when empty', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = []
    const fetchImpl = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      calls.push({ url: requestUrl(input), headers: headersRecord(init?.headers) })
      return new Response(JSON.stringify({ models: [] }), { status: 200 })
    }

    const models = await fetchOnethingCodexModels({
      accessToken: 'access-token',
      accountId: 'acct_123',
      isFedrampAccount: true,
    }, fetchImpl, { timeoutMs: 0 })

    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/backend-api/codex/models')
    expect(url.searchParams.get('client_version')).toBe(ONETHING_CODEX_CLIENT_VERSION)
    expect(calls[0].headers?.Authorization).toBe('Bearer access-token')
    expect(calls[0].headers?.originator).toBe('codex_cli_rs')
    expect(calls[0].headers?.['ChatGPT-Account-ID']).toBe('acct_123')
    expect(calls[0].headers?.['X-OpenAI-Fedramp']).toBe('true')
    expect(models[0].id).toBe(ONETHING_CODEX_DEFAULT_MODEL)
  })

  it('provides fallback model metadata', () => {
    const models = getOnethingCodexFallbackModels()

    expect(models[0].id).toBe(ONETHING_CODEX_DEFAULT_MODEL)
    expect(models[0].supported_parameters).toContain('tools')
    expect(models[0].supported_parameters).toContain('reasoning')
    const metadata = codexMetadata(models[0])
    expect(metadata.defaultReasoningEffort).toBe('medium')
    expect(fieldValues(jsonArrayField(metadata, 'supportedReasoningEfforts'), 'effort')).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(jsonArrayField(metadata, 'nativeTools')).toContain('image_generation')
    // The native image_generation tool is what declares image output —
    // Codex /models never reports output_modalities.
    expect(models[0].architecture.output_modalities).toContain('image')

    const selectedFallback = getOnethingCodexFallbackModel('gpt-5.5')
    expect(selectedFallback.id).toBe('gpt-5.5')
    expect(selectedFallback.architecture.input_modalities).toContain('image')
    expect(selectedFallback.architecture.output_modalities).toContain('image')
  })

  it('parses Codex backend model metadata', () => {
    const model = codexModelInfoToOnethingOpenRouterModel({
      slug: 'gpt-5.4-codex',
      display_name: 'GPT-5.4 Codex',
      description: 'Next Codex model',
      context_window: 256000,
      input_modalities: ['text', 'image'],
      support_verbosity: true,
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' },
        { effort: 'xhigh', description: 'Deep' },
      ],
      supports_reasoning_summaries: true,
      experimental_supported_tools: ['image_generation'],
      serviceTiers: [
        { id: 'fast', name: 'Fast', description: 'Priority processing.' },
        { id: 'flex', name: 'Flex', description: 'Flexible processing.' },
      ],
    })

    expect(model?.id).toBe('gpt-5.4-codex')
    expect(model?.name).toBe('GPT-5.4 Codex')
    expect(model?.context_length).toBe(256000)
    expect(model?.architecture.input_modalities).toEqual(['text', 'image'])
    expect(model?.supported_parameters).toContain('verbosity')
    expect(model?.supported_parameters).toContain('reasoning')
    const metadata = codexMetadata(model)
    expect(metadata.defaultReasoningEffort).toBe('low')
    expect(jsonArrayField(metadata, 'supportedReasoningEfforts')).toEqual([
      { effort: 'low', description: 'Fast' },
      { effort: 'xhigh', description: 'Deep' },
    ])
    expect(jsonArrayField(metadata, 'serviceTiers')).toEqual([
      { id: 'fast', name: 'Fast', description: 'Priority processing.' },
      { id: 'flex', name: 'Flex', description: 'Flexible processing.' },
    ])
    expect(jsonArrayField(metadata, 'nativeTools')).toEqual(['image_generation'])
    expect(model?.architecture.output_modalities).toContain('image')
  })

  it('leaves output modalities at text when no native image tool is declared', () => {
    // A non-empty explicit tool list without image_generation is the only
    // "explicit no" the normalizer honours: an EMPTY experimental_supported_tools
    // is treated as "not enumerated" and still infers from input modalities
    // (normalizeOnethingCodexModelNativeTools, explicitTools.length === 0 branch).
    const model = codexModelInfoToOnethingOpenRouterModel({
      slug: 'gpt-5.5-text-only',
      input_modalities: ['text', 'image'],
      experimental_supported_tools: ['web_search'],
    })

    expect(jsonArrayField(codexMetadata(model), 'nativeTools')).toEqual([])
    expect(model?.architecture.output_modalities).toEqual(['text'])
    expect(model?.architecture.input_modalities).toEqual(['text', 'image'])
  })

  it('normalizes Responses body for the Codex backend contract', () => {
    const body = normalizeOnethingCodexResponsesBody({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'Hi' }],
      tools: [{ type: 'function', name: 'read' }],
      tool_choice: { type: 'function', name: 'read' },
      max_output_tokens: 64000,
      temperature: 0.2,
      metadata: { leaked: true },
    })

    expect(body.store).toBe(false)
    expect(body.instructions).toBeTruthy()
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.tool_choice).toBe('auto')
    expect(body.include).toEqual([])
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(body.metadata).toBeUndefined()
  })

  it('normalizes Codex reasoning and repairs backend contract rejections', () => {
    const body = normalizeOnethingCodexResponsesBody({
      model: 'gpt-5.5',
      input: [],
      reasoning: { effort: 'max', summary: 'auto' },
    })

    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect(body.include).toContain('reasoning.encrypted_content')
    expect(normalizeOnethingCodexReasoningEffort('max')).toBe('high')

    const repairedUnsupported = repairOnethingCodexRejectedBody({
      model: 'gpt-5.5',
      input: [],
      max_output_tokens: 64000,
    }, JSON.stringify({ detail: 'Unsupported parameter: max_output_tokens' }))

    expect(repairedUnsupported?.max_output_tokens).toBeUndefined()
  })

  it('normalizes Codex usage payload variants', () => {
    expect(normalizeOnethingCodexUsagePayload({
      planType: 'team',
      credits: { hasCredits: true, unlimited: true },
      rateLimitReachedType: { type: 'workspace_owner_usage_limit_reached' },
      rateLimit: {
        primaryWindow: { usedPercent: '75', limitWindowSeconds: '3600' },
      },
    })).toEqual({
      planType: 'team',
      credits: { hasCredits: true, unlimited: true },
      limits: [{
        id: 'codex',
        primary: { usedPercent: 75, windowSeconds: 3600 },
        rateLimitReachedType: 'workspace_owner_usage_limit_reached',
      }],
    })
  })

  it('fetches official Codex usage through injected fetch', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = []
    const fetchImpl = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      calls.push({ url: requestUrl(input), headers: headersRecord(init?.headers) })
      return new Response(JSON.stringify({
        plan_type: 'pro',
        credits: {
          has_credits: true,
          unlimited: false,
          balance: '12.50',
        },
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 18000,
            reset_after_seconds: 300,
            reset_at: 1770000000,
          },
        },
      }), { status: 200 })
    }

    const usage = await fetchOnethingCodexUsage({
      accessToken: 'access-token',
      accountId: 'acct_123',
      isFedrampAccount: true,
    }, fetchImpl, { timeoutMs: 0 })

    expect(calls[0].url).toBe(ONETHING_CODEX_USAGE_URL)
    expect(calls[0].url).toContain('/backend-api/wham/usage')
    expect(calls[0].url).not.toContain('/backend-api/codex')
    expect(calls[0].headers?.Authorization).toBe('Bearer access-token')
    expect(calls[0].headers?.originator).toBe('codex_cli_rs')
    expect(usage.planType).toBe('pro')
    expect(usage.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.50' })
    expect(usage.limits[0]).toMatchObject({
      id: 'codex',
      primary: { usedPercent: 25, windowSeconds: 18000, resetAfterSeconds: 300, resetAt: 1770000000 },
    })
  })

  it('surfaces Codex usage errors without leaking request secrets in runtime', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      detail: 'usage unavailable',
    }), { status: 403 })

    await expect(fetchOnethingCodexUsage({
      accessToken: 'secret-token',
    }, fetchImpl, { timeoutMs: 0 })).rejects.toThrow('Codex usage request failed: 403: usage unavailable')

    await expect(fetchOnethingCodexUsage({
      accessToken: 'secret-token',
    }, fetchImpl, { timeoutMs: 0 })).rejects.not.toThrow('secret-token')
  })

  it('decodes and parses Codex SSE events in runtime', async () => {
    expect(decodeOnethingCodexSseEventData('response.completed', ['{"response":{"id":"resp_1"}}'])).toEqual({
      type: 'response.completed',
      response: { id: 'resp_1' },
    })
    expect(decodeOnethingCodexSseEventData(null, ['[DONE]'])).toBeNull()

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_text.delta\n'))
        controller.enqueue(encoder.encode('data: {"delta":"hel"}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'))
        controller.close()
      },
    })

    const events = []
    for await (const event of parseOnethingCodexSseStream(stream)) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'response.output_text.delta', delta: 'hel' },
      { type: 'response.completed', response: { id: 'resp_1' } },
    ])
  })

  it('extracts Codex SSE response helpers in runtime', () => {
    const usage = onethingCodexUsageFromResponse({
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
        output_tokens_details: { reasoning_tokens: 1 },
        input_tokens_details: { cached_tokens: 4 },
      },
    })

    expect(usage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      reasoningTokens: 1,
      cachedInputTokens: 4,
    })
    expect(hasMeaningfulOnethingCodexUsage(usage)).toBe(true)
    expect(extractOnethingCodexOutputText({
      content: [{ text: 'hello' }, { content: ' world' }],
    })).toBe('hello world')
    expect(collectOnethingCodexReasoningSummaryText({
      summary: [{ text: 'step 1' }],
      parts: [{ value: ' step 2' }],
    })).toEqual(['step 1', ' step 2'])
    expect(extractOnethingCodexReasoningSummaryText({
      reasoningSummary: [{ text: 'done' }],
    })).toBe('done')
  })

  it('streams Codex SSE text, reasoning, metadata, and usage from runtime', async () => {
    const parts = await collectCodexStreamParts([
      { type: 'response.reasoning_summary_text.delta', item_id: 'reason_1', delta: 'thinking' },
      { type: 'response.output_text.delta', delta: 'hello' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-5.5',
          usage: {
            input_tokens: 3,
            output_tokens: 2,
            total_tokens: 5,
            output_tokens_details: { reasoning_tokens: 1 },
          },
        },
      },
    ])

    expect(parts).toEqual([
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'reasoning-0' },
      { type: 'reasoning-delta', id: 'reasoning-0', delta: 'thinking' },
      { type: 'reasoning-end', id: 'reasoning-0' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'hello' },
      { type: 'text-end', id: 'text-0' },
      {
        type: 'response-metadata',
        id: 'resp_1',
        modelId: 'gpt-5.5',
        timestamp: new Date('2026-01-02T03:04:05.000Z'),
      },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          reasoningTokens: 1,
          cachedInputTokens: undefined,
        },
      },
    ])
  })

  it('streams Codex tool calls and native image results from runtime', async () => {
    const parts = await collectCodexStreamParts([
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'item_read',
        delta: '{"path"',
      },
      {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'item_read',
          call_id: 'call_read',
          name: 'read',
          arguments: '{"path":"package.json"}',
        },
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'item_read',
          call_id: 'call_read',
          name: 'read',
          arguments: '{"path":"package.json"}',
        },
      },
      {
        type: 'response.output_item.added',
        item: {
          type: 'image_generation_call',
          id: 'img_1',
          status: 'in_progress',
        },
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          id: 'img_1',
          status: 'completed',
          revised_prompt: 'a small diagram',
          result: 'base64-image',
        },
      },
      { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.5' } },
    ])

    expect(parts).toContainEqual({ type: 'tool-input-start', id: 'call_read', toolName: 'read' })
    expect(parts).toContainEqual({ type: 'tool-input-delta', id: 'call_read', delta: '{"path"' })
    expect(parts).toContainEqual({ type: 'tool-input-delta', id: 'call_read', delta: ':"package.json"}' })
    expect(parts).toContainEqual({ type: 'tool-input-end', id: 'call_read' })
    expect(parts).toContainEqual({
      type: 'tool-call',
      toolCallId: 'call_read',
      toolName: 'read',
      input: '{"path":"package.json"}',
    })
    expect(parts).toContainEqual({
      type: 'raw',
      rawValue: {
        provider: 'codex',
        type: 'image-generation-start',
        callId: 'img_1',
        status: 'in_progress',
      },
    })
    expect(parts).toContainEqual({
      type: 'raw',
      rawValue: {
        provider: 'codex',
        type: 'image-generation-result',
        callId: 'img_1',
        status: 'completed',
        revisedPrompt: 'a small diagram',
        result: 'base64-image',
      },
    })
    expect(parts.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'tool-calls',
    })
  })

  it('requests Codex streams through injected runtime fetch and host hooks', async () => {
    const calls: Array<{ url: string; body?: string; headers?: Record<string, string> }> = []
    let prepared: OnethingCodexStreamRequestContext | undefined
    const fetchImpl = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      calls.push({
        url: requestUrl(input),
        body: bodyText(init?.body),
        headers: headersRecord(init?.headers),
      })
      return new Response([
        'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
      ].join(''), {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-oai-request-id': 'req_1',
        },
      })
    }

    const result = await requestOnethingCodexStream({
      modelId: 'gpt-5.5',
      token: {
        accessToken: 'access-token',
        accountId: 'acct_123',
        isFedrampAccount: true,
      },
      baseUrl: 'https://example.test/backend-api/codex',
      fetchImpl,
      callOptions: {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi from runtime' }] }],
        providerOptions: { codex: { instructions: 'Runtime instructions' } },
        headers: {
          'x-extra': 'visible',
          'x-empty': undefined,
        },
        tools: [],
      },
      onRequestPrepared(context) {
        prepared = context
      },
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    })

    expect(prepared?.url).toBe('https://example.test/backend-api/codex/responses')
    expect(prepared?.warnings).toEqual([])
    expect(summarizeOnethingCodexRequestBody(prepared!.body)).toMatchObject({
      model: 'gpt-5.5',
      inputCount: 1,
      messageCount: 1,
      toolCount: 0,
      stream: true,
      lastUserPreview: 'Hi from runtime',
    })

    const requestBody = JSON.parse(calls[0].body ?? '{}')
    expect(calls[0].url).toBe('https://example.test/backend-api/codex/responses')
    expect(calls[0].headers?.Authorization).toBe('Bearer access-token')
    expect(calls[0].headers?.['ChatGPT-Account-ID']).toBe('acct_123')
    expect(calls[0].headers?.['X-OpenAI-Fedramp']).toBe('true')
    expect(calls[0].headers?.['x-extra']).toBe('visible')
    expect(calls[0].headers?.['x-empty']).toBeUndefined()
    expect(requestBody.instructions).toBe('Runtime instructions')
    expect(result.request.body).toBe(calls[0].body)
    expect(result.response.headers['x-oai-request-id']).toBe('req_1')

    const parts = await readCodexRuntimeStream(result.stream)
    expect(parts).toContainEqual({ type: 'text-delta', id: 'text-0', delta: 'hello' })
    expect(parts.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    })
  })

  it('collects Codex generate results from runtime stream chunks', async () => {
    const stream = new ReadableStream<OnethingCodexStreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        controller.enqueue({ type: 'reasoning-delta', id: 'reasoning-0', delta: 'think' })
        controller.enqueue({ type: 'text-delta', id: 'text-0', delta: 'hel' })
        controller.enqueue({ type: 'text-delta', id: 'text-0', delta: 'lo' })
        controller.enqueue({
          type: 'tool-call',
          toolCallId: 'call_read',
          toolName: 'read',
          input: '{"path":"package.json"}',
        })
        controller.enqueue({
          type: 'finish',
          finishReason: 'tool-calls',
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            totalTokens: 5,
          },
        })
        controller.close()
      },
    })

    const result = await collectOnethingCodexGenerateResult({
      stream,
      request: { body: '{"model":"gpt-5.5"}' },
      response: { headers: { 'x-oai-request-id': 'req_1' } },
    }, {
      modelId: 'gpt-5.5',
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    })

    expect(result).toEqual({
      content: [
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'hello' },
        {
          type: 'tool-call',
          toolCallId: 'call_read',
          toolName: 'read',
          input: '{"path":"package.json"}',
        },
      ],
      finishReason: 'tool-calls',
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
      },
      warnings: [],
      request: { body: '{"model":"gpt-5.5"}' },
      response: {
        headers: { 'x-oai-request-id': 'req_1' },
        modelId: 'gpt-5.5',
        timestamp: new Date('2026-01-02T03:04:05.000Z'),
      },
    })
  })

  it('creates Codex API errors without leaking sensitive response headers', () => {
    const error = createOnethingCodexApiError(500, JSON.stringify({
      detail: 'server unavailable',
    }), new Headers({
      'x-oai-request-id': 'req_1',
      authorization: 'Bearer secret',
      cookie: 'session=secret',
      'x-safe': 'visible',
    })) as Error & {
      statusCode: number
      responseHeaders: Record<string, string>
      isRetryable: boolean
    }

    expect(error.message).toContain('Codex request failed (500): server unavailable [request-id: req_1]')
    expect(error.statusCode).toBe(500)
    expect(error.isRetryable).toBe(true)
    expect(error.responseHeaders.authorization).toBeUndefined()
    expect(error.responseHeaders.cookie).toBeUndefined()
    expect(error.responseHeaders['x-safe']).toBe('visible')
  })

  it('builds a native Codex Responses request in the runtime layer', () => {
    const { body, warnings } = buildOnethingCodexRequest('gpt-5.5', {
      prompt: [
        { role: 'system', content: 'System rules' },
        { role: 'user', content: [{ type: 'text', text: 'Read package.json' }] },
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: 'call_read',
            toolName: 'read',
            input: { path: 'package.json' },
          }],
        },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'call_read',
            toolName: 'read',
            output: { type: 'text', value: '{"name":"onething"}' },
          }],
        },
      ],
      tools: [{
        type: 'function',
        name: 'read',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }],
      providerOptions: {
        openai: { instructions: 'Top-level instructions' },
      },
      maxOutputTokens: 64000,
      temperature: 0.2,
    })

    expect(body.instructions).toBe('Top-level instructions')
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.tool_choice).toBe('auto')
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' })
    expect(body.include).toContain('reasoning.encrypted_content')
    expect(body.tools).toEqual([{
      type: 'function',
      name: 'read',
      description: 'Read a file',
      strict: false,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }])
    expect(body.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'System rules' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read package.json' }] },
      {
        type: 'function_call',
        name: 'read',
        arguments: '{"path":"package.json"}',
        call_id: 'call_read',
      },
      {
        type: 'function_call_output',
        call_id: 'call_read',
        output: '{"name":"onething"}',
      },
    ])
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body).not.toHaveProperty('temperature')
    expect(warnings.map(warning => warning.setting)).toEqual(['maxOutputTokens', 'temperature'])
  })

  it('maps image tool results to Codex multimodal function output in runtime', () => {
    const { body } = buildOnethingCodexRequest('gpt-5.5', {
      prompt: [
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: 'call_read',
            toolName: 'read',
            input: { path: 'pixel.png' },
          }],
        },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'call_read',
            toolName: 'read',
            result: {
              output: '[Image file: /tmp/pixel.png]\nMIME type: image/png',
              attachments: [{
                type: 'image',
                path: '/tmp/pixel.png',
                content: 'aW1hZ2U=',
                mimeType: 'image/png',
              }],
            },
          }],
        },
      ],
      tools: [],
    })

    const outputItem = body.input.find(item => item.type === 'function_call_output')
    expect(outputItem).toEqual({
      type: 'function_call_output',
      call_id: 'call_read',
      output: [
        { type: 'input_text', text: '[Image file: /tmp/pixel.png]\nMIME type: image/png' },
        { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=', detail: 'auto' },
      ],
    })
  })
})
