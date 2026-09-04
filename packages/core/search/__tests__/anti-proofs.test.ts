/**
 * §11 S1 的四条反证:**拆掉即红**。
 *
 * 每一条都用注入点或开关把那件机制拆掉,再断言病状当场回来 —— 不改产品代码。
 * 反过来读:这四个 `it` 各自证明「那行代码不是摆设」。
 */

import { describe, expect, it } from 'vitest'

import type { LexicalQuery } from '../index/types.js'
import { compositeAnalyzer } from '../analyzer/composite.js'
import {
  DEFAULT_NORMALIZERS,
  cjkPunctuationNormalizer,
  collapseWhitespaceNormalizer,
  composeNormalizers,
  nfkcNormalizer,
  stripZeroWidthNormalizer,
} from '../analyzer/normalize.js'
import { MemoryIndex } from '../index/memory-index.js'
import { createDefaultAnalyzerRegistry } from '../analyzer/registry.js'
import { PREFIX_EXPANSION_LIMIT, createPrefixExpander, expandTerm } from '../pipeline/expand.js'
import { createCursorCodec, hashQueryShape } from '../cursor.js'
import { OFFSET_CURSOR_KIND, readOffsetCursor } from '../pipeline/page.js'
import { CAP_A, CORPUS_NOW, corpusDocuments } from './unit-fixtures/corpus.js'
import { DEFAULT_SCHEMA, buildIndex } from './unit-fixtures/harness.js'

const index = buildIndex(corpusDocuments())

function phraseOf(text: string): LexicalQuery['phrases'][number] {
  const tokens = compositeAnalyzer.analyze(text)
  const base = tokens[0]?.position ?? 0
  return { terms: tokens.map(token => ({ term: token.text, offset: token.position - base })) }
}

function keysOf(searcher: MemoryIndex, query: LexicalQuery): string[] {
  return searcher.search(query).hits.map(hit => searcher.get(hit.docId)!.key)
}

function baseQuery(overrides: Partial<LexicalQuery> = {}): LexicalQuery {
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

describe('反证 ①:拆掉短语相邻核验 → 「身份 … 牌」假阳性红', () => {
  it('相邻在时 a-02 不中;把 phraseAdjacent 关掉(等于拆掉核验)它立刻变成假阳性', () => {
    const phrase = phraseOf('身份牌')
    const withVerifier = keysOf(index, baseQuery({ phrases: [phrase] }))
    const withoutVerifier = keysOf(index, baseQuery({ phrases: [phrase], phraseAdjacent: false }))

    expect(withVerifier).toContain('a-01')
    expect(withVerifier).not.toContain('a-02')

    // 拆掉即红:a-02 是「份牌先发,身份后验」—— 两个二元都在,顺序与相邻都不对。
    expect(withoutVerifier).toContain('a-02')
    expect(withoutVerifier.length).toBeGreaterThan(withVerifier.length)
  })
})

describe('反证 ②:拆掉 NFKC → 全角红', () => {
  const documents = corpusDocuments()

  function indexWith(normalizers: readonly typeof nfkcNormalizer[]): MemoryIndex {
    const searcher = new MemoryIndex({
      analyzers: createDefaultAnalyzerRegistry(),
      normalize: composeNormalizers(normalizers),
    })
    searcher.setSchema(CAP_A, DEFAULT_SCHEMA)
    for (const doc of documents) searcher.replaceKey(doc.capability, doc.key, [doc])
    return searcher
  }

  const query = baseQuery({
    terms: compositeAnalyzer.analyze('abc123').map(token => ({ alternatives: [{ term: token.text, weight: 1 }] })),
    minShouldMatch: 1,
  })

  it('NFKC 在:半角查询命中全角正文', () => {
    expect(keysOf(indexWith(DEFAULT_NORMALIZERS), query)).toContain('a-04')
  })

  it('把 NFKC 从列表里摘掉:同一条查询零命中', () => {
    const without = DEFAULT_NORMALIZERS.filter(normalizer => normalizer !== nfkcNormalizer)
    expect(without).toHaveLength(DEFAULT_NORMALIZERS.length - 1)
    expect(keysOf(indexWith(without), query)).not.toContain('a-04')
  })

  it('其余几项各自也在做事(摘一项就少一件本事)', () => {
    // 只问正文那一格:a-10 的标题里没有零宽字符,问标题证明不了任何事。
    const zeroWidthQuery = baseQuery({
      terms: compositeAnalyzer.analyze('零宽').map(token => ({ alternatives: [{ term: token.text, weight: 1 }] })),
      fields: { content: 1 },
      minShouldMatch: 1,
    })
    expect(keysOf(indexWith(DEFAULT_NORMALIZERS), zeroWidthQuery)).toContain('a-10')
    const withoutZeroWidth = DEFAULT_NORMALIZERS.filter(normalizer => normalizer !== stripZeroWidthNormalizer)
    expect(keysOf(indexWith(withoutZeroWidth), zeroWidthQuery)).not.toContain('a-10')

    // 折空白与中文标点也各是一项,不是顺手写的。
    expect(collapseWhitespaceNormalizer.apply('a   b').text).toBe('a b')
    expect(cjkPunctuationNormalizer.apply('。').text).toBe('.')
  })
})

describe('反证 ③:拆掉前缀上限 → `a` 展开红', () => {
  const wide = buildIndex(Array.from({ length: 300 }, (_, position) => ({
    capability: CAP_A,
    key: `w-${position}`,
    time: CORPUS_NOW,
    facets: {},
    fields: { content: `a${position}` },
  })))

  it('上限在:一个字母最多展开 64 个', () => {
    const expanded = expandTerm({ text: 'a', last: true }, [createPrefixExpander()], wide, { fields: ['content'] })
    expect(expanded).toHaveLength(PREFIX_EXPANSION_LIMIT + 1)
  })

  it('把上限拆掉(改成无穷大):半个词典被展开进来', () => {
    const unlimited = expandTerm(
      { text: 'a', last: true },
      [createPrefixExpander(Number.MAX_SAFE_INTEGER)],
      wide,
      { fields: ['content'], limit: Number.MAX_SAFE_INTEGER },
    )
    expect(unlimited.length).toBeGreaterThan(PREFIX_EXPANSION_LIMIT + 1)
    expect(unlimited.length).toBeGreaterThan(300)
  })
})

describe('反证 ④:cursor 不带 queryHash → 索引变后翻页错位红', () => {
  const codec = createCursorCodec()
  const capability = CAP_A

  it('带 queryHash:索引代次一变,旧游标就作废回到第一页', () => {
    const before = hashQueryShape({ raw: '索引', generation: 1 })
    const after = hashQueryShape({ raw: '索引', generation: 2 })
    const cursor = codec.encode({
      capability,
      kind: OFFSET_CURSOR_KIND,
      payload: { queryHash: before, offset: 20 },
    })
    expect(readOffsetCursor(codec, cursor, { capability, queryHash: after })).toBe(0)
  })

  it('把 queryHash 从游标里拆掉(编成常量):索引变了它照旧交出 offset 20 —— 这就是错位', () => {
    const stale = codec.encode({
      capability,
      kind: OFFSET_CURSOR_KIND,
      // 「不带 queryHash」在这个协议里的等价物:一个永远对得上的常量。
      payload: { queryHash: 'constant', offset: 20 },
    })
    expect(readOffsetCursor(codec, stale, { capability, queryHash: 'constant' })).toBe(20)
    // 而正确的做法下,同一次索引变更会让它回到 0(上一个用例)。
    expect(hashQueryShape({ raw: '索引', generation: 1 }))
      .not.toBe(hashQueryShape({ raw: '索引', generation: 2 }))
  })
})
