import { describe, expect, it } from 'vitest'
import { ACP_USAGE_SOURCE, acpAgentUsage, acpTurnCost } from '../usage.js'

/**
 * 一轮 ACP 用量怎么折进引擎的 `AgentUsage`(A2-b)。账本那一行由引擎写(对每一家 provider 都写),
 * 这里证的是「协议给的格子一格不丢」与「累计成本怎么变成这一轮的报价」。
 */
describe('acpAgentUsage', () => {
  it('keeps thought / cache counts and labels the ledger category', () => {
    expect(acpAgentUsage({
      inputTokens: 100, outputTokens: 20, totalTokens: 150, thoughtTokens: 30, cachedReadTokens: 40, cachedWriteTokens: 5,
    }, 0.25)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 150,
      reasoningTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      providerCostUSD: 0.25,
      usageSource: ACP_USAGE_SOURCE,
    })
  })

  it('omits absent / null optional counts and has no usage without a usage block', () => {
    expect(acpAgentUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3, thoughtTokens: null })).toEqual({
      inputTokens: 1, outputTokens: 2, totalTokens: 3, usageSource: 'acp',
    })
    expect(acpAgentUsage(undefined, 1)).toBeUndefined()
    expect(acpAgentUsage(null)).toBeUndefined()
  })
})

describe('acpTurnCost', () => {
  it('reports the delta of the cumulative USD cost against the baseline', () => {
    expect(acpTurnCost(0, { amount: 0.25, currency: 'USD' })).toEqual({ providerCostUSD: 0.25, nextBaseline: 0.25 })
    expect(acpTurnCost(0.25, { amount: 0.5, currency: 'usd' })).toEqual({ providerCostUSD: 0.25, nextBaseline: 0.5 })
  })

  it('does not attribute history when the baseline is unknown — it only learns it', () => {
    expect(acpTurnCost(undefined, { amount: 3, currency: 'USD' })).toEqual({ nextBaseline: 3 })
  })

  it('reports nothing for no change, a reset, another currency or no cost at all', () => {
    expect(acpTurnCost(0.5, { amount: 0.5, currency: 'USD' })).toEqual({ nextBaseline: 0.5 })
    expect(acpTurnCost(0.5, { amount: 0.1, currency: 'USD' })).toEqual({ nextBaseline: 0.1 })
    expect(acpTurnCost(0, { amount: 1, currency: 'EUR' })).toEqual({ nextBaseline: 0 })
    expect(acpTurnCost(0.5, undefined)).toEqual({ nextBaseline: 0.5 })
  })
})
