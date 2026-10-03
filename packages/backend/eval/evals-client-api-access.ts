import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
// 子路径直取(工单 4 C2)。从前这里是动态 import 整只总桶(2026-10 已删) ——
// 一个**授权判据**去动态拉整棵产品 barrel:授权本该是最先跑、最便宜的一步,
// 结果它成了这条路上最贵的一步,而且拉进来的东西 99% 与事故无关。
import { readIncident } from '@onething/backend/eval/incident'
import { isHistoricalLocalOperator, sessionAccess, SessionAccessError, type SessionAccessOperation } from '@onething/backend/session'

/** The repository-wide eval corpus has no tenant column; its historical owner is fixed. */
export function requireEvalRepositoryAccess(context: RpcDispatchContext): void {
  if (!isHistoricalLocalOperator(context)) throw new SessionAccessError()
}

export function requireEvalSourceAccess(context: RpcDispatchContext, sessionId: unknown, operation: SessionAccessOperation = 'read'): void {
  if (typeof sessionId === 'string' && sessionId) sessionAccess.resolve(context, sessionId, operation)
  else requireEvalRepositoryAccess(context)
}

export function canAccessEvalSource(context: RpcDispatchContext, sessionId: unknown): boolean {
  try { requireEvalSourceAccess(context, sessionId); return true }
  catch (error) { if (error instanceof SessionAccessError) return false; throw error }
}

export async function requireIncidentAccess(incidentId: string, context: RpcDispatchContext, operation: SessionAccessOperation = 'read'): Promise<void> {
  const incident = readIncident(incidentId)
  if (!incident) throw new SessionAccessError()
  requireEvalSourceAccess(context, incident.sessionId, operation)
}
