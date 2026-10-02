import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OnethingUsageLedger } from '../ledger.js'
import { getOnethingSessionUsageTotal } from '../summary.js'

describe('getOnethingSessionUsageTotal', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-session-usage-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('sums only the records for the requested session, split by billing mode', async () => {
    const ledger = new OnethingUsageLedger({ ledgerDir: dir })
    ledger.record({
      sessionId: 's1',
      providerId: 'anthropic',
      modelId: 'claude-fable-5',
      platform: 'electron',
      source: 'chat',
      billing: 'api',
      usage: { input: 100, output: 50 },
      unitPrice: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    })
    ledger.record({
      sessionId: 's1',
      providerId: 'codex',
      modelId: 'gpt-5-codex',
      platform: 'electron',
      source: 'chat',
      billing: 'subscription',
      usage: { input: 200, output: 100 },
      unitPrice: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    })
    ledger.record({
      sessionId: 's2',
      providerId: 'anthropic',
      modelId: 'claude-fable-5',
      platform: 'electron',
      source: 'chat',
      billing: 'api',
      usage: { input: 999, output: 999 },
    })
    await ledger.flush()

    const total = await getOnethingSessionUsageTotal(ledger, 's1')

    expect(total.turnCount).toBe(2)
    expect(total.apiCostUSD).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 10)
    expect(total.subscriptionCostUSD).toBeCloseTo((200 * 1.25 + 100 * 10) / 1_000_000, 10)
    expect(total.usage).toEqual({ input: 300, output: 150, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 450 })
  })

  it('returns zeroed totals for a session with no recorded usage', async () => {
    const ledger = new OnethingUsageLedger({ ledgerDir: dir })
    const total = await getOnethingSessionUsageTotal(ledger, 'unknown-session')

    expect(total).toEqual({
      apiCostUSD: 0,
      subscriptionCostUSD: 0,
      turnCount: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    })
  })
})
