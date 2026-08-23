import { describe, expect, it, vi } from 'vitest'
import { toJsonObject, type JsonObject, type JsonValue } from '@shared/json.js'
import {
  buildCodexHeaders,
  buildCodexModelsUrl,
  CODEX_DEFAULT_MODEL,
  codexModelInfoToOpenRouterModel,
  CODEX_CLIENT_VERSION,
  CODEX_USAGE_URL,
  fetchCodexUsage,
  getCodexFallbackModel,
  getCodexFallbackModels,
  normalizeCodexUsagePayload,
  prepareCodexCallOptions,
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
})
