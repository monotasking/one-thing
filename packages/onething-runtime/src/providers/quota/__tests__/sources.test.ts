import { afterEach, describe, expect, it } from 'vitest'
import {
  builtinQuotaSources,
  fetchProviderQuota,
  getQuotaSource,
  providerQuotaSourceOf,
  registerQuotaSource,
  resetQuotaSourcesForTests,
  type QuotaFetchContext,
} from '../index.js'
import {
  classifyQuotaWindowSeconds,
  quotaEpochMsOf,
  quotaWindowDaysOf,
} from '@shared/quota-windows.js'
import { codexQuotaFromHeaders } from '../../vendors/codex/quota.js'
import { BUILTIN_PROVIDER_MANIFESTS } from '../../builtin-manifests.js'

// P4 删了产品代码里的 `getBuiltinProviderManifest`(唯一读者是壳,已改读下发名册);用例里就地查表。
const getBuiltinProviderManifest = (id: string) => BUILTIN_PROVIDER_MANIFESTS.find((manifest) => manifest.id === id)

const NOW = 1_770_000_000_000

interface Call {
  url: string
  headers: Record<string, string>
}

function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } })
    return respond(url)
  }) as typeof globalThis.fetch
  return { calls, fetchImpl }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function ctx(overrides: Partial<QuotaFetchContext>, fetchImpl: typeof globalThis.fetch): QuotaFetchContext {
  return { fetchImpl, now: () => NOW, ...overrides }
}

afterEach(() => resetQuotaSourcesForTests())

describe('classify-windows', () => {
  it('按时长归类,不按位置', () => {
    expect(classifyQuotaWindowSeconds(18_000)).toBe('5h')
    expect(classifyQuotaWindowSeconds(3600)).toBe('5h')
    expect(classifyQuotaWindowSeconds(6 * 3600)).toBe('5h')
    expect(classifyQuotaWindowSeconds(6 * 3600 + 1)).toBe('7d')
    expect(classifyQuotaWindowSeconds(604_800)).toBe('7d')
    expect(classifyQuotaWindowSeconds(30 * 86_400)).toBe('30d')
    expect(classifyQuotaWindowSeconds(0)).toBeUndefined()
    expect(classifyQuotaWindowSeconds(Number.NaN)).toBeUndefined()
    expect(quotaWindowDaysOf('30d')).toBe(30)
    expect(quotaWindowDaysOf('7d')).toBeUndefined()
    expect(quotaWindowDaysOf('5h')).toBeUndefined()
  })

  it('时间戳:秒 / 毫秒 / ISO 三种写法都认', () => {
    expect(quotaEpochMsOf(1_770_000_000)).toBe(1_770_000_000_000)
    expect(quotaEpochMsOf(1_770_000_000_123)).toBe(1_770_000_000_123)
    expect(quotaEpochMsOf('2026-09-26T06:30:00Z')).toBe(Date.parse('2026-09-26T06:30:00Z'))
    expect(quotaEpochMsOf('nonsense')).toBeUndefined()
  })
})

describe('manifest → 注册表', () => {
  it('五家各指一个真登记的源,别家一律没有', () => {
    for (const id of ['codex', 'claude-code', 'deepseek', 'kimi', 'openrouter']) {
      expect(getBuiltinProviderManifest(id)?.quotaSource).toBe(id)
      expect(providerQuotaSourceOf(id)).toBe(id)
    }
    expect(providerQuotaSourceOf('gemini')).toBeUndefined()
    expect(builtinQuotaSources().map(source => source.id).sort()).toEqual(
      ['claude-code', 'codex', 'deepseek', 'kimi', 'openrouter'],
    )
  })

  it('没有源的家答 unsupported,一发请求都不起', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({}))
    await expect(fetchProviderQuota('gemini', ctx({ apiKey: 'k' }, fetchImpl))).resolves.toEqual({ kind: 'unsupported' })
    expect(calls).toHaveLength(0)
  })

  it('register 返回卸载函数,重复登记是明确错误', () => {
    const source = { id: 'siliconflow', fetch: async () => ({ kind: 'unsupported' as const }) }
    const dispose = registerQuotaSource('siliconflow', source)
    expect(getQuotaSource('siliconflow')).toBe(source)
    expect(() => registerQuotaSource('siliconflow', source)).toThrow(/already registered/)
    dispose()
    expect(getQuotaSource('siliconflow')).toBeUndefined()
  })
})

describe('codex', () => {
  const plusOrder = {
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 62, limit_window_seconds: 18_000, reset_at: 1_770_003_600 },
      secondary_window: { used_percent: 31, limit_window_seconds: 604_800, reset_after_seconds: 86_400 },
    },
    credits: { has_credits: true, unlimited: false, balance: '12.50' },
  }
  const swappedOrder = {
    plan_type: 'team',
    rate_limit: {
      primary_window: { used_percent: 31, limit_window_seconds: 604_800, reset_at: 1_770_600_000 },
      secondary_window: { used_percent: 62, limit_window_seconds: 18_000, reset_at: 1_770_003_600 },
    },
  }

  it('两种套餐顺序都归到 5h / 7d(按时长,不按 primary/secondary)', async () => {
    for (const payload of [plusOrder, swappedOrder]) {
      const { fetchImpl } = fakeFetch(() => json(payload))
      const quota = await fetchProviderQuota('codex', ctx({ oauthToken: { accessToken: 'at' } }, fetchImpl))
      expect(quota.kind).toBe('windows')
      if (quota.kind !== 'windows') return
      expect(quota.windows.map(window => [window.id, window.usedPercent])).toEqual([['5h', 62], ['7d', 31]])
      expect(quota.windows[0].resetsAt).toBe(1_770_003_600_000)
    }
  })

  it('credits 有余额时另出一条 balance(点数,不是美元);reset_after_seconds 现算', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(plusOrder))
    const quota = await fetchProviderQuota('codex', ctx({
      oauthToken: { accessToken: 'secret-at', accountId: 'acct_1', isFedrampAccount: true },
    }, fetchImpl))
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(calls[0].headers.Authorization).toBe('Bearer secret-at')
    expect(calls[0].headers['ChatGPT-Account-ID']).toBe('acct_1')
    expect(calls[0].headers['X-OpenAI-Fedramp']).toBe('true')
    expect(quota).toMatchObject({
      kind: 'windows',
      plan: 'plus',
      balance: { currency: 'credits', available: 12.5 },
      fetchedAt: NOW,
    })
    if (quota.kind === 'windows') expect(quota.windows[1].resetsAt).toBe(NOW + 86_400_000)
  })

  it('配额接口地址跟着端点的 origin 走(门把它指到本地假站)', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(swappedOrder))
    await fetchProviderQuota('codex', ctx({ oauthToken: { accessToken: 'at' }, baseUrl: 'http://127.0.0.1:9/backend-api/codex' }, fetchImpl))
    expect(calls[0].url).toBe('http://127.0.0.1:9/backend-api/wham/usage')
  })

  it('附加限额带 label,id 不与主窗口撞;没报时长的窗口丢掉', async () => {
    const { fetchImpl } = fakeFetch(() => json({
      rate_limit: {
        primary_window: { used_percent: 5, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 99 },
      },
      additional_rate_limits: [{
        metered_feature: 'codex_cloud',
        limit_name: 'Cloud tasks',
        rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } },
      }],
    }))
    const quota = await fetchProviderQuota('codex', ctx({ oauthToken: { accessToken: 'at' } }, fetchImpl))
    if (quota.kind !== 'windows') throw new Error('expected windows')
    expect(quota.windows.map(window => [window.id, window.label ?? null])).toEqual([
      ['5h', null],
      ['codex_cloud:5h', 'Cloud tasks'],
    ])
  })

  it('错误归因:401 → auth,429 → rate-limited,且错误句里没有令牌', async () => {
    const unauthorized = fakeFetch(() => json({ detail: 'token expired' }, 401))
    const auth = await fetchProviderQuota('codex', ctx({ oauthToken: { accessToken: 'secret-at' } }, unauthorized.fetchImpl))
    expect(auth).toMatchObject({ kind: 'error', reason: 'auth' })
    expect(JSON.stringify(auth)).not.toContain('secret-at')
    const limited = fakeFetch(() => json({}, 429))
    await expect(fetchProviderQuota('codex', ctx({ oauthToken: { accessToken: 'at' } }, limited.fetchImpl)))
      .resolves.toMatchObject({ kind: 'error', reason: 'rate-limited' })
    const offline = fakeFetch(() => { throw new TypeError('fetch failed') })
    await expect(fetchProviderQuota('codex', ctx({ oauthToken: { accessToken: 'at' } }, offline.fetchImpl)))
      .resolves.toMatchObject({ kind: 'error', reason: 'network' })
  })

  it('被动源:响应头一族 → 5h / 7d;不带这一族答 null', () => {
    const headers = new Headers({
      'x-codex-primary-used-percent': '40',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-used-percent': '12.5',
      'x-codex-secondary-window-minutes': '300',
      'x-codex-secondary-reset-at': '1770003600',
    })
    const quota = codexQuotaFromHeaders(headers, NOW)
    expect(quota).toMatchObject({ kind: 'windows', fetchedAt: NOW })
    if (quota?.kind !== 'windows') return
    expect(quota.windows).toEqual([
      { id: '5h', seconds: 18_000, usedPercent: 12.5, resetsAt: 1_770_003_600_000 },
      { id: '7d', seconds: 604_800, usedPercent: 40, resetsAt: NOW + 3_600_000 },
    ])
    expect(codexQuotaFromHeaders(new Headers({ 'content-type': 'text/event-stream' }), NOW)).toBeNull()
  })
})

describe('claude-code', () => {
  const payload = {
    five_hour: { utilization: 62, resets_at: '2026-09-26T06:30:00Z' },
    seven_day: { utilization: 31, resets_at: '2026-09-28T00:00:00Z' },
    seven_day_sonnet: { utilization: 44, resets_at: '2026-09-28T00:00:00Z' },
    seven_day_opus: null,
    extra_usage: { is_enabled: false },
  }

  it('三个头都带(少 UA 会进严限桶);五小时 / 本周 / 各型号周窗', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(payload))
    const quota = await fetchProviderQuota('claude-code', ctx({ oauthToken: { accessToken: 'at' } }, fetchImpl))
    expect(calls[0].url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(calls[0].headers).toMatchObject({
      Authorization: 'Bearer at',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/1.0',
    })
    if (quota.kind !== 'windows') throw new Error('expected windows')
    expect(quota.windows.map(window => [window.id, window.usedPercent, window.label ?? null])).toEqual([
      ['5h', 62, null],
      ['7d', 31, null],
      ['seven_day_sonnet', 44, 'Sonnet'],
    ])
    expect(quota.windows[0].resetsAt).toBe(Date.parse('2026-09-26T06:30:00Z'))
  })

  it('端点 origin 跟着 baseUrl(`/v1` 那一截不带进配额路径)', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(payload))
    await fetchProviderQuota('claude-code', ctx({ oauthToken: { accessToken: 'at' }, baseUrl: 'http://127.0.0.1:9/v1' }, fetchImpl))
    expect(calls[0].url).toBe('http://127.0.0.1:9/api/oauth/usage')
  })
})

describe('deepseek', () => {
  it('balance_infos 第一条,币种照给', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '123.45', granted_balance: '0.00', topped_up_balance: '123.45' },
      ],
    }))
    const quota = await fetchProviderQuota('deepseek', ctx({ apiKey: 'sk-ds' }, fetchImpl))
    expect(calls[0].url).toBe('https://api.deepseek.com/user/balance')
    expect(calls[0].headers.Authorization).toBe('Bearer sk-ds')
    expect(quota).toEqual({ kind: 'balance', currency: 'CNY', available: 123.45, fetchedAt: NOW })
  })

  it('USD 账号照给 USD', async () => {
    const { fetchImpl } = fakeFetch(() => json({ balance_infos: [{ currency: 'USD', total_balance: '4.10' }] }))
    await expect(fetchProviderQuota('deepseek', ctx({ apiKey: 'k' }, fetchImpl)))
      .resolves.toMatchObject({ kind: 'balance', currency: 'USD', available: 4.1 })
  })
})

describe('kimi', () => {
  it('国际站:data.available_balance → USD', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({
      code: 0,
      data: { available_balance: 49.58, voucher_balance: 46.58, cash_balance: 3 },
      status: true,
    }))
    const quota = await fetchProviderQuota('kimi', ctx({ apiKey: 'sk-kimi', config: { kimiRegion: 'intl' } }, fetchImpl))
    expect(calls[0].url).toBe('https://api.moonshot.ai/v1/users/me/balance')
    expect(quota).toEqual({ kind: 'balance', currency: 'USD', available: 49.58, fetchedAt: NOW })
  })

  it('国内站 / 编程套餐答 unsupported,一发请求都不起', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({}))
    await expect(fetchProviderQuota('kimi', ctx({ apiKey: 'k', config: { kimiRegion: 'cn' } }, fetchImpl)))
      .resolves.toEqual({ kind: 'unsupported' })
    await expect(fetchProviderQuota('kimi', ctx({ apiKey: 'k', config: { kimiApiMode: 'coding-plan', kimiRegion: 'intl' } }, fetchImpl)))
      .resolves.toEqual({ kind: 'unsupported' })
    expect(calls).toHaveLength(0)
  })

  it('手填的端点原样用(门的假站)', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ data: { available_balance: 1 } }))
    await fetchProviderQuota('kimi', ctx({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9/v1' }, fetchImpl))
    expect(calls[0].url).toBe('http://127.0.0.1:9/v1/users/me/balance')
  })
})

describe('openrouter', () => {
  it('/auth/key:limit − usage → USD', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ data: { label: 'k', usage: 5.88, limit: 10, is_free_tier: false } }))
    const quota = await fetchProviderQuota('openrouter', ctx({ apiKey: 'sk-or' }, fetchImpl))
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/auth/key')
    expect(quota).toMatchObject({ kind: 'balance', currency: 'USD', granted: 10 })
    if (quota.kind === 'balance') expect(quota.available).toBeCloseTo(4.12, 5)
  })

  it('limit 为 null(没设额度上限)答 unsupported —— 不编一个余额', async () => {
    const { fetchImpl } = fakeFetch(() => json({ data: { usage: 3, limit: null } }))
    await expect(fetchProviderQuota('openrouter', ctx({ apiKey: 'k' }, fetchImpl))).resolves.toEqual({ kind: 'unsupported' })
  })
})
