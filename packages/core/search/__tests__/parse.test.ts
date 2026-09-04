import { describe, expect, it } from 'vitest'

import { DEFAULT_INTENT } from '../candidate.js'
import { collectQueryTerms, parse, resolveIntent } from '../pipeline/parse.js'
import { DEFAULT_EXTRACTORS, extract, parseRelativeDuration } from '../pipeline/extract.js'
import { makeManifest } from './unit-fixtures/harness.js'
import { CORPUS_NOW } from './unit-fixtures/corpus.js'

// 两个假能力,各自自报前缀 —— core 里没有任何前缀字面量,这里才有。
const MANIFESTS = [
  makeManifest({ id: 'alpha', intentPrefixes: ['/', '>'] }),
  makeManifest({ id: 'beta', intentPrefixes: ['#'] }),
]

function termsOf(raw: string): string[] {
  return collectQueryTerms(parse(raw, { manifests: MANIFESTS }).ast).terms.map(term => term.text)
}

describe('parse 语法表', () => {
  it('空格 = AND', () => {
    expect(termsOf('索引 重建')).toEqual(['索引', '重建'])
  })

  it('引号 = 短语', () => {
    const { phrases, terms } = collectQueryTerms(parse('"身份牌" 分发', { manifests: MANIFESTS }).ast)
    expect(phrases.map(phrase => phrase.text)).toEqual(['身份牌'])
    expect(terms.map(term => term.text)).toEqual(['分发'])
  })

  it('-x = NOT', () => {
    const { terms, excluded } = collectQueryTerms(parse('索引 -缓存', { manifests: MANIFESTS }).ast)
    expect(terms.map(term => term.text)).toEqual(['索引'])
    expect(excluded.map(term => term.text)).toEqual(['缓存'])
  })

  it('k:v 进 filters,不进词', () => {
    const query = parse('身份牌 kind:x role:user archived:true', { manifests: MANIFESTS })
    expect(query.filters).toEqual({ kind: 'x', role: 'user', archived: true })
    expect(collectQueryTerms(query.ast).terms.map(term => term.text)).toEqual(['身份牌'])
  })

  it('逗号分隔的过滤片收成数组,数字识别成数字', () => {
    const query = parse('space:s1,s2 limit:20', { manifests: MANIFESTS })
    expect(query.filters).toEqual({ space: ['s1', 's2'], limit: 20 })
  })

  it('-k:v 取反成 { not }', () => {
    expect(parse('-role:user', { manifests: MANIFESTS }).filters).toEqual({ role: { not: 'user' } })
  })

  it('链接不会被读成过滤片', () => {
    const query = parse('https://example.com/a', { manifests: MANIFESTS })
    expect(query.filters).toEqual({})
    expect(collectQueryTerms(query.ast).terms).toHaveLength(1)
  })

  it('结构传进来的过滤片赢过查询串里写的', () => {
    const query = parse('space:s1', { manifests: MANIFESTS, filters: { space: 's9' } })
    expect(query.filters.space).toBe('s9')
  })

  it('归一化两侧同一条列表:全角引号也是短语', () => {
    const { phrases } = collectQueryTerms(parse('“身份牌”', { manifests: MANIFESTS }).ast)
    expect(phrases.map(phrase => phrase.text)).toEqual(['身份牌'])
  })

  it('词的 range 指原文,不指归一化后的串', () => {
    const raw = '　　索引'
    const query = parse(raw, { manifests: MANIFESTS })
    const term = collectQueryTerms(query.ast).terms[0]!
    expect(raw.slice(term.range.start, term.range.end)).toContain('索引')
  })
})

describe('意图:能力自报前缀,前缀不被吃', () => {
  it('/cmd 判成那个能力的意图,而 `/` 留在词里', () => {
    const query = parse('/cmd', { manifests: MANIFESTS })
    expect(query.intent).toBe('alpha')
    expect(query.raw).toBe('/cmd')
    expect(collectQueryTerms(query.ast).terms.map(term => term.text)).toEqual(['/cmd'])
  })

  it('#sym 判成另一个能力', () => {
    expect(parse('#sym', { manifests: MANIFESTS }).intent).toBe('beta')
  })

  it('都不中 = content', () => {
    expect(parse('索引重建', { manifests: MANIFESTS }).intent).toBe(DEFAULT_INTENT)
  })

  it('注册表为空时没有任何前缀会命中(core 里没有前缀字面量的证据)', () => {
    expect(parse('/cmd', { manifests: [] }).intent).toBe(DEFAULT_INTENT)
  })

  it('长前缀先答', () => {
    const manifests = [makeManifest({ id: 'alpha', intentPrefixes: ['#'] }), makeManifest({ id: 'beta', intentPrefixes: ['##'] })]
    expect(resolveIntent('##x', manifests)).toBe('beta')
  })
})

describe('extract:时间与实体', () => {
  const ctx = { now: CORPUS_NOW }

  it('英文相对时间进 since,词从 ast 里摘掉', () => {
    const query = extract(parse('索引 7d', { manifests: MANIFESTS }), DEFAULT_EXTRACTORS, ctx)
    expect(query.filters.since).toBe(CORPUS_NOW - 7 * 24 * 60 * 60 * 1000)
    expect(collectQueryTerms(query.ast).terms.map(term => term.text)).toEqual(['索引'])
  })

  it('结构里传来的 since:"2w" 也落成时间戳', () => {
    const query = extract(parse('索引', { manifests: MANIFESTS, filters: { since: '2w' } }), DEFAULT_EXTRACTORS, ctx)
    expect(query.filters.since).toBe(CORPUS_NOW - 14 * 24 * 60 * 60 * 1000)
  })

  it('中文「昨天」抽成一天的窗', () => {
    const query = extract(parse('昨天 索引', { manifests: MANIFESTS }), DEFAULT_EXTRACTORS, ctx)
    const since = query.filters.since as number
    const until = query.filters.until as number
    expect(until - since).toBe(24 * 60 * 60 * 1000)
    expect(collectQueryTerms(query.ast).terms.map(term => term.text)).toEqual(['索引'])
  })

  it('中文「上周」抽成一周的窗', () => {
    const query = extract(parse('上周', { manifests: MANIFESTS }), DEFAULT_EXTRACTORS, ctx)
    expect((query.filters.until as number) - (query.filters.since as number)).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('「八月」指最近的那个八月', () => {
    const query = extract(parse('八月', { manifests: MANIFESTS }), DEFAULT_EXTRACTORS, ctx)
    expect(new Date(query.filters.since as number).getMonth()).toBe(7)
  })

  it('抽不到就什么都不做 —— 查询逐字不变', () => {
    const parsed = parse('身份牌 分发', { manifests: MANIFESTS })
    const after = extract(parsed, DEFAULT_EXTRACTORS, ctx)
    expect(after.filters).toEqual(parsed.filters)
    expect(collectQueryTerms(after.ast).terms.map(term => term.text)).toEqual(['身份牌', '分发'])
  })

  it('短语里的时间词不摘 —— 引号是用户特意打的', () => {
    const query = extract(parse('"昨天"', { manifests: MANIFESTS }), DEFAULT_EXTRACTORS, ctx)
    expect(collectQueryTerms(query.ast).phrases.map(phrase => phrase.text)).toEqual(['昨天'])
  })

  it('相对时长的读法', () => {
    expect(parseRelativeDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000)
    expect(parseRelativeDuration('2w')).toBe(14 * 24 * 60 * 60 * 1000)
    expect(parseRelativeDuration('3h')).toBe(3 * 60 * 60 * 1000)
    expect(parseRelativeDuration('nope')).toBeUndefined()
  })
})
