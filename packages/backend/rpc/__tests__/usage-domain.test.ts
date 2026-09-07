/**
 * The T0 pilot domain, end to end through the dispatcher.
 *
 * Equivalence with the retired lines is what is being pinned: the deleted
 * `apps/electron/src/main/ipc/usage.ts` called
 * `getUsageSummaryWithProjects(getUsageLedger(), { granularity, count })` and
 * `getSessionUsageTotal(sessionId)`, and the deleted `/api/usage/*` routes
 * called the same pair through the runtime facade. The handlers must call
 * exactly those, with exactly those arguments, and hand the result back
 * untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usageRouter } from '@shared/ipc/usage.js'

const usageModule = vi.hoisted(() => ({
  ledger: { marker: 'the-app-usage-ledger' },
  getUsageLedger: vi.fn(),
  getUsageSummaryWithProjects: vi.fn(),
  getSessionUsageTotal: vi.fn(),
}))

// NOTE: this specifier must resolve to the SAME module the handler imports
// (packages/backend/wiring/usage/index.ts). A path one level off mocks nothing and the test
// then silently exercises the real ledger against the user's store.
vi.mock('../../wiring/usage/index.js', () => ({
  getUsageLedger: usageModule.getUsageLedger,
  getUsageSummaryWithProjects: usageModule.getUsageSummaryWithProjects,
  getSessionUsageTotal: usageModule.getSessionUsageTotal,
}))

const SUMMARY = {
  granularity: 'day',
  buckets: [{ key: '2026-08-13', records: 2, apiCostUSD: 0.5, subscriptionCostUSD: 0 }],
  totalApiCostUSD: 0.5,
  totalSubscriptionCostUSD: 0,
  pricingQuality: 'exact',
  byProject: [],
}

const SESSION_TOTAL = {
  apiCostUSD: 0.25,
  subscriptionCostUSD: 0,
  turnCount: 3,
  usage: {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 30,
  },
}

async function loadDomain() {
  const [
    { dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests },
    { usageRpcHandlers },
  ] = await Promise.all([
    import('../registry.js'),
    import('../domains/usage.js'),
  ])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, usageRpcHandlers }
}

describe('usage RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    usageModule.getUsageLedger.mockReset().mockReturnValue(usageModule.ledger)
    usageModule.getUsageSummaryWithProjects.mockReset().mockResolvedValue(SUMMARY)
    usageModule.getSessionUsageTotal.mockReset().mockResolvedValue(SESSION_TOTAL)
    const { resetRpcRegistryForTests, registerRouterHandlers, usageRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(usageRouter, usageRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('getSummary reaches the ledger aggregate with the same arguments as the retired handlers', async () => {
    const { dispatchRpc } = await loadDomain()

    const response = await dispatchRpc({
      domain: 'usage',
      method: 'getSummary',
      payload: { granularity: 'week', count: 12 },
    })

    expect(usageModule.getUsageSummaryWithProjects).toHaveBeenCalledTimes(1)
    expect(usageModule.getUsageSummaryWithProjects).toHaveBeenCalledWith(
      { readRecordsInRange: expect.any(Function) },
      { granularity: 'week', count: 12 },
    )
    expect(response).toEqual({ ok: true, data: SUMMARY })
  })

  it('getSummary falls back to day for a granularity the bucket builder has no branch for', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({ domain: 'usage', method: 'getSummary', payload: { granularity: 'century' } })

    expect(usageModule.getUsageSummaryWithProjects).toHaveBeenCalledWith(
      { readRecordsInRange: expect.any(Function) },
      { granularity: 'day', count: undefined },
    )
  })

  it('getSession returns the per-session total shape the composer readout expects', async () => {
    const { dispatchRpc } = await loadDomain()

    const response = await dispatchRpc({
      domain: 'usage',
      method: 'getSession',
      payload: { sessionId: 'session-1' },
    })

    expect(usageModule.getSessionUsageTotal).toHaveBeenCalledWith('session-1')
    expect(response).toEqual({ ok: true, data: SESSION_TOTAL })
  })

  it('a ledger read failure comes back as ok:false, not a rejection', async () => {
    const { dispatchRpc } = await loadDomain()
    usageModule.getSessionUsageTotal.mockRejectedValue(new Error('ledger unreadable'))

    await expect(dispatchRpc({
      domain: 'usage',
      method: 'getSession',
      payload: { sessionId: 'session-1' },
    })).resolves.toEqual({ ok: false, error: { message: 'ledger unreadable' } })
  })

  it('exposes exactly the two methods the router declares', async () => {
    const { dispatchRpc } = await loadDomain()

    const response = await dispatchRpc({ domain: 'usage', method: 'recordUsage', payload: {} })

    expect(response).toEqual({
      ok: false,
      error: { message: 'Unknown RPC method "usage.recordUsage"', code: 'UNKNOWN_METHOD' },
    })
  })
})
// Adapter fixtures explicitly belong to the local operator on both transports.
vi.mock('../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: () => ({}) }) }
})
