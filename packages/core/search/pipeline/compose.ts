/**
 * compose:把各段接成一条。
 *
 * 设计:docs/design/search-index-2026-09.md §6 开头那一行 + §6.5b
 *
 * ```
 * parse → extract → plan → fanout(含 authorize) → merge → rank → page → snippet
 * ```
 * 整条的输出是 `AsyncIterable<GroupResult>`:一个能力答完就出一组。两种适配器消费它 ——
 * **RPC 适配器**收齐再一次性回(`collectGroups`),**推送适配器**逐组往外推。
 * 流水线自己不知道有几种消费方式。
 */

import type {
  GroupResult,
  PageRequest,
  SearchContext,
  SearchQuery,
} from '../candidate.js'
import { ALL_CAPABILITIES } from '../candidate.js'
import type { CapabilityRegistry } from '../capability.js'
import type { Normalizer } from '../analyzer/normalize.js'
import type { BudgetPolicy } from './budget.js'
import { budgetPolicy as defaultBudgetPolicy } from './budget.js'
import type { QueryExtractor } from './extract.js'
import { DEFAULT_EXTRACTORS, extract } from './extract.js'
import type { AuthorizationWarn } from './authorize.js'
import { fanout } from './fanout.js'
import { createGroupMerge, identityMerge } from './merge.js'
import type { Ranker, RankingSignals } from './rank.js'
import { defaultRanker, emptyRankingSignals } from './rank.js'
import { parse } from './parse.js'

export interface SearchPipelineOptions {
  registry: CapabilityRegistry
  budgets?: BudgetPolicy
  normalizers?: readonly Normalizer[]
  extractors?: readonly QueryExtractor[]
  ranker?: Ranker
  signals?: RankingSignals
  warn?: AuthorizationWarn
  now?: () => number
}

export interface SearchRunOptions {
  /** 单类档翻页时把游标交给那一路 */
  page?: PageRequest
  capability?: string
  /** 壳以结构传进来的过滤片 */
  filters?: SearchQuery['filters']
}

export interface SearchPipeline {
  /** 只解析不查:壳要画「抽到的时间轴」时用得着 */
  compile(raw: string, ctx: SearchContext, options?: SearchRunOptions): SearchQuery
  search(raw: string, ctx: SearchContext, options?: SearchRunOptions): AsyncIterable<GroupResult>
  searchQuery(query: SearchQuery, ctx: SearchContext, options?: SearchRunOptions): AsyncIterable<GroupResult>
}

export function compose(options: SearchPipelineOptions): SearchPipeline {
  const registry = options.registry
  const ranker = options.ranker ?? defaultRanker
  const signals = options.signals ?? emptyRankingSignals
  const now = options.now ?? (() => Date.now())
  const run = fanout(registry, options.budgets ?? defaultBudgetPolicy)

  const compile: SearchPipeline['compile'] = (raw, ctx, runOptions = {}) => {
    const parsed = parse(raw, {
      manifests: registry.list().map(capability => capability.manifest),
      normalizers: options.normalizers,
      filters: runOptions.filters,
      capability: runOptions.capability,
    })
    return extract(parsed, options.extractors ?? DEFAULT_EXTRACTORS, { now: ctx.now })
  }

  const searchQuery: SearchPipeline['searchQuery'] = (query, ctx, runOptions = {}) => ({
    async *[Symbol.asyncIterator]() {
      // rank 只在组内(§6.5 全部档那一行);merge 只决定组与组的先后,
      // 而组的到达顺序由 fanout 定 —— 收齐的那一路才去排组。
      for await (const group of run(ctx, query, {
        warn: options.warn,
        page: runOptions.page,
        now,
      })) {
        yield group.page === undefined
          ? group
          : { ...group, page: { ...group.page, items: ranker.rank(group.page.items, ctx, signals) } }
      }
    },
  })

  return {
    compile,
    searchQuery,
    search: (raw, ctx, runOptions = {}) => searchQuery(compile(raw, ctx, runOptions), ctx, runOptions),
  }
}

/**
 * RPC 适配器那一路:收齐再排组。全部档按各 manifest 的 order,单类档恒等。
 */
export async function collectGroups(
  groups: AsyncIterable<GroupResult>,
  options: { registry: CapabilityRegistry; intent: string; capability?: string },
): Promise<GroupResult[]> {
  const collected: GroupResult[] = []
  for await (const group of groups) collected.push(group)

  const merge = (options.capability ?? ALL_CAPABILITIES) === ALL_CAPABILITIES
    ? createGroupMerge(options.registry.list().map(capability => capability.manifest), options.intent)
    : identityMerge
  return merge(collected)
}
