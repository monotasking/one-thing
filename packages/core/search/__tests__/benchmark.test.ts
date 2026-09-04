/**
 * 基准:2000 条查询在 MemoryIndex 上的中位耗时。
 *
 * §10 S1 行写的是「基准 2000 条查询 < 5ms」。这里**量并打印读数,不做硬断言** ——
 * MemoryIndex 不是产品实现(产品是 SqliteIndex),拿一台跑测试的机器的抖动去卡红线,
 * 只会得到一条随机失败的门。真正要守的性能门是 S3 的 `gate:search-index`。
 */

import { describe, expect, it } from 'vitest'

import { compositeAnalyzer } from '../analyzer/composite.js'
import type { LexicalQuery } from '../index/types.js'
import { CAP_A, CORPUS_NOW, corpusDocuments } from './unit-fixtures/corpus.js'
import { buildIndex } from './unit-fixtures/harness.js'

const WORDS = ['索引', '身份', '身份牌', '重建', '窗口', '大小', '记忆', '缓存', 'search', 'http', 'user', 'profile', '重要', '说明', '账本']

function termsOf(text: string): LexicalQuery['terms'] {
  return compositeAnalyzer.analyze(text).map(token => ({ alternatives: [{ term: token.text, weight: 1 }] }))
}

describe('基准', () => {
  it('2000 条查询的中位耗时(打印读数,不做硬断言)', () => {
    // 语料放大到 ~3000 份文档,免得量到的全是空表的速度。
    const documents = Array.from({ length: 100 }, (_, round) =>
      corpusDocuments().map(doc => ({ ...doc, key: `${doc.key}-${round}` }))).flat()
    const index = buildIndex(documents)

    const queries: LexicalQuery[] = Array.from({ length: 2000 }, (_, position) => {
      const first = WORDS[position % WORDS.length]!
      const second = WORDS[(position * 7 + 3) % WORDS.length]!
      return {
        capability: CAP_A,
        terms: termsOf(`${first} ${second}`),
        phrases: position % 5 === 0 ? [{ terms: compositeAnalyzer.analyze(first).map((token, at) => ({ term: token.text, offset: at })) }] : [],
        excluded: [],
        fields: { title: 2, content: 1 },
        filters: position % 3 === 0 ? { space: 's1' } : undefined,
        minShouldMatch: 1,
        phraseAdjacent: position % 2 === 0,
        limit: 20,
      }
    })

    const durations: number[] = []
    for (const query of queries) {
      const startedAt = performance.now()
      index.search(query)
      durations.push(performance.now() - startedAt)
    }
    durations.sort((a, b) => a - b)

    const at = (quantile: number): number => durations[Math.floor(durations.length * quantile)] ?? 0
    const total = durations.reduce((sum, value) => sum + value, 0)


    console.log([
      '[bench] MemoryIndex 2000 queries over',
      `${index.size()} docs (built at ${new Date(CORPUS_NOW).toISOString().slice(0, 10)}):`,
      `p50=${at(0.5).toFixed(3)}ms`,
      `p90=${at(0.9).toFixed(3)}ms`,
      `p99=${at(0.99).toFixed(3)}ms`,
      `total=${total.toFixed(1)}ms`,
    ].join(' '))

    expect(durations).toHaveLength(2000)
    expect(index.size()).toBeGreaterThan(2_000)
  })
})
