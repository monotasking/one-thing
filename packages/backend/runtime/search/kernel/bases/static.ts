/**
 * 静态型基座。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第三行
 *
 * 全量内存表 → 打分 → 排序 → 切页。**`total` 是真数**(整张表里中了几条),游标是
 * 偏移形,与索引型同一只 `paginate` / `readOffsetCursor`。
 *
 * ── 从前这里「一次全给、`cursor` 恒缺席」,为什么改(检索面终稿 §4)──────────
 *
 * 那句话的理由是「表小到不值得分页」。它在**总览档**里当场破产:`all` 档给 prompts
 * 的配额是 6 条,提示词表有 40 条时,屏上那一块永远只有 6 行、而且**说不出还有多少**
 * ——「每块自己原地续页」(§0 ②)需要的正是这一格 `cursor`,而「取尽了没有」需要的
 * 正是那个真 `total`。表小不等于配额大。
 */

import type {
  Candidate,
  PageRequest,
  SearchContext,
  SearchPage,
  SearchQuery,
} from '../candidate.js'
import type { CapabilityManifest, SearchCapability } from '../capability.js'
import type { CursorCodec } from '../cursor.js'
import { createCursorCodec, hashQueryShape } from '../cursor.js'
import { paginate, readOffsetCursor } from '../pipeline/page.js'

export interface StaticCapabilityOptions<TItem> {
  manifest: CapabilityManifest
  /** 函数形是为了「表会变」的那一类(启用的命令随设置变) */
  items: readonly TItem[] | ((ctx: SearchContext) => readonly TItem[])
  /** 返回 null = 不中;返回数越大越靠前 */
  score(item: TItem, query: SearchQuery, ctx: SearchContext): number | null
  toCandidate(item: TItem, score: number, ctx: SearchContext): Candidate
  supports?(query: SearchQuery): boolean
  codec?: CursorCodec
  now?: () => number
}

export function staticCapability<TItem>(options: StaticCapabilityOptions<TItem>): SearchCapability {
  const manifest = options.manifest
  const codec = options.codec ?? createCursorCodec()
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

      // 静态表没有「索引代次」这回事,所以指纹只折查询本身。表变了而游标还在的那
      // 一次会漏行或重行 —— 与索引型换代次是同一种过期,壳按 id 去重(§5.4 闸③)。
      const queryHash = hashQueryShape({
        raw: query.raw,
        intent: query.intent,
        filters: query.filters,
        level: query.ladder?.level ?? 0,
      })
      const offset = readOffsetCursor(codec, page.cursor, { capability: manifest.id, queryHash })
      const window = scored.slice(offset, offset + Math.max(0, page.limit))

      return paginate(
        window.map(entry => entry.candidate),
        page,
        { capability: manifest.id, codec, queryHash, total: scored.length, offset },
        now() - startedAt,
      )
    },
  }
}
