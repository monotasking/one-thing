/**
 * `SearchIndexService` —— 主线程门面 + 索引型能力的那一路 retriever。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位(「`SearchIndexService`(主线程
 * 门面,只认 worker-host)」)+ §4.2 索引基座那一行。
 *
 * 门面很薄,薄是有意的:**它只认 `IndexWorkerHost`**,不认识 sqlite、不认识 feed、
 * 不认识投影。于是「索引跑在哪条线程上」「崩了怎么办」全在 host 那一层,而
 * 「谁来问索引」全在这一层,两件事各有一个产地。
 *
 * `createSqliteLexicalRetriever(service, …)` 产出的是一只 core 的 `Retriever` ——
 * S3b 把它塞进 `indexedCapability({ retrievers: [它] })`,messages / chats / daily
 * 三路于是从 scan 基座换成索引基座,而**上层一个字不改**(§4.2「只有一路时 fuse
 * 是恒等」,所以 S7 加向量路也不会改写今天的读数)。
 */

import type {
  Candidate,
  CapabilityManifest,
  RetrievedPage,
  Retriever,
  SearchContext,
  SearchQuery,
  TextRange,
} from '@onething/core/search'
import type { IndexedDoc, LexicalHit, VectorHit } from '@onething/core/search'
import {
  VECTOR_RETRIEVER_ID,
  applyRanking,
  collectQueryTerms,
  fieldWeights,
  nearestPerDoc,
  queryTextOf,
  scoreOfDistance,
} from '@onething/core/search'

import type {
  IndexSearchRequest,
  IndexSearchResult,
  IndexStatus,
  IndexVectorSearchRequest,
  IndexVectorSearchResult,
} from './worker-core.js'
import type { IndexWorkerFactory } from './worker-host.js'
import { IndexWorkerHost } from './worker-host.js'

export interface SearchIndexServiceOptions {
  /** 「怎么造 Worker」。真宿主起 `worker_threads.Worker`;单测同线程跑 core。 */
  createWorker: IndexWorkerFactory
}

export class SearchIndexService {
  private readonly host: IndexWorkerHost

  constructor(options: SearchIndexServiceOptions) {
    this.host = new IndexWorkerHost(options.createWorker)
  }

  start(): void {
    this.host.start()
  }

  async dispose(): Promise<void> {
    await this.host.dispose()
  }

  search(request: IndexSearchRequest): Promise<IndexSearchResult> {
    return this.host.search(request)
  }

  /** 向量召回(S7)。查询嵌入也在 Worker 里做 —— 主线程不碰 wasm(§15.2)。 */
  vectorSearch(request: IndexVectorSearchRequest): Promise<IndexVectorSearchResult> {
    return this.host.vectorSearch(request)
  }

  /** 观察者那一路的入口:一条事件喊一声 key(§5.3)。 */
  enqueue(feedId: string, key: string, hint?: unknown): Promise<void> {
    return this.host.enqueue(feedId, key, hint)
  }

  /** 队列排空再答。「刚发的消息搜得到吗」这类判定与单测用。 */
  drain(): Promise<void> {
    return this.host.drain()
  }

  rebuild(): Promise<void> {
    return this.host.rebuild()
  }

  status(): Promise<IndexStatus> {
    return this.host.status()
  }
}

export interface SqliteLexicalRetrieverOptions {
  manifest: CapabilityManifest
  service: Pick<SearchIndexService, 'search'>
  /** 候选长什么样是**能力**的事;core 不发明任何 target kind。 */
  toCandidate(context: {
    doc: IndexedDoc
    hit: LexicalHit
    score: number
    queryRanges: TextRange[]
    ctx: SearchContext
  }): Candidate
  now?: () => number
}

/**
 * 索引型能力的词法召回路 —— 与 core 的 `createLexicalRetriever` 同一个位置,区别
 * 只有一处:**索引在另一条线程上**,所以它是异步的,而且不在这一侧拼
 * `LexicalQuery`(词典要用来做前缀展开,而词典跟着索引走 —— 详见
 * `worker-core.ts` 的 `IndexSearchRequest` 注释)。
 *
 * 打分仍然走 core 的 `applyRanking`:半衰、按 facet 值加权、某字段命中置顶三格
 * 全是 `manifest.ranking` 里的**数据**,这一侧一个能力名都没有。
 */
export function createSqliteLexicalRetriever(options: SqliteLexicalRetrieverOptions): Retriever {
  const manifest = options.manifest
  const fields = fieldWeights(manifest)
  const now = options.now ?? (() => Date.now())

  return {
    id: 'lexical',
    async retrieve(query: SearchQuery, ctx: SearchContext, page): Promise<RetrievedPage> {
      const request: IndexSearchRequest = {
        capability: manifest.id,
        fields,
        ast: query.ast,
        filters: query.filters,
        ...(query.ladder !== undefined ? { ladder: query.ladder } : {}),
        limit: page.limit,
        offset: page.offset,
      }
      const result = await options.service.search(request)
      const byDocId = new Map(result.docs.map(doc => [doc.docId, doc]))
      const at = now()

      const items: Candidate[] = []
      for (const hit of result.hits) {
        const doc = byDocId.get(hit.docId)
        if (doc === undefined) continue
        const score = applyRanking(hit, doc, manifest.ranking, at)
        const candidate = options.toCandidate({
          doc,
          hit,
          score,
          queryRanges: queryRangesFor(query, hit),
          ctx,
        })
        items.push(ctx.debug === true
          ? { ...candidate, explain: { base: hit.score, score, matched: hit.matched, fields: hit.fields } }
          : candidate)
      }
      return { items, total: result.total }
    },
  }
}

/**
 * 命中词落在查询串的哪一段(壳画「为什么命中」时用)。与
 * `core/search/bases/lexical-retriever.ts` 里那只同名私有函数**同一条判据** ——
 * 它没有导出,所以这里照抄了六行;两边都只读 `hit.matched` 与 AST,不会分家。
 */
function queryRangesFor(query: SearchQuery, hit: LexicalHit): TextRange[] {
  const { terms, phrases } = collectQueryTerms(query.ast)
  const matched = new Set(hit.matched)
  return [...terms, ...phrases]
    .filter(entry => [...matched].some(term => entry.text.includes(term)))
    .map(entry => entry.range)
}


export interface SqliteVectorRetrieverOptions {
  manifest: CapabilityManifest
  service: Pick<SearchIndexService, 'vectorSearch'>
  /** 候选长什么样是**能力**的事;core 不发明任何 target kind。 */
  toCandidate(context: {
    doc: IndexedDoc
    hit: VectorHit
    score: number
    ctx: SearchContext
  }): Candidate
  /**
   * KNN 取几条。缺省 = `offset + limit`。**不放大** —— 授权是 `docId IN (子查询)`
   * 下推进 KNN 的(见 `sqlite-vec.ts` 的读数表),范围外的候选根本不占名额,所以
   * 不需要「多取几条再筛」那种补偿。
   */
  overfetch?: number
  now?: () => number
}

/**
 * 索引型能力的**向量召回路**(S7)—— 与 `createSqliteLexicalRetriever` 同一个位置的
 * 第二条路,区别只有一处:它问的是 `vec_docs` 的 KNN,不是倒排。
 *
 * 与 core 的 `createVectorRetriever` 是同一份判据的两种装法(那一份认同步的
 * `VectorIndex`,单测用;这一份走 postMessage,真宿主用),三件共用的算术
 * ——`nearestPerDoc` / `scoreOfDistance` / `applyRanking`——都从 core 取,不在这边
 * 抄第二遍。
 *
 * **跑不跑不由它决定**:`indexedCapability` 读 `manifest.retrievers.vector.when`
 * 决定这一次要不要调它(§15.4)。它被调到了就老实答,答不了就答空 + 一句 explain。
 */
export function createSqliteVectorRetriever(options: SqliteVectorRetrieverOptions): Retriever {
  const manifest = options.manifest
  const now = options.now ?? (() => Date.now())

  return {
    id: VECTOR_RETRIEVER_ID,
    async retrieve(query: SearchQuery, ctx: SearchContext, page): Promise<RetrievedPage> {
      const text = queryTextOf(query)
      if (text.length === 0) return { items: [] }

      const request: IndexVectorSearchRequest = {
        capability: manifest.id,
        text,
        ...(query.filters !== undefined ? { filters: query.filters } : {}),
        k: options.overfetch ?? (page.limit + page.offset),
      }
      const result = await options.service.vectorSearch(request)
      // 向量路没准备好 = 这一路没有话说,不是「零命中」。融合那边少一路而已。
      if (result.unavailable !== undefined && result.hits.length === 0) return { items: [] }

      const byDocId = new Map(result.docs.map(doc => [doc.docId, doc]))
      const at = now()
      const items: Candidate[] = []
      // 距离上限由**能力自述**(`manifest.retrievers.vector.maxDistance`);缺席 =
      // 不设限,那正是今天的默认档(理由见 core 那一格的注释与 §13 留账)。
      const ceiling = manifest.retrievers?.[VECTOR_RETRIEVER_ID]?.maxDistance
      const within = nearestPerDoc(result.hits)
        .filter(hit => ceiling === undefined || hit.distance <= ceiling)
      for (const hit of within.slice(page.offset, page.offset + page.limit)) {
        const doc = byDocId.get(hit.docId)
        if (doc === undefined) continue
        const base = scoreOfDistance(hit.distance)
        // 与词法路同一只打分器。`fields: []` —— 向量路不说命中落在哪个字段,
        // 于是 `pinFieldHit` 天然不触发。
        const score = applyRanking(
          { docId: hit.docId, score: base, matched: [], fields: [] },
          doc,
          manifest.ranking,
          at,
        )
        const candidate = options.toCandidate({ doc, hit, score, ctx })
        items.push(ctx.debug === true
          ? { ...candidate, explain: { retriever: VECTOR_RETRIEVER_ID, distance: hit.distance, base, score } }
          : candidate)
      }
      // `total` 不给:KNN 数不出「一共有多少条相似的」(§7.3 不知道就别给)。
      return { items }
    },
  }
}
