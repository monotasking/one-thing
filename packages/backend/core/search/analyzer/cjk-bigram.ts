/**
 * CJK 字二元分析器。
 *
 * 设计:docs/design/search-index-2026-09.md §6.3
 *
 * 为什么二元不分词:小语料上词典分词召回差、模型造词多;二元召回全,精确靠
 * 短语相邻补回来(「身份牌」= 身份 + 份牌 相邻)。单字成段时补一个 unigram
 * ——只在**成段**时补,这是设计的原话,代价见 index.ts 的留账。
 */

import type { Analyzer, Token } from './types.js'

/**
 * CJK 字符区间,写成码点数字而不是字面量正则 —— 区间端点用汉字写出来没人审得动。
 * 统一表意文字扩展 A / 统一表意文字 / 兼容表意 / 平假名片假名 / 谚文音节。
 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x3040, 0x30ff],
  [0xac00, 0xd7af],
]

export function isCjkChar(char: string): boolean {
  const codePoint = char.codePointAt(0)
  if (codePoint === undefined) return false
  return CJK_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)
}

export class CjkBigramAnalyzer implements Analyzer {
  readonly id: string

  constructor(id = 'cjk-bigram') {
    this.id = id
  }

  analyze(text: string): Token[] {
    const tokens: Token[] = []
    let position = 0
    let index = 0

    while (index < text.length) {
      if (!isCjkChar(text[index]!)) {
        index += 1
        continue
      }
      const runStart = index
      while (index < text.length && isCjkChar(text[index]!)) index += 1
      const runEnd = index

      if (runEnd - runStart === 1) {
        // 单字成段:二元产不出东西,补 unigram,否则这个字永远搜不到。
        tokens.push({ text: text.slice(runStart, runEnd), start: runStart, end: runEnd, position })
        position += 1
        continue
      }

      for (let i = runStart; i < runEnd - 1; i += 1) {
        tokens.push({ text: text.slice(i, i + 2), start: i, end: i + 2, position })
        position += 1
      }
    }

    return tokens
  }
}

export const cjkBigramAnalyzer = new CjkBigramAnalyzer()
