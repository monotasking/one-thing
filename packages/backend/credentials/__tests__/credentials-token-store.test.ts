/**
 * 真凭证池上的令牌存放面(批 8,`docs/design/subscription-accounts-2026-09.md` §8):
 * 默认空间与别的空间同一个文件形状、同一条写路。
 *
 *  ① 不指名登录两次(无身份的家)= 池里两条,第一条令牌一字未变;
 *  ② 同一身份再登 = 原地换那一条(条数不变、冷却抹掉);
 *  ③ 指名(重新授权)= 原地换那一条,别的账号不动;
 *  ④ 不指名的读落到第一个不在冷却里的账号;`listEntries` 池序、坏令牌照样列出;
 *  ⑤ 退出只删那一条;不指名的删除是空操作(「登出一个」与「清空」是两件事)。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  configureSpaceCredentialsCrypto,
  getSpaceProviderCredentials,
  markSpaceCredentialCooldown,
  resetSpaceCredentialsCacheForTests,
  writeSpaceCredentials,
} from '../credentials-pool.js'
import { setRootDirForTests } from '../../space/space-persistence.js'
import { createOnethingSpaceTokenStore } from '../credentials-token-store.js'
import type { OnethingOAuthToken } from '@onething/backend/auth'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-space-token-store-'))
  setRootDirForTests(tmpDir)
  resetSpaceCredentialsCacheForTests()
  configureSpaceCredentialsCrypto(undefined)
})

afterEach(async () => {
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  configureSpaceCredentialsCrypto(undefined)
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function token(over: Partial<OnethingOAuthToken> = {}): OnethingOAuthToken {
  return { accessToken: 'at', refreshToken: 'rt', expiresAt: 10_000, tokenType: 'Bearer', ...over }
}

const DEFAULT = { kind: 'space', spaceId: 'default' } as const

function oauthEntries(spaceId: string, providerId: string) {
  return (getSpaceProviderCredentials(spaceId, providerId)?.entries ?? []).filter(entry => entry.authType === 'oauth')
}

describe('令牌存放面:空间凭证池(默认空间也是)', () => {
  it('① 不指名登录两次(无身份)= 默认空间池里两条,第一条令牌一字未变', async () => {
    const store = createOnethingSpaceTokenStore({ now: () => 0 })
    const first = await store.saveToken('kimi-code', token({ accessToken: 'one' }), DEFAULT)
    const second = await store.saveToken('kimi-code', token({ accessToken: 'two' }), DEFAULT)

    expect(first.entryId).not.toBe(second.entryId)
    const entries = oauthEntries('default', 'kimi-code')
    expect(entries.map(entry => (entry.oauthToken as OnethingOAuthToken).accessToken)).toEqual(['one', 'two'])
    await expect(store.getToken('kimi-code', { ...DEFAULT, entryId: first.entryId }))
      .resolves.toMatchObject({ accessToken: 'one' })
  })

  it('② 同一身份再登 = 原地换那一条,冷却一并抹掉', async () => {
    const store = createOnethingSpaceTokenStore({ now: () => 0 })
    const work = { kind: 'space', spaceId: 'work' } as const
    const alice = await store.saveToken('codex', token({ accessToken: 'a1', accountId: 'acct-a' }), work)
    await store.saveToken('codex', token({ accessToken: 'b1', accountId: 'acct-b' }), work)
    markSpaceCredentialCooldown('work', 'codex', alice.entryId, 99_999)

    const again = await store.saveToken('codex', token({ accessToken: 'a2', accountId: 'acct-a' }), work)

    expect(again.entryId).toBe(alice.entryId)
    const entries = oauthEntries('work', 'codex')
    expect(entries).toHaveLength(2)
    expect((entries[0].oauthToken as OnethingOAuthToken).accessToken).toBe('a2')
    expect(entries[0].cooldownUntil).toBeUndefined()
    // 默认空间一条都没有:空间之间互不影响。
    expect(oauthEntries('default', 'codex')).toEqual([])
  })

  it('③ 指名 = 重新授权那一条,别的账号不动(即使令牌换成了另一个身份)', async () => {
    const store = createOnethingSpaceTokenStore({ now: () => 0 })
    const one = await store.saveToken('codex', token({ accessToken: 'one', email: 'a@x.com' }), DEFAULT)
    const two = await store.saveToken('codex', token({ accessToken: 'two', email: 'b@x.com' }), DEFAULT)

    await store.saveToken('codex', token({ accessToken: 'two-new', email: 'b@x.com' }), { ...DEFAULT, entryId: two.entryId })

    const entries = oauthEntries('default', 'codex')
    expect(entries.map(entry => [entry.id, (entry.oauthToken as OnethingOAuthToken).accessToken]))
      .toEqual([[one.entryId, 'one'], [two.entryId, 'two-new']])
  })

  it('④ 不指名的读落到第一个不在冷却里的账号;listEntries 池序、坏令牌照样列出', async () => {
    const store = createOnethingSpaceTokenStore({ now: () => 1_000 })
    writeSpaceCredentials('default', {
      providers: {
        codex: {
          policy: 'priority-failover',
          entries: [
            { id: 'broken', label: 'broken', authType: 'oauth', oauthToken: { nope: true }, source: 'user' },
            { id: 'cool', label: 'cool', authType: 'oauth', oauthToken: token({ accessToken: 'cool' }), source: 'user', cooldownUntil: 5_000 },
            { id: 'warm', label: 'warm', authType: 'oauth', oauthToken: token({ accessToken: 'warm' }), source: 'user' },
          ],
        },
      },
    })
    await expect(store.resolveEntryId('codex', DEFAULT)).resolves.toBe('warm')
    const listed = await store.listEntries('codex', 'default')
    expect(listed.map(entry => [entry.entryId, entry.token?.accessToken ?? null, entry.cooldownUntil ?? null]))
      .toEqual([['broken', null, null], ['cool', 'cool', 5_000], ['warm', 'warm', null]])
  })

  it('⑤ 退出只删那一条;不指名的删除什么都不删', async () => {
    const store = createOnethingSpaceTokenStore({ now: () => 0 })
    const one = await store.saveToken('kimi-code', token({ accessToken: 'one' }), DEFAULT)
    await store.saveToken('kimi-code', token({ accessToken: 'two' }), DEFAULT)

    await store.deleteToken('kimi-code', DEFAULT)
    expect(oauthEntries('default', 'kimi-code')).toHaveLength(2)

    await store.deleteToken('kimi-code', { ...DEFAULT, entryId: one.entryId })
    expect(oauthEntries('default', 'kimi-code').map(entry => (entry.oauthToken as OnethingOAuthToken).accessToken))
      .toEqual(['two'])
  })
})
