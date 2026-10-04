/**
 * per-space OAuth(批 B6)+ 单槽退役(批 8,`docs/design/subscription-accounts-2026-09.md` §8)。
 *
 * 钉死的事:
 *  1. **目标只有空间池一种**:缺席 / 非法 / 默认 spaceId 一律是默认空间那一池 —— 默认空间
 *     不再有自己的单槽,第二次登录**追加**而不是盖掉第一次(09-26 报障)。
 *  2. 同一身份再登一次 = 更新那一条(Codex 看 accountId,其它家看 email;取不到不去重)。
 *  3. 不指名的读 / 刷新 / 退出落到「第一个可用账号」,刷新**原地换**那一条,不凭空多一个账号。
 *  4. `status` 带 `accounts[]`,每条各报各的过期;带 `entryId` 答那一条。
 *  5. 并发刷新只飞一次,且**按 (provider, 目标) 分锁** —— 合成一把锁会让 A 空间的
 *     调用拿到 B 空间的 token(盲点 5)。
 */

import { describe, expect, it, vi } from 'vitest'
import { OnethingAuthService } from '../auth-service.js'
import {
  credentialRefreshKey,
  credentialTargetFromSpaceMarker,
  credentialTargetKey,
  DEFAULT_CREDENTIAL_TARGET,
  normalizeCredentialTarget,
} from '../auth-credential-target.js'
import { oauthTokenIdentity, parseSpaceOAuthToken, pickDefaultOAuthEntryId } from '../../credentials/credentials-token-store.js'
import type {
  OnethingAuthProviderDefinition,
  OnethingOAuthToken,
} from '../auth-types.js'
import { MemoryPoolTokenStore } from './memory-pool-store.js'

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
  const spaceTokenStore = new MemoryPoolTokenStore(options.now ?? (() => 0))
  const service = new OnethingAuthService({
    tokenStore: spaceTokenStore,
    getDefinition: () => DEFINITION,
    fetch: options.fetchImpl ?? (async () => jsonResponse({})),
    createId: (() => {
      let n = 0
      return () => `id-${++n}`
    })(),
    now: options.now ?? (() => 0),
  })
  return { service, spaceTokenStore }
}

describe('写回目标(credential target)', () => {
  it('归一:缺席 / 非法 id / 默认空间一律是默认空间那一池(批 8:没有 settings 单槽了)', () => {
    expect(normalizeCredentialTarget(undefined)).toEqual(DEFAULT_CREDENTIAL_TARGET)
    expect(normalizeCredentialTarget({ spaceId: '../etc' })).toEqual({ kind: 'space', spaceId: 'default' })
    expect(normalizeCredentialTarget({ spaceId: 'default' })).toEqual({ kind: 'space', spaceId: 'default' })
    // spaceId 缺席而指名了条目(老调用方的退出)= 默认空间的那一条。
    expect(normalizeCredentialTarget({ entryId: 'e1' })).toEqual({ kind: 'space', spaceId: 'default', entryId: 'e1' })
    expect(normalizeCredentialTarget({ spaceId: 'work', entryId: 'e1' }))
      .toEqual({ kind: 'space', spaceId: 'work', entryId: 'e1' })
  })

  it('锁名:同一空间的两条 entry 不共用一把锁,两个空间也不共用', () => {
    expect(credentialTargetKey(undefined)).toBe('space:default:*')
    const a = credentialRefreshKey('codex', normalizeCredentialTarget({ spaceId: 'work', entryId: 'a' }))
    const b = credentialRefreshKey('codex', normalizeCredentialTarget({ spaceId: 'work', entryId: 'b' }))
    const other = credentialRefreshKey('codex', normalizeCredentialTarget({ spaceId: 'home', entryId: 'a' }))
    const defaultA = credentialRefreshKey('codex', normalizeCredentialTarget({ entryId: 'a' }))
    expect(new Set([a, b, other, defaultA]).size).toBe(4)
  })

  it('B3 的运行期标记换成目标:默认空间的标记也指向池里那一条', () => {
    expect(credentialTargetFromSpaceMarker(undefined)).toEqual(DEFAULT_CREDENTIAL_TARGET)
    expect(credentialTargetFromSpaceMarker({ spaceId: 'default', entryId: 'x' }))
      .toEqual({ kind: 'space', spaceId: 'default', entryId: 'x' })
    expect(credentialTargetFromSpaceMarker({ spaceId: 'work', entryId: 'x' }))
      .toEqual({ kind: 'space', spaceId: 'work', entryId: 'x' })
  })
})

describe('默认空间不再是特例(批 8)', () => {
  it('不带 spaceId 登两次 = 默认空间池里两条,第二次不盖第一次(09-26 报障)', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => {
      n += 1
      return jsonResponse({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600 })
    })
    const { service, spaceTokenStore } = makeService({ fetchImpl })

    const first = await service.start('codex')
    await expect(service.completeManualCode('codex', 'code', first.state ?? '')).resolves.toEqual({ success: true })
    const second = await service.start('codex')
    await expect(service.completeManualCode('codex', 'code', second.state ?? '')).resolves.toEqual({ success: true })

    expect(spaceTokenStore.entries('codex').map(entry => entry.token.accessToken)).toEqual(['access-1', 'access-2'])
  })

  it('不指名的刷新落到第一个账号,原地换令牌 —— 不会凭空多出一个账号', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'refreshed', expires_in: 3600 }))
    const { service, spaceTokenStore } = makeService({ fetchImpl })
    spaceTokenStore.seed('codex', token({ accessToken: 'one', refreshToken: 'rt-1' }))
    spaceTokenStore.seed('codex', token({ accessToken: 'two', refreshToken: 'rt-2' }))

    await expect(service.refreshToken('codex')).resolves.toMatchObject({ accessToken: 'refreshed' })
    expect(spaceTokenStore.entries('codex').map(entry => entry.token.accessToken)).toEqual(['refreshed', 'two'])
    expect(String((fetchImpl.mock.calls[0] as unknown[])[1] && ((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body)).toContain('rt-1')
  })

  it('池里一个账号都没有:读答 null,刷新报「没有可刷新的令牌」(不回落任何别处)', async () => {
    const { service } = makeService()
    await expect(service.getToken('codex')).resolves.toBeNull()
    await expect(service.refreshToken('codex')).rejects.toThrow('No refresh token available')
    await expect(service.refreshTokenIfNeeded('codex')).rejects.toThrow('Not logged in')
  })

  it('不指名的读跳过冷却中的账号', async () => {
    const { service, spaceTokenStore } = makeService({ now: () => 1_000 })
    spaceTokenStore.seed('codex', token({ accessToken: 'cooling' }), 'default', { cooldownUntil: 5_000 })
    spaceTokenStore.seed('codex', token({ accessToken: 'warm' }))
    await expect(service.getToken('codex')).resolves.toMatchObject({ accessToken: 'warm' })
  })
})

describe('同一身份再登一次 = 更新那一条(§8.2)', () => {
  it('身份判据:Codex 看 accountId(并上 chatgptUserId),其它家看 email,取不到不去重', () => {
    expect(oauthTokenIdentity(token({ accountId: 'acct', email: 'a@x.com' }))).toBe('account:acct')
    expect(oauthTokenIdentity(token({ accountId: 'acct', providerMetadata: { chatgptUserId: 'u1' } })))
      .toBe('account:acct:u1')
    expect(oauthTokenIdentity(token({ email: ' A@X.com ' }))).toBe('email:a@x.com')
    expect(oauthTokenIdentity(token())).toBeUndefined()
  })

  it('同一个邮箱再登一次:原地换令牌,不出第二行;另一个邮箱:追加', async () => {
    const answers = [
      { access_token: 'a1', expires_in: 3600 },
      { access_token: 'a2', expires_in: 3600 },
      { access_token: 'b1', expires_in: 3600 },
    ]
    let n = 0
    const fetchImpl = vi.fn(async () => jsonResponse(answers[n++]))
    const definition: OnethingAuthProviderDefinition = {
      ...DEFINITION,
      // 这家的令牌带邮箱(真实的 Codex 从 JWT 里读,这里直接给)。
      normalizeToken: (data: { access_token: string; expires_in: number }) => ({
        accessToken: data.access_token,
        expiresAt: 10_000,
        tokenType: 'Bearer',
        email: data.access_token.startsWith('a') ? 'alice@example.com' : 'bob@example.com',
      }),
    }
    const store = new MemoryPoolTokenStore(() => 0)
    const service = new OnethingAuthService({
      tokenStore: store,
      getDefinition: () => definition,
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => 0,
    })
    const target = { kind: 'space', spaceId: 'work' } as const
    for (let i = 0; i < 3; i += 1) {
      const started = await service.start('codex', target)
      await expect(service.completeManualCode('codex', 'code', started.state ?? '', target))
        .resolves.toEqual({ success: true })
    }
    expect(store.entries('codex', 'work').map(entry => [entry.token.email, entry.token.accessToken]))
      .toEqual([['alice@example.com', 'a2'], ['bob@example.com', 'b1']])
  })
})

describe('状态按条目(§8.3)', () => {
  it('不带 entryId 答第一个可用账号并附 accounts[];带 entryId 答那一条', async () => {
    const { service, spaceTokenStore } = makeService({ now: () => 5_000 })
    const first = spaceTokenStore.seed('codex', token({ accessToken: 'one', email: 'a@x.com', planType: 'plus', expiresAt: 1_000 }), 'work')
    const second = spaceTokenStore.seed('codex', token({ accessToken: 'two', email: 'b@x.com', expiresAt: 9_000 }), 'work')

    const all = await service.getStatus('codex', { kind: 'space', spaceId: 'work' })
    expect(all.accounts).toEqual([
      { entryId: first, label: 'codex #1', email: 'a@x.com', planType: 'plus', isExpired: true, expiresAt: 1_000, canRefresh: true },
      { entryId: second, label: 'codex #2', email: 'b@x.com', isExpired: false, expiresAt: 9_000, canRefresh: true },
    ])
    expect(all.entryId).toBe(first)

    const one = await service.getStatus('codex', { kind: 'space', spaceId: 'work', entryId: second })
    expect(one).toMatchObject({ entryId: second, isLoggedIn: true, isExpired: false, account: { email: 'b@x.com' } })

    // 另一个空间一条都没有:空列表,不回落。
    const other = await service.getStatus('codex', { kind: 'space', spaceId: 'home' })
    expect(other).toMatchObject({ isLoggedIn: false, accounts: [] })
    expect(other.entryId).toBeUndefined()
  })

  it('不指名的退出删的是 status 答的那一条,另一条还在', async () => {
    const { service, spaceTokenStore } = makeService()
    spaceTokenStore.seed('codex', token({ accessToken: 'one' }))
    spaceTokenStore.seed('codex', token({ accessToken: 'two' }))
    await service.deleteToken('codex')
    expect(spaceTokenStore.entries('codex').map(entry => entry.token.accessToken)).toEqual(['two'])
  })

  it('纯判据:先跳冷却、令牌读不出的排最后', () => {
    expect(pickDefaultOAuthEntryId([
      { entryId: 'broken', token: null },
      { entryId: 'cool', token: token(), cooldownUntil: 10 },
      { entryId: 'warm', token: token() },
    ], 5)).toBe('warm')
    expect(pickDefaultOAuthEntryId([{ entryId: 'cool', token: token(), cooldownUntil: 10 }], 5)).toBe('cool')
    expect(pickDefaultOAuthEntryId([{ entryId: 'broken', token: null }], 5)).toBe('broken')
    expect(pickDefaultOAuthEntryId([], 5)).toBeUndefined()
  })
})

describe('非 default 空间:token 落进本空间的池', () => {
  it('entryId 缺席 = 追加一条新 entry(同一 provider 可以多账号)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
    }))
    const { service, spaceTokenStore } = makeService({ fetchImpl })
    const target = { kind: 'space', spaceId: 'work' } as const

    const first = await service.start('codex', target)
    await expect(service.completeManualCode('codex', 'code-1', first.state ?? '', target))
      .resolves.toEqual({ success: true })
    const second = await service.start('codex', target)
    await expect(service.completeManualCode('codex', 'code-2', second.state ?? '', target))
      .resolves.toEqual({ success: true })

    expect(spaceTokenStore.pools.get('work|codex')?.map(entry => entry.id))
      .toEqual(['entry-1', 'entry-2'])
    // 默认空间那一池一个字节都没被碰过。
    expect(spaceTokenStore.entries('codex')).toEqual([])
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
    // 默认空间没登过:不回落到任何一个空间的账号(跨空间不回落)。
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
  it('半个 token 当没登录(与旧单槽的 parseToken 同一口径)', () => {
    expect(parseSpaceOAuthToken(undefined)).toBeNull()
    expect(parseSpaceOAuthToken({ accessToken: 'a' })).toBeNull()
    expect(parseSpaceOAuthToken({ expiresAt: 1 })).toBeNull()
    expect(parseSpaceOAuthToken({ accessToken: 'a', expiresAt: 1 }))
      .toEqual({ accessToken: 'a', expiresAt: 1, tokenType: 'Bearer' })
  })
})
