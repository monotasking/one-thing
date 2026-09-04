/**
 * `SqliteIndex` 答**同一份**索引契约卷子(⑧),外加只有它才答得出的那几条(⑨):
 * 短语 / 放宽四级 / 字段权重 / facet 过滤 / 前缀,以及关系边与检查点。
 *
 * 卷子本体在 `@onething/core/search/__tests__/index-contract`,另一位考生是
 * `MemoryIndex`。两边答得不一样,就说明「上层只认接口」是假话。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { describeIndexContract, DEFAULT_SCHEMA } from '@onething/core/search/__tests__/index-contract'
import type { ContractIndexOptions } from '@onething/core/search/__tests__/index-contract'
import { corpusDocuments, CAP_A } from '@onething/core/search/__tests__/unit-fixtures/corpus'
import type { LexicalQuery } from '@onething/core/search'
import { compositeAnalyzer } from '@onething/core/search'

import { SqliteIndex } from '../sqlite-index.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-sqlite-index-'))
let counter = 0

function createIndex(options: ContractIndexOptions = {}): SqliteIndex {
  counter += 1
  const index = new SqliteIndex({
    path: path.join(tempRoot, `index-${counter}.sqlite`),
    ...(options.maxFieldChars !== undefined ? { maxFieldChars: options.maxFieldChars } : {}),
  })
  const documents = options.documents ?? corpusDocuments()
  const capabilities = new Set(documents.map(doc => doc.capability))
  for (const capability of [...capabilities, ...Object.keys(options.schemas ?? {})]) {
    index.setSchema(capability, options.schemas?.[capability] ?? DEFAULT_SCHEMA)
  }
  if (capabilities.size === 0) index.setSchema(CAP_A, DEFAULT_SCHEMA)
  for (const doc of documents) index.replaceKey(doc.capability, doc.key, [doc])
  return index
}

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describeIndexContract('SqliteIndex', createIndex)

// ---- ⑨ 只有 SqliteIndex 答得出的那几条 -----------------------------------

const index = createIndex()

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

const keysOf = (result: { hits: Array<{ docId: number }> }): string[] =>
  result.hits.map(hit => index.get(hit.docId)!.key)

describe('SqliteIndex 放宽阶梯的四级', () => {
  // 「索引 重建」在语料里只有 a-19 两个词都有;a-18 只有「索引」。
  const words = termsOf('索引 重建')

  it('① 严格:全 AND + 短语相邻', () => {
    const strict = index.search(query({
      terms: words,
      phrases: [phraseOf('索引重建')],
      minShouldMatch: words.length,
      phraseAdjacent: true,
    }))
    expect(keysOf(strict)).toEqual(['a-19'])
  })

  it('② 去相邻:短语降级成「这些词都在」,假阳性回来', () => {
    const strict = index.search(query({ phrases: [phraseOf('身份牌')], phraseAdjacent: true }))
    const relaxed = index.search(query({ phrases: [phraseOf('身份牌')], phraseAdjacent: false }))
    expect(keysOf(strict)).not.toContain('a-02')
    expect(keysOf(relaxed)).toContain('a-02')
  })

  it('③ 至少命中一半:召回严格档的超集', () => {
    const strict = index.search(query({ terms: words, minShouldMatch: words.length }))
    const half = index.search(query({ terms: words, minShouldMatch: Math.ceil(words.length / 2) }))
    for (const key of keysOf(strict)) expect(keysOf(half)).toContain(key)
    expect(half.hits.length).toBeGreaterThan(strict.hits.length)
  })

  it('④ 单词:min = 1,召回最宽', () => {
    const half = index.search(query({ terms: words, minShouldMatch: Math.ceil(words.length / 2) }))
    const single = index.search(query({ terms: words, minShouldMatch: 1 }))
    expect(single.hits.length).toBeGreaterThanOrEqual(half.hits.length)
    expect(keysOf(single)).toContain('a-18')
  })
})

describe('SqliteIndex 前缀展开', () => {
  it('候选词直接翻成 MATCH 的 OR —— 不查 fts5vocab 也不用 term*', () => {
    const candidates = index.terms('content', 'search', 64)
    expect(candidates).toEqual(['search', 'searchable', 'searched', 'searching'])
    const hits = index.search(query({
      terms: [{ alternatives: candidates.map((term, rank) => ({ term, weight: rank === 0 ? 1 : 0.5 })) }],
      minShouldMatch: 1,
    }))
    expect(keysOf(hits)).toContain('a-21')
  })

  it('词典按字段隔离 —— 标题里没有 search*,问标题就是空', () => {
    expect(index.terms('title', 'search', 64)).toEqual([])
  })
})

describe('SqliteIndex 关系边与检查点', () => {
  it('边表按 (rel, to) 反查文档 —— core 不认识 rel 的名字', () => {
    const local = createIndex({ documents: [] })
    local.replaceKey(CAP_A, 'r-1', [{
      capability: CAP_A,
      key: 'r-1',
      time: 1,
      facets: {},
      fields: { content: '改了两个文件' },
      relations: [
        { rel: 'touched-file', to: 'src/a.ts' },
        { rel: 'touched-file', to: 'src/b.ts' },
      ],
    }])
    const docId = local.byKey(CAP_A, 'r-1')[0]!.docId
    expect(local.docIdsByEdge('touched-file', 'src/a.ts')).toEqual([docId])
    expect(local.docIdsByEdge('touched-file', 'src/zzz.ts')).toEqual([])
    // 整键替换把旧边一并撤掉。
    local.replaceKey(CAP_A, 'r-1', [{
      capability: CAP_A, key: 'r-1', time: 1, facets: {}, fields: { content: '这次没碰文件' },
    }])
    expect(local.docIdsByEdge('touched-file', 'src/a.ts')).toEqual([])
    local.close()
  })

  it('检查点按 (feedId, key) 记,读得回、删得掉、枚举得出', () => {
    const local = createIndex({ documents: [] })
    expect(local.readCheckpoint('ledger', 's1')).toBeUndefined()
    local.writeCheckpoint('ledger', 's1', '12:900')
    local.writeCheckpoint('ledger', 's2', '3:100')
    expect(local.readCheckpoint('ledger', 's1')).toBe('12:900')
    local.writeCheckpoint('ledger', 's1', '13:901')
    expect(local.readCheckpoint('ledger', 's1')).toBe('13:901')
    expect(local.checkpointKeys('ledger')).toEqual(['s1', 's2'])
    local.dropCheckpoint('ledger', 's1')
    expect(local.checkpointKeys('ledger')).toEqual(['s2'])
    local.close()
  })

  it('代次每次写都前进 —— 索引一变游标自然失效', () => {
    const local = createIndex({ documents: [] })
    const before = local.generation()
    local.replaceKey(CAP_A, 'g-1', [{
      capability: CAP_A, key: 'g-1', time: 1, facets: {}, fields: { content: '一' },
    }])
    expect(local.generation()).toBeGreaterThan(before)
    local.close()
  })

  it('库头三格:重开同一个文件,version / analyzerId 与代次都还在', () => {
    counter += 1
    const file = path.join(tempRoot, `reopen-${counter}.sqlite`)
    const first = new SqliteIndex({ path: file, analyzerId: 'composite@1' })
    first.setSchema(CAP_A, DEFAULT_SCHEMA)
    first.replaceKey(CAP_A, 'k', [{
      capability: CAP_A, key: 'k', time: 1, facets: {}, fields: { content: '持久' },
    }])
    const generation = first.generation()
    first.close()

    const second = new SqliteIndex({ path: file, analyzerId: 'composite@1' })
    expect(second.readMeta('version')).toBe('1')
    expect(second.readMeta('analyzerId')).toBe('composite@1')
    expect(second.generation()).toBe(generation)
    expect(second.byKey(CAP_A, 'k')).toHaveLength(1)
    second.close()
  })
})

describe('SqliteIndex 字段名上限', () => {
  it('超过 32 个不同字段名当场抛,不静默错乱', () => {
    const local = createIndex({ documents: [] })
    const fields: Record<string, string> = {}
    for (let i = 0; i < 40; i += 1) fields[`f${i}`] = '内容'
    expect(() => local.replaceKey(CAP_A, 'wide', [{
      capability: CAP_A, key: 'wide', time: 1, facets: {}, fields,
    }])).toThrow(/too many distinct field names/)
    local.close()
  })
})
