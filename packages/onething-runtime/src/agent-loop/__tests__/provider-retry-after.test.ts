/**
 * `Retry-After` 透传(批 B8-2)—— 清掉批 D 勘误 3 记档的那颗雷。
 *
 * 批 D 把 `retryAfterAt` 这个字段留在分类器里当占位,但**五个家族没有一处读响应头**,
 * 所以它恒为 undefined、冷却一律走默认常量。这个文件守两件事:
 *
 *  1. **五家各自的真实形态**都能被解析出来(逐家一条,用真 `Response` 喂进
 *     provider 的错误构造处 —— 不是对 helper 打桩,那样什么也没验)。
 *  2. **认不出的头一律忽略**。解析层猜一个出来会直接变成冷却时长,那是分类器
 *     最不该做的事。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProvider, AgentTurnRequest } from '@onething/core/agent-loop'
import { createClaudeAgentProvider } from '../providers/claude.js'
import { createDeepSeekAgentProvider } from '../providers/deepseek.js'
import { createGeminiAgentProvider } from '../providers/gemini.js'
import { createOpenAICompatibleAgentProvider } from '../providers/openai-compatible.js'
import { createCodexAgentProvider } from '../providers/codex.js'
import {
  classifyProviderError,
  parseProviderRetryAfter,
  parseProviderRetryAfterValue,
  providerErrorCooldownUntil,
  providerErrorRetryAfterAt,
  PROVIDER_ERROR_COOLDOWN_MS,
  PROVIDER_RETRY_AFTER_MAX_MS,
} from '../provider-error-classification.js'

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  // codex / providers 在错误路径上打日志,测试里没必要看。
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const request = {
  turn: 0,
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
} as unknown as AgentTurnRequest

function errorResponse(body: string, headers: Record<string, string>): Response {
  return new Response(body, { status: 429, headers })
}

/** 起流并把错误抓出来 —— 五家的错误都在第一次 `!response.ok` 上抛。 */
async function captureError(provider: AgentProvider): Promise<unknown> {
  try {
    for await (const _event of provider.streamTurn!(request)) {
      // drain
    }
  } catch (error) {
    return error
  }
  throw new Error('provider did not throw')
}

describe('per-family Retry-After passthrough', () => {
  it('claude: retry-after seconds + anthropic-ratelimit-*-reset', async () => {
    const provider = createClaudeAgentProvider({
      apiKey: 'k',
      fetchImpl: async () =>
        errorResponse('{"type":"error","error":{"type":"rate_limit_error"}}', {
          'retry-after': '42',
          'anthropic-ratelimit-requests-reset': new Date(NOW + 600_000).toISOString(),
        }),
    })

    const error = await captureError(provider)
    // `retry-after` 是 provider 直接回答「什么时候再来」的那一句,优先于桶重置时刻。
    expect(providerErrorRetryAfterAt(error)).toBe(NOW + 42_000)
  })

  it('claude: RFC 3339 reset header alone (no retry-after)', async () => {
    const provider = createClaudeAgentProvider({
      apiKey: 'k',
      fetchImpl: async () =>
        errorResponse('{}', {
          'anthropic-ratelimit-tokens-reset': new Date(NOW + 90_000).toISOString(),
        }),
    })

    expect(providerErrorRetryAfterAt(await captureError(provider))).toBe(NOW + 90_000)
  })

  it('deepseek: retry-after seconds', async () => {
    const provider = createDeepSeekAgentProvider({
      apiKey: 'k',
      fetchImpl: async () => errorResponse('rate limit', { 'retry-after': '15' }),
    })

    expect(providerErrorRetryAfterAt(await captureError(provider))).toBe(NOW + 15_000)
  })

  it('gemini: RetryInfo lives in the response body, not a header', async () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '27s' },
        ],
      },
    })
    const provider = createGeminiAgentProvider({
      apiKey: 'k',
      fetchImpl: async () => errorResponse(body, {}),
    })

    expect(providerErrorRetryAfterAt(await captureError(provider))).toBe(NOW + 27_000)
  })

  it('openai-compatible: x-ratelimit-reset-* Go durations, earliest wins', async () => {
    const provider = createOpenAICompatibleAgentProvider({
      providerId: 'zhipu',
      apiKey: 'k',
      defaultBaseUrl: 'https://example.invalid/v1',
      fetchImpl: async () =>
        errorResponse('{"error":{"code":"rate_limit_exceeded"}}', {
          'x-ratelimit-reset-requests': '6m0s',
          'x-ratelimit-reset-tokens': '2m59.56s',
        }),
    })

    const error = await captureError(provider)
    // 两个桶都有重置时刻时取**更早**的那个(猜短的代价可逆,批 D 勘误 6 同一句)。
    expect(providerErrorRetryAfterAt(error)).toBe(NOW + 179_560)
    // 既有形状一字未改:statusCode 仍然藏在 data 里。
    expect((error as { data: { statusCode: number } }).data.statusCode).toBe(429)
  })

  it('codex: retry-after passed through the headers it already received', async () => {
    const provider = createCodexAgentProvider({
      apiKey: 'k',
      fetchImpl: async () =>
        errorResponse('{"error":{"message":"slow down"}}', {
          'retry-after': '8',
          'x-oai-request-id': 'req_1',
        }),
    })

    const error = await captureError(provider)
    expect(providerErrorRetryAfterAt(error)).toBe(NOW + 8_000)
    expect((error as { statusCode: number }).statusCode).toBe(429)
  })
})

describe('HTTP-date form', () => {
  it('parses an IMF-fixdate Retry-After into an absolute timestamp', async () => {
    const at = NOW + 120_000
    const provider = createDeepSeekAgentProvider({
      apiKey: 'k',
      fetchImpl: async () =>
        errorResponse('rate limit', { 'retry-after': new Date(at).toUTCString() }),
    })

    // toUTCString 只到秒 —— 与 at 同秒即可。
    expect(providerErrorRetryAfterAt(await captureError(provider))).toBe(at)
  })

  it('parses HTTP-date directly', () => {
    expect(parseProviderRetryAfterValue('Sun, 16 Aug 2026 12:05:00 GMT', NOW)).toBe(
      NOW + 300_000,
    )
  })
})

describe('malformed headers are ignored', () => {
  it.each([
    ['empty', ''],
    ['words', 'soon'],
    ['negative', '-30'],
    ['NaN', 'NaN'],
    ['half a duration', '6m0x'],
    ['garbage date', 'Sun, 99 Foo 2026'],
  ])('%s → undefined', (_label, value) => {
    expect(parseProviderRetryAfterValue(value, NOW)).toBeUndefined()
  })

  it('a past timestamp is dropped rather than producing an instant recovery', () => {
    const headers = new Headers({ 'retry-after': new Date(NOW - 60_000).toUTCString() })
    expect(parseProviderRetryAfter(headers, undefined, NOW)).toBeUndefined()
  })

  it('a provider that sends a malformed header falls back to the default cooldown', async () => {
    const provider = createClaudeAgentProvider({
      apiKey: 'k',
      fetchImpl: async () =>
        errorResponse('{"error":{"type":"rate_limit_error"}}', { 'retry-after': 'later' }),
    })

    const classification = classifyProviderError(await captureError(provider))
    expect(classification.retryAfterAt).toBeUndefined()
    expect(providerErrorCooldownUntil(classification, NOW)).toBe(
      NOW + PROVIDER_ERROR_COOLDOWN_MS['rate-limited'],
    )
  })
})

describe('the classifier consumes retryAfterAt', () => {
  it('prefers the provider recovery time over the class default', () => {
    const error = Object.assign(new Error('deepseek agent loop API error: 429 slow down'), {
      retryAfterAt: NOW + 5_000,
    })
    const classification = classifyProviderError(error)
    expect(classification.kind).toBe('rate-limited')
    expect(classification.retryAfterAt).toBe(NOW + 5_000)
    // 默认是 60s,provider 说 5s —— 用 provider 的。
    expect(providerErrorCooldownUntil(classification, NOW)).toBe(NOW + 5_000)
  })

  it('reads retryAfterAt out of the data bag too', () => {
    const error = Object.assign(new Error('boom'), {
      data: { statusCode: 429, retryAfterAt: NOW + 7_000 },
    })
    expect(classifyProviderError(error).retryAfterAt).toBe(NOW + 7_000)
  })

  it('caps an absurd Retry-After at one hour', () => {
    const error = Object.assign(new Error('gemini agent loop API error: 429 exhausted'), {
      retryAfterAt: NOW + 24 * 60 * 60_000,
    })
    const classification = classifyProviderError(error)
    // 原话原样留着(日志/勘误看得见),夹取只发生在冷却计算上。
    expect(classification.retryAfterAt).toBe(NOW + 24 * 60 * 60_000)
    expect(providerErrorCooldownUntil(classification, NOW)).toBe(
      NOW + PROVIDER_RETRY_AFTER_MAX_MS,
    )
  })

  it('never turns a non-rotating error into a cooldown', () => {
    const error = Object.assign(new Error('openai agent loop API error: 400 bad param'), {
      retryAfterAt: NOW + 30_000,
    })
    const classification = classifyProviderError(error)
    expect(classification.kind).toBe('unknown')
    expect(providerErrorCooldownUntil(classification, NOW)).toBe(0)
  })
})
