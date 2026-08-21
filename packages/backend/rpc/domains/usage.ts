/**
 * Token usage / billing over the generic RPC channel — the T0 pilot domain.
 *
 * Read-only: aggregates the append-only usage ledger into day/week/month
 * buckets for the settings usage panel, plus a per-session total for the
 * in-composer readout. See docs/design/token-billing.md.
 *
 * This file replaces `apps/electron/src/main/ipc/usage.ts` (deleted) and the
 * server's `/api/usage/*` routes: one implementation, both hosts.
 */
import type { RouteHandlers } from '@onething/core/ipc'
import { usageRouter, type UsageRoutes } from '@shared/ipc/usage.js'
import {
  getSessionUsageTotal,
  getUsageLedger,
  getUsageSummaryWithProjects,
} from '../../wiring/usage/index.js'
import { registerRouterHandlers } from '../registry.js'

/**
 * The envelope carries whatever the caller sent — on the server that is the
 * open network, not a typed renderer. Normalizing here (the old `/api/usage/*`
 * route did it, the old Electron handler did not) keeps the bucket builder
 * from being handed a granularity it has no branch for.
 */
function normalizeGranularity(value: unknown): 'day' | 'week' | 'month' {
  return value === 'week' || value === 'month' ? value : 'day'
}

export const usageRpcHandlers: RouteHandlers<UsageRoutes> = {
  async getSummary(request) {
    return getUsageSummaryWithProjects(getUsageLedger(), {
      granularity: normalizeGranularity(request?.granularity),
      count: request?.count,
    })
  },
  async getSession(request) {
    return getSessionUsageTotal(request?.sessionId ?? '')
  },
}

export function registerUsageRpcDomain(): () => void {
  return registerRouterHandlers(usageRouter, usageRpcHandlers)
}
