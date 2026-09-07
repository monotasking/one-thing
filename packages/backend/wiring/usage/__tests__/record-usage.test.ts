/**
 * 厂商报价进账本(设计稿 §10 决策 3):`AgentUsage.providerCostUSD` 一路透传
 * 到账本记录,**与本地价目估算并存,永不覆盖**。没报价的家一个字节都不变。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnethingUsageLedger } from '@onething/runtime/usage'

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-record-usage-'))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingStorePath: () => storeDir,
}))

vi.mock('../../providers/model-registry.js', () => ({
  getModelCapabilityEntry: () => ({
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  }),
}))

vi.mock('../../providers/space-credentials.js', () => ({
  resolveSessionCredentialId: () => undefined,
}))

vi.mock('../../../store.js', () => ({
  getSession: () => undefined,
}))

vi.mock('../../../session/reads.js', () => ({
  sessionReads: { getMessage: () => undefined },
}))

async function loadRecordUsage() {
  const { recordUsage, configureUsageLedger } = await import('../index.js')
  ledger = new OnethingUsageLedger({ ledgerDir: path.join(storeDir, 'usage') })
  release = configureUsageLedger(ledger)
  return recordUsage
}
let ledger: OnethingUsageLedger | undefined
let release: (() => void) | undefined

const BASE = {
  providerId: 'openrouter',
  modelId: 'anthropic/claude-fable-5',
  platform: 'electron',
  source: 'chat',
}

describe('recordUsage —— 厂商报价', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(async () => {
    await ledger?.close()
    release?.()
    fs.rmSync(path.join(storeDir, 'usage'), { recursive: true, force: true })
  })

  it('把 AgentUsage.providerCostUSD 落进账本,本地估算照算', async () => {
    const recordUsage = await loadRecordUsage()
    const record = recordUsage({
      ...BASE,
      usage: { inputTokens: 100, outputTokens: 50, providerCostUSD: 0.00042 },
    })
    expect(record.providerCostUSD).toBe(0.00042)
    // 本地价目那条公式一行没动。
    expect(record.costUSD).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 10)
  })

  it('没报价的 provider 记录里连这个键都不出现', async () => {
    const recordUsage = await loadRecordUsage()
    const record = recordUsage({
      ...BASE,
      providerId: 'anthropic',
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    expect(record).not.toHaveProperty('providerCostUSD')
    expect(record.costUSD).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 10)
  })
})
