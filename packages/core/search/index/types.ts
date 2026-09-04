/**
 * 索引的三个接口:倒排 / 文档表 / 向量。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位 / §5.1 / §15.1
 *
 * **接口在 core,产品实现在 runtime**(SqliteIndex,node:sqlite FTS5)。core 里
 * 只有一份纯 TS 的 `MemoryIndex`,它是单测的替身,也是「换实现不改上层」的活证据:
 * 上层(索引基座的词法召回)只认这几个接口,谁来实现都一样。
 * `VectorIndex` / `Embedder` S1 只定形,S7 接上真实现(sqlite-vec + wasm 嵌入器)。
 */

import type { FacetFilter, FacetValue } from '../candidate.js'
import type { DocPayload } from '../feed.js'

/** 一条倒排项。positions 让短语相邻成为可能。 */
export interface Posting {
  docId: number
  /** 词频 */
  tf: number
  positions: number[]
}

export interface IndexedDoc extends DocPayload {
  docId: number
  /** 超过分析器单文档上限时截断过(§5.5) */
  truncated?: boolean
}

/** 词典视图 —— expander 只看它,不看文档(§6.2b)。 */
export interface Vocabulary {
  terms(field: string, prefix: string, limit: number): string[]
}

export interface InvertedIndex extends Vocabulary {
  postings(field: string, term: string): Posting[]
  docFreq(field: string, term: string): number
  /** 活文档数(墓碑不算) */
  docCount(): number
  fieldLength(docId: number, field: string): number
  averageFieldLength(field: string): number
}

export interface DocTable {
  get(docId: number): IndexedDoc | undefined
  byKey(capability: string, key: string): IndexedDoc[]
  size(): number
}

/**
 * 一次向量召回的**范围** —— 与词法路的 `LexicalQuery.filters` 逐字同一种东西。
 *
 * S1 把这一格写成 `filter?: (doc) => boolean`。S7 真接上去才发现那个形是错的:
 * 谓词是**结果过滤**,而 §6.4b 立的法是「授权是查询的输入,不是结果的过滤」——
 * 一个闭包过不了 SQL 的 WHERE,只能先 KNN 拿 k 条、再挨个问谓词,于是授权范围外
 * 的候选先占掉了 k 个名额。改成与词法路同形的 facet 表之后,两条召回路问索引的
 * 是同一句话,授权在 KNN 里就已经生效(实测:vec0 把 `docId IN (子查询)` 下推进
 * KNN 扫描,而 SQL 的 JOIN 则是后过滤 —— 见 `sqlite-vec.ts` 的读数)。
 */
export interface VectorSearchScope {
  capability?: string
  /** 键由能力声明,core 只按形状比对(与 `LexicalQuery.filters` 同一份形) */
  filters?: Record<string, FacetFilter>
}

/** 一段命中。`chunk` 是切段序号 —— 同一份文档可以有多段,取最近的那一段。 */
export interface VectorHit {
  docId: number
  chunk: number
  /** 越小越近(L2)。打分时取 `1 / (1 + distance)`,不在这里换算。 */
  distance: number
}

export interface VectorIndex {
  readonly dims: number
  upsert(docId: number, chunk: number, embedding: Float32Array): void
  /** 这份文档的全部段一起删。 */
  remove(docId: number): void
  /** 全清(换模型时用:`meta.embeddingModelId` 不符 → 清空重嵌,§5.4)。 */
  clear(): void
  /** 已嵌进去几段(`status.vector` 那一路的读数)。 */
  size(): number
  search(embedding: Float32Array, k: number, scope?: VectorSearchScope): VectorHit[]
}

/**
 * 嵌入器(§15.3)。**模型是数据,嵌入器是注册表里的一条**。
 *
 * 三件事全在这一份接口里,调用方一件都不用记:
 *  - `dims` 由嵌入器说(库里 `vec_docs` 的维度跟着它建,不写死);
 *  - `ready()` 负责下载 / 装载,幂等,进度由实现自己上报;
 *  - `embed()` 收一批文本答一批向量。**e5 那种要 `query:` / `passage:` 前缀的
 *    模型,前缀由嵌入器自己贴**(所以有 `kind` 这一格)—— 让调用方记前缀就是
 *    把模型的知识漏到外面。
 */
export interface Embedder {
  readonly id: string
  readonly dims: number
  /** 单段最多几个 token(切段判据;假嵌入器按字数近似)。 */
  readonly maxTokens: number
  ready(signal?: AbortSignal): Promise<void>
  embed(texts: readonly string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]>
  /** 一段文本按这个嵌入器的分词器有多少 token(切段用)。 */
  countTokens(text: string): number
}

/** 嵌的是一条查询还是一段正文 —— 非对称模型(e5 / bge)靠它贴前缀。 */
export type EmbedKind = 'query' | 'passage'

/** 一个查询词及其展开出来的同类项(expander 的产物,权重进打分)。 */
export interface LexicalTerm {
  alternatives: Array<{ term: string; weight: number }>
}

/** 短语:每个 token 记相对词位,判据是「存在基点 b 使每个 token 落在 b + offset」。 */
export interface LexicalPhrase {
  terms: Array<{ term: string; offset: number }>
}

export interface LexicalQuery {
  capability?: string
  terms: LexicalTerm[]
  phrases: LexicalPhrase[]
  /** NOT:命中即出局 */
  excluded: string[]
  /** 字段 → 权重(来自 manifest.schema) */
  fields: Record<string, number>
  /** 键由能力声明,core 只按形状比对 */
  filters?: Record<string, FacetFilter>
  /** 至少要命中几个 terms(阶梯 ③ 给一半) */
  minShouldMatch: number
  /** 阶梯 ① true;② 起短语降级成普通词 */
  phraseAdjacent: boolean
  limit: number
  offset?: number
}

export interface LexicalHit {
  docId: number
  score: number
  /** 命中了哪些词(explain 与摘要用) */
  matched: string[]
  /** 命中落在哪些字段(manifest.ranking.pinFieldHit 读它) */
  fields: string[]
}

export interface LexicalResult {
  hits: LexicalHit[]
  /** 授权之后的真数(§6.4b) */
  total: number
}

export interface LexicalSearcher {
  search(query: LexicalQuery): LexicalResult
}

/** 写面:整键替换与墓碑(§5.2b「整键替换,幂等」)。 */
export interface IndexWriter {
  replaceKey(capability: string, key: string, docs: readonly DocPayload[]): void
  tombstone(capability: string, key: string): void
}

/** BM25 的两个常数(§6.5):FTS5 的 bm25() 用的也是这一对。 */
export const BM25_K1 = 1.2
export const BM25_B = 0.75

/** facet 过滤的判据。core 只认形状,不认识任何键名。 */
export function matchesFacetFilter(value: FacetValue | undefined, filter: FacetFilter): boolean {
  if (Array.isArray(filter)) return value !== undefined && filter.includes(value)
  if (filter !== null && typeof filter === 'object') {
    if ('not' in filter) {
      const excluded = Array.isArray(filter.not) ? filter.not : [filter.not]
      return value === undefined || !excluded.includes(value)
    }
    if (typeof value !== 'number') return false
    if (filter.gte !== undefined && value < filter.gte) return false
    if (filter.lte !== undefined && value > filter.lte) return false
    return true
  }
  return value === filter
}

export function matchesFacetFilters(
  facets: Record<string, FacetValue>,
  filters: Record<string, FacetFilter> | undefined,
): boolean {
  if (filters === undefined) return true
  for (const [key, filter] of Object.entries(filters)) {
    if (!matchesFacetFilter(facets[key], filter)) return false
  }
  return true
}
