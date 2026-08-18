import type { OnethingUsageLedger } from './ledger.js'
import type { OnethingUsageBillingMode, OnethingUsageLedgerRecord, OnethingUsageTokens } from './types.js'

export type OnethingUsageSummaryGranularity = 'day' | 'week' | 'month'

const DEFAULT_BUCKET_COUNT: Record<OnethingUsageSummaryGranularity, number> = {
  day: 30,
  week: 12,
  month: 12,
}

export interface OnethingUsageBreakdownEntry {
  key: string
  usage: OnethingUsageTokens
  apiCostUSD: number
  subscriptionCostUSD: number
  records: number
}

export interface OnethingUsageBucket {
  bucketKey: string
  startTs: number
  endTs: number
  usage: OnethingUsageTokens
  apiCostUSD: number
  subscriptionCostUSD: number
  records: number
  byProvider: OnethingUsageBreakdownEntry[]
  byModel: OnethingUsageBreakdownEntry[]
  byPlatform: OnethingUsageBreakdownEntry[]
  /**
   * Per call category (chat / title / memory / toc / evals / ...). This is what
   * answers "how much did feature X cost me" — the side-line calls are
   * invisible without it.
   */
  bySource: OnethingUsageBreakdownEntry[]
}

export interface OnethingUsageSummaryRequest {
  granularity: OnethingUsageSummaryGranularity
  /** Number of trailing buckets to return. Defaults: 30 day / 12 week / 12 month. */
  count?: number
  now?: number
  /** Maps a session to its project directory; enables the byProject totals. */
  resolveProjectPath?: (sessionId: string) => string | undefined
}

/**
 * How much of the ranged usage we could actually put a dollar figure on, plus
 * the cache-read discount. The dashboard's "cost quality" block reads this:
 * every cost we show is computed locally from the pricing table (never
 * provider-reported), so the interesting split is priced vs unpriced tokens.
 */
export interface OnethingUsagePricingQuality {
  /** usage.total tokens from records with a known price (costUSD != null). */
  pricedTokens: number
  /** usage.total tokens from records with no known price (costUSD == null). */
  unpricedTokens: number
  /** Estimated savings from cache reads vs paying the full input rate. */
  cacheSavingsUSD: number
}

/**
 * Range totals for one project directory. Sessions without a resolvable
 * workingDirectory (quick chats, deleted sessions) group under projectPath ''.
 */
export interface OnethingUsageProjectTotals {
  projectPath: string
  /** Basename of projectPath; '' for the unbound group. */
  projectName: string
  usage: OnethingUsageTokens
  apiCostUSD: number
  subscriptionCostUSD: number
  records: number
  /** Distinct sessions that contributed usage. */
  sessionCount: number
  lastActiveTs: number
  byProvider: OnethingUsageBreakdownEntry[]
  byModel: OnethingUsageBreakdownEntry[]
}

export interface OnethingUsageSummaryResult {
  granularity: OnethingUsageSummaryGranularity
  buckets: OnethingUsageBucket[]
  totalApiCostUSD: number
  totalSubscriptionCostUSD: number
  pricingQuality: OnethingUsagePricingQuality
  byProject: OnethingUsageProjectTotals[]
}

function zeroUsage(): OnethingUsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }
}

function addUsage(a: OnethingUsageTokens, b: OnethingUsageTokens): OnethingUsageTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
  }
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function addDays(ts: number, days: number): number {
  const d = new Date(ts)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

function startOfLocalMonth(ts: number): number {
  const d = new Date(ts)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function addMonths(ts: number, months: number): number {
  const d = new Date(ts)
  d.setMonth(d.getMonth() + months)
  return d.getTime()
}

/** Monday-start ISO week containing ts. */
function startOfIsoWeek(ts: number): number {
  const d = new Date(startOfLocalDay(ts))
  const isoDayOfWeek = (d.getDay() + 6) % 7 // 0 = Monday
  d.setDate(d.getDate() - isoDayOfWeek)
  return d.getTime()
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** ISO 8601 week key, e.g. '2026-W28'. Week 1 is the week containing the year's first Thursday. */
function isoWeekKey(weekStartTs: number): string {
  const thursday = addDays(weekStartTs, 3)
  const d = new Date(thursday)
  const year = d.getFullYear()
  const jan1 = new Date(year, 0, 1).getTime()
  const week = Math.floor((thursday - startOfIsoWeek(jan1)) / (7 * 86400000)) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

function bucketRange(granularity: OnethingUsageSummaryGranularity, ts: number): { start: number; end: number; key: string } {
  if (granularity === 'day') {
    const start = startOfLocalDay(ts)
    return { start, end: addDays(start, 1), key: dayKey(start) }
  }
  if (granularity === 'week') {
    const start = startOfIsoWeek(ts)
    return { start, end: addDays(start, 7), key: isoWeekKey(start) }
  }
  const start = startOfLocalMonth(ts)
  return { start, end: addMonths(start, 1), key: monthKey(start) }
}

function stepBack(granularity: OnethingUsageSummaryGranularity, ts: number): number {
  if (granularity === 'day') return addDays(ts, -1)
  if (granularity === 'week') return addDays(ts, -7)
  return addMonths(ts, -1)
}

function emptyBreakdownMap(): Map<string, OnethingUsageBreakdownEntry> {
  return new Map()
}

function accumulateBreakdown(
  map: Map<string, OnethingUsageBreakdownEntry>,
  key: string,
  record: OnethingUsageLedgerRecord,
): void {
  const entry = map.get(key) ?? { key, usage: zeroUsage(), apiCostUSD: 0, subscriptionCostUSD: 0, records: 0 }
  entry.usage = addUsage(entry.usage, record.usage)
  entry.records += 1
  if (record.costUSD != null) {
    if (record.billing === 'subscription') entry.subscriptionCostUSD += record.costUSD
    else entry.apiCostUSD += record.costUSD
  }
  map.set(key, entry)
}

function costForBilling(record: OnethingUsageLedgerRecord, billing: OnethingUsageBillingMode): number {
  return record.costUSD != null && record.billing === billing ? record.costUSD : 0
}

function pathBasename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

interface ProjectAccumulator {
  usage: OnethingUsageTokens
  apiCostUSD: number
  subscriptionCostUSD: number
  records: number
  sessionIds: Set<string>
  lastActiveTs: number
  byProvider: Map<string, OnethingUsageBreakdownEntry>
  byModel: Map<string, OnethingUsageBreakdownEntry>
}

/** Range-total per project directory, sorted by cost desc. The byProject block in settings reads this. */
function computeProjectTotals(
  records: OnethingUsageLedgerRecord[],
  range: { start: number; end: number },
  resolveProjectPath: (sessionId: string) => string | undefined,
): OnethingUsageProjectTotals[] {
  const projects = new Map<string, ProjectAccumulator>()
  for (const record of records) {
    if (record.ts < range.start || record.ts >= range.end) continue
    const projectPath = record.sessionId ? resolveProjectPath(record.sessionId) ?? '' : ''
    let acc = projects.get(projectPath)
    if (!acc) {
      acc = {
        usage: zeroUsage(),
        apiCostUSD: 0,
        subscriptionCostUSD: 0,
        records: 0,
        sessionIds: new Set(),
        lastActiveTs: 0,
        byProvider: emptyBreakdownMap(),
        byModel: emptyBreakdownMap(),
      }
      projects.set(projectPath, acc)
    }
    acc.usage = addUsage(acc.usage, record.usage)
    acc.records += 1
    acc.apiCostUSD += costForBilling(record, 'api')
    acc.subscriptionCostUSD += costForBilling(record, 'subscription')
    if (record.sessionId) acc.sessionIds.add(record.sessionId)
    acc.lastActiveTs = Math.max(acc.lastActiveTs, record.ts)
    accumulateBreakdown(acc.byProvider, record.providerId, record)
    accumulateBreakdown(acc.byModel, record.modelId, record)
  }
  return Array.from(projects.entries())
    .map(([projectPath, acc]) => ({
      projectPath,
      projectName: pathBasename(projectPath),
      usage: acc.usage,
      apiCostUSD: acc.apiCostUSD,
      subscriptionCostUSD: acc.subscriptionCostUSD,
      records: acc.records,
      sessionCount: acc.sessionIds.size,
      lastActiveTs: acc.lastActiveTs,
      byProvider: Array.from(acc.byProvider.values()).sort(
        (a, b) => b.apiCostUSD + b.subscriptionCostUSD - (a.apiCostUSD + a.subscriptionCostUSD),
      ),
      byModel: Array.from(acc.byModel.values()).sort(
        (a, b) => b.apiCostUSD + b.subscriptionCostUSD - (a.apiCostUSD + a.subscriptionCostUSD),
      ),
    }))
    .sort((a, b) => b.apiCostUSD + b.subscriptionCostUSD - (a.apiCostUSD + a.subscriptionCostUSD))
}

/** Buckets already-loaded records into day/week/month totals plus per-provider/model/platform breakdowns. */
export function computeOnethingUsageSummary(
  records: OnethingUsageLedgerRecord[],
  request: OnethingUsageSummaryRequest,
): OnethingUsageSummaryResult {
  const now = request.now ?? Date.now()
  const count = request.count ?? DEFAULT_BUCKET_COUNT[request.granularity]

  const ranges: Array<{ start: number; end: number; key: string }> = []
  let cursor = now
  for (let i = 0; i < count; i++) {
    ranges.unshift(bucketRange(request.granularity, cursor))
    cursor = stepBack(request.granularity, cursor)
  }

  const buckets: OnethingUsageBucket[] = ranges.map(range => ({
    bucketKey: range.key,
    startTs: range.start,
    endTs: range.end,
    usage: zeroUsage(),
    apiCostUSD: 0,
    subscriptionCostUSD: 0,
    records: 0,
    byProvider: [],
    byModel: [],
    byPlatform: [],
    bySource: [],
  }))

  const providerMaps = buckets.map(() => emptyBreakdownMap())
  const modelMaps = buckets.map(() => emptyBreakdownMap())
  const platformMaps = buckets.map(() => emptyBreakdownMap())
  const sourceMaps = buckets.map(() => emptyBreakdownMap())

  const overallStart = ranges[0]?.start ?? now
  const overallEnd = ranges[ranges.length - 1]?.end ?? now

  let totalApiCostUSD = 0
  let totalSubscriptionCostUSD = 0
  let pricedTokens = 0
  let unpricedTokens = 0
  let cacheSavingsUSD = 0

  for (const record of records) {
    if (record.ts < overallStart || record.ts >= overallEnd) continue
    const index = ranges.findIndex(range => record.ts >= range.start && record.ts < range.end)
    if (index === -1) continue
    if (record.costUSD != null) pricedTokens += record.usage.total
    else unpricedTokens += record.usage.total
    // A cache read would have been billed at the full input rate without
    // caching; the discount vs the cache-read rate is the saving.
    if (record.unitPrice) {
      const saving = record.usage.cacheRead * (record.unitPrice.input - record.unitPrice.cacheRead) / 1_000_000
      if (saving > 0) cacheSavingsUSD += saving
    }
    const bucket = buckets[index]
    bucket.usage = addUsage(bucket.usage, record.usage)
    bucket.records += 1
    const apiCost = costForBilling(record, 'api')
    const subscriptionCost = costForBilling(record, 'subscription')
    bucket.apiCostUSD += apiCost
    bucket.subscriptionCostUSD += subscriptionCost
    totalApiCostUSD += apiCost
    totalSubscriptionCostUSD += subscriptionCost
    accumulateBreakdown(providerMaps[index], record.providerId, record)
    accumulateBreakdown(modelMaps[index], record.modelId, record)
    accumulateBreakdown(platformMaps[index], record.platform, record)
    accumulateBreakdown(sourceMaps[index], record.source, record)
  }

  buckets.forEach((bucket, index) => {
    bucket.byProvider = Array.from(providerMaps[index].values())
    bucket.byModel = Array.from(modelMaps[index].values())
    bucket.byPlatform = Array.from(platformMaps[index].values())
    bucket.bySource = Array.from(sourceMaps[index].values())
  })

  const byProject = request.resolveProjectPath
    ? computeProjectTotals(records, { start: overallStart, end: overallEnd }, request.resolveProjectPath)
    : []

  return {
    granularity: request.granularity,
    buckets,
    totalApiCostUSD,
    totalSubscriptionCostUSD,
    pricingQuality: { pricedTokens, unpricedTokens, cacheSavingsUSD },
    byProject,
  }
}

/** Reads the ledger for the needed range and computes the bucketed summary. */
export async function getOnethingUsageSummary(
  ledger: OnethingUsageLedger,
  request: OnethingUsageSummaryRequest,
): Promise<OnethingUsageSummaryResult> {
  const now = request.now ?? Date.now()
  const count = request.count ?? DEFAULT_BUCKET_COUNT[request.granularity]
  let rangeStart = now
  for (let i = 0; i < count; i++) rangeStart = stepBack(request.granularity, rangeStart)
  const start = bucketRange(request.granularity, rangeStart).start
  const end = bucketRange(request.granularity, now).end
  const records = await ledger.readRecordsInRange(start, end)
  return computeOnethingUsageSummary(records, request)
}

export interface OnethingSessionUsageTotal {
  apiCostUSD: number
  subscriptionCostUSD: number
  turnCount: number
  usage: OnethingUsageTokens
}

/**
 * Total cost/usage for one session — a live in-session readout, distinct
 * from the day/week/month settings summary above. Scans the whole ledger
 * since a session's records may span multiple monthly files; fine at
 * personal-use volume, revisit with a per-session index if the ledger grows.
 */
export async function getOnethingSessionUsageTotal(
  ledger: OnethingUsageLedger,
  sessionId: string,
): Promise<OnethingSessionUsageTotal> {
  const records = await ledger.readRecordsInRange(0, Date.now() + 86_400_000)
  const total: OnethingSessionUsageTotal = {
    apiCostUSD: 0,
    subscriptionCostUSD: 0,
    turnCount: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
  }
  for (const record of records) {
    if (record.sessionId !== sessionId) continue
    total.turnCount += 1
    if (record.costUSD != null) {
      if (record.billing === 'subscription') total.subscriptionCostUSD += record.costUSD
      else total.apiCostUSD += record.costUSD
    }
    total.usage.input += record.usage.input
    total.usage.output += record.usage.output
    total.usage.cacheRead += record.usage.cacheRead
    total.usage.cacheWrite += record.usage.cacheWrite
    total.usage.reasoning += record.usage.reasoning
    total.usage.total += record.usage.total
  }
  return total
}

/* ── 按凭证归因的用量(批 E)──────────────────────────────────────────────── */

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

/** 读账本的对应窗口再聚合。窗口通常很窄(批 E 用 24h),只扫重叠的月文件。 */
export async function getOnethingCredentialUsage(
  ledger: OnethingUsageLedger,
  query: OnethingCredentialUsageQuery,
): Promise<Record<string, OnethingCredentialUsageTotals>> {
  const records = await ledger.readRecordsInRange(query.startTs, query.endTs)
  return computeOnethingCredentialUsage(records, query)
}
