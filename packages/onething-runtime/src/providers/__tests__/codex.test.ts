import { toJsonObject, type JsonObject, type JsonValue } from '@onething/core'
import { describe, expect, it } from 'vitest'
import {
  buildOnethingCodexHeaders,
  buildOnethingCodexModelsUrl,
  codexModelInfoToOnethingOpenRouterModel,
  fetchOnethingCodexModels,
  fetchOnethingCodexUsage,
  getOnethingCodexFallbackModel,
  getOnethingCodexFallbackModels,
  normalizeOnethingCodexReasoningEffort,
  normalizeOnethingCodexUsagePayload,
  ONETHING_CODEX_CLIENT_VERSION,
  ONETHING_CODEX_DEFAULT_MODEL,
  ONETHING_CODEX_USAGE_URL,
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

  it('clamps the Codex reasoning effort(max → high,认不出落 medium)', () => {
    expect(normalizeOnethingCodexReasoningEffort('max')).toBe('high')
    expect(normalizeOnethingCodexReasoningEffort('xhigh')).toBe('xhigh')
    expect(normalizeOnethingCodexReasoningEffort('nonsense')).toBe('medium')
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
})
