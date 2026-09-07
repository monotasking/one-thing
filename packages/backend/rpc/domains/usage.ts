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
import type { RpcRouteHandlers } from '../registry.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import { isHistoricalLocalOperator, sessionAccess } from '../../session/access.js'
import type { UsageRoutes } from '@shared/ipc/usage.js'
import {
  getSessionUsageTotal,
  getUsageLedger,
  getUsageSummaryWithProjects,
} from '../../wiring/usage/index.js'

/**
 * The envelope carries whatever the caller sent — on the server that is the
 * open network, not a typed renderer. Normalizing here (the old `/api/usage/*`
 * route did it, the old Electron handler did not) keeps the bucket builder
 * from being handed a granularity it has no branch for.
 */
function normalizeGranularity(value: unknown): 'day' | 'week' | 'month' {
  return value === 'week' || value === 'month' ? value : 'day'
}

export const usageRpcHandlers: RpcRouteHandlers<UsageRoutes> = {
  async getSummary(request, context = DESKTOP_RPC_CONTEXT) {
    const ledger = getUsageLedger()
    return getUsageSummaryWithProjects({
      async readRecordsInRange(start, end) {
        const records = await ledger.readRecordsInRange(start, end)
        const visible = new Set(sessionAccess.filterIds(context, records.map(record => record.sessionId).filter((id): id is string => typeof id === 'string')))
        return records.filter(record => record.sessionId ? visible.has(record.sessionId) : isHistoricalLocalOperator(context))
      },
    }, {
      granularity: normalizeGranularity(request?.granularity),
      count: request?.count,
    })
  },
  async getSession(request, context = DESKTOP_RPC_CONTEXT) {
    sessionAccess.resolve(context, request?.sessionId ?? '', 'read')
    return getSessionUsageTotal(request?.sessionId ?? '')
  },
}
