import { describe, expect, it, vi } from 'vitest'
import type { OnethingAuthProviderDefinition } from '../auth-types.js'
import {
  createOnethingAuthService,
  createOnethingAuthServiceOptions,
} from '../auth-service-factory.js'
import type { OnethingAuthTokenStore } from '../auth-service.js'

function createTokenStore(): OnethingAuthTokenStore {
  return {
    getToken: vi.fn(async () => null),
    saveToken: vi.fn(async () => ({ entryId: 'e' })),
    deleteToken: vi.fn(async () => {}),
    resolveEntryId: vi.fn(async () => undefined),
    listEntries: vi.fn(async () => []),
  }
}

describe('onething auth service factory', () => {
  it('uses runtime defaults for provider registry and callback server', () => {
    const tokenStore = createTokenStore()

    const options = createOnethingAuthServiceOptions({ tokenStore })

    expect(options.tokenStore).toBe(tokenStore)
    expect(options.getDefinition?.('codex')?.providerId).toBe('codex')
    expect(options.callbackServer).toBeDefined()
  })

  it('allows host adapters to override runtime defaults', () => {
    const tokenStore = createTokenStore()
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const definition: OnethingAuthProviderDefinition = {
      providerId: 'host-provider',
      name: 'Host Provider',
      flowKind: 'manual-pkce',
      oauthFlow: 'authorization-code',
      clientId: 'client',
      authorizationUrl: 'https://example.test/auth',
      tokenUrl: 'https://example.test/token',
      scopes: ['read'],
    }
    const getDefinition = vi.fn(() => definition)
    const callbackServer = {
      registerFlow: vi.fn(),
      unregisterState: vi.fn(),
      cleanup: vi.fn(),
    }

    const options = createOnethingAuthServiceOptions({
      tokenStore,
      fetch: fetchImpl,
      getDefinition,
      callbackServer,
    })

    expect(options.fetch).toBe(fetchImpl)
    expect(options.getDefinition?.('host-provider')).toBe(definition)
    expect(options.callbackServer).toBe(callbackServer)
  })

  // 2026-10-04(D24 断边 ③)起 auth 不再认识凭证池:令牌存放面必须由调用方给,缺省装上凭证池那一台的行为删了。
  // 「真的凭证池那一台长什么样」改由凭证功能自己的测试钉(`credentials/__tests__/credentials-token-store.test.ts`),
  // 装配把它交给进程那台登录服务这一步由 `process-auth-service` 的持有器承接。这里钉新的契约:给什么就用什么。
  it('tokenStore 由调用方给,原样装上(批 8:令牌只有池这一个家;池那一台由装配交进来)', () => {
    const tokenStore = createTokenStore()
    const options = createOnethingAuthServiceOptions({ tokenStore })
    expect(options.tokenStore).toBe(tokenStore)
  })

  it('creates a reusable runtime auth service instance', () => {
    const service = createOnethingAuthService({ tokenStore: createTokenStore() })

    expect(service.getDefinition('codex')?.providerId).toBe('codex')
  })
})
