/**
 * 静态型基座。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第三行
 *
 * 全量内存表 → 打分 → 排序 → **一次全给**(`cursor` 恒缺席)。表小到不值得分页,
 * 分页反而让壳多一条「还有没有下一页」的分支。
 */

import type {
  Candidate,
  PageRequest,
  SearchContext,
  SearchPage,
  SearchQuery,
} from '../candidate.js'
import type { CapabilityManifest, SearchCapability } from '../capability.js'

export interface StaticCapabilityOptions<TItem> {
  manifest: CapabilityManifest
  /** 函数形是为了「表会变」的那一类(启用的命令随设置变) */
  items: readonly TItem[] | ((ctx: SearchContext) => readonly TItem[])
  /** 返回 null = 不中;返回数越大越靠前 */
  score(item: TItem, query: SearchQuery, ctx: SearchContext): number | null
  toCandidate(item: TItem, score: number, ctx: SearchContext): Candidate
  supports?(query: SearchQuery): boolean
  now?: () => number
}

export function staticCapability<TItem>(options: StaticCapabilityOptions<TItem>): SearchCapability {
  const manifest = options.manifest
  const now = options.now ?? (() => Date.now())

  return {
    manifest,
    supports: options.supports ?? (() => true),

    async search(query: SearchQuery, page: PageRequest, ctx: SearchContext): Promise<SearchPage> {
      const startedAt = now()
      const source = typeof options.items === 'function' ? options.items(ctx) : options.items

      const scored: Array<{ candidate: Candidate; score: number }> = []
      for (const item of source) {
        const score = options.score(item, query, ctx)
        if (score === null) continue
        scored.push({ candidate: options.toCandidate(item, score, ctx), score })
      }

      scored.sort((a, b) => (b.score - a.score)
        || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0))

      return {
        items: scored.slice(0, Math.max(0, page.limit)).map(entry => entry.candidate),
        total: scored.length,
        took: now() - startedAt,
      }
    },
  }
}
