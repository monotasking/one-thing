import { describe, expect, it, vi } from 'vitest'
import { OnethingAuthService } from '../auth-service.js'
import type {
  OnethingAuthProviderDefinition,
} from '../types.js'
import { MemoryPoolTokenStore as MemoryTokenStore } from './memory-pool-store.js'

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('onething runtime auth service', () => {
  it('falls back to api-key auth for providers without OAuth definitions', async () => {
    const service = new OnethingAuthService({
      tokenStore: new MemoryTokenStore(),
      getDefinition: () => undefined,
    })

    await expect(service.resolveProviderAuth('custom', 'key')).resolves.toEqual({
      kind: 'api-key',
      apiKey: 'key',
    })
    await expect(service.resolveProviderAuth('custom')).resolves.toBeNull()
  })

  it('runs manual PKCE code exchange through injected fetch and token storage', async () => {
    const tokenStore = new MemoryTokenStore(() => 1_000)
    const fetchImpl = vi.fn(async () => jsonResponse({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'read',
    }))
    const service = new OnethingAuthService({
      tokenStore,
      fetch: fetchImpl as typeof fetch,
      now: () => 1_000,
    })

    const started = await service.start('claude-code')
    expect(started).toMatchObject({
      success: true,
      flowKind: 'manual-pkce',
      requiresCodeEntry: true,
    })

    const completed = await service.completeManualCode(
      'claude-code',
      `manual-code#${started.state}`,
      started.state || '',
    )

    expect(completed).toEqual({ success: true })
    expect(fetchImpl).toHaveBeenCalledOnce()
    // 完成即出表:这条流的超时计时器跟着收掉。
    expect(service.pendingTimerCount()).toBe(0)
    expect(tokenStore.tokenOf('claude-code')).toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      tokenType: 'Bearer',
      scope: 'read',
    })
  })

  it('runs device flow polling without owning any IM or Electron host code', async () => {
    const definition: OnethingAuthProviderDefinition = {
      providerId: 'device-test',
      name: 'Device Test',
      flowKind: 'device-code',
      oauthFlow: 'device',
      clientId: 'client-id',
      tokenUrl: 'https://example.test/token',
      deviceCodeUrl: 'https://example.test/device',
      scopes: ['read'],
    }
    const tokenStore = new MemoryTokenStore(() => 1_000)
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        device_code: 'device-code',
        user_code: 'USER-CODE',
        verification_uri: 'https://example.test/verify',
        expires_in: 900,
        interval: 5,
      }))
      .mockResolvedValueOnce(jsonResponse({
        error: 'authorization_pending',
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'device-access',
        expires_in: 3600,
        token_type: 'Bearer',
      }))
    const service = new OnethingAuthService({
      tokenStore,
      fetch: fetchImpl as typeof fetch,
      getDefinition: providerId => providerId === definition.providerId ? definition : undefined,
      createId: () => `id-${fetchImpl.mock.calls.length}`,
      now: () => 1_000,
    })

    const started = await service.start('device-test')
    expect(started).toMatchObject({
      success: true,
      flowKind: 'device-code',
      userCode: 'USER-CODE',
      verificationUri: 'https://example.test/verify',
    })

    await expect(service.pollDeviceFlow('device-test', started.flowId)).resolves.toMatchObject({
      success: true,
      completed: false,
      pollStatus: 'authorization_pending',
    })
    await expect(service.pollDeviceFlow('device-test', started.flowId)).resolves.toEqual({
      success: true,
      completed: true,
    })
    expect(tokenStore.tokenOf('device-test')).toMatchObject({
      accessToken: 'device-access',
      tokenType: 'Bearer',
    })
    // 公开的 `pollDeviceFlow` 与服务自己的轮询走同一条收尾:完成即收掉两只计时器。
    expect(service.pendingTimerCount()).toBe(0)
  })
})
