import { describe, expect, it } from 'vitest'
import { buildOnethingUsageLedgerRecord, computeOnethingUsageCostUSD, resolveOnethingUsageBillingMode } from '../pricing.js'

describe('resolveOnethingUsageBillingMode', () => {
  it('flags known subscription providers', () => {
    expect(resolveOnethingUsageBillingMode('codex', ['codex', 'claude-code', 'github-copilot'])).toBe('subscription')
    expect(resolveOnethingUsageBillingMode('anthropic', ['codex', 'claude-code', 'github-copilot'])).toBe('api')
  })
})

describe('computeOnethingUsageCostUSD', () => {
  it('returns null when no unit price is available', () => {
    expect(computeOnethingUsageCostUSD({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150 }, undefined)).toBeNull()
  })

  it('treats cacheRead as a discounted subset of input, not additional tokens', () => {
    const cost = computeOnethingUsageCostUSD(
      { input: 1000, output: 200, cacheRead: 800, cacheWrite: 0, reasoning: 0, total: 1200 },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    )
    // billable input = 1000 - 800 = 200 tokens @ $3/1M + 800 @ $0.3/1M + 200 output @ $15/1M
    const expected = (200 * 3 + 800 * 0.3 + 200 * 15) / 1_000_000
    expect(cost).toBeCloseTo(expected, 10)
  })

  it('bills cacheWrite separately from input', () => {
    const cost = computeOnethingUsageCostUSD(
      { input: 500, output: 0, cacheRead: 0, cacheWrite: 500, reasoning: 0, total: 1000 },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    )
    const expected = (500 * 3 + 500 * 3.75) / 1_000_000
    expect(cost).toBeCloseTo(expected, 10)
  })

  it('never lets cacheRead exceed input and produce negative billable input', () => {
    const cost = computeOnethingUsageCostUSD(
      { input: 100, output: 0, cacheRead: 500, cacheWrite: 0, reasoning: 0, total: 100 },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    )
    const expected = (500 * 0.3) / 1_000_000
    expect(cost).toBeCloseTo(expected, 10)
  })
})

describe('buildOnethingUsageLedgerRecord', () => {
  it('normalizes usage, computes cost, and defaults total from input+output', () => {
    const record = buildOnethingUsageLedgerRecord(
      {
        sessionId: 's1',
        providerId: 'anthropic',
        modelId: 'claude-fable-5',
        platform: 'electron',
        source: 'chat',
        billing: 'api',
        usage: { input: 100, output: 50 },
        unitPrice: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
      () => 1234,
    )
    expect(record.ts).toBe(1234)
    expect(record.usage).toEqual({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150 })
    expect(record.costUSD).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 10)
    expect(record.partial).toBeUndefined()
  })

  it('落厂商报价时,本地价目估算一分不动(并存,不覆盖)', () => {
    const record = buildOnethingUsageLedgerRecord({
      providerId: 'openrouter',
      modelId: 'anthropic/claude-fable-5',
      platform: 'electron',
      source: 'chat',
      billing: 'api',
      usage: { input: 100, output: 50 },
      unitPrice: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      providerCostUSD: 0.00042,
    })
    expect(record.providerCostUSD).toBe(0.00042)
    // 本地口径照算 —— 两个数各自成立。
    expect(record.costUSD).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 10)
  })

  it('厂商没报价就诚实缺席(不造 0),负值夹回 0', () => {
    const base = {
      providerId: 'anthropic',
      modelId: 'claude-fable-5',
      platform: 'electron',
      source: 'chat',
      billing: 'api' as const,
      usage: { input: 100, output: 50 },
    }
    expect(buildOnethingUsageLedgerRecord(base).providerCostUSD).toBeUndefined()
    expect(
      buildOnethingUsageLedgerRecord({ ...base, providerCostUSD: -1 }).providerCostUSD,
    ).toBe(0)
    // 免费模型报的 0 是一句真话,不当"没报"。
    expect(
      buildOnethingUsageLedgerRecord({ ...base, providerCostUSD: 0 }).providerCostUSD,
    ).toBe(0)
  })

  it('marks subscription billing without dropping the cost estimate', () => {
    const record = buildOnethingUsageLedgerRecord({
      providerId: 'codex',
      modelId: 'gpt-5-codex',
      platform: 'electron',
      source: 'chat',
      billing: 'subscription',
      usage: { input: 1000, output: 200 },
      unitPrice: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
      partial: true,
    })
    expect(record.billing).toBe('subscription')
    expect(record.partial).toBe(true)
    expect(record.costUSD).toBeGreaterThan(0)
  })

  it('leaves costUSD null when no pricing is known for the model', () => {
    const record = buildOnethingUsageLedgerRecord({
      providerId: 'custom-openai-compatible',
      modelId: 'unknown-model',
      platform: 'electron',
      source: 'chat',
      billing: 'api',
      usage: { input: 10, output: 5 },
    })
    expect(record.costUSD).toBeNull()
    expect(record.unitPrice).toBeUndefined()
  })
})
