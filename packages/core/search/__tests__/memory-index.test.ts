import { describe, expect, it } from 'vitest'

import { MemoryIndex } from '../index/memory-index.js'
import { matchesFacetFilter } from '../index/types.js'
import type { LexicalQuery } from '../index/types.js'
import { compositeAnalyzer } from '../analyzer/composite.js'
import { CAP_A, CORPUS_SIZE, corpusDocuments } from './unit-fixtures/corpus.js'
import { DEFAULT_SCHEMA, buildIndex } from './unit-fixtures/harness.js'

const index = buildIndex(corpusDocuments())

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

function keys(result: { hits: Array<{ docId: number }> }): string[] {
  return result.hits.map(hit => index.get(hit.docId)!.key)
}

describe('MemoryIndex 短语相邻', () => {
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

describe('MemoryIndex BM25 与字段权重', () => {
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

describe('MemoryIndex 匹配语义', () => {
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

describe('MemoryIndex facet 过滤', () => {
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

describe('MemoryIndex 整键替换与墓碑', () => {
  it('整键替换幂等:替两次与替一次的读数逐字同', () => {
    const local = buildIndex(corpusDocuments())
    const docs = corpusDocuments().filter(doc => doc.key === 'a-01')
    const before = local.search(query({ terms: termsOf('身份牌'), minShouldMatch: 1 })).total
    local.replaceKey(CAP_A, 'a-01', docs)
    local.replaceKey(CAP_A, 'a-01', docs)
    expect(local.search(query({ terms: termsOf('身份牌'), minShouldMatch: 1 })).total).toBe(before)
    expect(local.size()).toBe(CORPUS_SIZE)
  })

  it('替换后旧内容搜不到、新内容搜得到', () => {
    const local = buildIndex(corpusDocuments())
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

  it('墓碑:文档没了、倒排也没了、钥匙记着已死', () => {
    const local = buildIndex(corpusDocuments())
    expect(local.byKey(CAP_A, 'a-01')).toHaveLength(1)
    local.tombstone(CAP_A, 'a-01')
    expect(local.byKey(CAP_A, 'a-01')).toHaveLength(0)
    expect(local.isTombstoned(CAP_A, 'a-01')).toBe(true)
    expect(local.tombstoneCount()).toBe(1)
    expect(local.size()).toBe(CORPUS_SIZE - 1)
    expect(local.search(query({ terms: termsOf('私发'), minShouldMatch: 1 })).hits).toHaveLength(0)
  })

  it('墓碑之后再整键替换,记号撤销', () => {
    const local = buildIndex(corpusDocuments())
    local.tombstone(CAP_A, 'a-01')
    local.replaceKey(CAP_A, 'a-01', corpusDocuments().filter(doc => doc.key === 'a-01'))
    expect(local.isTombstoned(CAP_A, 'a-01')).toBe(false)
    expect(local.search(query({ terms: termsOf('私发'), minShouldMatch: 1 })).hits).toHaveLength(1)
  })

  it('删掉一条之后平均字段长度跟着变(统计没有留在原地)', () => {
    const local = buildIndex(corpusDocuments())
    const before = local.averageFieldLength('content')
    local.tombstone(CAP_A, 'a-26')
    expect(local.averageFieldLength('content')).not.toBe(before)
  })
})

describe('MemoryIndex 词典与截断', () => {
  it('前缀区间展开返回字典序', () => {
    expect(index.terms('content', 'search', 10)).toEqual(['search', 'searchable', 'searched', 'searching'])
  })

  it('上限生效', () => {
    expect(index.terms('content', 'search', 2)).toHaveLength(2)
  })

  it('超长字段截断并标 truncated', () => {
    const small = new MemoryIndex({ maxFieldChars: 10 })
    small.setSchema(CAP_A, DEFAULT_SCHEMA)
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
