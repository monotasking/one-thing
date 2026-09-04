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
import type {
  CapabilityManifest,
  RetrieverPolicy,
  RetrieverWhen,
  SearchCapability,
} from '../capability.js'
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

/**
 * 「调用方明说要语义召回」的那一格。**它是查询级的一个开关,不是某个能力的 facet**
 * —— 壳的「语义」片、CLI 的 `--semantic` 都填它。放在 core 是因为流水线要认它,
 * 而它跟 `raw` / `intent` 一样属于查询自己的词汇表,不是任何能力的名字。
 */
export const SEMANTIC_FILTER_KEY = 'semantic'

/**
 * 这一路召回器这一次跑不跑(§15.4)。三条判据全读**查询自己的事实**:
 * 阶梯级数、调用方有没有明说、消费面是不是能力声明的那几个。
 */
export function retrieverRuns(
  policy: RetrieverPolicy | undefined,
  query: SearchQuery,
  ctx: SearchContext,
): boolean {
  const when: RetrieverWhen = policy?.when ?? 'always'
  if (when === 'always') return true
  if (when === 'relaxed') {
    // 严格档(level 0)不跑;走到 ② 及以后才加这一路 —— 词法严格档已经有答案时
    // 不必多花那 ~40ms(§15.4 的理由就是预算)。
    return (query.ladder?.level ?? 0) >= 1
  }
  if (query.filters[SEMANTIC_FILTER_KEY] === true) return true
  return (policy?.surfaces ?? []).includes(ctx.surface)
}

/**
 * 多路融合之后的 `total`。**宁可缺席,不许说谎**(§7.3「不知道就别给」)。
 *
 * 词法路数得出「一共有多少条命中」,KNN 数不出(它只答最近的 k 条)。两路都出了
 * 候选时,取词法那个数就会在「词法零命中、向量出了五条」这一形上写出
 * `total: 0` 配五条结果 —— 那是壳画分页时会当场露馅的假话。所以:出了候选的只有
 * 一路时用那一路的数,两路都出了候选就答「不知道」。
 */
function fusedTotal(
  results: ReadonlyArray<{ page: RetrievedPage }>,
): number | undefined {
  const contributing = results.filter(entry => entry.page.items.length > 0)
  if (contributing.length > 1) return undefined
  const one = contributing[0] ?? results[0]
  return one?.page.total
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

      // **这一次跑哪几路**(§15.4)。判据全在 manifest 那张表里,`indexed.ts` 只是读
      // 表然后算 —— 这个文件里既没有能力名,也没有召回器名。
      const running = options.retrievers.filter(retriever =>
        retrieverRuns(manifest.retrievers?.[retriever.id], query, ctx))

      // 多路融合要在同一批上做,所以各路都从头取 offset + limit 条再切。
      const window = { limit: offset + page.limit, offset: 0 }
      const results = await Promise.all(running.map(async retriever => ({
        id: retriever.id,
        page: await retriever.retrieve(query, ctx, running.length === 1
          ? { limit: page.limit, offset }
          : window),
      })))

      const single = results.length === 1
      const fused = single
        ? [...(results[0]?.page.items ?? [])]
        : fuse(results.map(entry => ({ id: entry.id, items: entry.page.items })))
      const items = single ? fused : fused.slice(offset, offset + page.limit)
      const total = fusedTotal(results)

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
