import { describe, expect, it } from 'vitest'
import {
  PROVIDER_ERROR_COOLDOWN_MS,
  classifyOAuthRefreshError,
  classifyProviderError,
  providerErrorCooldownUntil,
  providerErrorStatus,
} from '../provider-error-classification.js'

/**
 * 每个家族的错误对象都是**照着 provider 里真实的构造语句**造的(见分类器文件头
 * 那张表),不是造一个"看起来像"的形状 —— 那样测的是测试自己。
 */

/** claude.ts:784 / claude-code 同路:裸 Error,状态码只在消息里。 */
function claudeError(status: number, body: string): Error {
  return new Error(`Claude agent loop API error: ${status} ${body}`)
}

/** deepseek.ts:455:裸 Error。 */
function deepseekError(status: number, body: string): Error {
  return new Error(`DeepSeek agent loop API error: ${status} ${body}`)
}

/** gemini.ts:552:裸 Error。 */
function geminiError(status: number, body: string): Error {
  return new Error(`Gemini agent loop API error: ${status} ${body}`)
}

/** openai-compatible.ts:330:状态码藏在 `data.statusCode` 里一层。 */
function openAICompatibleError(providerId: string, status: number, body: string): Error {
  return Object.assign(
    new Error(`${providerId} agent loop API error: ${status} ${body}`),
    { responseBody: body, data: { providerId, statusCode: status, responseBody: body } },
  )
}

/** codex.ts:660:唯一带顶层 statusCode + isRetryable 的。 */
function codexError(status: number, detail: string): Error {
  return Object.assign(
    new Error(`Codex request failed (${status})${detail ? `: ${detail}` : ''}`),
    { statusCode: status, responseBody: detail, isRetryable: status >= 500 || status === 429 },
  )
}

describe('状态码提取:五个家族三种放法', () => {
  it('codex —— 顶层 statusCode', () => {
    expect(providerErrorStatus(codexError(429, 'slow down'))).toBe(429)
  })

  it('openai-compatible —— data.statusCode(retry.ts 的 errorStatus 读不到的那一层)', () => {
    expect(providerErrorStatus(openAICompatibleError('zhipu', 401, '{}'))).toBe(401)
  })

  it('claude / deepseek / gemini —— 从锚定前缀里抠', () => {
    expect(providerErrorStatus(claudeError(429, ''))).toBe(429)
    expect(providerErrorStatus(deepseekError(402, ''))).toBe(402)
    expect(providerErrorStatus(geminiError(500, ''))).toBe(500)
  })

  it('**不在整条消息里扫三位数** —— 响应体里的数字不许冒充状态码', () => {
    // 200 成功但流里出错的情况:消息里带着一个 "max_tokens": 500,不能被读成 500。
    const error = new Error('Claude agent loop error: stream failed with {"max_tokens": 500}')
    expect(providerErrorStatus(error)).toBeUndefined()
  })
})

describe('配额耗尽:必须有字面证据或 402', () => {
  it('OpenAI 家族的 insufficient_quota', () => {
    const error = openAICompatibleError(
      'openai',
      429,
      '{"error":{"code":"insufficient_quota","type":"insufficient_quota"}}',
    )
    const result = classifyProviderError(error)
    expect(result.kind).toBe('quota-exhausted')
    expect(result.rotates).toBe(true)
  })

  it('DeepSeek 402 Insufficient Balance', () => {
    expect(classifyProviderError(deepseekError(402, 'Insufficient Balance')).kind)
      .toBe('quota-exhausted')
  })

  it('Anthropic 400 credit balance is too low —— 状态码是 400,只有字面证据救得了它', () => {
    const result = classifyProviderError(
      claudeError(400, '{"error":{"message":"Your credit balance is too low"}}'),
    )
    expect(result.kind).toBe('quota-exhausted')
  })

  it('Zhipu 错误码 1113(账户额度不足)', () => {
    expect(classifyProviderError(openAICompatibleError('zhipu', 200, '{"code":"1113"}')).kind)
      .toBe('quota-exhausted')
  })

  it('Kimi exceeded_current_quota_error', () => {
    expect(
      classifyProviderError(openAICompatibleError('kimi', 429, 'exceeded_current_quota_error')).kind,
    ).toBe('quota-exhausted')
  })

  it('Qwen/DashScope Allocated quota exceeded 与欠费', () => {
    expect(classifyProviderError(openAICompatibleError('qwen', 429, 'Allocated quota exceeded')).kind)
      .toBe('quota-exhausted')
    expect(classifyProviderError(openAICompatibleError('qwen', 403, 'Arrearage')).kind)
      .toBe('quota-exhausted')
  })

  it('OpenRouter 402 insufficient credits', () => {
    expect(
      classifyProviderError(openAICompatibleError('openrouter', 402, 'insufficient credits')).kind,
    ).toBe('quota-exhausted')
  })
})

describe('限流:429 没有配额字样就是限流,不是耗尽', () => {
  it('裸 429 —— 取冷却更短的那一类', () => {
    const result = classifyProviderError(claudeError(429, '{"type":"rate_limit_error"}'))
    expect(result.kind).toBe('rate-limited')
    expect(result.rotates).toBe(true)
  })

  it('Gemini 429 RESOURCE_EXHAUSTED —— 它同时用于限流与配额,歧义时按限流', () => {
    // 猜短的代价可逆(轮回来再撞一次),猜长的代价是白白闲置一把好 key。
    expect(classifyProviderError(geminiError(429, '{"status":"RESOURCE_EXHAUSTED"}')).kind)
      .toBe('rate-limited')
  })

  it('没有状态码但有限流字样', () => {
    expect(classifyProviderError(new Error('rate limit exceeded, try again later')).kind)
      .toBe('rate-limited')
  })
})

describe('密钥无效:是自己一类,不是「用完」', () => {
  it('401 + invalid api key', () => {
    const result = classifyProviderError(openAICompatibleError('grok', 401, 'Incorrect API key provided'))
    expect(result.kind).toBe('auth-invalid')
    expect(result.rotates).toBe(true)
  })

  it('裸 401 也算 —— 状态码本身就是确定证据', () => {
    expect(classifyProviderError(codexError(401, '')).kind).toBe('auth-invalid')
  })

  it('Gemini API key not valid', () => {
    expect(classifyProviderError(geminiError(400, 'API key not valid. Please pass a valid API key.')).kind)
      .toBe('auth-invalid')
  })

  it('**403 没有鉴权字样时不判** —— 也可能是地区封禁或模型无权限,换 key 无济于事', () => {
    const result = classifyProviderError(claudeError(403, 'model not available in your region'))
    expect(result.kind).toBe('unknown')
    expect(result.rotates).toBe(false)
  })
})

describe('transient:服务端的事,不冷却任何 key', () => {
  it('5xx', () => {
    for (const status of [500, 502, 503, 504]) {
      const result = classifyProviderError(deepseekError(status, 'server error'))
      expect(result.kind).toBe('transient')
      expect(result.rotates).toBe(false)
    }
  })

  it('Anthropic 529 overloaded —— 过载不是限流,不能把 key 冷却掉', () => {
    const result = classifyProviderError(claudeError(529, '{"type":"overloaded_error"}'))
    expect(result.kind).toBe('transient')
    expect(result.rotates).toBe(false)
  })

  it('网络断 / 流被掐', () => {
    expect(classifyProviderError(new Error('fetch failed')).kind).toBe('transient')
    expect(classifyProviderError(new Error('read ECONNRESET')).kind).toBe('transient')
    expect(classifyProviderError(new Error('terminated')).kind).toBe('transient')
  })
})

describe('unknown:认不出来就绝不轮换', () => {
  it('参数写错 / 模型不存在 / 上下文超长 —— 全是程序性问题', () => {
    const cases = [
      openAICompatibleError('deepseek', 400, '{"error":{"message":"Invalid tool schema"}}'),
      claudeError(404, 'model claude-nonexistent not found'),
      openAICompatibleError('kimi', 413, 'maximum context length exceeded'),
    ]
    for (const error of cases) {
      const result = classifyProviderError(error)
      expect(result.kind).toBe('unknown')
      expect(result.rotates).toBe(false)
    }
  })

  it('用户按了停止不算失败', () => {
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    expect(classifyProviderError(aborted).rotates).toBe(false)
  })

  it('空错误 / 陌生字符串', () => {
    expect(classifyProviderError(undefined).kind).toBe('unknown')
    expect(classifyProviderError('something went sideways').kind).toBe('unknown')
  })
})

describe('冷却时长', () => {
  it('三类各取各的默认值,不轮换的一律 0', () => {
    const now = 1_000_000
    expect(providerErrorCooldownUntil(classifyProviderError(deepseekError(402, 'Insufficient Balance')), now))
      .toBe(now + PROVIDER_ERROR_COOLDOWN_MS['quota-exhausted'])
    expect(providerErrorCooldownUntil(classifyProviderError(claudeError(429, 'rate_limit_error')), now))
      .toBe(now + PROVIDER_ERROR_COOLDOWN_MS['rate-limited'])
    expect(providerErrorCooldownUntil(classifyProviderError(codexError(401, '')), now))
      .toBe(now + PROVIDER_ERROR_COOLDOWN_MS['auth-invalid'])
    expect(providerErrorCooldownUntil(classifyProviderError(claudeError(503, '')), now)).toBe(0)
    expect(providerErrorCooldownUntil(classifyProviderError(new Error('???')), now)).toBe(0)
  })

  it('quota > rate-limit,auth-invalid 最长(它不会自己恢复)', () => {
    expect(PROVIDER_ERROR_COOLDOWN_MS['quota-exhausted'])
      .toBeGreaterThan(PROVIDER_ERROR_COOLDOWN_MS['rate-limited'])
    expect(PROVIDER_ERROR_COOLDOWN_MS['auth-invalid'])
      .toBeGreaterThan(PROVIDER_ERROR_COOLDOWN_MS['quota-exhausted'])
  })
})

/**
 * OAuth token 端点的失败(批 B6)。**与聊天端点分开判**:同一个 400 在两处含义相反,
 * 合成一个函数就必然有一边判错。
 */
describe('classifyOAuthRefreshError —— token 端点', () => {
  /** auth-service 在 !response.ok 时挂上去的那个形状(裸消息不带锚定前缀)。 */
  function refreshError(status: number, body = ''): Error {
    return Object.assign(new Error(`Token refresh failed: ${status}`), {
      statusCode: status,
      responseBody: body,
    })
  }

  it('400 invalid_grant = 凭证死了(而聊天端点的 400 是程序性错误,绝不轮换)', () => {
    expect(classifyOAuthRefreshError(refreshError(400, '{"error":"invalid_grant"}')).kind)
      .toBe('auth-invalid')
    // 同一个错误交给通用分类器必须还是 unknown —— 两个函数的分工就在这里。
    expect(classifyProviderError(refreshError(400, '{"error":"invalid_grant"}')).kind)
      .toBe('unknown')
  })

  it('401 / 403 也是凭证死了', () => {
    expect(classifyOAuthRefreshError(refreshError(401)).kind).toBe('auth-invalid')
    expect(classifyOAuthRefreshError(refreshError(403)).kind).toBe('auth-invalid')
  })

  it('压根没有 refresh token = 再也活不过来,同样按 auth-invalid', () => {
    expect(classifyOAuthRefreshError(new Error('No refresh token available')).kind)
      .toBe('auth-invalid')
  })

  it('5xx / 网络断是服务端的事,不冷却任何账号', () => {
    expect(classifyOAuthRefreshError(refreshError(503)).kind).toBe('transient')
    expect(classifyOAuthRefreshError(new Error('fetch failed')).kind).toBe('transient')
    expect(providerErrorCooldownUntil(classifyOAuthRefreshError(refreshError(503)))).toBe(0)
  })

  it('认不出来的一律 unknown(不动池子)', () => {
    expect(classifyOAuthRefreshError(new Error('something odd')).kind).toBe('unknown')
  })

  it('auth-invalid 的冷却就是那张表里的 24 小时', () => {
    const now = 1_000_000
    expect(providerErrorCooldownUntil(classifyOAuthRefreshError(refreshError(401)), now))
      .toBe(now + PROVIDER_ERROR_COOLDOWN_MS['auth-invalid'])
  })
})
