import { describe, expect, it, vi } from 'vitest'
import { toJsonObject, type JsonObject, type JsonValue } from '@shared/json.js'
import {
  buildCodexHeaders,
  buildCodexModelsUrl,
  buildCodexRequest,
  CODEX_DEFAULT_MODEL,
  codexModelInfoToOpenRouterModel,
  CODEX_CLIENT_VERSION,
  CODEX_BASE_URL,
  CODEX_USAGE_URL,
  createCodexFetch,
  createCodexModel,
  fetchCodexUsage,
  getCodexFallbackModel,
  getCodexFallbackModels,
  normalizeCodexUsagePayload,
  normalizeCodexReasoningEffort,
  normalizeCodexResponsesBody,
  prepareCodexCallOptions,
  repairCodexRejectedBody,
} from '../codex.js'

type CodexRequestOptions = Parameters<typeof buildCodexRequest>[1]
type CodexLanguageModel = ReturnType<typeof createCodexModel>
type CodexStreamOptions = Parameters<CodexLanguageModel['doStream']>[0]
type CodexStreamResult = Awaited<ReturnType<CodexLanguageModel['doStream']>>
type CodexStreamChunk = CodexStreamResult['stream'] extends ReadableStream<infer Chunk> ? Chunk : never

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
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  return undefined
}

function codexRequestOptions(options: CodexRequestOptions): CodexRequestOptions {
  return options
}

function codexStreamOptions(options: CodexStreamOptions): CodexStreamOptions {
  return options
}

async function readCodexChunks(stream: ReadableStream<CodexStreamChunk>): Promise<CodexStreamChunk[]> {
  const reader = stream.getReader()
  const chunks: CodexStreamChunk[] = []
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

describe('codex provider helpers', () => {
  it('builds ChatGPT subscription auth headers', () => {
    const headers = buildCodexHeaders({
      accessToken: 'access-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
      accountId: 'acct_123',
      isFedrampAccount: true,
    })

    expect(headers.Authorization).toBe('Bearer access-token')
    expect(headers.originator).toBe('codex_cli_rs')
    expect(headers.version).toBe(CODEX_CLIENT_VERSION)
    expect(headers['ChatGPT-Account-ID']).toBe('acct_123')
    expect(headers['X-OpenAI-Fedramp']).toBe('true')
  })

  it('adds the Codex client version query to model refreshes', () => {
    const url = new URL(buildCodexModelsUrl())

    expect(url.pathname).toBe('/backend-api/codex/models')
    expect(url.searchParams.get('client_version')).toBe(CODEX_CLIENT_VERSION)
  })

  it('fetches official Codex usage from the ChatGPT WHAM endpoint', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = []
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async (input, init) => {
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
          secondary_window: {
            used_percent: 50,
            limit_window_seconds: 604800,
            reset_after_seconds: 86400,
            reset_at: 1770600000,
          },
        },
        additional_rate_limits: [{
          limit_name: 'Cloud tasks',
          metered_feature: 'codex_cloud',
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 3600,
              reset_after_seconds: 120,
              reset_at: 1770000100,
            },
          },
        }],
      }), { status: 200 })
    })

    const usage = await fetchCodexUsage({
      accessToken: 'access-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
      accountId: 'acct_123',
      isFedrampAccount: true,
    }, fetchImpl)

    expect(calls[0].url).toBe(CODEX_USAGE_URL)
    expect(calls[0].url).toContain('/backend-api/wham/usage')
    expect(calls[0].url).not.toContain('/backend-api/codex')
    expect(calls[0].headers?.Authorization).toBe('Bearer access-token')
    expect(calls[0].headers?.originator).toBe('codex_cli_rs')
    expect(calls[0].headers?.['ChatGPT-Account-ID']).toBe('acct_123')
    expect(calls[0].headers?.['X-OpenAI-Fedramp']).toBe('true')
    expect(usage.planType).toBe('pro')
    expect(usage.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.50' })
    expect(usage.limits[0]).toMatchObject({
      id: 'codex',
      primary: { usedPercent: 25, windowSeconds: 18000, resetAfterSeconds: 300, resetAt: 1770000000 },
      secondary: { usedPercent: 50, windowSeconds: 604800, resetAfterSeconds: 86400, resetAt: 1770600000 },
    })
    expect(usage.limits[1]).toMatchObject({
      id: 'codex_cloud',
      name: 'Cloud tasks',
      primary: { usedPercent: 10 },
    })
  })

  it('normalizes Codex usage payload variants', () => {
    expect(normalizeCodexUsagePayload({
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

  it('surfaces Codex usage errors without leaking request secrets', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      detail: 'usage unavailable',
    }), { status: 403 }))

    await expect(fetchCodexUsage({
      accessToken: 'secret-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
    }, fetchImpl)).rejects.toThrow('Codex usage request failed: 403: usage unavailable')

    await expect(fetchCodexUsage({
      accessToken: 'secret-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
    }, fetchImpl)).rejects.not.toThrow('secret-token')
  })

  it('provides a usable fallback model', () => {
    const models = getCodexFallbackModels()

    expect(models[0].id).toBe(CODEX_DEFAULT_MODEL)
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

    const selectedFallback = getCodexFallbackModel('gpt-5.5')
    expect(selectedFallback.id).toBe('gpt-5.5')
    expect(selectedFallback.supported_parameters).toContain('tools')
    expect(selectedFallback.supported_parameters).toContain('reasoning')
    expect(selectedFallback.architecture.input_modalities).toContain('image')
  })

  it('parses Codex backend model metadata', () => {
    const model = codexModelInfoToOpenRouterModel({
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
  })

  it('respects explicit Codex model metadata when native image generation is absent', () => {
    const model = codexModelInfoToOpenRouterModel({
      slug: 'gpt-5.4-codex',
      input_modalities: ['text', 'image'],
      experimental_supported_tools: ['web_search'],
    })

    expect(jsonArrayField(codexMetadata(model), 'nativeTools')).toEqual([])
    expect(model?.architecture.output_modalities).toEqual(['text'])
  })

  it('parses deprecated Codex speed tiers as service tiers', () => {
    const model = codexModelInfoToOpenRouterModel({
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      additionalSpeedTiers: ['fast'],
    })

    expect(jsonArrayField(codexMetadata(model), 'serviceTiers')).toEqual([
      { id: 'fast', name: 'Fast', description: undefined },
    ])
    expect(model?.architecture.input_modalities).toEqual(['text', 'image'])
  })

  it('moves system instructions into Codex provider options', () => {
    const options = prepareCodexCallOptions({
      messages: [
        { role: 'system', content: 'System rules' },
        { role: 'developer', content: [{ type: 'text', text: 'Developer rules' }] },
        { role: 'user', content: 'Hello' },
      ],
      tools: {
        read: { description: 'Read a file', inputSchema: {} },
      },
      toolChoice: { type: 'tool', toolName: 'read' },
      maxOutputTokens: 64000,
    }, {
      providerId: 'codex',
      modelId: 'gpt-5.5',
      mode: 'stream',
      isReasoningModel: false,
    })

    expect(options.messages).toEqual([{ role: 'user', content: 'Hello' }])
    const codexOptions = options.providerOptions?.codex as { instructions?: string } | undefined
    expect(codexOptions?.instructions).toBe('System rules\n\nDeveloper rules')
    expect(options.providerOptions?.openai).toBeUndefined()
    expect(options.toolChoice).toEqual({ type: 'auto' })
    expect(options.maxOutputTokens).toBeUndefined()
  })

  it('normalizes Responses body for the Codex backend contract', () => {
    const body = normalizeCodexResponsesBody({
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

  it('normalizes Codex thinking body fields only when reasoning is enabled', () => {
    const body = normalizeCodexResponsesBody({
      model: 'gpt-5.5',
      input: [],
      reasoning: { effort: 'max', summary: 'auto' },
    })

    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect(body.include).toContain('reasoning.encrypted_content')

    const offBody = normalizeCodexResponsesBody({
      model: 'gpt-5.5',
      input: [],
      include: ['reasoning.encrypted_content'],
    })

    expect(offBody.reasoning).toBeUndefined()
    expect(offBody.include).toEqual([])
    expect(normalizeCodexReasoningEffort('max')).toBe('high')
  })

  it('repairs backend contract rejections without exposing the user to another manual cycle', () => {
    const repairedToolChoice = repairCodexRejectedBody({
      model: 'gpt-5.5',
      input: [],
      tool_choice: { type: 'function', name: 'read' },
    }, JSON.stringify({
      error: {
        message: "Invalid value: 'function'. Value must be 'file_search'.",
        param: 'tool_choice.type',
      },
    }))

    expect(repairedToolChoice?.tool_choice).toBe('auto')

    const repairedUnsupported = repairCodexRejectedBody({
      model: 'gpt-5.5',
      input: [],
      max_output_tokens: 64000,
    }, JSON.stringify({ detail: 'Unsupported parameter: max_output_tokens' }))

    expect(repairedUnsupported?.max_output_tokens).toBeUndefined()
  })

  it('builds a native Codex Responses request without OpenAI Responses-only parameters', () => {
    const { body, warnings } = buildCodexRequest('gpt-5.5', codexRequestOptions({
      prompt: [
        { role: 'system', content: 'System rules' },
        { role: 'user', content: [{ type: 'text', text: 'Read package.json' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_read',
              toolName: 'read',
              input: { path: 'package.json' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_read',
              toolName: 'read',
              output: { type: 'text', value: '{"name":"onething"}' },
            },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'read',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
      providerOptions: {
        openai: { instructions: 'Top-level instructions' },
      },
      maxOutputTokens: 64000,
      temperature: 0.2,
    }))

    expect(body.instructions).toBe('Top-level instructions')
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.tool_choice).toBe('auto')
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' })
    expect(body.include).toContain('reasoning.encrypted_content')
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'read',
        description: 'Read a file',
        strict: false,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ])
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

  it('maps image tool results to Codex Responses multimodal function output', () => {
    const { body } = buildCodexRequest('gpt-5.5', codexRequestOptions({
      prompt: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_read',
              toolName: 'read',
              input: { path: 'pixel.png' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
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
            },
          ],
        },
      ],
      tools: [],
    }))

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

  it('disables Codex thinking when requested', () => {
    const { body } = buildCodexRequest('gpt-5.5', codexRequestOptions({
      prompt: [{ role: 'user', content: 'Hi' }],
      providerOptions: {
        codex: {
          instructions: 'Instructions',
          thinking: 'disabled',
          reasoningEffort: 'high',
        },
      },
    }))

    expect(body.reasoning).toBeUndefined()
    expect(body.include).not.toContain('reasoning.encrypted_content')
  })

  it('sends Codex service tier only when explicitly selected', () => {
    const explicit = buildCodexRequest('gpt-5.5', codexRequestOptions({
      prompt: [{ role: 'user', content: 'Hi' }],
      providerOptions: {
        codex: {
          instructions: 'Instructions',
          serviceTier: 'fast',
        },
      },
    }))

    const automatic = buildCodexRequest('gpt-5.5', codexRequestOptions({
      prompt: [{ role: 'user', content: 'Hi' }],
      providerOptions: {
        codex: {
          instructions: 'Instructions',
        },
      },
    }))

    expect(explicit.body.service_tier).toBe('fast')
    expect(automatic.body.service_tier).toBeUndefined()
  })

  it('adds Codex native image generation as a backend tool when enabled', () => {
    const { body } = buildCodexRequest('gpt-5.5', codexRequestOptions({
      prompt: [{ role: 'user', content: 'Generate an image of the app mascot' }],
      tools: [
        {
          type: 'function',
          name: 'read',
          description: 'Read a file',
          inputSchema: { type: 'object' },
        },
      ],
      providerOptions: {
        codex: {
          instructions: 'Instructions',
          nativeTools: ['image_generation'],
        },
      },
    }))

    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'read',
        description: 'Read a file',
        strict: false,
        parameters: { type: 'object' },
      },
      {
        type: 'image_generation',
        output_format: 'png',
      },
    ])
    expect(body.tool_choice).toBe('auto')
    expect(body.parallel_tool_calls).toBe(false)
  })

  it('does not add Codex native image generation when disabled', () => {
    const { body } = buildCodexRequest('gpt-5.5', codexRequestOptions({
      prompt: [{ role: 'user', content: 'Generate an image' }],
      providerOptions: {
        codex: {
          instructions: 'Instructions',
        },
      },
    }))

    expect(body.tools).toEqual([])
  })

  it('streams Codex backend SSE through the provider model surface', async () => {
    const calls: Array<{ url: string; body?: string; headers?: Record<string, string> }> = []
    const baseFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      calls.push({
        url: requestUrl(input),
        body: bodyText(init?.body),
        headers: headersRecord(init?.headers),
      })
      return new Response([
        'data: {"type":"response.reasoning_summary_text.delta","delta":"summary"}\n\n',
        'data: {"type":"response.reasoning_text.delta","delta":"raw hidden"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"encrypted-reasoning"}}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
      ].join(''), {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-oai-request-id': 'req_1',
        },
      })
    })
    const model = createCodexModel('gpt-5.5', {
      accessToken: 'access-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
      accountId: 'acct_123',
    }, CODEX_BASE_URL, baseFetch)

    const result = await model.doStream(codexStreamOptions({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      providerOptions: {
        openai: { instructions: 'Instructions' },
        codex: { serviceTier: 'fast' },
      },
      maxOutputTokens: 64000,
      tools: [],
    }))
    const chunks = await readCodexChunks(result.stream)

    const requestBody = JSON.parse(calls[0].body || '{}')
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(calls[0].headers?.Authorization).toBe('Bearer access-token')
    expect(calls[0].headers?.originator).toBe('codex_cli_rs')
    expect(calls[0].headers?.['ChatGPT-Account-ID']).toBe('acct_123')
    expect(requestBody.instructions).toBe('Instructions')
    expect(requestBody.store).toBe(false)
    expect(requestBody.service_tier).toBe('fast')
    expect(requestBody.reasoning).toEqual({ effort: 'medium', summary: 'auto' })
    expect(requestBody.include).toContain('reasoning.encrypted_content')
    expect(requestBody.max_output_tokens).toBeUndefined()
    expect(chunks).toContainEqual({ type: 'reasoning-delta', id: 'reasoning-0', delta: 'summary' })
    expect(chunks).not.toContainEqual({ type: 'reasoning-delta', id: 'reasoning-0', delta: 'raw hidden' })
    expect(chunks).toContainEqual({ type: 'text-delta', id: 'text-0', delta: 'hello' })
    expect(chunks).toContainEqual({
      type: 'raw',
      rawValue: {
        provider: 'codex',
        type: 'encrypted-reasoning',
        encryptedContent: 'encrypted-reasoning',
      },
    })
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    expect(finish?.finishReason).toBe('stop')
    expect(finish?.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
  })

  it('emits output text deltas before the Codex SSE stream completes', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let completedEnqueued = false
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController
      },
    })
    const baseFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const model = createCodexModel('gpt-5.5', {
      accessToken: 'access-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
    }, CODEX_BASE_URL, baseFetch)

    const result = await model.doStream(codexStreamOptions({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Stream now' }] }],
      providerOptions: { codex: { instructions: 'Instructions' } },
      tools: [],
    }))
    const reader = result.stream.getReader()

    expect(await reader.read()).toEqual({
      done: false,
      value: { type: 'stream-start', warnings: [] },
    })

    controller?.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"live"}\n\n'))
    expect(await reader.read()).toEqual({
      done: false,
      value: { type: 'text-start', id: 'text-0' },
    })
    expect(await reader.read()).toEqual({
      done: false,
      value: { type: 'text-delta', id: 'text-0', delta: 'live' },
    })
    expect(completedEnqueued).toBe(false)

    completedEnqueued = true
    controller?.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n'))
    controller?.close()
    const remaining: CodexStreamChunk[] = []
    while (true) {
      const next = await reader.read()
      if (next.done) break
      remaining.push(next.value)
    }
    expect(remaining.find(chunk => chunk.type === 'finish')).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
    })
  })

  it('streams Codex native image generation calls without exposing base64 in text chunks', async () => {
    const imageBase64 = Buffer.from('fake-png').toString('base64')
    const baseFetch = vi.fn<typeof globalThis.fetch>(async () => new Response([
      'data: {"type":"response.output_item.added","item":{"type":"image_generation_call","id":"ig_1","status":"in_progress"}}\n\n',
      `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"ig_1","status":"completed","revised_prompt":"A clean app icon","result":"${imageBase64}"}}\n\n`,
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
    ].join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const model = createCodexModel('gpt-5.5', {
      accessToken: 'access-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
    }, CODEX_BASE_URL, baseFetch)

    const result = await model.doStream(codexStreamOptions({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Generate an image' }] }],
      providerOptions: {
        codex: {
          instructions: 'Instructions',
          nativeTools: ['image_generation'],
        },
      },
      tools: [],
    }))
    const chunks = await readCodexChunks(result.stream)

    expect(chunks).toContainEqual({
      type: 'raw',
      rawValue: {
        provider: 'codex',
        type: 'image-generation-start',
        callId: 'ig_1',
        status: 'in_progress',
      },
    })
    expect(chunks).toContainEqual({
      type: 'raw',
      rawValue: {
        provider: 'codex',
        type: 'image-generation-result',
        callId: 'ig_1',
        status: 'completed',
        revisedPrompt: 'A clean app icon',
        result: imageBase64,
      },
    })
    expect(chunks.some((chunk) => chunk.type === 'text-delta' && String(chunk.delta).includes(imageBase64))).toBe(false)
  })

  it('streams function call argument deltas before the final tool call', async () => {
    const baseFetch = vi.fn<typeof globalThis.fetch>(async () => new Response([
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_item_1","call_id":"call_1","name":"edit"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_item_1","call_id":"call_1","delta":"{\\"path\\":\\"a.txt\\",\\"edits\\":[{\\"oldText\\":\\"old\\",\\"newText\\":\\"he"}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_item_1","call_id":"call_1","delta":"llo\\"}]}"}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_item_1","call_id":"call_1","name":"edit","arguments":"{\\"path\\":\\"a.txt\\",\\"edits\\":[{\\"oldText\\":\\"old\\",\\"newText\\":\\"hello\\"}]}"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
    ].join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const model = createCodexModel('gpt-5.5', {
      accessToken: 'access-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
    }, CODEX_BASE_URL, baseFetch)

    const result = await model.doStream(codexStreamOptions({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Edit a file' }] }],
      providerOptions: { codex: { instructions: 'Instructions' } },
      tools: [],
    }))
    const chunks = await readCodexChunks(result.stream)

    expect(chunks).toEqual(expect.arrayContaining([
      { type: 'tool-input-start', id: 'call_1', toolName: 'edit' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"path":"a.txt","edits":[{"oldText":"old","newText":"he' },
      { type: 'tool-input-delta', id: 'call_1', delta: 'llo"}]}' },
      { type: 'tool-input-end', id: 'call_1' },
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'edit',
        input: '{"path":"a.txt","edits":[{"oldText":"old","newText":"hello"}]}',
      },
    ]))
    expect(chunks.filter((chunk) => chunk.type === 'tool-input-delta').map((chunk) => chunk.delta).join('')).toBe('{"path":"a.txt","edits":[{"oldText":"old","newText":"hello"}]}')
    expect(chunks.find((chunk) => chunk.type === 'finish')?.finishReason).toBe('tool-calls')
  })

  it('falls back to a single argument payload when no argument deltas are sent', async () => {
    const baseFetch = vi.fn<typeof globalThis.fetch>(async () => new Response([
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_item_1","call_id":"call_1","name":"write","arguments":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"hello\\"}"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n',
    ].join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const model = createCodexModel('gpt-5.5', {
      accessToken: 'access-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
    }, CODEX_BASE_URL, baseFetch)

    const result = await model.doStream(codexStreamOptions({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Write a file' }] }],
      providerOptions: { codex: { instructions: 'Instructions' } },
      tools: [],
    }))
    const chunks = await readCodexChunks(result.stream)

    expect(chunks).toEqual(expect.arrayContaining([
      { type: 'tool-input-start', id: 'call_1', toolName: 'write' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"path":"a.txt","content":"hello"}' },
      { type: 'tool-input-end', id: 'call_1' },
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'write',
        input: '{"path":"a.txt","content":"hello"}',
      },
    ]))
  })

  it('emits completed reasoning item summaries when summary deltas are absent', async () => {
    const baseFetch = vi.fn<typeof globalThis.fetch>(async () => new Response([
      'data: {"type":"response.output_item.added","item":{"type":"reasoning","id":"reasoning_1","summary":[]}}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"reasoning_1","summary":[{"type":"summary_text","text":"finished summary"}],"content":[{"type":"reasoning_text","text":"raw hidden"}],"encrypted_content":"encrypted-reasoning"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
    ].join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const model = createCodexModel('gpt-5.5', {
      accessToken: 'access-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
    }, CODEX_BASE_URL, baseFetch)

    const result = await model.doStream(codexStreamOptions({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      providerOptions: { codex: { instructions: 'Instructions' } },
      tools: [],
    }))
    const chunks = await readCodexChunks(result.stream)

    expect(chunks).toContainEqual({ type: 'reasoning-delta', id: 'reasoning-0', delta: 'finished summary' })
    expect(chunks).not.toContainEqual({ type: 'reasoning-delta', id: 'reasoning-0', delta: 'raw hidden' })
    expect(chunks).toContainEqual({ type: 'text-delta', id: 'text-0', delta: 'answer' })
    expect(chunks).toContainEqual({
      type: 'raw',
      rawValue: {
        provider: 'codex',
        type: 'encrypted-reasoning',
        encryptedContent: 'encrypted-reasoning',
      },
    })
  })

  it('rewrites outbound /responses fetch bodies without touching other requests', async () => {
    const calls: Array<{ url: string; body?: string }> = []
    const baseFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      calls.push({ url: requestUrl(input), body: bodyText(init?.body) })
      return new Response('{}', { status: 200 })
    })
    const fetch = createCodexFetch(baseFetch)

    await fetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: [{ role: 'user', content: 'Hi' }],
      }),
    })
    await fetch('https://chatgpt.com/backend-api/codex/models', {
      method: 'GET',
    })

    const responseBody = JSON.parse(calls[0].body || '{}')
    expect(responseBody.store).toBe(false)
    expect(responseBody.parallel_tool_calls).toBe(false)
    expect(responseBody.tools).toEqual([])
    expect(responseBody.tool_choice).toBe('auto')
    expect(calls[1].body).toBeUndefined()
  })

  it('retries once with a repaired body when Codex rejects a request parameter', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls: string[] = []
    const baseFetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      calls.push(bodyText(init?.body) ?? '')
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          error: {
            message: "Invalid value: 'function'. Value must be 'file_search'.",
            param: 'tool_choice.type',
          },
        }), { status: 400 })
      }
      return new Response('{}', { status: 200 })
    })
    const fetch = createCodexFetch(baseFetch)

    try {
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: [],
          tool_choice: { type: 'function', name: 'read' },
        }),
      })

      expect(response.ok).toBe(true)
      expect(calls).toHaveLength(2)
      expect(JSON.parse(calls[1]).tool_choice).toBe('auto')
    } finally {
      warnSpy.mockRestore()
    }
  })
})
