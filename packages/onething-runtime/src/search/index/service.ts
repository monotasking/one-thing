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
import type { IndexedDoc, LexicalHit } from '@onething/core/search'
import { applyRanking, collectQueryTerms, fieldWeights } from '@onething/core/search'

import type { IndexSearchRequest, IndexSearchResult, IndexStatus } from './worker-core.js'
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
