/**
 * 词法召回:`SearchQuery` + 阶梯 → `LexicalQuery` → 候选。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2(索引基座那一行)/ §6.3 / §6.5
 *
 * 它是索引型能力的第一路 retriever(第二路是 S7 的向量路)。三件事:
 * ① 用与文档侧**同一个分析器**切查询词(切法不同就等于没索引);
 * ② 按阶梯决定 AND / 短语相邻 / 至少命中几个;
 * ③ 缺省打分器只读 manifest 的 `ranking` 那格数据 —— core 里没有 role / title 这些词。
 *
 * 候选长什么样是能力的事:`toCandidate` 由能力提供,core 不发明任何 target kind。
 */

import type {
  Candidate,
  SearchContext,
  SearchQuery,
  TextRange,
} from '../candidate.js'
import type { CapabilityManifest, RankingDeclaration } from '../capability.js'
import type { AnalyzerRegistry } from '../analyzer/registry.js'
import type { Analyzer } from '../analyzer/types.js'
import type { DocTable, IndexedDoc, LexicalHit, LexicalQuery, LexicalSearcher, Vocabulary } from '../index/types.js'
import { collectQueryTerms } from '../pipeline/parse.js'
import type { ExpanderRegistry } from '../pipeline/expand.js'
import { expandTerm } from '../pipeline/expand.js'
import type { Retriever, RetrievedPage } from './indexed.js'

/**
 * 「某字段命中就置顶」的实现:加一个足够大的常数,而不是乘一个系数。
 * 置顶是硬规矩(设计原话「标题命中置顶」),乘系数只是「更靠前一点」,不是同一件事;
 * 而加常数之后分数仍是**一个**可比的数,cursor 与同分判据都不用为它开特例。
 */
export const PIN_FIELD_HIT_OFFSET = 1_000_000

const DAY_MS = 24 * 60 * 60 * 1000

export interface LexicalRetrieverIndex extends LexicalSearcher, Vocabulary, DocTable {}

export interface LexicalHitContext {
  doc: IndexedDoc
  hit: LexicalHit
  score: number
  /** 命中词在查询原串里的位置(高亮用) */
  queryRanges: TextRange[]
  ctx: SearchContext
}

export interface LexicalRetrieverOptions {
  manifest: CapabilityManifest
  index: LexicalRetrieverIndex
  analyzers: AnalyzerRegistry
  /** 查询侧用哪个分析器切词;缺省 = 注册表的兜底(composite) */
  queryAnalyzer?: string
  expanders?: ExpanderRegistry
  toCandidate(context: LexicalHitContext): Candidate
  now?: () => number
}

export function createLexicalRetriever(options: LexicalRetrieverOptions): Retriever {
  const manifest = options.manifest
  const fields = fieldWeights(manifest)
  const analyzer = options.analyzers.resolve(options.queryAnalyzer)
  const now = options.now ?? (() => Date.now())

  return {
    id: 'lexical',
    async retrieve(query, ctx, page): Promise<RetrievedPage> {
      const lexical = buildLexicalQuery(query, {
        manifest,
        fields,
        analyzer,
        vocabulary: options.index,
        expanders: options.expanders,
        limit: page.limit,
        offset: page.offset,
      })
      if (lexical.terms.length === 0 && lexical.phrases.length === 0) {
        return { items: [], total: 0 }
      }

      const result = options.index.search(lexical)
      const items: Candidate[] = []
      for (const hit of result.hits) {
        const doc = options.index.get(hit.docId)
        if (doc === undefined) continue
        const score = applyRanking(hit, doc, manifest.ranking, now())
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

/** 字段 → 权重。没声明 schema 的能力不该走索引基座,这里给一个空表让它自己发现。 */
export function fieldWeights(manifest: CapabilityManifest): Record<string, number> {
  const schema = manifest.schema ?? {}
  return Object.fromEntries(Object.entries(schema).map(([field, spec]) => [field, spec.weight]))
}

interface BuildOptions {
  manifest: CapabilityManifest
  fields: Record<string, number>
  analyzer: Analyzer
  vocabulary: Vocabulary
  expanders?: ExpanderRegistry
  limit: number
  offset: number
}

export function buildLexicalQuery(query: SearchQuery, options: BuildOptions): LexicalQuery {
  const { terms, phrases, excluded } = collectQueryTerms(query.ast)
  const ladder = query.ladder
  const fieldNames = Object.keys(options.fields)
  const expanders = options.expanders?.list() ?? []

  const analyzedTerms = terms.flatMap(term => options.analyzer.analyze(term.text))
  const lastIndex = analyzedTerms.length - 1

  const lexicalTerms = analyzedTerms.map((token, index) => ({
    alternatives: expanders.length === 0
      ? [{ term: token.text, weight: 1 }]
      : expandTerm(
        { text: token.text, last: index === lastIndex },
        expanders,
        options.vocabulary,
        { fields: fieldNames },
      ),
  }))

  const lexicalPhrases = phrases.map(phrase => {
    const tokens = options.analyzer.analyze(phrase.text)
    const base = tokens[0]?.position ?? 0
    return { terms: tokens.map(token => ({ term: token.text, offset: token.position - base })) }
  }).filter(phrase => phrase.terms.length > 0)

  const minShouldMatch = ladder === undefined
    ? lexicalTerms.length
    : Math.min(ladder.minShouldMatch, lexicalTerms.length)

  return {
    capability: options.manifest.id,
    terms: lexicalTerms,
    phrases: lexicalPhrases,
    excluded: excluded.flatMap(term => options.analyzer.analyze(term.text)).map(token => token.text),
    fields: options.fields,
    filters: query.filters,
    minShouldMatch,
    phraseAdjacent: ladder?.phraseAdjacent ?? true,
    limit: options.limit,
    offset: options.offset,
  }
}

/**
 * 缺省打分器。**只读 manifest.ranking 那格数据**:半衰、按 facet 值加权、某字段命中置顶。
 * 想改某一路怎么打分,改它自己的 manifest;想换整套打分,换一个 retriever。
 */
export function applyRanking(
  hit: LexicalHit,
  doc: IndexedDoc,
  ranking: RankingDeclaration | undefined,
  now: number,
): number {
  let score = hit.score
  if (ranking === undefined) return score

  if (ranking.halfLifeDays !== undefined && ranking.halfLifeDays > 0 && doc.time > 0) {
    const ageDays = Math.max(0, (now - doc.time) / DAY_MS)
    score *= Math.pow(2, -(ageDays / ranking.halfLifeDays))
  }

  for (const [facetKey, table] of Object.entries(ranking.boosts ?? {})) {
    const value = doc.facets[facetKey]
    if (value === undefined) continue
    const factor = table[String(value)]
    if (factor !== undefined) score *= factor
  }

  if (ranking.pinFieldHit !== undefined && hit.fields.includes(ranking.pinFieldHit)) {
    score += PIN_FIELD_HIT_OFFSET
  }

  return score
}

/** 命中词落在查询串的哪一段(壳画「为什么命中」时用;debug 之外不贵)。 */
function queryRangesFor(query: SearchQuery, hit: LexicalHit): TextRange[] {
  const { terms, phrases } = collectQueryTerms(query.ast)
  const matched = new Set(hit.matched)
  return [...terms, ...phrases]
    .filter(entry => [...matched].some(term => entry.text.includes(term)))
    .map(entry => entry.range)
}

