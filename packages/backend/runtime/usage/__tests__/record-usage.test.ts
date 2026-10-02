/**
 * 厂商报价进账本(设计稿 §10 决策 3):`AgentUsage.providerCostUSD` 一路透传
 * 到账本记录,**与本地价目估算并存,永不覆盖**。没报价的家一个字节都不变。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnethingUsageLedger } from '@onething/backend/runtime/usage'

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-record-usage-'))

vi.mock('@onething/backend/runtime/storage', () => ({
  getOnethingStorePath: () => storeDir,
}))

vi.mock('@onething/backend/runtime/providers/model-registry-service', () => ({
  getModelCapabilityEntry: () => ({
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  }),
}))

vi.mock('@onething/backend/runtime/providers/space-credentials', () => ({
  resolveSessionCredentialId: () => undefined,
}))

vi.mock('@onething/backend/store.js', () => ({
  getSession: () => undefined,
}))

vi.mock('../../../session/reads.js', () => ({
  sessionReads: { getMessage: () => undefined },
}))

async function loadRecordUsage() {
  const { recordUsage, configureUsageLedger } = await import('../usage-recorder.js')
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

describe('recordUsage —— 轮转 v2 接力到同家 API 的那一发(批 6)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(async () => {
    await ledger?.close()
    release?.()
    fs.rmSync(path.join(storeDir, 'usage'), { recursive: true, force: true })
  })

  it('用户选的是订阅家,这一发被 route 到 sibling-api:账记在 API 家、billing 是 api、凭证是那一把', async () => {
    const recordUsage = await loadRecordUsage()
    const { usageAttributionOf } = await import('../usage-recorder.js')
    const attribution = usageAttributionOf('codex', {
      spaceCredential: { spaceId: 'work', entryId: 'k1', authType: 'apiKey', route: { providerId: 'openai', reason: 'sibling-api' } },
    })
    const record = recordUsage({
      ...BASE,
      ...attribution,
      modelId: 'gpt-5.5',
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    expect(record.providerId).toBe('openai')
    expect(record.billing).toBe('api')
    expect(record.credentialId).toBe('k1')
  })

  it('没被接力:照旧记在用户选的那一家(订阅 = 估算)', async () => {
    const recordUsage = await loadRecordUsage()
    const { usageAttributionOf } = await import('../usage-recorder.js')
    const record = recordUsage({
      ...BASE,
      ...usageAttributionOf('codex', { spaceCredential: { spaceId: 'work', entryId: 'A', authType: 'oauth' } }),
      modelId: 'gpt-5.5',
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    expect(record.providerId).toBe('codex')
    expect(record.billing).toBe('subscription')
    expect(record.credentialId).toBe('A')
  })
})
