/**
 * 归一化列表,每一个带偏移映射。
 *
 * 设计:docs/design/search-index-2026-09.md §6.1(+ §4.4 轴 ⑩)
 *
 * 硬要求:**归一化后的下标要能映回原文**。所以每一段归一化都产一张
 * `map`(长度 = 输出长度 + 1,末位指向输入末尾),`composeNormalizers` 把各段的
 * map 串起来。加一种归一化(繁简、变音符折叠)= 列表里多一项,别处一字不改。
 */

import type { TextRange } from '../candidate.js'

export interface NormalizeResult {
  text: string
  /** map[i] = 输出第 i 个字符在**输入**里的下标;长度 = text.length + 1 */
  map: number[]
}

export interface Normalizer {
  readonly id: string
  apply(text: string): NormalizeResult
}

/** 归一化的成品:带着回原文的路。 */
export interface NormalizedText {
  source: string
  text: string
  /** map[i] = 输出第 i 个字符在 **source** 里的下标;长度 = text.length + 1 */
  map: readonly number[]
}

/** 逐码点改写的通用外壳:给一个「这个码点变成什么」,偏移映射自动带出来。 */
function perCodePoint(id: string, rewrite: (codePoint: string) => string): Normalizer {
  return {
    id,
    apply(text) {
      let out = ''
      const map: number[] = []
      let index = 0
      while (index < text.length) {
        const codePoint = String.fromCodePoint(text.codePointAt(index)!)
        const replacement = rewrite(codePoint)
        for (let k = 0; k < replacement.length; k += 1) map.push(index)
        out += replacement
        index += codePoint.length
      }
      map.push(text.length)
      return { text: out, map }
    },
  }
}

/**
 * NFKC。逐码点做而不是整串做:整串 `normalize('NFKC')` 会跨字符合成,合成之后
 * 「输出第 i 个字符来自输入哪一个」就答不上来了,而高亮要的正是这个答案。
 * 全角 → 半角(Ａ→A、！→!、U+3000→空格)在逐码点这一形下照样成立,
 * 「全角必中」那条用例守的就是它。
 */
export const nfkcNormalizer: Normalizer = perCodePoint('nfkc', cp => cp.normalize('NFKC'))

export const lowercaseNormalizer: Normalizer = perCodePoint('lowercase', cp => cp.toLowerCase())

// 零宽与不可见控制字符:ZWSP / ZWNJ / ZWJ / LRM / RLM / BOM / 软连字符 / 词连接符。
// 写成码点数字而不是字符字面量 —— 源码里看不见的字符审不了也改不动。
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff, 0x00ad, 0x2060])

export const stripZeroWidthNormalizer: Normalizer = perCodePoint(
  'strip-zero-width',
  cp => (ZERO_WIDTH.has(cp.codePointAt(0) ?? 0) ? '' : cp),
)

/** 中文标点 → ASCII。NFKC 管全角 ASCII,管不到 。「」、这些 CJK 专属标点。 */
const CJK_PUNCTUATION = new Map<string, string>([
  ['、', ','], ['。', '.'], ['，', ','], ['；', ';'], ['：', ':'],
  ['？', '?'], ['！', '!'], ['「', '"'], ['」', '"'], ['『', '"'], ['』', '"'],
  ['（', '('], ['）', ')'], ['《', '<'], ['》', '>'], ['—', '-'], ['～', '~'],
  ['‘', "'"], ['’', "'"], ['“', '"'], ['”', '"'], ['·', '.'], ['…', '.'],
])

export const cjkPunctuationNormalizer: Normalizer = perCodePoint(
  'cjk-punctuation',
  cp => CJK_PUNCTUATION.get(cp) ?? cp,
)

/** 空白折一:连续空白塌成一个半角空格,映射指向这一段空白的第一个字符。 */
export const collapseWhitespaceNormalizer: Normalizer = {
  id: 'collapse-whitespace',
  apply(text) {
    let out = ''
    const map: number[] = []
    let index = 0
    while (index < text.length) {
      const char = text[index]!
      if (/\s/.test(char)) {
        const start = index
        while (index < text.length && /\s/.test(text[index]!)) index += 1
        out += ' '
        map.push(start)
        continue
      }
      out += char
      map.push(index)
      index += 1
    }
    map.push(text.length)
    return { text: out, map }
  },
}

/**
 * 缺省列表。顺序有意义:先去零宽、再 NFKC、再标点、最后折空白。
 *
 * **与设计 §6.1 的一处出入,写在这儿而不是悄悄改**:§6.1 把「小写」列在归一化里,
 * 但小写若发生在**切词之前**,`getUserProfile` 就先塌成 `getuserprofile`,§6.3 要求的
 * camel 拆一层当场没了(实测:短语「getUserProfile」搜不到自己)。小写是**词过滤器**
 * 不是字符过滤器 —— 所以它挪进分析器(`LatinWordAnalyzer` 出的 token 已经是小写,
 * CJK 无大小写),两侧仍然对称,大小写无关照旧成立。
 * `lowercaseNormalizer` 仍然导出,谁需要「连原文一起小写」自己往列表里加。
 */
export const DEFAULT_NORMALIZERS: readonly Normalizer[] = Object.freeze([
  stripZeroWidthNormalizer,
  nfkcNormalizer,
  cjkPunctuationNormalizer,
  collapseWhitespaceNormalizer,
])

export function composeNormalizers(
  normalizers: readonly Normalizer[],
): (source: string) => NormalizedText {
  return source => {
    let text = source
    // 恒等映射起步,之后每过一段就把这一段的 map 折进来。
    let map: number[] = []
    for (let i = 0; i <= source.length; i += 1) map.push(i)

    for (const normalizer of normalizers) {
      const stage = normalizer.apply(text)
      const folded: number[] = new Array(stage.map.length)
      for (let i = 0; i < stage.map.length; i += 1) folded[i] = map[stage.map[i]!]!
      text = stage.text
      map = folded
    }

    return { source, text, map }
  }
}

/** 归一化后的下标 → 原文下标。越界钳到两端,永不抛。 */
export function mapOffsetToSource(normalized: NormalizedText, offset: number): number {
  if (offset <= 0) return normalized.map[0] ?? 0
  if (offset >= normalized.map.length) return normalized.source.length
  return normalized.map[offset]!
}

export function mapRangeToSource(normalized: NormalizedText, range: TextRange): TextRange {
  return {
    start: mapOffsetToSource(normalized, range.start),
    end: mapOffsetToSource(normalized, range.end),
  }
}
