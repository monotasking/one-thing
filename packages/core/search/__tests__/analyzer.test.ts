import { describe, expect, it } from 'vitest'

import {
  CompositeAnalyzer,
  DEFAULT_COMPOSITE_MEMBERS,
  cjkBigramAnalyzer,
  compositeAnalyzer,
  latinWordAnalyzer,
  splitWordParts,
} from '../analyzer/index.js'
import {
  DEFAULT_NORMALIZERS,
  composeNormalizers,
  mapRangeToSource,
  nfkcNormalizer,
} from '../analyzer/normalize.js'

const normalize = composeNormalizers(DEFAULT_NORMALIZERS)

function textsOf(tokens: Array<{ text: string }>): string[] {
  return tokens.map(token => token.text)
}

describe('切分黄金表', () => {
  it('中文按字二元切,单字成段时补 unigram', () => {
    expect(textsOf(cjkBigramAnalyzer.analyze('身份牌'))).toEqual(['身份', '份牌'])
    expect(textsOf(cjkBigramAnalyzer.analyze('牌'))).toEqual(['牌'])
    // 词位连续 —— 短语相邻靠它。
    expect(cjkBigramAnalyzer.analyze('身份牌').map(token => token.position)).toEqual([0, 1])
  })

  it('中文 token 的偏移指回原文', () => {
    const tokens = cjkBigramAnalyzer.analyze('他的身份牌')
    const first = tokens[0]!
    expect('他的身份牌'.slice(first.start, first.end)).toBe(first.text)
  })

  it('英文按词切并小写', () => {
    expect(textsOf(latinWordAnalyzer.analyze('The Quick Fox'))).toEqual(['the', 'quick', 'fox'])
  })

  it('camel / snake 拆一层并保留整词', () => {
    expect(textsOf(latinWordAnalyzer.analyze('getUserProfile')))
      .toEqual(['getuserprofile', 'get', 'user', 'profile'])
    expect(textsOf(latinWordAnalyzer.analyze('max_retry_count')))
      .toEqual(['max_retry_count', 'max', 'retry', 'count'])
    // 整词与首段共位,后续段依次 +1(短语判据要的相对词位)。
    expect(latinWordAnalyzer.analyze('getUser').map(token => token.position)).toEqual([0, 0, 1])
  })

  it('字母数字边界也拆', () => {
    expect(splitWordParts('utf8')).toEqual(['utf', '8'])
    expect(splitWordParts('v2')).toEqual(['v', '2'])
  })

  it('混排按字符类别分段,词位跨段连续', () => {
    const tokens = compositeAnalyzer.analyze('索引 index 重建')
    expect(textsOf(tokens)).toEqual(['索引', 'index', '重建'])
    expect(tokens.map(token => token.position)).toEqual([0, 1, 2])
  })

  it('全角经归一化后与半角切成同一批 token', () => {
    const full = compositeAnalyzer.analyze(normalize('ＡＢＣ１２３').text)
    const half = compositeAnalyzer.analyze(normalize('abc123').text)
    expect(textsOf(full)).toEqual(textsOf(half))
  })

  it('成员表是列表:去掉拉丁那一员,英文就不再产 token', () => {
    const cjkOnly = new CompositeAnalyzer([DEFAULT_COMPOSITE_MEMBERS[0]!])
    expect(textsOf(cjkOnly.analyze('索引 index'))).toEqual(['索引'])
  })
})

describe('归一化与偏移映射', () => {
  it('空白折一 / 中文标点 / 零宽全在缺省列表里', () => {
    expect(normalize('a   b').text).toBe('a b')
    expect(normalize('句号。').text).toBe('句号.')
    expect(normalize('零​宽').text).toBe('零宽')
  })

  it('小写**不**在缺省列表里 —— 它在切词之前做会毁掉 camel 拆分', () => {
    expect(normalize('getUserProfile').text).toBe('getUserProfile')
    // 大小写无关照旧成立,只是由分析器负责。
    expect(textsOf(latinWordAnalyzer.analyze('HTTP'))).toEqual(['http'])
    expect(textsOf(latinWordAnalyzer.analyze(normalize('getUserProfile').text)))
      .toEqual(['getuserprofile', 'get', 'user', 'profile'])
  })

  it('归一化后的下标能逐字映回原文', () => {
    const source = '前缀　ＡＢＣ 后缀'
    const normalized = normalize(source)
    const at = normalized.text.indexOf('ABC')
    expect(at).toBeGreaterThanOrEqual(0)
    const range = mapRangeToSource(normalized, { start: at, end: at + 3 })
    expect(source.slice(range.start, range.end)).toBe('ＡＢＣ')
  })

  it('长度会变的那几步(全角展开、空白塌缩)映射仍然对齐', () => {
    const source = '一​二   三'
    const normalized = normalize(source)
    for (let i = 0; i < normalized.text.length; i += 1) {
      const mapped = mapRangeToSource(normalized, { start: i, end: i + 1 })
      expect(mapped.start).toBeGreaterThanOrEqual(0)
      expect(mapped.end).toBeLessThanOrEqual(source.length)
    }
    const at = normalized.text.indexOf('三')
    expect(source.slice(mapRangeToSource(normalized, { start: at, end: at + 1 }).start)).toBe('三')
  })

  it('末位映射指向原文末尾,整串区间往返恒等', () => {
    const source = 'ＡＢ 三'
    const normalized = normalize(source)
    const whole = mapRangeToSource(normalized, { start: 0, end: normalized.text.length })
    expect(source.slice(whole.start, whole.end)).toBe(source)
  })

  it('NFKC 逐码点做,不跨字符合成', () => {
    // 整串 NFKC 会把这两个码点合成一个字符,逐码点做则各归各的 —— 偏移才答得上来。
    const source = 'ガ'
    const stage = nfkcNormalizer.apply(source)
    expect(stage.map.length).toBe(stage.text.length + 1)
    expect(stage.map[stage.map.length - 1]).toBe(source.length)
  })
})
