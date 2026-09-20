import { describe, expect, it } from 'vitest'
import { analyzeUnit } from '../inline-tokens'
import type { Unit } from '../units'

/**
 * **待办编辑器不渲染公式** —— 它和消息共用同一份 mdast(`parseMarkdownTree`),
 * 所以数学语法一进解析器,这里就会看见 `math` / `inlineMath` 两种节点。
 *
 * 这一组守的是两件事:
 *  ① 不炸 —— 新节点走的是 `visit` 的 default 支(没有 children 的叶子原样当文字);
 *  ② **那条不变量仍然成立**:文字段的显示长度 = 它在原文里占的长度。光标在
 *    「屏幕第几个字」与「原文第几个字」之间换算全靠它,而公式节点一旦被当成
 *    「一个符号」画出来,这条就破了。
 *
 * 编辑一条带公式的待办时看见的因此是 `$x^2$` 这几个字符本身 —— 那正是可编辑的
 * 东西(公式排好之后没法把光标放进去)。
 */

/** 一个最小的段落单元。行号在这一组里不参与判断 —— 切分只看传进去的那段 value。 */
const para: Unit = { type: 'para', start: 0, end: 0 }

/** 这一份切分覆盖了原文的每一个字符吗(不变量的机器判据)。 */
function coversEveryChar(value: string): boolean {
  const analysis = analyzeUnit(para, value)
  let at = 0
  for (const token of analysis.tokens) {
    if (token.from !== at) return false
    at = token.to
  }
  return at === value.length
}

describe('编辑器遇到公式节点', () => {
  it('行内公式:原样当文字,一个记号都不认', () => {
    const analysis = analyzeUnit(para, '设 $x^2$ 为解')
    expect(analysis.tokens.every((token) => token.kind === 'text')).toBe(true)
    expect(analysis.groups).toEqual([])
  })

  it('TeX 定界符那一形同样不炸', () => {
    expect(() => analyzeUnit(para, String.raw`见 \(x\) 处`)).not.toThrow()
  })

  it('块公式(段落里写成一行的 $$x$$)也只是文字', () => {
    const analysis = analyzeUnit(para, '$$x$$')
    expect(analysis.tokens.map((token) => token.kind)).toEqual(['text'])
  })

  it('不变量:切分逐字覆盖原文,一个字符不多不少', () => {
    for (const value of ['设 $x^2$ 为解', String.raw`见 \(x\) 处`, '$$x$$', '花了 $5 和 $10']) {
      expect(coversEveryChar(value), value).toBe(true)
    }
  })

  it('公式旁边的粗体照旧认得出来 —— 这条改动没有把别的记号一起吃掉', () => {
    const analysis = analyzeUnit(para, '**粗** 与 $x$')
    expect(analysis.groups.map((group) => group.kind)).toEqual(['strong'])
  })
})
