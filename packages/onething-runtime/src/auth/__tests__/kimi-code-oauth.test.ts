/**
 * Kimi Code(编程套餐)的 OAuth 登录 —— Device Authorization Grant。
 *
 * 这组测试钉的是**线上真的收什么**,不是我们希望它收什么。三条参数都是对着
 * `auth.kimi.com` 实测过的(device_authorization 是未授权端点,发一次只会生成一个
 * 没人批准的待授权码):
 *
 *  1. 不带 scope —— 官方实现只发 client_id;
 *  2. 不带 `X-Msh-*` —— 官方 CLI 会带一组(platform=`kimi_cli`),实测不带同样 200。
 *     它们是**客户端身份**,而 Kimi 的条款写明篡改客户端标识可能暂停会员权益 ——
 *     "发得通"不是"可以发"的理由,所以一个都不发;
 *  3. 用 `verification_uri_complete` —— 那个 URL 里已经带上了 user_code,点开即确认,
 *     不用手抄八位码。
 */
import { describe, expect, it, vi } from 'vitest'
import { OnethingAuthService } from '../auth-service.js'
import { getAuthProviderDefinition, resolveKimiOAuthHost } from '../registry.js'
import type { OnethingOAuthToken } from '../types.js'
import { MemoryPoolTokenStore as MemoryTokenStore } from './memory-pool-store.js'

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const KIMI_CODE = 'kimi-code'

describe('Kimi Code OAuth 定义', () => {
  it('端点、client、流程档都是厂商公开的那一套', () => {
    const definition = getAuthProviderDefinition(KIMI_CODE)
    expect(definition).toBeDefined()
    expect(definition?.flowKind).toBe('device-code')
    expect(definition?.oauthFlow).toBe('device')
    expect(definition?.clientId).toBe('17e5f671-d194-4dfb-9706-5516cb48c098')
    expect(definition?.deviceCodeUrl).toBe('https://auth.kimi.com/api/oauth/device_authorization')
    expect(definition?.tokenUrl).toBe('https://auth.kimi.com/api/oauth/token')
    // scope 一个都不要 —— 服务端不收,发空串是在问「给我零个权限」。
    expect(definition?.scopes).toEqual([])
    // 两个端点都吃 form,不是 json。
    expect(definition?.tokenBodyFormat).toBe('form')
    expect(definition?.refreshBodyFormat).toBe('form')
  })

  it('host 跟随官方 CLI 的两个环境变量(自建/灰度环境靠它切)', () => {
    expect(resolveKimiOAuthHost({})).toBe('https://auth.kimi.com')
    expect(resolveKimiOAuthHost({ KIMI_OAUTH_HOST: 'https://auth.example.test/' }))
      .toBe('https://auth.example.test')
    // 专用的那个优先级更高。
    expect(resolveKimiOAuthHost({
      KIMI_CODE_OAUTH_HOST: 'https://a.test',
      KIMI_OAUTH_HOST: 'https://b.test',
    })).toBe('https://a.test')
  })
})

describe('Kimi Code 登录流程', () => {
  function makeService(fetchImpl: ReturnType<typeof vi.fn>) {
    return new OnethingAuthService({
      tokenStore: new MemoryTokenStore(),
      fetch: fetchImpl as unknown as typeof fetch,
      getDefinition: providerId =>
        providerId === KIMI_CODE ? getAuthProviderDefinition(KIMI_CODE) : undefined,
      now: () => 1_000,
    })
  }

  it('起流程:只发 client_id,不发 scope,不发任何客户端身份头', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({
      device_code: 'dev-code',
      user_code: 'KFMV-PQUJ',
      verification_uri: 'https://www.kimi.com/code/authorize_device',
      verification_uri_complete: 'https://www.kimi.com/code/authorize_device?user_code=KFMV-PQUJ',
      expires_in: 1800,
      interval: 5,
    }))

    const started = await makeService(fetchImpl).start(KIMI_CODE)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://auth.kimi.com/api/oauth/device_authorization')
    const body = new URLSearchParams(String(init.body))
    expect(body.get('client_id')).toBe('17e5f671-d194-4dfb-9706-5516cb48c098')
    expect(body.has('scope')).toBe(false)
    const headerNames = Object.keys(init.headers ?? {}).map(name => name.toLowerCase())
    expect(headerNames.filter(name => name.startsWith('x-msh-'))).toEqual([])

    // 交给用户的是**带码的**那个链接:点开就是确认页。
    expect(started).toMatchObject({
      success: true,
      flowKind: 'device-code',
      userCode: 'KFMV-PQUJ',
      verificationUri: 'https://www.kimi.com/code/authorize_device?user_code=KFMV-PQUJ',
      interval: 5,
    })
  })

  it('没有 complete 链接时退回普通 verification_uri,而不是留空', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({
      device_code: 'dev-code',
      user_code: 'AAAA-BBBB',
      verification_uri: 'https://www.kimi.com/code/authorize_device',
      expires_in: 1800,
      interval: 5,
    }))
    const started = await makeService(fetchImpl).start(KIMI_CODE)
    expect(started.verificationUri).toBe('https://www.kimi.com/code/authorize_device')
  })

  it('轮询到批准为止,换来的 access_token 就是打 API 的那把钥匙', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        device_code: 'dev-code',
        user_code: 'KFMV-PQUJ',
        verification_uri_complete: 'https://www.kimi.com/code/authorize_device?user_code=KFMV-PQUJ',
        expires_in: 1800,
        interval: 5,
      }))
      .mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'kimi-access',
        refresh_token: 'kimi-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      }))

    const service = makeService(fetchImpl)
    const started = await service.start(KIMI_CODE)

    await expect(service.pollDeviceFlow(KIMI_CODE, started.flowId)).resolves.toMatchObject({
      success: true,
      completed: false,
      pollStatus: 'authorization_pending',
    })
    await expect(service.pollDeviceFlow(KIMI_CODE, started.flowId)).resolves.toEqual({
      success: true,
      completed: true,
    })

    const [pollUrl, pollInit] = fetchImpl.mock.calls[1]!
    expect(pollUrl).toBe('https://auth.kimi.com/api/oauth/token')
    const pollBody = new URLSearchParams(String(pollInit.body))
    expect(pollBody.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(pollBody.get('device_code')).toBe('dev-code')

    await expect(service.getToken(KIMI_CODE)).resolves.toMatchObject({
      accessToken: 'kimi-access',
      refreshToken: 'kimi-refresh',
    })
  })

  it('续期走 refresh_token,body 仍然是 form(json 会被拒)', async () => {
    const tokenStore = new MemoryTokenStore()
    tokenStore.seed(KIMI_CODE, {
      accessToken: 'old',
      refreshToken: 'kimi-refresh',
      expiresAt: 0,
      tokenType: 'Bearer',
    } as OnethingOAuthToken)

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      access_token: 'fresh',
      refresh_token: 'kimi-refresh-2',
      expires_in: 3600,
      token_type: 'Bearer',
    }))
    const service = new OnethingAuthService({
      tokenStore,
      fetch: fetchImpl as unknown as typeof fetch,
      getDefinition: () => getAuthProviderDefinition(KIMI_CODE),
    })

    await service.refreshToken(KIMI_CODE)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://auth.kimi.com/api/oauth/token')
    expect(String((init.headers as Record<string, string>)['Content-Type']))
      .toContain('application/x-www-form-urlencoded')
    const body = new URLSearchParams(String(init.body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('kimi-refresh')
    expect(body.get('client_id')).toBe('17e5f671-d194-4dfb-9706-5516cb48c098')
    expect(tokenStore.tokenOf(KIMI_CODE)).toMatchObject({ accessToken: 'fresh' })
    // 刷新原地换那一条,不追加。
    expect(tokenStore.entries(KIMI_CODE)).toHaveLength(1)
  })
})
