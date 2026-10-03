import type {
  OnethingUsageTokens,
} from '@shared/contracts/usage.js'
export type {
  OnethingUsageTokens,
} from '@shared/contracts/usage.js'

export interface OnethingUsageUnitPrice {
  /** USD per 1M tokens */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type OnethingUsageBillingMode = 'api' | 'subscription'

/**
 * Call categories that land in the ledger. Kept as named constants rather than
 * bare string literals at each call site so the usage panel's breakdown and the
 * producers cannot drift apart.
 *
 * Deliberately not a closed union on the record type: the ledger is
 * append-only and already holds historical values, so a narrowed type would
 * make old records unreadable.
 */
export const ONETHING_USAGE_SOURCES = {
  /** The main chat turn. */
  chat: 'chat',
  /** Session title generation. */
  title: 'title',
  /** Legacy: soul-memory capture + idle review (plugin retired 2026-08-06).
   *  Kept so historical ledger entries still resolve to a known source. */
  memory: 'memory',
  /** Skill review trigger. */
  skill: 'skill',
  /** Session table-of-contents segmentation. */
  toc: 'toc',
  /** Context compaction summary — one call per chunk, on the session model. */
  compact: 'compact',
  /** Evals workbench / replay / judge. */
  evals: 'evals',
  /** Collab room response-willingness judgement (one small call per member). */
  collabWillingness: 'collab-willingness',
  /** Collab room daily digest — one call per room per folded day (P2). */
  collabDigest: 'collab-digest',
  /**
   * 房间编排(collab-coordinator-plan.md):**一条用户消息一次**,产出
   * 「谁说、什么次序」的整份 waves。它取代的是 N 路意愿判定,所以这一格与
   * `collab-willingness` 是此消彼长的关系 —— 两条线并排看得见,才说得清换算法
   * 到底省了多少。
   */
  collabPlan: 'collab-plan',
  /**
   * 宠物开口(宠物 P4,`docs/design/pet-system-2026-09.md` §11.2):一条时刻过了注意力预算、又没带
   * 现成台词时,工具模型写的那一句。一次开口一次调用,被冷却挡掉的不调。
   */
  pet: 'pet',
} as const

export type OnethingUsageSource =
  (typeof ONETHING_USAGE_SOURCES)[keyof typeof ONETHING_USAGE_SOURCES]

export interface OnethingUsageLedgerRecord {
  ts: number
  sessionId?: string
  /**
   * 归属 space(批 B2)。**写入端只加维度,不动聚合与旧行解析** —— 账本是
   * append-only 的,历史行没有这个字段,读侧一律按缺席=`'default'` 理解
   * (与会话归属同一句缺省)。按 space 出账是后续切片的事。
   */
  workspaceId?: string
  /**
   * 命中的 per-space 凭证池 entry id(批 B3)。
   *
   * **默认空间诚实缺席**:它的凭证来自 `settings.ai`,那里根本没有 entry id,
   * 编一个 `'legacy'` 只会让后来的人以为有过这么个东西。旧行同理缺席,
   * 读侧透传即可 —— 聚合与旧行解析一行未动。
   */
  credentialId?: string
  providerId: string
  modelId: string
  /** Originating channel: electron | telegram | wechat | cli | api | server */
  platform: string
  /** Call category: chat | title | memory | goal | evals | ... */
  source: string
  billing: OnethingUsageBillingMode
  usage: OnethingUsageTokens
  unitPrice?: OnethingUsageUnitPrice
  costUSD?: number | null
  /**
   * 厂商在响应里报的本次请求成本(USD)—— OpenRouter `usage.cost`、
   * xAI `cost_in_usd_ticks / 1e10` 等少数几家才有。
   *
   * **与 `costUSD`(本地价目估算)并存,永不覆盖**:两个口径同时落盘,读侧
   * 才说得清"这一段到底按谁的价算的"。账本 append-only,老行没有这个字段,
   * 读侧一律按"没有厂商报价"理解 —— 零迁移。
   */
  providerCostUSD?: number
  /** Set when the stream aborted mid-turn and usage may be incomplete. */
  partial?: boolean
}

export interface OnethingUsageRecordInput {
  ts?: number
  sessionId?: string
  workspaceId?: string
  credentialId?: string
  providerId: string
  modelId: string
  platform: string
  source: string
  billing: OnethingUsageBillingMode
  usage: Partial<OnethingUsageTokens> & { input: number; output: number }
  unitPrice?: OnethingUsageUnitPrice
  /** 厂商报的本次成本(USD)。没报就缺席 —— 不要造 0。 */
  providerCostUSD?: number
  partial?: boolean
}
