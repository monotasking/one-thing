/**
 * 向量召回:`SearchQuery` → 一句查询文本 → 嵌入 → KNN → 候选。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2(索引基座那一行)/ §4.4 轴 ③ /
 * §15.1 / §15.4
 *
 * 它与 `lexical-retriever.ts` 是**同一个位置的两条路**,区别只有一处:词法路问的是
 * 倒排,这一条问的是 `VectorIndex`。共同点比区别多,而且是要紧的那些:
 *  ① 授权是**查询的输入**(§6.4b)—— `query.filters` 原样进 `VectorSearchScope`,
 *     不许先 KNN 拿 k 条再过滤(那样授权范围外的候选先占掉名额,`total` 与
 *     「命中几条」当场变成假话);
 *  ② 候选长什么样是**能力**的事(`toCandidate`),core 不发明任何 target kind;
 *  ③ 打分走同一只 `applyRanking` —— 半衰 / facet 加权 / 字段置顶三格都是 manifest
 *     里的数据,这个文件里一个能力名都没有。
 *
 * **距离怎么变成分数**:`1 / (1 + distance)`(L2,越近越大,恒在 (0,1])。它与词法
 * 路的 BM25 不同量纲 —— 所以两路**不比分数**,融合走 RRF(只看名次,§4.2)。
 *
 * 一份文档可以有多段(§15.3 的 512 token 切段),KNN 会把同一份文档的几段都答回来。
 * 这里**按 docId 取最近的那一段**:候选是文档不是段,同一条消息不该在结果里出现两次。
 */

import type {
  Candidate,
  SearchContext,
  SearchQuery,
  TextRange,
} from '../candidate.js'
import type { CapabilityManifest } from '../capability.js'
import type { Embedder, IndexedDoc, VectorHit, VectorIndex } from '../index/types.js'
import { applyRanking } from './lexical-retriever.js'
import type { Retriever, RetrievedPage } from './indexed.js'

/** 这一路的召回器 id。`manifest.retrievers[id].when` 按它认路(§15.4)。 */
export const VECTOR_RETRIEVER_ID = 'vector'

export interface VectorHitContext {
  doc: IndexedDoc
  hit: VectorHit
  score: number
  /** 与词法路同形的一格;向量路没有「命中词」,恒空 */
  queryRanges: TextRange[]
  ctx: SearchContext
}

export interface VectorRetrieverOptions {
  manifest: CapabilityManifest
  index: VectorIndex
  docs: { get(docId: number): IndexedDoc | undefined }
  embedder: Embedder
  /**
   * KNN 取几条。缺省 `limit`;实现若做不到「过滤在 KNN 里」的会自己放大它
   * (runtime 的 sqlite 实现做得到,所以不放大 —— 见 `sqlite-vec.ts`)。
   */
  overfetch?: number
  toCandidate(context: VectorHitContext): Candidate
  now?: () => number
}

/** 查询串:AST 的原样文本。向量路要的是**一句自然语言**,不是切好的词元。 */
export function queryTextOf(query: SearchQuery): string {
  return query.raw.trim()
}

/** L2 距离 → (0,1] 的分数。 */
export function scoreOfDistance(distance: number): number {
  return 1 / (1 + Math.max(0, distance))
}

/** 同一份文档只留最近的那一段。KNN 已按距离升序,所以第一次见到就是最近的。 */
export function nearestPerDoc(hits: readonly VectorHit[]): VectorHit[] {
  const seen = new Set<number>()
  const out: VectorHit[] = []
  for (const hit of hits) {
    if (seen.has(hit.docId)) continue
    seen.add(hit.docId)
    out.push(hit)
  }
  return out
}

export function createVectorRetriever(options: VectorRetrieverOptions): Retriever {
  const manifest = options.manifest
  const now = options.now ?? (() => Date.now())

  return {
    id: VECTOR_RETRIEVER_ID,
    async retrieve(query: SearchQuery, ctx: SearchContext, page): Promise<RetrievedPage> {
      const text = queryTextOf(query)
      if (text.length === 0) return { items: [] }

      const [embedding] = await options.embedder.embed([text], 'query', ctx.signal)
      if (embedding === undefined) return { items: [] }

      const k = options.overfetch ?? (page.limit + page.offset)
      const ceiling = manifest.retrievers?.[VECTOR_RETRIEVER_ID]?.maxDistance
      const hits = nearestPerDoc(options.index.search(embedding, k, {
        capability: manifest.id,
        filters: query.filters,
      })).filter(hit => ceiling === undefined || hit.distance <= ceiling)

      const at = now()
      const items: Candidate[] = []
      for (const hit of hits.slice(page.offset, page.offset + page.limit)) {
        const doc = options.docs.get(hit.docId)
        if (doc === undefined) continue
        const base = scoreOfDistance(hit.distance)
        // 与词法路同一只打分器:半衰 / facet 加权 / 字段置顶都是 manifest 的数据。
        // `fields: []` —— 向量路不说「命中落在哪个字段」,所以 `pinFieldHit` 天然不触发。
        const score = applyRanking(
          { docId: hit.docId, score: base, matched: [], fields: [] },
          doc,
          manifest.ranking,
          at,
        )
        const candidate = options.toCandidate({ doc, hit, score, queryRanges: [], ctx })
        items.push(ctx.debug === true
          ? { ...candidate, explain: { retriever: VECTOR_RETRIEVER_ID, distance: hit.distance, base, score } }
          : candidate)
      }
      // `total` **不给** —— KNN 答的是「最近的 k 条」,它数不出「一共有多少条相似的」。
      // §7.3:不知道就别给。
      return { items }
    },
  }
}
