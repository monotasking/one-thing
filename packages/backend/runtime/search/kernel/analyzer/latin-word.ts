/**
 * 拉丁 / 数字词分析器。
 *
 * 设计:docs/design/search-index-2026-09.md §6.3
 *
 * `\p{L}\p{N}_` 连续段成词(归一化已经小写过,这里再兜一次底);camel / snake
 * 再拆一层**并保留整词** —— 保留整词才搜得到 `getUser`,拆一层才搜得到 `user`。
 *
 * 词位的排法是短语相邻的关键:整词与它的第一段**共位**,后续段依次 +1。
 * 于是查询「getUser」拆成 getuser@0 / get@0 / user@1,文档里同样的排法,
 * 短语判据「存在基点 b 使每个 token 落在 b + 相对位置」自然成立;
 * 而 `get user` 两个词在文档里也是 get@k / user@k+1,同一条判据一起答了。
 */

import type { Analyzer, Token } from './types.js'
import { isCjkChar } from './cjk-bigram.js'

const WORD_CHAR = /[\p{L}\p{N}_]/u

/** camel / snake 拆一层:大小写边界、字母数字边界、下划线与连字符。 */
export function splitWordParts(word: string): string[] {
  const parts: string[] = []
  let current = ''

  const flush = (): void => {
    if (current.length > 0) parts.push(current)
    current = ''
  }

  for (let i = 0; i < word.length; i += 1) {
    const char = word[i]!
    if (char === '_' || char === '-') {
      flush()
      continue
    }
    const previous = word[i - 1]
    if (previous !== undefined && isBoundary(previous, char)) flush()
    current += char
  }
  flush()

  return parts.map(part => part.toLowerCase())
}

function isBoundary(previous: string, char: string): boolean {
  const previousLower = previous !== previous.toUpperCase() && previous === previous.toLowerCase()
  const charUpper = char !== char.toLowerCase() && char === char.toUpperCase()
  // camelCase 的驼峰边界。
  if (previousLower && charUpper) return true
  // 字母 ↔ 数字边界(v2 / utf8 这类词在两侧都要能搜到)。
  const previousDigit = /\d/.test(previous)
  const charDigit = /\d/.test(char)
  return previousDigit !== charDigit
}

export class LatinWordAnalyzer implements Analyzer {
  readonly id: string

  constructor(id = 'latin-word') {
    this.id = id
  }

  analyze(text: string): Token[] {
    const tokens: Token[] = []
    let position = 0
    let index = 0

    while (index < text.length) {
      const char = text[index]!
      if (!WORD_CHAR.test(char) || isCjkChar(char)) {
        index += 1
        continue
      }
      const start = index
      while (index < text.length && WORD_CHAR.test(text[index]!) && !isCjkChar(text[index]!)) {
        index += 1
      }
      const end = index
      const word = text.slice(start, end)
      const lowered = word.toLowerCase()
      const parts = splitWordParts(word)

      tokens.push({ text: lowered, start, end, position })

      if (parts.length > 1) {
        // 段的偏移在整词内部按序推进 —— 拆一层不丢原文位置,高亮仍指得到那一段。
        let cursor = start
        parts.forEach((part, partIndex) => {
          const found = text.toLowerCase().indexOf(part, cursor)
          const partStart = found >= 0 && found < end ? found : cursor
          const partEnd = Math.min(partStart + part.length, end)
          tokens.push({ text: part, start: partStart, end: partEnd, position: position + partIndex })
          cursor = partEnd
        })
        position += parts.length
        continue
      }

      position += 1
    }

    return tokens
  }
}

export const latinWordAnalyzer = new LatinWordAnalyzer()
