/**
 * 按凭证归因的用量(批 E;2026-10-04 从 `usage/summary.ts` 搬来,D24)。
 *
 * 插件凭证策略要按「每把钥匙最近用了多少」挑钥匙,这里把一批用量账本记录按 `credentialId` 分桶。
 * 它是纯函数,对用量功能只有类型引用:记录从哪来(账本在 usage 里)由调用方读好递进来。
 */
import type { OnethingUsageLedgerRecord } from '@onething/backend/usage'

/**
 * 一条凭证在一个窗口里的用量。
 *
 * 这是**账本已有维度的第一个读侧消费者**:`credentialId` 从批 B3 起就写进每一行
 * (默认空间诚实缺席),但至今没有任何聚合面读它 —— 批 E 的插件策略要按用量挑
 * 钥匙,才第一次需要把它读回来。所以这里是**最小的一个**聚合:一个窗口、一个
 * provider、按 entry id 分桶,不进 bucket 体系(它按时间分桶,而这里要的是
 * "最近一段时间的总量"这一个数)。
 */
export interface OnethingCredentialUsageTotals {
  requests: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 能定价的那部分合计(costUSD 为 null 的行记 0 —— 不编)。 */
  costUSD: number
}

export interface OnethingCredentialUsageQuery {
  /** 只统计这个 provider 的行。缺省 = 全部 provider。 */
  providerId?: string
  /** 只统计这个空间的行。缺省 = 全部空间(旧行无 workspaceId,按 'default' 理解)。 */
  workspaceId?: string
  /** 窗口起点(含)。 */
  startTs: number
  /** 窗口终点(不含)。 */
  endTs: number
}

function emptyCredentialTotals(): OnethingCredentialUsageTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 }
}

/** 纯函数:一批记录 → 按 credentialId 分桶。没有 credentialId 的行**直接跳过**。 */
export function computeOnethingCredentialUsage(
  records: readonly OnethingUsageLedgerRecord[],
  query: Pick<OnethingCredentialUsageQuery, 'providerId' | 'workspaceId'> = {},
): Record<string, OnethingCredentialUsageTotals> {
  const byCredential: Record<string, OnethingCredentialUsageTotals> = {}
  for (const record of records) {
    // 默认空间的行没有 credentialId(它的凭证源是 settings.ai,无 entry id) ——
    // 跳过而不是归进一个编出来的 'legacy' 桶。
    if (!record.credentialId) continue
    if (query.providerId && record.providerId !== query.providerId) continue
    // 旧行没有 workspaceId,按 'default' 理解(与账本写入端同一句缺省)。
    if (query.workspaceId && (record.workspaceId ?? 'default') !== query.workspaceId) continue
    const totals = byCredential[record.credentialId] ?? emptyCredentialTotals()
    totals.requests += 1
    totals.inputTokens += record.usage.input
    totals.outputTokens += record.usage.output
    totals.totalTokens += record.usage.total
    if (record.costUSD != null) totals.costUSD += record.costUSD
    byCredential[record.credentialId] = totals
  }
  return byCredential
}
