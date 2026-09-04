/**
 * 混排分析器:按字符类别分段,每段交给认它的分析器。
 *
 * 设计:docs/design/search-index-2026-09.md §6.3
 *
 * 成员是一张**列表**,不是两个写死的分支:加一种文字(变音符折叠之后的拉丁、
 * 将来的标识符分析器)= 列表里多一项。段与段之间词位连续,所以「中文 + 英文」
 * 挨着写的短语照样能相邻命中。
 */

import type { Analyzer, Token } from './types.js'
import { cjkBigramAnalyzer, isCjkChar } from './cjk-bigram.js'
import { latinWordAnalyzer } from './latin-word.js'

export interface CompositeMember {
  /** 这一段字符归不归我 */
  matches(char: string): boolean
  analyzer: Analyzer
}

export class CompositeAnalyzer implements Analyzer {
  readonly id: string
  private readonly members: readonly CompositeMember[]

  constructor(members: readonly CompositeMember[], id = 'composite') {
    this.id = id
    this.members = members
  }

  analyze(text: string): Token[] {
    const tokens: Token[] = []
    let position = 0
    let index = 0

    while (index < text.length) {
      const member = this.memberFor(text[index]!)
      if (member === undefined) {
        index += 1
        continue
      }
      const start = index
      while (index < text.length && this.memberFor(text[index]!) === member) index += 1
      const segment = text.slice(start, index)

      let localMax = -1
      for (const token of member.analyzer.analyze(segment)) {
        tokens.push({
          text: token.text,
          start: token.start + start,
          end: token.end + start,
          position: position + token.position,
        })
        if (token.position > localMax) localMax = token.position
      }
      position += localMax + 1
    }

    return tokens
  }

  private memberFor(char: string): CompositeMember | undefined {
    return this.members.find(member => member.matches(char))
  }
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

/** 缺省成员表:CJK 走二元,其余字母数字走词。先问先答,顺序即优先级。 */
export const DEFAULT_COMPOSITE_MEMBERS: readonly CompositeMember[] = Object.freeze([
  { matches: (char: string) => isCjkChar(char), analyzer: cjkBigramAnalyzer },
  { matches: (char: string) => WORD_CHAR.test(char), analyzer: latinWordAnalyzer },
])

export const compositeAnalyzer = new CompositeAnalyzer(DEFAULT_COMPOSITE_MEMBERS)
