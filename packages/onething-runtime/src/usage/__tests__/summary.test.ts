import { describe, expect, it } from 'vitest'
import { computeOnethingCredentialUsage, computeOnethingUsageSummary } from '../summary.js'
import type { OnethingUsageLedgerRecord } from '../types.js'

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

describe('computeOnethingUsageSummary', () => {
  it('buckets records by local day and keeps api/subscription costs separate', () => {
    const day1 = new Date(2026, 6, 13, 10, 0, 0).getTime()
    const day2 = new Date(2026, 6, 14, 10, 0, 0).getTime()
    const records = [
      record({ ts: day1, costUSD: 0.001, billing: 'api' }),
      record({ ts: day1, costUSD: 0.002, billing: 'subscription', providerId: 'codex' }),
      record({ ts: day2, costUSD: 0.003, billing: 'api' }),
    ]

    const summary = computeOnethingUsageSummary(records, { granularity: 'day', count: 3, now: day2 })

    expect(summary.buckets).toHaveLength(3)
    const [, bucketDay1, bucketDay2] = summary.buckets
    expect(bucketDay1.bucketKey).toBe('2026-07-13')
    expect(bucketDay1.records).toBe(2)
    expect(bucketDay1.apiCostUSD).toBeCloseTo(0.001, 10)
    expect(bucketDay1.subscriptionCostUSD).toBeCloseTo(0.002, 10)
    expect(bucketDay2.bucketKey).toBe('2026-07-14')
    expect(bucketDay2.records).toBe(1)
    expect(summary.totalApiCostUSD).toBeCloseTo(0.004, 10)
    expect(summary.totalSubscriptionCostUSD).toBeCloseTo(0.002, 10)
  })

  it('breaks down usage by provider, model, and platform within a bucket', () => {
    const ts = new Date(2026, 6, 13, 10, 0, 0).getTime()
    const records = [
      record({ ts, providerId: 'anthropic', modelId: 'claude-fable-5', platform: 'electron' }),
      record({ ts, providerId: 'codex', modelId: 'gpt-5-codex', platform: 'telegram', billing: 'subscription' }),
    ]

    const summary = computeOnethingUsageSummary(records, { granularity: 'day', count: 1, now: ts })
    const bucket = summary.buckets[0]
    expect(bucket.byProvider.map(e => e.key).sort()).toEqual(['anthropic', 'codex'])
    expect(bucket.byModel.map(e => e.key).sort()).toEqual(['claude-fable-5', 'gpt-5-codex'])
    expect(bucket.byPlatform.map(e => e.key).sort()).toEqual(['electron', 'telegram'])
  })

  it('rolls day-level records up into ISO week buckets (Monday start)', () => {
    // 2026-07-13 is a Monday; 2026-07-19 is the following Sunday (same ISO week).
    const monday = new Date(2026, 6, 13, 9, 0, 0).getTime()
    const sunday = new Date(2026, 6, 19, 9, 0, 0).getTime()
    const nextMonday = new Date(2026, 6, 20, 9, 0, 0).getTime()
    const records = [
      record({ ts: monday, costUSD: 0.001 }),
      record({ ts: sunday, costUSD: 0.002 }),
      record({ ts: nextMonday, costUSD: 0.004 }),
    ]

    const summary = computeOnethingUsageSummary(records, { granularity: 'week', count: 2, now: nextMonday })
    expect(summary.buckets).toHaveLength(2)
    expect(summary.buckets[0].bucketKey).toBe('2026-W29')
    expect(summary.buckets[0].records).toBe(2)
    expect(summary.buckets[0].apiCostUSD).toBeCloseTo(0.003, 10)
    expect(summary.buckets[1].bucketKey).toBe('2026-W30')
    expect(summary.buckets[1].records).toBe(1)
  })

  it('rolls day-level records up into calendar month buckets', () => {
    const julEarly = new Date(2026, 6, 1, 9, 0, 0).getTime()
    const julLate = new Date(2026, 6, 31, 9, 0, 0).getTime()
    const aug = new Date(2026, 7, 5, 9, 0, 0).getTime()
    const records = [
      record({ ts: julEarly, costUSD: 0.001 }),
      record({ ts: julLate, costUSD: 0.002 }),
      record({ ts: aug, costUSD: 0.004 }),
    ]

    const summary = computeOnethingUsageSummary(records, { granularity: 'month', count: 2, now: aug })
    expect(summary.buckets.map(b => b.bucketKey)).toEqual(['2026-07', '2026-08'])
    expect(summary.buckets[0].records).toBe(2)
    expect(summary.buckets[0].apiCostUSD).toBeCloseTo(0.003, 10)
    expect(summary.buckets[1].records).toBe(1)
  })

  it('ignores records outside the requested range', () => {
    const inRange = new Date(2026, 6, 13).getTime()
    const outOfRange = new Date(2026, 0, 1).getTime()
    const records = [record({ ts: inRange }), record({ ts: outOfRange })]
    const summary = computeOnethingUsageSummary(records, { granularity: 'day', count: 1, now: inRange })
    expect(summary.buckets[0].records).toBe(1)
  })
  it('breaks spend down by call category so side-line calls are visible', () => {
    // Chat bills itself; title / memory / skill review are calls the app makes
    // on its own and were historically invisible in the ledger summary.
    const day = new Date(2026, 6, 13, 10, 0, 0).getTime()
    const records = [
      record({ ts: day, source: 'chat', costUSD: 0.05 }),
      record({ ts: day, source: 'chat', costUSD: 0.03 }),
      record({ ts: day, source: 'memory', costUSD: 0.004 }),
      record({ ts: day, source: 'title', costUSD: 0.001 }),
    ]

    const summary = computeOnethingUsageSummary(records, { granularity: 'day', count: 1, now: day })
    const bySource = summary.buckets[0]!.bySource

    expect(bySource.map(entry => entry.key).sort()).toEqual(['chat', 'memory', 'title'])
    const chat = bySource.find(entry => entry.key === 'chat')!
    expect(chat.apiCostUSD).toBeCloseTo(0.08)
    expect(chat.records).toBe(2)
    expect(bySource.find(entry => entry.key === 'memory')!.apiCostUSD).toBeCloseTo(0.004)
  })

  it('reports pricing quality: priced vs unpriced tokens and cache savings', () => {
    const day = new Date(2026, 6, 13, 10, 0, 0).getTime()
    const unitPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
    const records = [
      // priced: 1200 tokens, 800 cache reads at 3 - 0.3 = 2.7 USD/M discount
      record({
        ts: day,
        usage: { input: 1000, output: 200, cacheRead: 800, cacheWrite: 0, reasoning: 0, total: 1200 },
        costUSD: 0.003,
        unitPrice,
      }),
      // unpriced: costUSD null (no pricing known for the model)
      record({ ts: day, costUSD: undefined, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150 } }),
    ]

    const summary = computeOnethingUsageSummary(records, { granularity: 'day', count: 1, now: day })

    expect(summary.pricingQuality.pricedTokens).toBe(1200)
    expect(summary.pricingQuality.unpricedTokens).toBe(150)
    expect(summary.pricingQuality.cacheSavingsUSD).toBeCloseTo((800 * 2.7) / 1_000_000, 10)
  })

  it('never counts negative cache savings when cache read costs as much as input', () => {
    const day = new Date(2026, 6, 13, 10, 0, 0).getTime()
    const records = [
      record({
        ts: day,
        usage: { input: 100, output: 0, cacheRead: 100, cacheWrite: 0, reasoning: 0, total: 100 },
        unitPrice: { input: 0.3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      }),
    ]

    const summary = computeOnethingUsageSummary(records, { granularity: 'day', count: 1, now: day })
    expect(summary.pricingQuality.cacheSavingsUSD).toBe(0)
  })

  it('aggregates range totals per project directory when a resolver is given', () => {
    const day1 = new Date(2026, 6, 13, 10, 0, 0).getTime()
    const day2 = new Date(2026, 6, 14, 10, 0, 0).getTime()
    const projects: Record<string, string | undefined> = {
      'session-a': '/dev/kero',
      'session-b': '/dev/kero',
      'session-c': '/dev/waku',
      'session-deleted': undefined,
    }
    const records = [
      record({ ts: day1, sessionId: 'session-a', costUSD: 0.01, providerId: 'anthropic' }),
      record({ ts: day2, sessionId: 'session-b', costUSD: 0.02, providerId: 'codex', billing: 'subscription', modelId: 'gpt-5' }),
      record({ ts: day2, sessionId: 'session-c', costUSD: 0.005, modelId: 'claude-sonnet-5' }),
      record({ ts: day2, sessionId: 'session-deleted', costUSD: 0.001 }),
    ]

    const summary = computeOnethingUsageSummary(records, {
      granularity: 'day',
      count: 2,
      now: day2,
      resolveProjectPath: sessionId => projects[sessionId],
    })

    const [kero, waku, unbound] = summary.byProject
    expect(summary.byProject).toHaveLength(3)

    // Sorted by total cost desc.
    expect(kero.projectPath).toBe('/dev/kero')
    expect(kero.projectName).toBe('kero')
    expect(kero.apiCostUSD).toBeCloseTo(0.01, 10)
    expect(kero.subscriptionCostUSD).toBeCloseTo(0.02, 10)
    expect(kero.sessionCount).toBe(2)
    expect(kero.lastActiveTs).toBe(day2)
    expect(kero.byProvider.map(e => e.key).sort()).toEqual(['anthropic', 'codex'])
    expect(kero.byModel.map(e => e.key).sort()).toEqual(['claude-fable-5', 'gpt-5'])

    expect(waku.projectName).toBe('waku')
    expect(waku.sessionCount).toBe(1)

    // Unresolvable sessions group under the unbound '' project.
    expect(unbound.projectPath).toBe('')
    expect(unbound.projectName).toBe('')
    expect(unbound.apiCostUSD).toBeCloseTo(0.001, 10)
  })

  it('returns no project totals without a resolver', () => {
    const day = new Date(2026, 6, 13, 10, 0, 0).getTime()
    const summary = computeOnethingUsageSummary([record({ ts: day })], { granularity: 'day', count: 1, now: day })
    expect(summary.byProject).toEqual([])
  })
})

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
