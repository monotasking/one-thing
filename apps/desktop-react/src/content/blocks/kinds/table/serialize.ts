import type { BlockModel } from '../../../model/blocks'
import { inlineText, type InlineNode } from '../../../model/inline'

type TableModel = Extract<BlockModel, { kind: 'table' }>

/**
 * 表格的**序列化半边** —— 纯函数,零 React,单测直测。
 *
 * 「序列化归块,写剪贴板归壳」(§4.2 动作词表那条分界):块只负责算出**那一段字**,
 * 怎么进剪贴板、失败了怎么办,全在 `shell/actions.ts` 一处。所以这个文件里没有
 * 一行浏览器 API,也就没有一行需要 jsdom 才能测的东西。
 */

/** 复制为 Markdown —— 原样还给一张能贴回 markdown 的表。 */
export function tableToMarkdown(model: TableModel): string {
  const head = model.head.map(cellToMarkdown)
  const width = Math.max(head.length, ...model.rows.map((row) => row.length), 1)
  const lines = [
    row(pad(head, width)),
    // 分隔行一律默认对齐:模型里没有 align(对齐由「列里装的是什么」现算,
    // 见 numericColumns),那就不该在导出时凭空编一个出来。
    row(new Array(width).fill('---')),
    ...model.rows.map((cells) => row(pad(cells.map(cellToMarkdown), width))),
  ]
  return lines.join('\n')
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`
}

function pad(cells: readonly string[], width: number): string[] {
  const out = [...cells]
  while (out.length < width) out.push('')
  return out
}

/**
 * 复制为 CSV。
 *
 * RFC 4180 的三条:含逗号 / 引号 / 换行的字段要加引号,字段里的引号翻倍。
 * 单元格取**纯文字**(inlineText)—— CSV 是给表格软件吃的,把 `**粗**` 原样塞进去
 * 只会让那一格显示成六个字符。
 */
export function tableToCsv(model: TableModel): string {
  const rows = [model.head, ...model.rows]
  return rows.map((cells) => cells.map((cell) => csvField(inlineText(cell))).join(',')).join('\n')
}

function csvField(text: string): string {
  if (!/[",\n\r]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * 复制一列 —— 列头那个 ⧉ 的产物。
 *
 * 只给这一列的**数据**(不含表头):人点列头上的复制,要的是那一列的值,
 * 表头是他刚刚看着点下去的那个字,再抄一遍给他没有用。一行一个,换行分隔 ——
 * 这个形状可以直接粘进表格软件的一列,也可以直接粘进编辑器。
 */
export function columnToText(model: TableModel, column: number): string {
  return model.rows.map((cells) => inlineText(cells[column] ?? [])).join('\n')
}

/**
 * 哪几列是数字列(定稿:数字列右对齐 + mono)。
 *
 * 判据是**列里装的是什么**,不是作者在分隔行里写没写冒号 —— 后者在模型输出的表里
 * 几乎永远是默认值,拿它当真相会让表格十次有九次不对齐。
 *
 * 一列算数字列要同时成立:至少有一个非空格、且**每一个**非空格都能读成数(允许
 * 千分位逗号、百分号、正负号、货币符号前缀)。有一格不是,整列就不是 —— 混着字的
 * 那一列右对齐会更难读。
 */
export function numericColumns(model: TableModel): boolean[] {
  const width = Math.max(model.head.length, ...model.rows.map((row) => row.length), 0)
  const out: boolean[] = []
  for (let col = 0; col < width; col += 1) {
    let seen = 0
    let numeric = true
    for (const row of model.rows) {
      const text = inlineText(row[col] ?? []).trim()
      if (text === '') continue
      seen += 1
      if (!isNumericCell(text)) {
        numeric = false
        break
      }
    }
    out.push(numeric && seen > 0)
  }
  return out
}

const NUMERIC = /^[+-]?[$¥€£]?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?$|^[+-]?[$¥€£]?\d+(?:\.\d+)?%?$/

function isNumericCell(text: string): boolean {
  return NUMERIC.test(text)
}

/** 行内树 → markdown 原文。表格的 markdown 导出要保住强调 / 行内码 / 链接。 */
export function cellToMarkdown(nodes: readonly InlineNode[]): string {
  return nodes.map(nodeToMarkdown).join('')
}

function nodeToMarkdown(node: InlineNode): string {
  switch (node.type) {
    case 'text':
      // 单元格里的竖线要转义,换行要压成空格 —— 一个 markdown 表格行不能跨行。
      return node.text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
    case 'code':
      return `\`${node.text.replace(/\|/g, '\\|')}\``
    case 'emphasis':
      return node.strong ? `**${cellToMarkdown(node.children)}**` : `*${cellToMarkdown(node.children)}*`
    case 'strike':
      return `~~${cellToMarkdown(node.children)}~~`
    case 'link':
      return `[${cellToMarkdown(node.children)}](${node.href})`
    case 'citation':
      // 角标是呈现不是正文(inlineText 也不收它)—— 导出时同样不跟着走。
      return ''
  }
}
