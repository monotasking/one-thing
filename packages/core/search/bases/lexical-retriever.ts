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
import type { DocTable, IndexedDoc, LexicalHit, LexicalPhrase, LexicalQuery, LexicalSearcher, Vocabulary } from '../index/types.js'
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

/**
 * `SearchQuery` → `LexicalQuery`。**「一个 AST 词摊成多个词元」的翻译就在这里**。
 *
 * 分析器把一个查询词切成几个词元是常态(`2026-09-05` → `2026` `09` `05`;
 * `身份牌` → `身份` `份牌`;`getUserProfile` → 整词 + 三段)。从前它们被摊成几个
 * **独立**的 `terms[]`,而 `minShouldMatch` 数的是 AST 里的词(1),`min(1, 3) = 1`
 * —— 严格档于是变成 OR:查 `2026-09-05` 把 `2026-09-06` 也召回,查 `身份牌` 把
 * `身份证` 也召回。旧的子串路不会这样,这是相对旧路的**过召回**(§2「找得到」不
 * 包括「多找到」)。
 *
 * 现在:`ladder.multiTokenTerms === 'phrase'`(①②)时,这样一个词翻成**一条短语**
 * —— 与用户手打 `"…"` 完全同一条翻译、同一个 `LexicalPhrase` 形状,所以两个索引
 * 实现(`MemoryIndex` / `SqliteIndex`)一个字都不用改:① `phraseAdjacent: true` 是
 * 相邻核验,② 降级成「这些词元同在一个字段里」(不要求顺序)。③④(`'split'`)照旧
 * 摊平,「至少一半的词」「任一词」这两句话到那时才数得着词元。
 *
 * 短语用的是**整份词元表**(含 camel 保留的那个整词),不是挑出来的一部分:
 * `SqliteIndex` 的相邻判据走 FTS 的 token 流先后,只有「查询侧切法与文档侧逐字
 * 相同」时两边才对得齐(见 `sqlite-index.ts` 文件头)。挑掉整词能让
 * `get user profile` 这种分写形也在①中,但会让两个实现在混排词上分家 —— 契约用
 * 例是同一份卷子,不许分家。分写形由 ③ 接住。
 *
 * 代价一条(明说):成了短语的那个词不再吃前缀展开(`LexicalPhrase` 没有
 * `alternatives` 这一格),所以边打边搜的 `getUse…` 在①②落空、由③接住。CJK 不受
 * 影响 —— 二元词元长度恒为 2,拿一个完整二元做前缀本来就只展开出它自己。
 */
export function buildLexicalQuery(query: SearchQuery, options: BuildOptions): LexicalQuery {
  const { terms, phrases, excluded } = collectQueryTerms(query.ast)
  const ladder = query.ladder
  const fieldNames = Object.keys(options.fields)
  const expanders = options.expanders?.list() ?? []

  const alternativesOf = (text: string, last: boolean): Array<{ term: string; weight: number }> =>
    expanders.length === 0
      ? [{ term: text, weight: 1 }]
      : expandTerm({ text, last }, expanders, options.vocabulary, { fields: fieldNames })

  // 短语的相对词位:以第一个词元为基点。用户手打的 `"…"` 与这里摊出来的多词元词
  // 共用它 —— 一处翻译,两个入口。
  const phraseOf = (tokens: ReturnType<Analyzer['analyze']>): LexicalPhrase => {
    const base = tokens[0]?.position ?? 0
    return { terms: tokens.map(token => ({ term: token.text, offset: token.position - base })) }
  }

  const analyzedByTerm = terms.map(term => options.analyzer.analyze(term.text))
  const keepWords = (ladder?.multiTokenTerms ?? 'phrase') === 'phrase'

  const lexicalTerms: LexicalQuery['terms'] = []
  const termPhrases: LexicalPhrase[] = []
  if (keepWords) {
    const lastIndex = analyzedByTerm.length - 1
    analyzedByTerm.forEach((tokens, index) => {
      if (tokens.length === 0) return
      // 摊成一个词元的词照旧是词(前缀展开、按 minShouldMatch 计数都不变);
      // 摊成两个以上的才成短语。
      if (tokens.length > 1) {
        termPhrases.push(phraseOf(tokens))
        return
      }
      lexicalTerms.push({ alternatives: alternativesOf(tokens[0]!.text, index === lastIndex) })
    })
  } else {
    const flat = analyzedByTerm.flat()
    flat.forEach((token, index) => {
      lexicalTerms.push({ alternatives: alternativesOf(token.text, index === flat.length - 1) })
    })
  }

  const lexicalPhrases = [
    ...phrases.map(phrase => phraseOf(options.analyzer.analyze(phrase.text))),
    ...termPhrases,
  ].filter(phrase => phrase.terms.length > 0)

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

