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
import { defineClientApi, type RpcRouteHandlers } from '@onething/backend/http-server/http-server-dispatch-table.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import { isHistoricalLocalOperator, sessionAccess } from '@onething/backend/session'
import { usageRouter, type UsageRoutes } from '@shared/ipc/usage.js'
import {
  getSessionUsageTotal,
  getUsageLedger,
  getUsageSummaryWithProjects,
} from '@onething/backend/usage/usage-recorder'

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

/** 名册 `http-server/http-server-client-api-roster.ts` 里的一行:域 `usage` 的契约与处理者。 */
export const USAGE_CLIENT_API = defineClientApi({ id: 'rpc:usage', router: usageRouter, handlers: usageRpcHandlers })
