/**
 * 配额按凭证取令牌(批 5 留账「默认空间多账号拿到的是同一份配额」,批 8 §8.6 关掉)。
 *
 * 默认空间池里两个订阅账号:问 A 的配额刷的是 A 那一条、递给配额源的是 A 的令牌;问 B 同理。
 * 批 8 之前默认空间的目标一律归到单槽,两问拿到的是同一把令牌。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const refreshed = vi.hoisted(() => [] as unknown[])

vi.mock('../../auth/process-auth-service.js', () => ({
  getAuthService: () => ({
    refreshTokenIfNeeded: async (_providerId: string, target: { spaceId: string; entryId?: string }) => {
      refreshed.push(target)
      const { getSpaceCredentialEntry } = await import('../../credentials/credentials-pool.js')
      return getSpaceCredentialEntry(target.spaceId, 'codex', target.entryId)?.oauthToken
    },
  }),
}))

vi.mock('../../credentials/credentials-resolution.js', async () => {
  const { credentialTargetFromSpaceMarker } = await import('@onething/backend/auth')
  return {
    credentialTargetFromMarker: credentialTargetFromSpaceMarker,
    decideSpaceProviderCredential: vi.fn(),
  }
})

import {
  configureSpaceCredentialsCrypto,
  resetSpaceCredentialsCacheForTests,
  writeSpaceCredentials,
} from '../../credentials/credentials-pool.js'
import { setRootDirForTests } from '@onething/backend/space/space-persistence'
import { resolveQuotaCredential } from '../quota.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-quota-cred-'))
  setRootDirForTests(tmpDir)
  resetSpaceCredentialsCacheForTests()
  configureSpaceCredentialsCrypto(undefined)
  refreshed.length = 0
})

afterEach(() => {
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('配额:默认空间两个订阅账号各答各的令牌(批 8 §8.6)', () => {
  it('按 credentialId 问:刷的是那一条、递给配额源的是那一条的令牌', async () => {
    const token = (accessToken: string, accountId: string) =>
      ({ accessToken, refreshToken: `rt-${accessToken}`, expiresAt: 4_000_000_000_000, tokenType: 'Bearer', accountId })
    writeSpaceCredentials('default', {
      providers: {
        codex: {
          policy: 'priority-failover',
          entries: [
            { id: 'A', label: 'A', authType: 'oauth', source: 'user', oauthToken: token('at-A', 'acct-A') },
            { id: 'B', label: 'B', authType: 'oauth', source: 'user', oauthToken: token('at-B', 'acct-B') },
          ],
        },
      },
    })

    const a = await resolveQuotaCredential('codex', 'default', 'A')
    const b = await resolveQuotaCredential('codex', 'default', 'B')

    expect(refreshed).toEqual([
      { kind: 'space', spaceId: 'default', entryId: 'A' },
      { kind: 'space', spaceId: 'default', entryId: 'B' },
    ])
    expect(a).toMatchObject({ kind: 'ready', credentialId: 'A', context: { oauthToken: { accessToken: 'at-A', accountId: 'acct-A' } } })
    expect(b).toMatchObject({ kind: 'ready', credentialId: 'B', context: { oauthToken: { accessToken: 'at-B', accountId: 'acct-B' } } })
  })
})
