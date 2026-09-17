import type { BlockContent, Code, List, ListItem, Paragraph, PhrasingContent, RootContent, Table } from 'mdast'
import type { BlockModel, ListItemModel } from '../model/blocks'
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
 * 表里有的:paragraph / heading(1-3)/ list / code / table(GFM)/ blockquote /
 * thematicBreak,外加一处**提升**:独占一段的 image 从行内升成 `image` 块(§1)。
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
      return translateParagraph(node, source)

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
 * 段落 —— 外加**「独占一段的图提升成物件」**这一处判据(正本 §1、§3)。
 *
 * mdast 里 image 永远是行内节点(phrasing),所以「一张图是一件东西」这句话在翻译
 * 表里只有一个落点:**这一段除了一张图之外只剩空白**。判据落在这一处,别处一个字
 * 都不判 —— 两处判会分叉成两种真相(与 `closed` 只从源文本看同一条纪律)。
 *
 * 判据里「只剩空白」用的是**源节点**而不是翻译后的行内树:翻译会把相邻文字并格
 * (`push`),`![a](x) ` 与 ` ![a](x)` 并出来的形状不一样,按结果判就会时灵时不灵。
 *
 * 三种不提升,各有各的理由:两张图一段(它们是并排的两件东西,提升成一个块只能
 * 丢掉一张)、图夹着字(那一句话的一部分)、`imageReference`(它根本没被翻译成
 * image 节点,仍是原文文字)。这三种都留在段落里,由行内芯片说清「这里有一张图」。
 */
function translateParagraph(node: Paragraph, source: string): BlockModel {
  const meat = node.children.filter((child) => !isBlankText(child))
  const only = meat.length === 1 ? meat[0] : undefined
  if (only?.type === 'image') {
    return {
      kind: 'image',
      ref: { kind: 'url', url: only.url },
      alt: only.alt ?? '',
      title: only.title ?? undefined,
    }
  }
  return { kind: 'paragraph', inline: toInline(node.children, source) }
}

/** 只有空白的文字节点 —— 图前图后的换行与空格,它们不算「这一段还有别的东西」。 */
function isBlankText(node: PhrasingContent): boolean {
  return node.type === 'text' && node.value.trim() === ''
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
  const items: ListItemModel[] = []
  for (const child of node.children) {
    collectListItem(child, source, items, 0)
  }
  return { kind: 'list', ordered: node.ordered === true, items }
}

function collectListItem(item: ListItem, source: string, out: ListItemModel[], depth: number): void {
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

  // GFM 任务项:mdast 的 `checked` 是 true / false / null(null = 不是任务项)。
  out.push({ blocks: own, checked: typeof item.checked === 'boolean' ? item.checked : null, depth })
  for (const list of nested) {
    for (const child of list.children) collectListItem(child, source, out, depth + 1)
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
