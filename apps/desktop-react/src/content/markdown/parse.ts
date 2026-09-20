import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { normalizeMathDelimiters } from './math-delimiters'
import { mdastToBlocks, type ParsedBlock } from './to-blocks'

/**
 * **一段 markdown → 一串块**(§3.2)。
 *
 * micromark/mdast,加 GFM(表格 / 删除线 / 自动链接 / 任务列表)与数学(`$…$` 行内、
 * `$$…$$` 块)。选它不是因为它流行:它的 AST 有**逐节点的源偏移**,而源偏移是流式
 * 那半边的地基(key 由它派生,增量的切点由它验证)。换一个不给位置的解析器,§6
 * 整节就没法成立。
 *
 * 扩展只在这一处组装:`extensions`(词法)与 `mdastExtensions`(建树)两份是 unified
 * 家族的既定形状,加一种语法就是这两个数组各加一格。
 *
 * ── 单 `$` 行内**开着**,判据在翻译表里 ────────────────────────────────────
 * `singleDollarTextMath` 是扩展的缺省(true),这里不关它:真实语料里 `$x$` 比
 * `$$x$$` 常见得多。代价是「花了 $5 和 $10」也会被词法认成一段公式 —— 那不在这里
 * 治,治在 `to-inline.ts` 的 pandoc 判据里(内容首尾非空白、闭合后一位不是数字),
 * 不过判据的就原文照抄成文字。**词法认得宽,翻译表判得严**,两层分工。
 *
 * ── 喂的是归一文本,翻的是原文 ────────────────────────────────────────────
 * `\(…\)` / `\[…\]` 这四个 TeX 定界符扩展不认,所以先经 `normalizeMathDelimiters`
 * **等长**换成 `$$`。等长意味着两份文本的每一个下标一一对应,于是:解析器看见的是
 * 它认得的语法,而 `mdastToBlocks` 拿到的 `source` 仍是**作者写的原文** —— 一切按
 * 偏移回读源码的地方(降级、「查看源码」、行内兜底)吐出来的还是那几个字节。
 */

const EXTENSIONS = [gfm(), math()]
const MDAST_EXTENSIONS = [gfmFromMarkdown(), mathFromMarkdown()]

/**
 * 原样交出一棵带源偏移的 mdast(同一套扩展)。待办编辑器按它切行内记号
 * (`content/editing/inline-tokens.ts`)—— 编辑时认成粗体的,与消息里认成粗体的是同一份判断。
 *
 * 这里同样喂归一文本:编辑器按偏移切的是**原文**,而归一等长,所以两边对得上。
 * 公式节点(`math` / `inlineMath`)在编辑器里没有画法,走它的默认支当普通文字 ——
 * 编辑一条待办时看见的是 `$x^2$` 这几个字符,不是一个排好版的公式。
 */
export function parseMarkdownTree(text: string) {
  return fromMarkdown(normalizeMathDelimiters(text), {
    extensions: EXTENSIONS,
    mdastExtensions: MDAST_EXTENSIONS,
  })
}

export function parseMarkdown(text: string): ParsedBlock[] {
  if (!text) return []
  const tree = fromMarkdown(normalizeMathDelimiters(text), {
    extensions: EXTENSIONS,
    mdastExtensions: MDAST_EXTENSIONS,
  })
  return mdastToBlocks(tree.children, text)
}

export type { ParsedBlock }
