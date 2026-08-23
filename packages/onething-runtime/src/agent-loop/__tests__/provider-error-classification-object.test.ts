import { describe, expect, it } from 'vitest'
import {
  AnthropicErrorMapper,
  CodexResponsesErrorMapper,
  GeminiErrorMapper,
  OpenAIChatErrorMapper,
} from '../providers/wires/index.js'
import {
  classifyProviderError,
  providerErrorRetryAfterAt,
  providerErrorStatus,
} from '../provider-error-classification.js'

/**
 * 分类器读**对象**的那条路(P1-d1)。
 *
 * 错误一律经四条线各自的 `ErrorMapper` 生产 —— 不手搓"看起来像"的形状,那样测的
 * 是测试自己。既有的那份 `provider-error-classification.test.ts` 守的是另一半:
 * 裸 `Error` / `data.statusCode` / 消息前缀抠取这三段兜底,一行未改仍然绿。
 */
function jsonResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('四条线的 ProviderHttpError 都走对象路径', () => {
  it('openai-chat:429 限流 —— 状态码来自 status,不是消息抠取', () => {
    const body = JSON.stringify({
      error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' },
    })
    const error = new OpenAIChatErrorMapper('openai').fromResponse(
      jsonResponse(429, { 'retry-after': '15' }),
      body,
    )
    expect(providerErrorStatus(error)).toBe(429)
    const classification = classifyProviderError(error)
    expect(classification.kind).toBe('rate-limited')
    expect(classification.status).toBe(429)
    expect(classification.rotates).toBe(true)
    // retry-after 也从对象顶层读回来,不再靠 `data` 兜一层。
    expect(providerErrorRetryAfterAt(error)).toBe(classification.retryAfterAt)
    expect(classification.retryAfterAt).toBeGreaterThan(Date.now())
  })

  it('openai-chat / deepseek:402 + insufficient_balance —— 配额耗尽', () => {
    const body = JSON.stringify({ error: { message: 'Insufficient Balance' } })
    const error = new OpenAIChatErrorMapper('deepseek', 'DeepSeek').fromResponse(
      jsonResponse(402),
      body,
    )
    // 用户可见的前缀一字不变。
    expect(error.message.startsWith('DeepSeek agent loop API error: 402 ')).toBe(true)
    expect(providerErrorStatus(error)).toBe(402)
    const classification = classifyProviderError(error)
    expect(classification.kind).toBe('quota-exhausted')
    expect(classification.status).toBe(402)
  })

  it('anthropic:401 —— key 被拒', () => {
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    })
    const error = new AnthropicErrorMapper('claude').fromResponse(jsonResponse(401), body)
    expect(error.message.startsWith('Claude agent loop API error: 401 ')).toBe(true)
    expect(providerErrorStatus(error)).toBe(401)
    const classification = classifyProviderError(error)
    expect(classification.kind).toBe('auth-invalid')
    expect(classification.rotates).toBe(true)
  })

  it('gemini:5xx —— transient,不冷却任何 key', () => {
    const body = JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } })
    const error = new GeminiErrorMapper('gemini').fromResponse(jsonResponse(503), body)
    expect(providerErrorStatus(error)).toBe(503)
    const classification = classifyProviderError(error)
    expect(classification.kind).toBe('transient')
    expect(classification.rotates).toBe(false)
  })

  it('codex:顶层 statusCode / isRetryable 兼容字段仍在,status 是同一个数', () => {
    const body = JSON.stringify({ error: { message: 'Rate limit reached for requests' } })
    const error = new CodexResponsesErrorMapper('codex').fromResponse(
      jsonResponse(429, { 'x-oai-request-id': 'req_1' }),
      body,
    )
    expect(error.message).toContain('Codex request failed (429)')
    expect(error.statusCode).toBe(429)
    expect(error.status).toBe(429)
    expect(error.isRetryable).toBe(true)
    expect(classifyProviderError(error).kind).toBe('rate-limited')
  })

  it('流中的错误事件 status=0 —— 当作没有 HTTP 状态,回到文本判据', () => {
    const error = new AnthropicErrorMapper('claude').fromStreamEvent({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    })
    expect(error?.status).toBe(0)
    expect(error?.inStream).toBe(true)
    // 0 不当状态码 —— 否则 `data.statusCode` 会把它捡回来,凭空造出一个 HTTP 状态。
    expect(providerErrorStatus(error)).toBeUndefined()
    const classification = classifyProviderError(error)
    expect(classification.kind).toBe('transient')
    expect(classification.status).toBeUndefined()
  })
})

describe('非 ProviderHttpError 的旧形状仍走三段兜底', () => {
  it('openai-compatible 的老对象:statusCode 藏在 data 里', () => {
    const body = '{"error":{"message":"Rate limit reached"}}'
    const legacy = Object.assign(
      new Error(`acme agent loop API error: 429 ${body}`),
      { responseBody: body, data: { providerId: 'acme', statusCode: 429, responseBody: body } },
    )
    expect(providerErrorStatus(legacy)).toBe(429)
    expect(classifyProviderError(legacy).kind).toBe('rate-limited')
  })

  it('裸 Error:只有消息前缀能抠出状态码,响应体里的数字不参与', () => {
    const legacy = new Error(
      'Gemini agent loop API error: 429 {"error":{"message":"quota"},"max_tokens":500}',
    )
    expect(providerErrorStatus(legacy)).toBe(429)
    expect(classifyProviderError(legacy).kind).toBe('rate-limited')
  })

  it('codex 的老对象:顶层 statusCode', () => {
    const legacy = Object.assign(new Error('Codex request failed (500): boom'), {
      statusCode: 500,
      responseBody: 'boom',
      isRetryable: true,
    })
    expect(providerErrorStatus(legacy)).toBe(500)
    expect(classifyProviderError(legacy).kind).toBe('transient')
  })
})
