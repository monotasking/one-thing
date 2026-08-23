import { describe, expect, it } from 'vitest'
import { isRetryableAgentError } from './retry.js'

/**
 * 回合级重试的状态码读取顺序(P1-d1)。
 *
 * runtime 的 provider 错误现在是一个对象(`ProviderHttpError`:顶层 `status` +
 * `providerId`)。core 不 import runtime,所以这里造的是**同一个鸭子形状**,
 * 与生产对象逐字段等价 —— 测的是"读取顺序",不是"某个类"。
 *
 * 三条要点:
 *  1. 读得到状态码就到此为止,正文全文扫描是兜底;
 *  2. `status === 0` = 没有 HTTP 状态(流中错误 / 超时),当作读不到,继续走文本;
 *  3. 旧形状(裸 `Error`,状态码只在消息里)照旧走正则。
 */
function providerHttpError(init: {
  status: number
  message: string
  responseBody?: string
  providerId?: string
}): Error {
  return Object.assign(new Error(init.message), {
    providerId: init.providerId ?? 'acme',
    status: init.status,
    responseBody: init.responseBody ?? '',
  })
}

describe('isRetryableAgentError — 先读对象上的状态码', () => {
  it('429 + 响应体里含 "max_tokens": 500 → 按 429 判可重试', () => {
    const error = providerHttpError({
      status: 429,
      message:
        'acme agent loop API error: 429 {"error":{"message":"Rate limit reached"},"max_tokens": 500}',
      responseBody: '{"error":{"message":"Rate limit reached"},"max_tokens": 500}',
    })
    expect(isRetryableAgentError(error)).toBe(true)
  })

  it('对象上的状态码压过正文里的数字 —— 404 不因为正文里的 503 变成可重试', () => {
    const error = providerHttpError({
      status: 404,
      message: 'acme agent loop failed while proxying an upstream 503',
    })
    expect(isRetryableAgentError(error)).toBe(false)
    // 同一句话、没有对象状态码 = 旧形状 → 正则扫到 503 → 可重试。
    // 两条结论不同,正是"先读对象"这件事本身。
    expect(
      isRetryableAgentError(
        new Error('acme agent loop failed while proxying an upstream 503'),
      ),
    ).toBe(true)
  })

  it('status 0(流中的错误事件 / 超时)当作读不到,继续走文本判据', () => {
    expect(
      isRetryableAgentError(
        providerHttpError({ status: 0, message: 'acme agent loop error: Overloaded' }),
      ),
    ).toBe(true)
    expect(
      isRetryableAgentError(
        providerHttpError({ status: 0, message: 'acme agent loop stream was interrupted' }),
      ),
    ).toBe(true)
  })

  it('旧形状仍然走正则:状态码只在消息里', () => {
    expect(isRetryableAgentError(new Error('Gemini agent loop API error: 429 quota'))).toBe(
      true,
    )
    expect(isRetryableAgentError(new Error('Gemini agent loop API error: 404 no model'))).toBe(
      false,
    )
  })

  it('顶层 isRetryable 仍然优先(codex 的预判)', () => {
    const error = Object.assign(new Error('Codex request failed (500): boom'), {
      providerId: 'codex',
      status: 500,
      statusCode: 500,
      isRetryable: false,
    })
    expect(isRetryableAgentError(error)).toBe(false)
  })
})
