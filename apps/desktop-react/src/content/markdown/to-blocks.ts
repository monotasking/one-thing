import type { BlockContent, Code, List, ListItem, RootContent, Table } from 'mdast'
import type { BlockModel } from '../model/blocks'
import { routeFence } from './fence'
import { toInline } from './to-inline'

/**
 * **mdast → BlockModel**(§3.2 的翻译表,块那一半)。
 *
 * ── AST 不外泄 ────────────────────────────────────────────────────────
 * 这个文件是 mdast 在本仓的**唯一**出口:上游拿到的永远是 §1 那份块词汇,谁都不
 * 认识 `mdast` 这个词。换解析器 = 换这一个文件(加它旁边的 parse.ts),块渲染器、
 * 装配管线、ChatStream 一行不动。
 *
 * ── 翻译表之外一律 source-fallback ────────────────────────────────────
 * 表里有的:paragraph / heading(1-3)/ list / code / table(GFM)/ blockquote。
 * 表里没有的(html 块、脚注定义、`---` 分隔线、frontmatter、将来的新语法)统统落
 * `source-fallback`,原文可见 —— 这不是兜底的客气话,是全系统的失败语义(§3.1)。
 * 于是「解析器认出了一个我们还没画法的东西」永远不会变成一段白屏。
 */

/** 一个块 + 它在源文本里的起始偏移。偏移是 key 的产地(§6),所以随块一起出厂。 */
export interface ParsedBlock {
  block: BlockModel
  /** 源偏移(mdast `position.start.offset`)。 */
  offset: number
  /** 源结束偏移 —— 增量解析拿它判「这一块是不是贴着活尾巴」。 */
  end: number
}

export function mdastToBlocks(nodes: readonly RootContent[], source: string): ParsedBlock[] {
  const out: ParsedBlock[] = []
  for (const node of nodes) {
    const offset = node.position?.start.offset ?? 0
    const end = node.position?.end.offset ?? source.length
    out.push({ block: translate(node, source), offset, end })
  }
  return out
}

function translate(node: RootContent, source: string): BlockModel {
  switch (node.type) {
    case 'paragraph':
      return { kind: 'paragraph', inline: toInline(node.children, source) }

    case 'heading':
      // 更深的标题**钳到 3**,不落兜底:`####` 在聊天里是常见写法,把它显示成源码
      // 反而是坏事。聊天纸面只有三级字号阶梯(§UI),第四级没有可画的形状,
      // 所以它和第三级同形 —— 信息(这是个标题)保住了,层级的细分丢了,记在这里。
      return {
        kind: 'heading',
        level: node.depth <= 1 ? 1 : node.depth === 2 ? 2 : 3,
        inline: toInline(node.children, source),
      }

    case 'code':
      return translateCode(node, source)

    case 'list':
      return translateList(node, source)

    case 'table':
      return translateTable(node, source)

    case 'blockquote':
      return { kind: 'quote', blocks: mdastToBlocks(node.children, source).map((entry) => entry.block) }

    case 'thematicBreak':
      // `---` / `***`:一条横线不是一段源码(08-31 真机报障:它曾落 fallback,
      // 被画成带「复制源码」檐的代码块)。零参数块,画法在 kinds/divider。
      return { kind: 'divider' }

    default:
      return fallback(node, source, `md:${node.type}`)
  }
}

/**
 * 围栏。
 *
 * `closed` 只能从**源文本**看出来:micromark 对一个没闭合的围栏一样产出 code 节点
 * (它在 EOF 处闭合),AST 上分不出「作者写完了」和「还在流」。所以这里读回源码的
 * 最后一行:是不是一行光秃秃的 ``` / ~~~。这是流式契约(§6)唯一的判据。
 */
function translateCode(node: Code, source: string): BlockModel {
  const start = node.position?.start.offset ?? 0
  const end = node.position?.end.offset ?? source.length
  const raw = source.slice(start, end)
  const indented = !/^\s{0,3}(`{3,}|~{3,})/.test(raw)
  // 缩进代码块(四个空格)没有围栏,它由「下一行不再缩进」结束 —— 天然是闭合的。
  const closed = indented || CLOSING_FENCE.test(raw)
  return routeFence(node.lang ?? null, node.value, closed)
}

/** 最后一行是不是收尾围栏(允许 0-3 空格缩进,后面只许空白)。 */
const CLOSING_FENCE = /\n\s{0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * 列表。
 *
 * ── 一项是一串块(08-31 真机报障后改的)──────────────────────────────
 * 从前一项是**一行行内树**,于是项里的非段落内容(围栏、表、引用)只能取源码原文
 * 当一行字塞进去 —— 用户看见的就是 ``` ```lua ``` 原样摊在列表项里。现在项内逐子块
 * 走 `translate`:围栏还是 code 块,表还是 table 块,引用还是 quote 块。谁来画由
 * **同一张注册表**说了算(铁律 1:嵌套 = 注册表复用),和引用块走的是同一条路。
 *
 * 连带的一处诚实变化:一项里连续两段字从前被 `\n` 接成一棵行内树(看起来是一项里
 * 的软换行),现在是**两个 paragraph 块** —— 源文本里它们本来就是两段。
 *
 * ── 嵌套仍然拍平一层,这条裁定不动 ──────────────────────────────────
 * 词汇现在装得下子树了,但「子列表的项提升成同一张列表的后续项」是既有拍板:
 * 内容一个字不丢,层级关系丢了(二级项在屏幕上与一级项同缩进)。要翻它是另一批的事,
 * 不是这一批顺手改的东西。
 */
function translateList(node: List, source: string): BlockModel {
  const items: BlockModel[][] = []
  for (const child of node.children) {
    collectListItem(child, source, items)
  }
  return { kind: 'list', ordered: node.ordered === true, items }
}

function collectListItem(item: ListItem, source: string, out: BlockModel[][]): void {
  const own: BlockModel[] = []
  const nested: List[] = []

  for (const child of item.children) {
    if (child.type === 'list') {
      nested.push(child)
      continue
    }
    // 项内一律走翻译表本身 —— 包括「表里没有的落 source-fallback」这条总纪律。
    // 项里没有第二套规则,也就没有第二处会跟主表分叉的地方。
    own.push(translate(child, source))
  }

  out.push(own)
  for (const list of nested) {
    for (const child of list.children) collectListItem(child, source, out)
  }
}

/**
 * GFM 表。
 *
 * 第一行是表头,其余是数据行。`align` 不进模型:六轮定稿说数字列右对齐、其余左对齐,
 * 判据是**列里装的是什么**(渲染层现算),不是作者在分隔行里写没写冒号 —— 后者在
 * 真实的模型输出里几乎永远是默认值,拿它当真相会让表格十次有九次不对齐。
 */
function translateTable(node: Table, source: string): BlockModel {
  const rows = node.children.map((row) => row.children.map((cell) => toInline(cell.children, source)))
  const [head = [], ...body] = rows
  return { kind: 'table', head, rows: body }
}

/** 翻译表之外的块:原文照抄,注明是哪一类节点没画法。 */
function fallback(node: RootContent, source: string, reason: string): BlockModel {
  return { kind: 'source-fallback', reason, source: rawBlockText(node, source) }
}

function rawBlockText(node: BlockContent | RootContent, source: string): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (typeof start === 'number' && typeof end === 'number') return source.slice(start, end)
  return 'value' in node && typeof node.value === 'string' ? node.value : ''
}
