/**
 * per-space OAuth(批 B6)—— 写回目标参数化 + 刷新单飞锁。
 *
 * 三件事在这里钉死:
 *  1. **默认空间的路径一个字节都不变**(缺省参数 = settings 源)。这是回归测试:
 *     整个切片的做法是「给现有流程加一个落点参数」,不是「复制一条 per-space 流程」。
 *  2. 带 space 目标时,token 落进那个空间的池;`entryId` 缺席 = 追加新 entry(多账号)。
 *  3. 并发刷新只飞一次,且**按 (provider, 目标) 分锁** —— 合成一把锁会让 A 空间的
 *     调用拿到 B 空间的 token(盲点 5)。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  OnethingAuthService,
  type OnethingAuthTokenStore,
} from '../auth-service.js'
import {
  credentialRefreshKey,
  credentialTargetFromSpaceMarker,
  credentialTargetKey,
  normalizeCredentialTarget,
  SETTINGS_CREDENTIAL_TARGET,
} from '../credential-target.js'
import { parseSpaceOAuthToken, type OnethingSpaceAuthTokenStore } from '../space-token-store.js'
import type {
  OnethingAuthProviderDefinition,
  OnethingOAuthToken,
} from '../types.js'

class MemoryTokenStore implements OnethingAuthTokenStore {
  readonly tokens = new Map<string, OnethingOAuthToken>()

  constructor(private readonly now = () => Date.now()) {}

  async getToken(providerId: string): Promise<OnethingOAuthToken | null> {
    return this.tokens.get(providerId) ?? null
  }

  async saveToken(providerId: string, token: OnethingOAuthToken): Promise<void> {
    this.tokens.set(providerId, token)
  }

  async deleteToken(providerId: string): Promise<void> {
    this.tokens.delete(providerId)
  }

  isTokenExpired(token: OnethingOAuthToken): boolean {
    return this.now() >= token.expiresAt
  }
}

/** 池的最小替身:`<spaceId>|<providerId>` → entries。追加/覆盖语义与真实池一致。 */
class MemorySpaceTokenStore implements OnethingSpaceAuthTokenStore {
  readonly pools = new Map<string, Array<{ id: string; token: OnethingOAuthToken; label?: string }>>()
  private seq = 0

  private key(spaceId: string, providerId: string): string {
    return `${spaceId}|${providerId}`
  }

  async getToken(
    providerId: string,
    target: { spaceId: string; entryId?: string },
  ): Promise<OnethingOAuthToken | null> {
    const entries = this.pools.get(this.key(target.spaceId, providerId)) ?? []
    const entry = target.entryId ? entries.find(item => item.id === target.entryId) : undefined
    return entry?.token ?? null
  }

  async saveToken(
    providerId: string,
    token: OnethingOAuthToken,
    target: { spaceId: string; entryId?: string; label?: string },
  ): Promise<{ entryId: string }> {
    const key = this.key(target.spaceId, providerId)
    const entries = this.pools.get(key) ?? []
    const existing = target.entryId ? entries.find(item => item.id === target.entryId) : undefined
    if (existing) {
      existing.token = token
      this.pools.set(key, entries)
      return { entryId: existing.id }
    }
    const entryId = `entry-${++this.seq}`
    entries.push({ id: entryId, token, label: target.label })
    this.pools.set(key, entries)
    return { entryId }
  }

  async deleteToken(
    providerId: string,
    target: { spaceId: string; entryId?: string },
  ): Promise<void> {
    const key = this.key(target.spaceId, providerId)
    const entries = this.pools.get(key) ?? []
    this.pools.set(key, entries.filter(item => item.id !== target.entryId))
  }
}

const DEFINITION: OnethingAuthProviderDefinition = {
  providerId: 'codex',
  name: 'Codex',
  flowKind: 'manual-pkce',
  oauthFlow: 'authorization-code',
  clientId: 'client',
  authorizationUrl: 'https://auth.test/authorize',
  tokenUrl: 'https://auth.test/token',
  refreshUrl: 'https://auth.test/refresh',
  scopes: ['openid'],
}

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function token(over: Partial<OnethingOAuthToken> = {}): OnethingOAuthToken {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 10_000,
    tokenType: 'Bearer',
    ...over,
  }
}

function makeService(options: {
  fetchImpl?: typeof fetch
  now?: () => number
} = {}) {
  const tokenStore = new MemoryTokenStore(options.now)
  const spaceTokenStore = new MemorySpaceTokenStore()
  const service = new OnethingAuthService({
    tokenStore,
    spaceTokenStore,
    getDefinition: () => DEFINITION,
    fetch: options.fetchImpl ?? (async () => jsonResponse({})),
    createId: (() => {
      let n = 0
      return () => `id-${++n}`
    })(),
    now: options.now ?? (() => 0),
  })
  return { service, tokenStore, spaceTokenStore }
}

describe('写回目标(credential target)', () => {
  it('归一:缺席 / 非法 id / 默认空间一律落回 settings', () => {
    expect(normalizeCredentialTarget(undefined)).toEqual(SETTINGS_CREDENTIAL_TARGET)
    expect(normalizeCredentialTarget({ spaceId: '../etc' })).toEqual(SETTINGS_CREDENTIAL_TARGET)
    expect(normalizeCredentialTarget({ spaceId: 'default' })).toEqual(SETTINGS_CREDENTIAL_TARGET)
    expect(normalizeCredentialTarget({ spaceId: 'work', entryId: 'e1' }))
      .toEqual({ kind: 'space', spaceId: 'work', entryId: 'e1' })
  })

  it('锁名:同一空间的两条 entry 不共用一把锁,两个空间也不共用', () => {
    expect(credentialTargetKey(undefined)).toBe('settings')
    const a = credentialRefreshKey('codex', normalizeCredentialTarget({ spaceId: 'work', entryId: 'a' }))
    const b = credentialRefreshKey('codex', normalizeCredentialTarget({ spaceId: 'work', entryId: 'b' }))
    const other = credentialRefreshKey('codex', normalizeCredentialTarget({ spaceId: 'home', entryId: 'a' }))
    expect(new Set([a, b, other]).size).toBe(3)
    expect(credentialRefreshKey('codex', SETTINGS_CREDENTIAL_TARGET)).toBe('codex::settings')
  })

  it('B3 的运行期标记换成目标:没有 spaceId 就是 settings', () => {
    expect(credentialTargetFromSpaceMarker(undefined)).toEqual(SETTINGS_CREDENTIAL_TARGET)
    expect(credentialTargetFromSpaceMarker({ spaceId: 'default', entryId: 'x' }))
      .toEqual(SETTINGS_CREDENTIAL_TARGET)
    expect(credentialTargetFromSpaceMarker({ spaceId: 'work', entryId: 'x' }))
      .toEqual({ kind: 'space', spaceId: 'work', entryId: 'x' })
  })
})

describe('默认空间回归:缺省参数 = 今天的行为', () => {
  it('登录写进 settings 源的 token store,池一条都不动', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
    }))
    const { service, tokenStore, spaceTokenStore } = makeService({ fetchImpl })

    const started = await service.start('codex')
    await expect(service.completeManualCode('codex', 'code', started.state ?? ''))
      .resolves.toEqual({ success: true })

    expect(tokenStore.tokens.get('codex')?.accessToken).toBe('access')
    expect(spaceTokenStore.pools.size).toBe(0)
  })

  it('刷新读写的还是 settings 源', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      access_token: 'refreshed',
      expires_in: 3600,
    }))
    const { service, tokenStore, spaceTokenStore } = makeService({ fetchImpl })
    await tokenStore.saveToken('codex', token())

    await expect(service.refreshToken('codex')).resolves.toMatchObject({ accessToken: 'refreshed' })
    expect(tokenStore.tokens.get('codex')?.accessToken).toBe('refreshed')
    expect(spaceTokenStore.pools.size).toBe(0)
  })

  it('宿主没装 spaceTokenStore 时,space 目标降级为 settings(而不是半路抛错)', async () => {
    const tokenStore = new MemoryTokenStore(() => 0)
    const service = new OnethingAuthService({
      tokenStore,
      getDefinition: () => DEFINITION,
      fetch: async () => jsonResponse({ access_token: 'refreshed', expires_in: 3600 }),
      now: () => 0,
    })
    await tokenStore.saveToken('codex', token())

    await expect(service.refreshToken('codex', { kind: 'space', spaceId: 'work', entryId: 'e' }))
      .resolves.toMatchObject({ accessToken: 'refreshed' })
    expect(tokenStore.tokens.get('codex')?.accessToken).toBe('refreshed')
  })
})

describe('非 default 空间:token 落进本空间的池', () => {
  it('entryId 缺席 = 追加一条新 entry(同一 provider 可以多账号)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
    }))
    const { service, tokenStore, spaceTokenStore } = makeService({ fetchImpl })
    const target = { kind: 'space', spaceId: 'work' } as const

    const first = await service.start('codex', target)
    await expect(service.completeManualCode('codex', 'code-1', first.state ?? '', target))
      .resolves.toEqual({ success: true })
    const second = await service.start('codex', target)
    await expect(service.completeManualCode('codex', 'code-2', second.state ?? '', target))
      .resolves.toEqual({ success: true })

    expect(spaceTokenStore.pools.get('work|codex')?.map(entry => entry.id))
      .toEqual(['entry-1', 'entry-2'])
    // 默认空间那一份一个字节都没被碰过。
    expect(tokenStore.tokens.size).toBe(0)
  })

  it('登出只删那一条 entry,同 provider 的另一个账号还在', async () => {
    const { service, spaceTokenStore } = makeService()
    await service.saveToken('codex', token(), { kind: 'space', spaceId: 'work' })
    await service.saveToken('codex', token({ accessToken: 'at2' }), { kind: 'space', spaceId: 'work' })

    await service.deleteToken('codex', { kind: 'space', spaceId: 'work', entryId: 'entry-1' })
    expect(spaceTokenStore.pools.get('work|codex')?.map(entry => entry.id)).toEqual(['entry-2'])
  })

  it('两个空间各登各的:同一个 provider 的状态互不干扰', async () => {
    const { service } = makeService()
    await service.saveToken('codex', token({ accessToken: 'work-at' }), { kind: 'space', spaceId: 'work' })
    await service.saveToken('codex', token({ accessToken: 'home-at' }), { kind: 'space', spaceId: 'home' })

    await expect(service.getToken('codex', { kind: 'space', spaceId: 'work', entryId: 'entry-1' }))
      .resolves.toMatchObject({ accessToken: 'work-at' })
    await expect(service.getToken('codex', { kind: 'space', spaceId: 'home', entryId: 'entry-2' }))
      .resolves.toMatchObject({ accessToken: 'home-at' })
    await expect(service.getToken('codex')).resolves.toBeNull()
  })

  it('登录流按目标分家:一个空间的手输码不会认领另一个空间的流', async () => {
    const { service } = makeService({
      fetchImpl: vi.fn(async () => jsonResponse({ access_token: 'a', expires_in: 3600 })),
    })
    const started = await service.start('codex', { kind: 'space', spaceId: 'work' })

    // home 空间没有起过流,拿 work 的 state 去完成必须失败(找不到流)。
    await expect(
      service.completeManualCode('codex', 'code', started.state ?? '', { kind: 'space', spaceId: 'home' }),
    ).resolves.toMatchObject({ success: false })
  })
})

describe('刷新单飞锁(盲点 5)', () => {
  it('并发刷新同一条 entry 只真的飞一次,大家拿到同一个 token', async () => {
    // 用一个手动 gate 把第一次 fetch 悬在半空:两次调用必须都落在同一个飞行中的
    // promise 上,否则「单飞」就只是碰巧串行而已。
    let openGate: (() => void) | undefined
    const gate = new Promise<void>(resolve => { openGate = resolve })
    const fetchImpl = vi.fn(async () => {
      await gate
      return jsonResponse({ access_token: 'refreshed', expires_in: 3600 })
    })
    const { service, spaceTokenStore } = makeService({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await service.saveToken('codex', token(), { kind: 'space', spaceId: 'work' })
    const target = { kind: 'space', spaceId: 'work', entryId: 'entry-1' } as const

    const first = service.refreshToken('codex', target)
    const second = service.refreshToken('codex', target)
    openGate?.()
    const [a, b] = await Promise.all([first, second])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    // 写回的是**那一条** entry,没有新增。
    const entries = spaceTokenStore.pools.get('work|codex') ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0].token.accessToken).toBe('refreshed')
  })

  it('两个空间的刷新各飞各的 —— 合成一把锁会让 A 拿到 B 的 token', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      return jsonResponse({ access_token: body.includes('rt-work') ? 'work-new' : 'home-new', expires_in: 3600 })
    })
    const { service, spaceTokenStore } = makeService({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await service.saveToken('codex', token({ refreshToken: 'rt-work' }), { kind: 'space', spaceId: 'work' })
    await service.saveToken('codex', token({ refreshToken: 'rt-home' }), { kind: 'space', spaceId: 'home' })

    const [work, home] = await Promise.all([
      service.refreshToken('codex', { kind: 'space', spaceId: 'work', entryId: 'entry-1' }),
      service.refreshToken('codex', { kind: 'space', spaceId: 'home', entryId: 'entry-2' }),
    ])

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(work.accessToken).toBe('work-new')
    expect(home.accessToken).toBe('home-new')
    expect(spaceTokenStore.pools.get('work|codex')?.[0].token.accessToken).toBe('work-new')
    expect(spaceTokenStore.pools.get('home|codex')?.[0].token.accessToken).toBe('home-new')
  })

  it('刷新失败之后锁要放开,下一次还能再飞', async () => {
    let attempt = 0
    const fetchImpl = vi.fn(async () => {
      attempt += 1
      return attempt === 1
        ? new Response('nope', { status: 400 })
        : jsonResponse({ access_token: 'ok', expires_in: 3600 })
    })
    const { service } = makeService({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await service.saveToken('codex', token(), { kind: 'space', spaceId: 'work' })
    const target = { kind: 'space', spaceId: 'work', entryId: 'entry-1' } as const

    await expect(service.refreshToken('codex', target)).rejects.toThrow('Token refresh failed: 400')
    await expect(service.refreshToken('codex', target)).resolves.toMatchObject({ accessToken: 'ok' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('refreshTokenIfNeeded 走的是同一把锁(绕过去就等于没有锁)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'refreshed', expires_in: 3600 }))
    const { service } = makeService({ fetchImpl, now: () => 9_999 })
    await service.saveToken('codex', token({ expiresAt: 10_000 }), { kind: 'space', spaceId: 'work' })
    const target = { kind: 'space', spaceId: 'work', entryId: 'entry-1' } as const

    const [a, b] = await Promise.all([
      service.refreshTokenIfNeeded('codex', target),
      service.refreshTokenIfNeeded('codex', target),
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(a.accessToken).toBe('refreshed')
    expect(b.accessToken).toBe('refreshed')
  })

  it('刷新被拒时错误带着状态码 —— 分类器要靠它判 auth-invalid', async () => {
    const { service } = makeService({
      fetchImpl: (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch,
    })
    await service.saveToken('codex', token(), { kind: 'space', spaceId: 'work' })

    await expect(
      service.refreshToken('codex', { kind: 'space', spaceId: 'work', entryId: 'entry-1' }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('池里 token 的形状检查', () => {
  it('半个 token 当没登录(与 settings 源的 parseToken 同一口径)', () => {
    expect(parseSpaceOAuthToken(undefined)).toBeNull()
    expect(parseSpaceOAuthToken({ accessToken: 'a' })).toBeNull()
    expect(parseSpaceOAuthToken({ expiresAt: 1 })).toBeNull()
    expect(parseSpaceOAuthToken({ accessToken: 'a', expiresAt: 1 }))
      .toEqual({ accessToken: 'a', expiresAt: 1, tokenType: 'Bearer' })
  })
})
