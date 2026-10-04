/**
 * 按凭证归因的用量(批 E)。2026-10-04 随 `computeOnethingCredentialUsage` 从 `usage/__tests__/usage-summary.test.ts`
 * 搬来(D24);断言一字未改,记录助手 `record()` 照抄那边的同一份。
 */
import { describe, expect, it } from 'vitest'
import { computeOnethingCredentialUsage } from '../credentials-usage.js'
import type { OnethingUsageLedgerRecord } from '@onething/backend/usage'

function record(overrides: Partial<OnethingUsageLedgerRecord> & { ts: number }): OnethingUsageLedgerRecord {
  return {
    providerId: 'anthropic',
    modelId: 'claude-fable-5',
    platform: 'electron',
    source: 'chat',
    billing: 'api',
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150 },
    costUSD: 0.001,
    ...overrides,
  }
}

describe('computeOnethingCredentialUsage(批 E)', () => {
  const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
  const records = [
    record({ ts: now - 1000, providerId: 'deepseek', workspaceId: 'work', credentialId: 'a' }),
    record({ ts: now - 900, providerId: 'deepseek', workspaceId: 'work', credentialId: 'a', costUSD: null }),
    record({ ts: now - 800, providerId: 'deepseek', workspaceId: 'work', credentialId: 'b' }),
    // 别的 provider / 别的空间 —— 不该混进来。
    record({ ts: now - 700, providerId: 'claude', workspaceId: 'work', credentialId: 'a' }),
    record({ ts: now - 600, providerId: 'deepseek', workspaceId: 'other', credentialId: 'a' }),
    // 默认空间的行**没有 credentialId**(它的凭证源是 settings.ai)。
    record({ ts: now - 500, providerId: 'deepseek' }),
  ]

  it('buckets by credentialId within one provider + one space', () => {
    expect(computeOnethingCredentialUsage(records, { providerId: 'deepseek', workspaceId: 'work' }))
      .toEqual({
        a: { requests: 2, inputTokens: 200, outputTokens: 100, totalTokens: 300, costUSD: 0.001 },
        b: { requests: 1, inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.001 },
      })
  })

  it('skips rows with no credentialId rather than inventing a bucket for them', () => {
    // 编一个 'legacy' 桶只会让后来的人以为有过这么个东西(与账本写入端同一句)。
    const totals = computeOnethingCredentialUsage(records, { providerId: 'deepseek' })
    expect(Object.keys(totals).sort()).toEqual(['a', 'b'])
    expect(totals.a.requests).toBe(3)
  })

  it('reads a missing workspaceId as the default space (旧行零迁移)', () => {
    const legacy = [record({ ts: now, providerId: 'deepseek', credentialId: 'x' })]
    expect(computeOnethingCredentialUsage(legacy, { workspaceId: 'default' }).x?.requests).toBe(1)
    expect(computeOnethingCredentialUsage(legacy, { workspaceId: 'work' })).toEqual({})
  })

  it('does not fabricate a cost for unpriced rows', () => {
    const unpriced = [record({ ts: now, credentialId: 'x', costUSD: null })]
    expect(computeOnethingCredentialUsage(unpriced).x.costUSD).toBe(0)
  })
})
