/**
 * 索引型基座。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第一行 + §4.4 轴 ③ + §15.1
 *
 * 召回是一张**列表**不是一个函数:`retrievers: [lexical, vector]`,`fuse` 融合。
 * 第一稿只留了 `Ranker` 位 —— 向量是**召回**不是排序,位留错了,这里是补回来的那一格。
 * 缺省融合是 RRF(倒数排名融合,k=60);**只有一路时 fuse 是恒等**(逐字同一批候选、
 * 同一个次序、同一份分数),所以 S7 加向量路不会把词法路的读数改掉。
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

export interface RetrievedPage {
  items: Candidate[]
  /** 授权之后的真数;不知道就别给(§7.3) */
  total?: number
}

export interface Retriever {
  readonly id: string
  retrieve(
    query: SearchQuery,
    ctx: SearchContext,
    page: { limit: number; offset: number },
  ): Promise<RetrievedPage>
}

export type Fusion = (lists: ReadonlyArray<{ id: string; items: readonly Candidate[] }>) => Candidate[]

/** RRF:`score = Σ 1 / (k + rank_i)`。k=60 是文献与 §15.1 的取值。 */
export function rrfFusion(k = 60): Fusion {
  return lists => {
    if (lists.length === 0) return []
    // 单路恒等 —— 这条不是优化,是契约:S7 之前的读数不许被融合改写。
    if (lists.length === 1) return [...(lists[0]?.items ?? [])]

    const byId = new Map<string, { candidate: Candidate; score: number }>()
    for (const list of lists) {
      list.items.forEach((candidate, rank) => {
        const key = candidate.id
        const contribution = 1 / (k + rank + 1)
        const existing = byId.get(key)
        if (existing === undefined) byId.set(key, { candidate, score: contribution })
        else existing.score += contribution
      })
    }
    return [...byId.values()]
      .sort((a, b) => (b.score - a.score)
        || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0))
      .map(entry => ({ ...entry.candidate, score: entry.score }))
  }
}

export interface IndexedCapabilityOptions {
  manifest: CapabilityManifest
  retrievers: readonly Retriever[]
  fuse?: Fusion
  codec?: CursorCodec
  /** 缺省:有词就答。空词那一形由能力自己定(有的能力空词要出最近项) */
  supports?(query: SearchQuery): boolean
  /**
   * 索引代次。索引一变就换一个值,`queryHash` 跟着变,在飞的游标自然失效
   * (§4.2「索引变了 hash 变,cursor 自然失效」)。
   */
  generation?(): string | number
  feed?: SearchCapability['feed']
  preview?: SearchCapability['preview']
  compare?: SearchCapability['compare']
  invoke?: SearchCapability['invoke']
  now?: () => number
}

export function indexedCapability(options: IndexedCapabilityOptions): SearchCapability {
  const manifest = options.manifest
  const codec = options.codec ?? createCursorCodec()
  const fuse = options.fuse ?? rrfFusion()
  const now = options.now ?? (() => Date.now())

  const capability: SearchCapability = {
    manifest,
    supports: options.supports ?? (query => query.raw.trim().length > 0),

    async search(query: SearchQuery, page: PageRequest, ctx: SearchContext): Promise<SearchPage> {
      const startedAt = now()
      const queryHash = hashQueryShape({
        raw: query.raw,
        intent: query.intent,
        filters: query.filters,
        level: query.ladder?.level ?? 0,
        generation: options.generation?.() ?? 0,
      })
      const offset = readOffsetCursor(codec, page.cursor, { capability: manifest.id, queryHash })

      // 多路融合要在同一批上做,所以各路都从头取 offset + limit 条再切。
      const window = { limit: offset + page.limit, offset: 0 }
      const results = await Promise.all(options.retrievers.map(async retriever => ({
        id: retriever.id,
        page: await retriever.retrieve(query, ctx, options.retrievers.length === 1
          ? { limit: page.limit, offset }
          : window),
      })))

      const single = options.retrievers.length === 1
      const fused = single
        ? [...(results[0]?.page.items ?? [])]
        : fuse(results.map(entry => ({ id: entry.id, items: entry.page.items })))
      const items = single ? fused : fused.slice(offset, offset + page.limit)
      const total = results.find(entry => entry.page.total !== undefined)?.page.total

      return paginate(items, page, {
        capability: manifest.id,
        codec,
        queryHash,
        total,
        offset,
      }, now() - startedAt)
    },
  }

  if (options.feed !== undefined) capability.feed = options.feed
  if (options.preview !== undefined) capability.preview = options.preview
  if (options.compare !== undefined) capability.compare = options.compare
  if (options.invoke !== undefined) capability.invoke = options.invoke
  return capability
}
