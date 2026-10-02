/**
 * 索引的**契约用例**:一份用例,两个实现各跑一遍。
 *
 * 设计:docs/design/search-index-2026-09.md §5.1 末句 ——「`MemoryIndex`(core,
 * 纯 TS)只为单测与**「换实现不改上层」的活证据**而存在」。S1 那句话当时只有一半
 * 是真的:用例只跑了 MemoryIndex,「换实现」这半边没人验。S3a 把 SqliteIndex
 * (`runtime/search/index/sqlite-index.ts`,node:sqlite FTS5)接上来,于是这个文件
 * 从 `memory-index.test.ts` 里抽出来 —— **用例语义一字未改**,只是把「哪一个索引」
 * 变成了参数。
 *
 * 两个实现要答同一份卷子的五件事(§5.1 那一行原话):短语相邻、BM25 字段权重、
 * facet 过滤、整键替换、墓碑。加上 S1 补的匹配语义(AND / 一半 / 词序 / NOT /
 * 归一化)与词典截断。**任何一条两边答得不一样,就说明「上层只认接口」这句话是假的。**
 *
 * 这个文件住 `__tests__/`,所以边界检查器 `checkCoreSearchNamesNoCapability`
 * 不看它(夹具与用例当然要拿真名字当证词)—— 不过它本来也只用中性名 alpha。
 */

import { describe, expect, it } from 'vitest'

import type { CapabilityManifest, FieldSchema } from '../capability.js'
import type { DocPayload } from '../feed.js'
import type { IndexedDoc, LexicalQuery, LexicalResult } from '../index/types.js'
import { matchesFacetFilter } from '../index/types.js'
import { compositeAnalyzer } from '../analyzer/composite.js'
import { createDefaultAnalyzerRegistry } from '../analyzer/registry.js'
import { buildLexicalQuery } from '../bases/lexical-retriever.js'
import { parse } from '../pipeline/parse.js'
import { plan } from '../pipeline/plan.js'
import { CAP_A, CORPUS_SIZE, corpusDocuments } from './unit-fixtures/corpus.js'
import { DEFAULT_SCHEMA } from './unit-fixtures/harness.js'

/**
 * 被测索引的形。它是 core 那四个接口(`InvertedIndex` / `DocTable` /
 * `LexicalSearcher` / `IndexWriter`)的合集,外加 `MemoryIndex` 自己那两只墓碑
 * 读数 —— 「这把钥匙死了没有」是 feed 校对要问的问题(§5.4「库里有、feed 说
 * 不存在的墓碑」),所以它是**契约的一部分**,不是某个实现的私货。
 */
export interface ContractIndex {
  replaceKey(capability: string, key: string, docs: readonly DocPayload[]): void
  tombstone(capability: string, key: string): void
  isTombstoned(capability: string, key: string): boolean
  tombstoneCount(): number
  search(query: LexicalQuery): LexicalResult
  get(docId: number): IndexedDoc | undefined
  byKey(capability: string, key: string): IndexedDoc[]
  size(): number
  postings(field: string, term: string): Array<{ docId: number }>
  terms(field: string, prefix: string, limit: number): string[]
  averageFieldLength(field: string): number
}

export interface ContractIndexOptions {
  documents?: readonly DocPayload[]
  schemas?: Record<string, Record<string, FieldSchema>>
  maxFieldChars?: number
}

/**
 * 造一个装好文档的索引。返回值带一只可选的 `close` —— SqliteIndex 持着文件句柄,
 * MemoryIndex 不持;契约不该因为这个差别而分叉,所以 `close` 可选、用例统一调。
 */
export type ContractIndexFactory = (
  options?: ContractIndexOptions,
) => ContractIndex & { close?(): void }

/** 把一句话切成短语的相对词位形(与查询侧一模一样的切法)。 */
function phraseOf(text: string): LexicalQuery['phrases'][number] {
  const tokens = compositeAnalyzer.analyze(text)
  const base = tokens[0]?.position ?? 0
  return { terms: tokens.map(token => ({ term: token.text, offset: token.position - base })) }
}

function termsOf(text: string): LexicalQuery['terms'] {
  return compositeAnalyzer.analyze(text).map(token => ({ alternatives: [{ term: token.text, weight: 1 }] }))
}

function query(overrides: Partial<LexicalQuery> = {}): LexicalQuery {
  return {
    capability: CAP_A,
    terms: [],
    phrases: [],
    excluded: [],
    fields: { title: 2, content: 1 },
    minShouldMatch: 0,
    phraseAdjacent: true,
    limit: 50,
    ...overrides,
  }
}

/**
 * 一份卷子,两个实现。`name` 只进 describe 的标题,用例本身不认识是谁在答。
 */
export function describeIndexContract(name: string, createIndex: ContractIndexFactory): void {
  /**
   * 用例里绝大多数只读,共用一份;要写的那几条自己 `createIndex()` 一份新的。
   * 收尾统一 `close()`(SqliteIndex 要关句柄,MemoryIndex 没有这一格)。
   */
  const index = createIndex()

  const keys = (result: { hits: Array<{ docId: number }> }): string[] =>
    result.hits.map(hit => index.get(hit.docId)!.key)

  /** 写用例里造的那些临时索引,用完就关。 */
  const withLocal = (
    options: ContractIndexOptions | undefined,
    body: (local: ContractIndex) => void,
  ): void => {
    const local = createIndex(options)
    try {
      body(local)
    } finally {
      local.close?.()
    }
  }

  describe(`${name} 短语相邻`, () => {
    it('「身份牌」= 身份 + 份牌 相邻,命中挨着写的那条', () => {
      const hits = keys(index.search(query({ phrases: [phraseOf('身份牌')] })))
      expect(hits).toContain('a-01')
    })

    it('「份牌先发,身份后验」两个二元都在却不相邻 —— 不命中', () => {
      const hits = keys(index.search(query({ phrases: [phraseOf('身份牌')] })))
      expect(hits).not.toContain('a-02')
      // 但它确实两个二元都有 —— 证明排除它靠的是相邻,不是缺词。
      expect(index.postings('content', '身份').some(posting => index.get(posting.docId)!.key === 'a-02')).toBe(true)
      expect(index.postings('content', '份牌').some(posting => index.get(posting.docId)!.key === 'a-02')).toBe(true)
    })

    it('去掉相邻约束(阶梯 ②)那条假阳性就回来了', () => {
      const hits = keys(index.search(query({ phrases: [phraseOf('身份牌')], phraseAdjacent: false })))
      expect(hits).toContain('a-02')
    })

    it('英文短语按词相邻', () => {
      expect(keys(index.search(query({ phrases: [phraseOf('brown fox')] })))).toContain('a-12')
      expect(keys(index.search(query({ phrases: [phraseOf('fox brown')] })))).not.toContain('a-12')
    })

    it('camel 拆出来的段与整词共位,短语判据一起答', () => {
      expect(keys(index.search(query({ phrases: [phraseOf('getUserProfile')] })))).toContain('a-05')
    })
  })

  /**
   * **一个查询词分析成多个词元时,严格档是一条相邻短语**(S3b 第二轮修,设计 §6.2)。
   *
   * `2026-09-05` 在查询 AST 里是**一个**词,分析器把它切成 `2026` `09` `05` 三个
   * 词元。从前的翻译把三个词元摊成三个独立的 `terms[]`,而 `minShouldMatch` 数的是
   * AST 里的词(1),`min(1, 3) = 1` —— 于是「①严格 = 全 AND」在这一形上实际是
   * **OR**,查 `2026-09-05` 把 `2026-09-06` 也召回。旧的子串路不会这样,这是相对旧
   * 路的过召回(§2「找得到」不包括「多找到」)。
   *
   * 这一组走的是**真流水线**(`parse` → `plan` → `buildLexicalQuery` → `search`):
   * 手拼 `LexicalQuery` 会把「一个 AST 词摊成几个词元」这件事本身绕过去,而它正是
   * 要考的东西。两个实现各答一遍,因为「短语」这一格在它们那里表示法不同
   * (MemoryIndex 按分析器词位,SqliteIndex 按 FTS token 流),判据必须同一。
   */
  describe(`${name} 一个查询词摊成多词元`, () => {
    const dated = (key: string, content: string): DocPayload => ({
      capability: CAP_A,
      key,
      time: 0,
      facets: {},
      fields: { content },
    })
    const documents = [
      dated('d-05', '会议纪要 2026-09-05 已经收尾'),
      dated('d-06', '会议纪要 2026-09-06 才开工'),
      dated('d-split', '排期表里写的是 05 09 2026 三个数分着写'),
    ]
    const manifest: CapabilityManifest = {
      id: CAP_A,
      labelKey: '',
      icon: '',
      kind: 'indexed',
      budget: { default: 50, timeoutMs: 0 },
      order: 0,
      schema: { content: { analyzer: 'composite', weight: 1 } },
    }
    const analyzers = createDefaultAnalyzerRegistry()

    /** 阶梯第 `level` 级下,这条查询在这个索引上命中哪几把钥匙。 */
    const hitsAt = (local: ContractIndex, raw: string, level: number): string[] => {
      const parsed = parse(raw)
      const step = plan(parsed)[level]!
      const lexical = buildLexicalQuery({ ...parsed, ladder: step }, {
        manifest,
        fields: { content: 1 },
        analyzer: analyzers.resolve(undefined),
        vocabulary: local,
        limit: 50,
        offset: 0,
      })
      return local.search(lexical).hits
        .map(hit => local.get(hit.docId)!.key)
        .sort()
    }

    it('分析器确实把它切成三个词元 —— 这一组的前提', () => {
      expect(compositeAnalyzer.analyze('2026-09-05').map(token => token.text))
        .toEqual(['2026', '09', '05'])
    })

    it('①严格:只中那一天(同月的隔壁天不进组)', () => {
      withLocal({ documents }, local => {
        expect(hitsAt(local, '2026-09-05', 0)).toEqual(['d-05'])
      })
    })

    it('②去相邻:分着写的那条也中(AND 不要求顺序);缺 `05` 的隔壁天仍不中', () => {
      withLocal({ documents }, local => {
        expect(hitsAt(local, '2026-09-05', 1)).toEqual(['d-05', 'd-split'])
      })
    })

    it('③摊成词元:隔壁天到这一级才回来(它有 2026 与 09)', () => {
      withLocal({ documents }, local => {
        expect(hitsAt(local, '2026-09-05', 2)).toEqual(['d-05', 'd-06', 'd-split'])
      })
    })

    it('camel 同理:①要整词命中,`get` 单独出现不算', () => {
      withLocal({
        documents: [
          dated('c-whole', '这里调用 getUserProfile 拿档案'),
          dated('c-part', '这里只有 get 与 profile 两个词'),
        ],
      }, local => {
        expect(hitsAt(local, 'getUserProfile', 0)).toEqual(['c-whole'])
        // ③ 摊成词元之后 `get` 那条才回来 —— 放宽是明说的,不是默默发生的。
        expect(hitsAt(local, 'getUserProfile', 2)).toEqual(['c-part', 'c-whole'])
      })
    })

    it('CJK 同理:「身份牌」不再顺带召回「身份证」', () => {
      withLocal({
        documents: [
          dated('k-pai', '身份牌已经私发四人了'),
          dated('k-zheng', '身份证还没有交上来'),
        ],
      }, local => {
        expect(hitsAt(local, '身份牌', 0)).toEqual(['k-pai'])
        expect(hitsAt(local, '身份牌', 2)).toEqual(['k-pai', 'k-zheng'])
      })
    })
  })

  describe(`${name} BM25 与字段权重`, () => {
    it('标题命中比正文命中分高(权重 2 : 1)', () => {
      const inTitle = index.search(query({ terms: termsOf('索引'), minShouldMatch: 1, fields: { title: 2, content: 1 } }))
      const scoreOf = (key: string): number =>
        inTitle.hits.find(hit => index.get(hit.docId)!.key === key)?.score ?? 0
      // a-19 标题正文都有「索引」,a-18 只有正文。
      expect(scoreOf('a-19')).toBeGreaterThan(scoreOf('a-18'))
    })

    it('把标题权重调到 0,标题那一路就不再贡献分数', () => {
      const withTitle = index.search(query({ terms: termsOf('索引'), minShouldMatch: 1 }))
      const withoutTitle = index.search(query({ terms: termsOf('索引'), minShouldMatch: 1, fields: { title: 0, content: 1 } }))
      const top = (result: typeof withTitle): number => result.hits[0]?.score ?? 0
      expect(top(withTitle)).toBeGreaterThan(top(withoutTitle))
    })

    it('词频高的排前面', () => {
      const result = index.search(query({ terms: termsOf('重要'), minShouldMatch: 1 }))
      expect(keys(result)[0]).toBe('a-25')
    })

    it('同分按 docId 升序 —— 确定性,cursor 才稳', () => {
      const first = index.search(query({ terms: termsOf('说明'), minShouldMatch: 1 }))
      const second = index.search(query({ terms: termsOf('说明'), minShouldMatch: 1 }))
      expect(keys(first)).toEqual(keys(second))
    })
  })

  describe(`${name} 匹配语义`, () => {
    it('AND:两个词都要在', () => {
      const both = index.search(query({ terms: termsOf('索引 重建'), minShouldMatch: 4 }))
      expect(keys(both)).toEqual(['a-19'])
    })

    it('至少命中一半(阶梯 ③)召回更多', () => {
      const strict = index.search(query({ terms: termsOf('索引 重建'), minShouldMatch: 4 }))
      const half = index.search(query({ terms: termsOf('索引 重建'), minShouldMatch: 1 }))
      expect(half.hits.length).toBeGreaterThan(strict.hits.length)
    })

    it('词序无关', () => {
      const a = index.search(query({ terms: termsOf('窗口 大小'), minShouldMatch: 4 }))
      const b = index.search(query({ terms: termsOf('大小 窗口'), minShouldMatch: 4 }))
      expect(new Set(keys(a))).toEqual(new Set(keys(b)))
      expect(keys(a).length).toBeGreaterThanOrEqual(2)
    })

    it('NOT:命中即出局', () => {
      const withCache = index.search(query({ terms: termsOf('索引'), minShouldMatch: 1 }))
      const without = index.search(query({ terms: termsOf('索引'), minShouldMatch: 1, excluded: ['缓存'] }))
      expect(keys(withCache)).toContain('a-18')
      expect(keys(without)).not.toContain('a-18')
    })

    it('全角与半角搜到同一条(文档侧已归一化)', () => {
      expect(keys(index.search(query({ terms: termsOf('abc123'), minShouldMatch: 1 })))).toContain('a-04')
    })

    it('大小写无关', () => {
      expect(keys(index.search(query({ terms: termsOf('HTTP'), minShouldMatch: 1 })))).toContain('a-06')
    })

    it('零宽字符不挡命中', () => {
      expect(keys(index.search(query({ terms: termsOf('零宽'), minShouldMatch: 1 })))).toContain('a-10')
    })

    it('换行不挡命中', () => {
      expect(keys(index.search(query({ terms: termsOf('第二行'), minShouldMatch: 1 })))).toContain('a-09')
    })
  })

  describe(`${name} facet 过滤`, () => {
    it('标量相等 / 数组属于 / 区间 / 取反', () => {
      expect(matchesFacetFilter('s1', 's1')).toBe(true)
      expect(matchesFacetFilter('s1', ['s1', 's2'])).toBe(true)
      expect(matchesFacetFilter(5, { gte: 1, lte: 10 })).toBe(true)
      expect(matchesFacetFilter(50, { gte: 1, lte: 10 })).toBe(false)
      expect(matchesFacetFilter('s3', { not: 's3' })).toBe(false)
      expect(matchesFacetFilter(undefined, { not: 's3' })).toBe(true)
    })

    it('空间过滤把另一个空间那条挡在外面', () => {
      const all = index.search(query({ terms: termsOf('身份牌'), minShouldMatch: 1 }))
      const scoped = index.search(query({ terms: termsOf('身份牌'), minShouldMatch: 1, filters: { space: 's1' } }))
      expect(keys(all)).toContain('a-17')
      expect(keys(scoped)).not.toContain('a-17')
      // total 是过滤之后的真数,不是过滤之前的。
      expect(scoped.total).toBeLessThan(all.total)
    })

    it('归档那条默认在,过滤片一挂就没了', () => {
      const withArchived = index.search(query({ terms: termsOf('归档'), minShouldMatch: 1 }))
      const without = index.search(query({ terms: termsOf('归档'), minShouldMatch: 1, filters: { archived: false } }))
      expect(keys(withArchived)).toContain('a-15')
      expect(keys(without)).not.toContain('a-15')
    })
  })

  describe(`${name} 整键替换与墓碑`, () => {
    it('整键替换幂等:替两次与替一次的读数逐字同', () => {
      withLocal(undefined, local => {
        const docs = corpusDocuments().filter(doc => doc.key === 'a-01')
        const before = local.search(query({ terms: termsOf('身份牌'), minShouldMatch: 1 })).total
        local.replaceKey(CAP_A, 'a-01', docs)
        local.replaceKey(CAP_A, 'a-01', docs)
        expect(local.search(query({ terms: termsOf('身份牌'), minShouldMatch: 1 })).total).toBe(before)
        expect(local.size()).toBe(CORPUS_SIZE)
      })
    })

    it('替换后旧内容搜不到、新内容搜得到', () => {
      withLocal(undefined, local => {
        local.replaceKey(CAP_A, 'a-01', [{
          capability: CAP_A,
          key: 'a-01',
          time: 1,
          facets: { space: 's1', role: 'user', archived: false },
          fields: { title: '改过的标题', content: '换成了完全不同的内容' },
        }])
        expect(local.search(query({ terms: termsOf('私发'), minShouldMatch: 1 })).hits).toHaveLength(0)
        expect(local.search(query({ terms: termsOf('改过'), minShouldMatch: 1 })).hits).toHaveLength(1)
      })
    })

    it('墓碑:文档没了、倒排也没了、钥匙记着已死', () => {
      withLocal(undefined, local => {
        expect(local.byKey(CAP_A, 'a-01')).toHaveLength(1)
        local.tombstone(CAP_A, 'a-01')
        expect(local.byKey(CAP_A, 'a-01')).toHaveLength(0)
        expect(local.isTombstoned(CAP_A, 'a-01')).toBe(true)
        expect(local.tombstoneCount()).toBe(1)
        expect(local.size()).toBe(CORPUS_SIZE - 1)
        expect(local.search(query({ terms: termsOf('私发'), minShouldMatch: 1 })).hits).toHaveLength(0)
      })
    })

    it('墓碑之后再整键替换,记号撤销', () => {
      withLocal(undefined, local => {
        local.tombstone(CAP_A, 'a-01')
        local.replaceKey(CAP_A, 'a-01', corpusDocuments().filter(doc => doc.key === 'a-01'))
        expect(local.isTombstoned(CAP_A, 'a-01')).toBe(false)
        expect(local.search(query({ terms: termsOf('私发'), minShouldMatch: 1 })).hits).toHaveLength(1)
      })
    })

    it('删掉一条之后平均字段长度跟着变(统计没有留在原地)', () => {
      withLocal(undefined, local => {
        const before = local.averageFieldLength('content')
        local.tombstone(CAP_A, 'a-26')
        expect(local.averageFieldLength('content')).not.toBe(before)
      })
    })
  })

  describe(`${name} 词典与截断`, () => {
    it('前缀区间展开返回字典序', () => {
      expect(index.terms('content', 'search', 10)).toEqual(['search', 'searchable', 'searched', 'searching'])
    })

    it('上限生效', () => {
      expect(index.terms('content', 'search', 2)).toHaveLength(2)
    })

    it('超长字段截断并标 truncated', () => {
      withLocal({ documents: [], maxFieldChars: 10 }, small => {
        small.replaceKey(CAP_A, 'long', [{
          capability: CAP_A,
          key: 'long',
          time: 1,
          facets: {},
          fields: { content: '一'.repeat(50) },
        }])
        expect(small.byKey(CAP_A, 'long')[0]!.truncated).toBe(true)
      })
    })
  })
}

/** 契约用例默认装的那张 schema —— 两个实现都从这里取,免得一边 2:1 一边 1:1。 */
export { DEFAULT_SCHEMA }
