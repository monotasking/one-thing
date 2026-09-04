/**
 * 索引的三个接口:倒排 / 文档表 / 向量。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位 / §5.1 / §15.1
 *
 * **接口在 core,产品实现在 runtime**(SqliteIndex,node:sqlite FTS5)。core 里
 * 只有一份纯 TS 的 `MemoryIndex`,它是单测的替身,也是「换实现不改上层」的活证据:
 * 上层(索引基座的词法召回)只认这几个接口,谁来实现都一样。
 * `VectorIndex` S1 只定形,S7 才实现。
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

export interface VectorIndex {
  readonly dims: number
  upsert(docId: number, chunk: number, embedding: Float32Array): void
  remove(docId: number): void
  search(
    embedding: Float32Array,
    k: number,
    filter?: (doc: IndexedDoc) => boolean,
  ): Array<{ docId: number; distance: number }>
}

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
