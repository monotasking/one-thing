import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { mdastToBlocks, type ParsedBlock } from './to-blocks'

/**
 * **一段 markdown → 一串块**(§3.2)。
 *
 * micromark/mdast,加 GFM(表格 / 删除线 / 自动链接 / 任务列表)。选它不是因为它流行:
 * 它的 AST 有**逐节点的源偏移**,而源偏移是流式那半边的地基(key 由它派生,增量的
 * 切点由它验证)。换一个不给位置的解析器,§6 整节就没法成立。
 *
 * 扩展只在这一处组装:`extensions`(词法)与 `mdastExtensions`(建树)两份是 unified
 * 家族的既定形状,加一种语法就是这两个数组各加一格。
 */

const EXTENSIONS = [gfm()]
const MDAST_EXTENSIONS = [gfmFromMarkdown()]

export function parseMarkdown(text: string): ParsedBlock[] {
  if (!text) return []
  const tree = fromMarkdown(text, {
    extensions: EXTENSIONS,
    mdastExtensions: MDAST_EXTENSIONS,
  })
  return mdastToBlocks(tree.children, text)
}

export type { ParsedBlock }
