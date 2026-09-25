import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OnethingAuthService,
  type OnethingAuthCallbackRegistration,
  type OnethingAuthCallbackServerAdapter,
  type OnethingAuthTokenStore,
} from '../auth-service.js'
import type {
  OnethingAuthFlowEvent,
  OnethingAuthProviderDefinition,
  OnethingOAuthToken,
} from '../types.js'

/**
 * 登录流的生命周期住在后端(批 1,`docs/design/provider-settings-rework-2026-09.md` §3.1)。
 *
 * 守五件事:
 *  ① `start` 之后服务**自己**按 interval 轮询设备码,`pending` 只发一次(轮询中间不发);
 *  ② 授权了 → `completed`,令牌落盘,计时器收干净;
 *  ③ `cancel(flowId)` → `cancelled`,之后 token 端点**一次都不再被打**;
 *  ④ 到 `expiresAt` → `expired`,同样不再打;
 *  ⑤ `dispose()` 之后零残留计时器(vitest 的假时钟数得到)。
 * 另有两条终局:token 端点说 `access_denied` = `failed`;回调流回调失败 = `failed`(不再是
 * 从前那句冒充「令牌过期」的 `token-expired`)。
 */

class MemoryTokenStore implements OnethingAuthTokenStore {
  readonly tokens = new Map<string, OnethingOAuthToken>()
  async getToken(providerId: string) { return this.tokens.get(providerId) ?? null }
  async saveToken(providerId: string, token: OnethingOAuthToken) { this.tokens.set(providerId, token) }
  async deleteToken(providerId: string) { this.tokens.delete(providerId) }
  isTokenExpired(token: OnethingOAuthToken) { return Date.now() >= token.expiresAt }
}

const DEVICE: OnethingAuthProviderDefinition = {
  providerId: 'dev',
  name: 'Device',
  flowKind: 'device-code',
  oauthFlow: 'device',
  clientId: 'c',
  tokenUrl: 'https://auth.test/token',
  deviceCodeUrl: 'https://auth.test/device',
  scopes: [],
}

const CALLBACK: OnethingAuthProviderDefinition = {
  providerId: 'cb',
  name: 'Callback',
  flowKind: 'pkce-callback',
  oauthFlow: 'authorization-code',
  clientId: 'c',
  authorizationUrl: 'https://auth.test/authorize',
  tokenUrl: 'https://auth.test/token',
  scopes: [],
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * 一台假 OAuth 站:设备码端点一次答完;token 端点按 `answers` 逐次答(用完就一直答最后一格)。
 * `tokenHits` 数 token 端点被打了几次 —— ③④ 的判据就是它不再涨。
 */
function fakeStation(answers: Array<Record<string, unknown>>, device: Record<string, unknown> = {}) {
  let tokenHits = 0
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const href = String(url)
    if (href === DEVICE.deviceCodeUrl) {
      return json({
        device_code: 'dc',
        user_code: 'UC-1',
        verification_uri: 'https://auth.test/verify',
        verification_uri_complete: 'https://auth.test/verify?user_code=UC-1',
        expires_in: 60,
        interval: 1,
        ...device,
      })
    }
    tokenHits += 1
    return json(answers[Math.min(tokenHits - 1, answers.length - 1)])
  })
  return { fetchImpl, hits: () => tokenHits }
}

function serviceWith(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof OnethingAuthService>[0]> = {}) {
  let n = 0
  const service = new OnethingAuthService({
    tokenStore: new MemoryTokenStore(),
    fetch: fetchImpl,
    getDefinition: id => [DEVICE, CALLBACK].find(d => d.providerId === id),
    createId: () => `id-${++n}`,
    logger: { warn: () => {} },
    ...extra,
  })
  const events: OnethingAuthFlowEvent[] = []
  service.on('flow', (event: OnethingAuthFlowEvent) => events.push(event))
  return { service, events }
}

/** 让计时器回调里那一串 await(fetch → json → 写盘)跑完。 */
async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('登录流的生命周期在 AuthService 里', () => {
  it('① + ② 服务自己轮询;pending 只发一次;授权后 completed、令牌落盘、计时器清零', async () => {
    const station = fakeStation([
      { error: 'authorization_pending' },
      { error: 'authorization_pending' },
      { access_token: 'at', expires_in: 3600, token_type: 'Bearer' },
    ])
    const { service, events } = serviceWith(station.fetchImpl as typeof fetch)
    const started = await service.start('dev')
    expect(started).toMatchObject({ success: true, flowKind: 'device-code', userCode: 'UC-1' })
    // RFC 8628 §3.3.1:有 complete 那一格就给它 —— 点开就是确认页。
    expect(started.verificationUri).toBe('https://auth.test/verify?user_code=UC-1')
    expect(events).toEqual([expect.objectContaining({ providerId: 'dev', flowId: started.flowId, phase: 'pending' })])
    expect(service.pendingTimerCount()).toBe(2)

    await tick(1000)
    await tick(1000)
    expect(station.hits()).toBe(2)
    // 轮询中间不发事件。
    expect(events.map(e => e.phase)).toEqual(['pending'])

    await tick(1000)
    expect(station.hits()).toBe(3)
    expect(events.map(e => e.phase)).toEqual(['pending', 'completed'])
    expect((await service.getStatus('dev')).isLoggedIn).toBe(true)
    expect(service.pendingTimerCount()).toBe(0)

    await tick(10_000)
    expect(station.hits()).toBe(3)
  })

  it('slow_down:间隔加 5 秒', async () => {
    const station = fakeStation([{ error: 'slow_down' }, { error: 'authorization_pending' }])
    const { service } = serviceWith(station.fetchImpl as typeof fetch)
    await service.start('dev')
    await tick(1000)
    expect(station.hits()).toBe(1)
    await tick(5000)
    expect(station.hits()).toBe(1)
    await tick(1000)
    expect(station.hits()).toBe(2)
    service.dispose()
  })

  it('③ cancel:发 cancelled,token 端点不再被打;再 cancel 一次答 false', async () => {
    const station = fakeStation([{ error: 'authorization_pending' }])
    const { service, events } = serviceWith(station.fetchImpl as typeof fetch)
    const started = await service.start('dev')
    await tick(1000)
    expect(station.hits()).toBe(1)

    expect(service.cancel(started.flowId!)).toBe(true)
    expect(events.map(e => e.phase)).toEqual(['pending', 'cancelled'])
    expect(service.pendingTimerCount()).toBe(0)
    await tick(30_000)
    expect(station.hits()).toBe(1)
    expect(service.cancel(started.flowId!)).toBe(false)
    expect(events.map(e => e.phase)).toEqual(['pending', 'cancelled'])
  })

  it('③′ 在飞的那一问回来时流已取消:答案不落盘', async () => {
    let release: (() => void) | undefined
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === DEVICE.deviceCodeUrl) {
        return json({ device_code: 'dc', user_code: 'U', verification_uri: 'https://v', expires_in: 60, interval: 1 })
      }
      await new Promise<void>(resolve => { release = resolve })
      return json({ access_token: 'late', expires_in: 3600, token_type: 'Bearer' })
    })
    const { service, events } = serviceWith(fetchImpl as typeof fetch)
    const started = await service.start('dev')
    await tick(1000)
    service.cancel(started.flowId!)
    release?.()
    await tick(0)
    expect((await service.getStatus('dev')).isLoggedIn).toBe(false)
    expect(events.map(e => e.phase)).toEqual(['pending', 'cancelled'])
  })

  it('④ 到 expiresAt:发 expired,之后不再打 token 端点', async () => {
    const station = fakeStation([{ error: 'authorization_pending' }], { expires_in: 3, interval: 1 })
    const { service, events } = serviceWith(station.fetchImpl as typeof fetch)
    await service.start('dev')
    await tick(3000)
    expect(events.map(e => e.phase)).toEqual(['pending', 'expired'])
    const hits = station.hits()
    await tick(30_000)
    expect(station.hits()).toBe(hits)
    expect(service.pendingTimerCount()).toBe(0)
  })

  it('token 端点说 access_denied:failed 带原话,轮询停', async () => {
    const station = fakeStation([{ error: 'access_denied' }])
    const { service, events } = serviceWith(station.fetchImpl as typeof fetch)
    await service.start('dev')
    await tick(1000)
    expect(events.at(-1)).toMatchObject({ phase: 'failed', error: 'access_denied' })
    await tick(10_000)
    expect(station.hits()).toBe(1)
    expect(service.pendingTimerCount()).toBe(0)
  })

  it('网络抖一下不判死:下一拍接着问', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === DEVICE.deviceCodeUrl) {
        return json({ device_code: 'dc', user_code: 'U', verification_uri: 'https://v', expires_in: 60, interval: 1 })
      }
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return json({ access_token: 'at', expires_in: 3600, token_type: 'Bearer' })
    })
    const { service, events } = serviceWith(fetchImpl as typeof fetch)
    await service.start('dev')
    await tick(1000)
    expect(events.map(e => e.phase)).toEqual(['pending'])
    await tick(1000)
    expect(events.map(e => e.phase)).toEqual(['pending', 'completed'])
  })

  it('重开一次登录:上一条收到 cancelled,新的一条 pending', async () => {
    const station = fakeStation([{ error: 'authorization_pending' }])
    const { service, events } = serviceWith(station.fetchImpl as typeof fetch)
    const first = await service.start('dev')
    const second = await service.start('dev')
    expect(events.map(e => [e.flowId, e.phase])).toEqual([
      [first.flowId, 'pending'],
      [first.flowId, 'cancelled'],
      [second.flowId, 'pending'],
    ])
    expect(service.pendingTimerCount()).toBe(2)
    service.dispose()
  })

  it('⑤ dispose:零残留计时器、不发事件;服务之后仍可再起流', async () => {
    const station = fakeStation([{ error: 'authorization_pending' }])
    const { service, events } = serviceWith(station.fetchImpl as typeof fetch)
    await service.start('dev')
    await service.start('cb').catch(() => undefined) // 没有回调服务的宿主:起不来,不留东西
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    expect(service.dispose()).toBe(1)
    expect(service.pendingTimerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(events.map(e => e.phase)).toEqual(['pending'])
    await tick(60_000)
    expect(station.hits()).toBe(0)

    await service.start('dev')
    expect(service.pendingTimerCount()).toBe(2)
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('回调流:回调失败 = failed(不再冒充 token-expired);成功 = completed', async () => {
    let registration: OnethingAuthCallbackRegistration | undefined
    const callbackServer: OnethingAuthCallbackServerAdapter = {
      async registerFlow(options) {
        registration = options
        return { redirectUri: 'http://localhost:1455/cb', port: 1455 }
      },
      unregisterState: vi.fn(),
      cleanup: vi.fn(),
    }
    const tokenAnswers = [json({ error: 'invalid_grant' }, 400), json({ access_token: 'at', expires_in: 3600, token_type: 'Bearer' })]
    const fetchImpl = vi.fn(async () => tokenAnswers.shift()!)
    const { service, events } = serviceWith(fetchImpl as unknown as typeof fetch, { callbackServer })
    const expired = vi.fn()
    service.on('token-expired', expired)

    const first = await service.start('cb')
    expect(first.authUrl).toContain('https://auth.test/authorize?')
    await registration!.onCallback({ code: 'x', state: first.state!, flowId: first.flowId!, providerId: 'cb' })
    expect(events.at(-1)).toMatchObject({ flowId: first.flowId, phase: 'failed' })
    expect(expired).not.toHaveBeenCalled()
    expect(service.pendingTimerCount()).toBe(0)

    const second = await service.start('cb')
    await registration!.onCallback({ code: 'y', state: second.state!, flowId: second.flowId!, providerId: 'cb' })
    expect(events.at(-1)).toMatchObject({ flowId: second.flowId, phase: 'completed' })
    expect(service.pendingTimerCount()).toBe(0)
  })
})
