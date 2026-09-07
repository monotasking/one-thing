/** Serializable usage reports shared by runtime and transport adapters. */
export interface OnethingUsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
}

export type OnethingUsageSummaryGranularity = 'day' | 'week' | 'month'

export interface OnethingUsageBreakdownEntry {
  key: string
  usage: OnethingUsageTokens
  apiCostUSD: number
  subscriptionCostUSD: number
  records: number
  /**
   * 厂商自己报的成本合计(USD),只累加带报价的记录。与上面两个本地估算
   * **并排**,不相加也不覆盖 —— 老记录没有这个字段,一律按 0 计。
   */
  providerCostUSD?: number
}

export interface OnethingUsageBucket {
  bucketKey: string
  startTs: number
  endTs: number
  usage: OnethingUsageTokens
  apiCostUSD: number
  subscriptionCostUSD: number
  /** 本段里厂商报价的合计(只有报价的记录进这个数)。 */
  providerCostUSD?: number
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

/**
 * How much of the ranged usage we could actually put a dollar figure on, plus
 * the cache-read discount. The dashboard's "cost quality" block reads this.
 *
 * 三个口径,**并存不相消**:厂商自己报了价的那部分(`providerReported*`)、
 * 本地价目表算得出的那部分(`pricedTokens`)、以及压根没价的那部分
 * (`unpricedTokens`)。厂商报价的记录同时也会被本地价目表算一遍,所以
 * `providerReportedTokens` 是 `pricedTokens` 的**子集**,不要相加。
 */
export interface OnethingUsagePricingQuality {
  /** usage.total tokens from records with a known price (costUSD != null). */
  pricedTokens: number
  /** usage.total tokens from records with no known price (costUSD == null). */
  unpricedTokens: number
  /** Estimated savings from cache reads vs paying the full input rate. */
  cacheSavingsUSD: number
  /**
   * 带厂商报价的记录贡献的 `usage.total` —— 这一段的成本**以厂商报价为准**
   * (`pricingQuality: 'provider-reported'`,设计稿 §10 决策 3)。老记录没有
   * 厂商报价,恒为 0。
   */
  providerReportedTokens?: number
  /**
   * 那同一批记录的**本地价目估算**合计。与 `totalProviderCostUSD` 并排显示,
   * 才看得出本地价目表偏了多少;两者永不互相覆盖。
   */
  providerReportedLocalCostUSD?: number
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
  /** 全窗口厂商报价合计(USD)。没有任何一条带报价时为 0。 */
  totalProviderCostUSD?: number
  pricingQuality: OnethingUsagePricingQuality
  byProject: OnethingUsageProjectTotals[]
}
