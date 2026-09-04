/**
 * `MemoryIndex` —— 纯 TS 的倒排 + 文档表。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位 / §5.1 / §6.5
 *
 * 它**不是**产品实现(那是 runtime 的 SqliteIndex)。它有两个用处,都写在设计里:
 * 单测的替身,以及「换实现不改上层」的活证据 —— 上层只认 `InvertedIndex` /
 * `DocTable` / `LexicalSearcher` 三个接口,MemoryIndex 与 SqliteIndex 各答一份。
 * 不追求性能,但要正确:短语相邻、BM25 字段权重、facet 过滤、整键替换、墓碑
 * 这五件事在这里是真的做,不是意思意思。
 */

import type { DocPayload } from '../feed.js'
import type { AnalyzerRegistry } from '../analyzer/registry.js'
import { createDefaultAnalyzerRegistry } from '../analyzer/registry.js'
import { DEFAULT_NORMALIZERS, composeNormalizers } from '../analyzer/normalize.js'
import type { FieldSchema } from '../capability.js'
import type {
  DocTable,
  IndexWriter,
  IndexedDoc,
  InvertedIndex,
  LexicalHit,
  LexicalPhrase,
  LexicalQuery,
  LexicalResult,
  LexicalSearcher,
  Posting,
} from './types.js'
import { BM25_B, BM25_K1, matchesFacetFilters } from './types.js'

/** §5.5:单文档字段上限,超出只索引前这么多字,文档标 truncated。 */
export const DEFAULT_MAX_FIELD_CHARS = 200_000

export interface MemoryIndexOptions {
  analyzers?: AnalyzerRegistry
  maxFieldChars?: number
  /**
   * 文档侧的归一化。**必须与查询侧是同一条列表** —— parse 归一化了查询,索引不归一化
   * 文档,等于两侧切法不同,全角 / 大小写 / 零宽任一差异就是零命中(那正是病根 §1
   * 的最后一行)。缺省 = `DEFAULT_NORMALIZERS`。
   */
  normalize?: (text: string) => { text: string }
}

interface FieldPostings {
  /** term → docId → posting */
  terms: Map<string, Map<number, Posting>>
  lengthSum: number
  docCount: number
}

function compositeKey(capability: string, key: string): string {
  // U+0000 不会出现在能力 id 或 key 里,拼起来当 Map 键不会撞。
  return `${capability}\u0000${key}`
}

export class MemoryIndex implements InvertedIndex, DocTable, LexicalSearcher, IndexWriter {
  private readonly analyzers: AnalyzerRegistry
  private readonly maxFieldChars: number
  private readonly normalize: (text: string) => { text: string }
  private readonly schemas = new Map<string, Record<string, FieldSchema>>()
  private readonly docs = new Map<number, IndexedDoc>()
  private readonly byKeyIndex = new Map<string, number[]>()
  private readonly fields = new Map<string, FieldPostings>()
  private readonly docFieldLengths = new Map<number, Map<string, number>>()
  private readonly tombstonedKeys = new Set<string>()
  private nextDocId = 1

  constructor(options: MemoryIndexOptions = {}) {
    this.analyzers = options.analyzers ?? createDefaultAnalyzerRegistry()
    this.maxFieldChars = options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS
    this.normalize = options.normalize ?? composeNormalizers(DEFAULT_NORMALIZERS)
  }

  /** 字段 → 分析器 + 权重。数据来自 manifest.schema,索引不认识能力,只认这张表。 */
  setSchema(capability: string, schema: Record<string, FieldSchema>): void {
    this.schemas.set(capability, schema)
  }

  // ---- 写面 -------------------------------------------------------------

  replaceKey(capability: string, key: string, docs: readonly DocPayload[]): void {
    const composite = compositeKey(capability, key)
    this.removeKey(composite)
    this.tombstonedKeys.delete(composite)

    const docIds: number[] = []
    for (const payload of docs) {
      const docId = this.nextDocId
      this.nextDocId += 1
      const indexed = this.indexDocument(docId, payload)
      this.docs.set(docId, indexed)
      docIds.push(docId)
    }
    if (docIds.length > 0) this.byKeyIndex.set(composite, docIds)
  }

  tombstone(capability: string, key: string): void {
    const composite = compositeKey(capability, key)
    this.removeKey(composite)
    this.tombstonedKeys.add(composite)
  }

  /** feed 说「这把钥匙已不存在」时留下的记号;校对时读它,不再重折。 */
  isTombstoned(capability: string, key: string): boolean {
    return this.tombstonedKeys.has(compositeKey(capability, key))
  }

  tombstoneCount(): number {
    return this.tombstonedKeys.size
  }

  private removeKey(composite: string): void {
    const docIds = this.byKeyIndex.get(composite)
    if (docIds === undefined) return
    for (const docId of docIds) this.removeDoc(docId)
    this.byKeyIndex.delete(composite)
  }

  private removeDoc(docId: number): void {
    const lengths = this.docFieldLengths.get(docId)
    if (lengths !== undefined) {
      for (const [field, length] of lengths) {
        const postings = this.fields.get(field)
        if (postings === undefined) continue
        postings.lengthSum -= length
        postings.docCount -= 1
      }
    }
    for (const postings of this.fields.values()) {
      for (const [term, byDoc] of postings.terms) {
        if (byDoc.delete(docId) && byDoc.size === 0) postings.terms.delete(term)
      }
    }
    this.docFieldLengths.delete(docId)
    this.docs.delete(docId)
  }

  private indexDocument(docId: number, payload: DocPayload): IndexedDoc {
    const schema = this.schemas.get(payload.capability)
    const lengths = new Map<string, number>()
    let truncated = false

    for (const [field, rawValue] of Object.entries(payload.fields)) {
      const value = rawValue.length > this.maxFieldChars
        ? rawValue.slice(0, this.maxFieldChars)
        : rawValue
      if (value.length < rawValue.length) truncated = true

      const analyzer = this.analyzers.resolve(schema?.[field]?.analyzer)
      // 先归一化再切 —— 与查询侧同一条列表,同一个顺序。
      const tokens = analyzer.analyze(this.normalize(value).text)
      const postings = this.fieldPostings(field)

      for (const token of tokens) {
        let byDoc = postings.terms.get(token.text)
        if (byDoc === undefined) {
          byDoc = new Map<number, Posting>()
          postings.terms.set(token.text, byDoc)
        }
        const existing = byDoc.get(docId)
        if (existing === undefined) {
          byDoc.set(docId, { docId, tf: 1, positions: [token.position] })
        } else {
          existing.tf += 1
          existing.positions.push(token.position)
        }
      }

      lengths.set(field, tokens.length)
      postings.lengthSum += tokens.length
      postings.docCount += 1
    }

    this.docFieldLengths.set(docId, lengths)
    return truncated ? { ...payload, docId, truncated } : { ...payload, docId }
  }

  private fieldPostings(field: string): FieldPostings {
    let postings = this.fields.get(field)
    if (postings === undefined) {
      postings = { terms: new Map(), lengthSum: 0, docCount: 0 }
      this.fields.set(field, postings)
    }
    return postings
  }

  // ---- InvertedIndex ----------------------------------------------------

  postings(field: string, term: string): Posting[] {
    const byDoc = this.fields.get(field)?.terms.get(term)
    return byDoc === undefined ? [] : [...byDoc.values()]
  }

  docFreq(field: string, term: string): number {
    return this.fields.get(field)?.terms.get(term)?.size ?? 0
  }

  docCount(): number {
    return this.docs.size
  }

  fieldLength(docId: number, field: string): number {
    return this.docFieldLengths.get(docId)?.get(field) ?? 0
  }

  averageFieldLength(field: string): number {
    const postings = this.fields.get(field)
    if (postings === undefined || postings.docCount === 0) return 0
    return postings.lengthSum / postings.docCount
  }

  /** 词典区间展开(§6.2b 的 prefix expander 只看它)。返回按字典序,便于稳定。 */
  terms(field: string, prefix: string, limit: number): string[] {
    const postings = this.fields.get(field)
    if (postings === undefined) return []
    const matched: string[] = []
    for (const term of postings.terms.keys()) {
      if (term.startsWith(prefix)) matched.push(term)
    }
    matched.sort()
    return matched.slice(0, Math.max(0, limit))
  }

  /** 全字段词典:expander 不必知道能力用了哪些字段。 */
  fieldNames(): string[] {
    return [...this.fields.keys()]
  }

  // ---- DocTable ---------------------------------------------------------

  get(docId: number): IndexedDoc | undefined {
    return this.docs.get(docId)
  }

  byKey(capability: string, key: string): IndexedDoc[] {
    const docIds = this.byKeyIndex.get(compositeKey(capability, key)) ?? []
    return docIds.map(docId => this.docs.get(docId)).filter((doc): doc is IndexedDoc => doc !== undefined)
  }

  size(): number {
    return this.docs.size
  }

  // ---- LexicalSearcher --------------------------------------------------

  search(query: LexicalQuery): LexicalResult {
    const fieldNames = Object.keys(query.fields)
    const candidates = this.collectCandidates(query, fieldNames)
    const scored: LexicalHit[] = []

    for (const docId of candidates) {
      const doc = this.docs.get(docId)
      if (doc === undefined) continue
      if (query.capability !== undefined && doc.capability !== query.capability) continue
      if (!matchesFacetFilters(doc.facets, query.filters)) continue
      if (this.hasExcluded(docId, query.excluded, fieldNames)) continue

      const hit = this.scoreDoc(docId, query, fieldNames)
      if (hit !== undefined) scored.push(hit)
    }

    scored.sort((a, b) => (b.score - a.score) || (a.docId - b.docId))
    const offset = query.offset ?? 0
    return { hits: scored.slice(offset, offset + query.limit), total: scored.length }
  }

  private collectCandidates(query: LexicalQuery, fieldNames: string[]): Set<number> {
    const candidates = new Set<number>()
    const push = (term: string): void => {
      for (const field of fieldNames) {
        const byDoc = this.fields.get(field)?.terms.get(term)
        if (byDoc === undefined) continue
        for (const docId of byDoc.keys()) candidates.add(docId)
      }
    }
    for (const term of query.terms) {
      for (const alternative of term.alternatives) push(alternative.term)
    }
    for (const phrase of query.phrases) {
      for (const part of phrase.terms) push(part.term)
    }
    return candidates
  }

  private hasExcluded(docId: number, excluded: readonly string[], fieldNames: string[]): boolean {
    return excluded.some(term =>
      fieldNames.some(field => this.fields.get(field)?.terms.get(term)?.has(docId) === true))
  }

  private scoreDoc(
    docId: number,
    query: LexicalQuery,
    fieldNames: string[],
  ): LexicalHit | undefined {
    const matched: string[] = []
    const hitFields = new Set<string>()
    let score = 0
    let matchedTerms = 0

    for (const term of query.terms) {
      let best = 0
      let bestTerm: string | undefined
      for (const alternative of term.alternatives) {
        const contribution = this.scoreTerm(docId, alternative.term, query, fieldNames, hitFields)
        const weighted = contribution * alternative.weight
        if (weighted > best) {
          best = weighted
          bestTerm = alternative.term
        }
      }
      if (bestTerm !== undefined) {
        matchedTerms += 1
        matched.push(bestTerm)
        score += best
      }
    }

    if (matchedTerms < Math.min(query.minShouldMatch, query.terms.length)) return undefined

    for (const phrase of query.phrases) {
      const phraseFields = query.phraseAdjacent
        ? this.adjacentFields(docId, phrase, fieldNames)
        : this.containingFields(docId, phrase, fieldNames)
      if (phraseFields.length === 0) return undefined
      for (const field of phraseFields) hitFields.add(field)
      for (const part of phrase.terms) {
        matched.push(part.term)
        score += this.scoreTerm(docId, part.term, query, fieldNames, hitFields)
      }
    }

    if (matched.length === 0) return undefined
    return { docId, score, matched, fields: [...hitFields] }
  }

  private scoreTerm(
    docId: number,
    term: string,
    query: LexicalQuery,
    fieldNames: string[],
    hitFields: Set<string>,
  ): number {
    let total = 0
    for (const field of fieldNames) {
      const posting = this.fields.get(field)?.terms.get(term)?.get(docId)
      if (posting === undefined) continue
      hitFields.add(field)
      total += (query.fields[field] ?? 1) * this.bm25(docId, field, term, posting.tf)
    }
    return total
  }

  private bm25(docId: number, field: string, term: string, tf: number): number {
    const total = Math.max(1, this.docCount())
    const df = this.docFreq(field, term)
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
    const length = this.fieldLength(docId, field)
    const average = this.averageFieldLength(field) || 1
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (length / average))
    return idf * ((tf * (BM25_K1 + 1)) / denominator)
  }

  /**
   * 短语相邻:存在基点 b,使短语的每个 token 都出现在 b + 它的相对词位上。
   * 「身份牌」= 身份@0 + 份牌@1,文档里挨着才算;「份牌先发,身份后验」两个二元
   * 都在却不成基点,不命中 —— 这就是二元召回全、精确靠短语补回来的那一半。
   */
  private adjacentFields(docId: number, phrase: LexicalPhrase, fieldNames: string[]): string[] {
    const matched: string[] = []
    for (const field of fieldNames) {
      const positionsOf = (term: string): number[] =>
        this.fields.get(field)?.terms.get(term)?.get(docId)?.positions ?? []
      const [head, ...rest] = phrase.terms
      if (head === undefined) continue
      const headPositions = positionsOf(head.term)
      if (headPositions.length === 0) continue

      const found = headPositions.some(headPosition => {
        const base = headPosition - head.offset
        return rest.every(part => positionsOf(part.term).includes(base + part.offset))
      })
      if (found) matched.push(field)
    }
    return matched
  }

  /** 阶梯 ② 去掉相邻约束之后:短语退化成「这些词都在这一字段里」。 */
  private containingFields(docId: number, phrase: LexicalPhrase, fieldNames: string[]): string[] {
    return fieldNames.filter(field =>
      phrase.terms.every(part => this.fields.get(field)?.terms.get(part.term)?.has(docId) === true))
  }
}
