import type { Nodes } from 'mdast'
import { parseMarkdownTree } from '../markdown/parse'
import { isList, type Unit } from './units'

/**
 * 一段原文 → **切分**(正本 `docs/todo-editor-2026-09.md` §3.6)。
 *
 * 用的是消息那一份 mdast(`parseMarkdownTree`,同一套 GFM 扩展)。凡是**落在某个元素里、
 * 又不属于它的文字**的字符就是记号(`**`、反引号、`[`、`](`、`)`、行首 `## ` / `> `);
 * 渲染认成粗体的,记号就是那两对 `**`,渲染不认的(写错的 `**半截`),这里也不会假装它是记号。
 *
 * 同一份切分两种画法(`paint.ts`):收起时藏掉记号与链接地址,展开时全画。
 *
 * **不变量:文字段的显示长度 = 它在原文里占的长度。** 光标在「屏幕第几个字」与
 * 「原文第几个字」之间换算全靠这一条;反斜杠转义因此拆成「一个记号 + 一个字」,
 * 认不出的实体(`&amp;`)原样当文字显示,不为它破例。
 */

export type GroupKind = 'strong' | 'emphasis' | 'delete' | 'code' | 'link' | 'prefix' | 'escape'

export interface InlineFlags {
  readonly strong?: boolean
  readonly emphasis?: boolean
  readonly delete?: boolean
  readonly code?: boolean
  readonly link?: boolean
}

export interface Token {
  readonly kind: 'text' | 'mark' | 'url'
  /** 原文区间 [from, to)。 */
  readonly from: number
  readonly to: number
  readonly flags: InlineFlags
  /** 由外到内,这个字所属的元素 id。记号 / 地址的最后一个就是它自己的元素。 */
  readonly groups: readonly number[]
}

export interface Group {
  readonly id: number
  readonly kind: GroupKind
  /** 整个元素(含记号)的原文区间 [start, end)。 */
  readonly start: number
  readonly end: number
}

export interface Analysis {
  readonly source: string
  readonly tokens: readonly Token[]
  readonly groups: readonly Group[]
}

class Builder {
  readonly tokens: Token[] = []
  readonly groups: Group[] = []

  constructor(readonly source: string, readonly base: number) {}

  group(kind: GroupKind, start: number, end: number): number {
    const id = this.groups.length
    this.groups.push({ id, kind, start: this.base + start, end: this.base + end })
    return id
  }

  push(kind: Token['kind'], from: number, to: number, flags: InlineFlags, groups: readonly number[]): void {
    if (to <= from) return
    const last = this.tokens[this.tokens.length - 1]
    // 相邻、同类、同格式、同元素的文字并成一段:画出来少几层 span,换算也少几步。
    if (last && kind === 'text' && last.kind === 'text' && last.to === this.base + from
      && sameFlags(last.flags, flags) && sameGroups(last.groups, groups)) {
      this.tokens[this.tokens.length - 1] = { ...last, to: this.base + to }
      return
    }
    this.tokens.push({ kind, from: this.base + from, to: this.base + to, flags, groups })
  }

  /** 文字节点:原文切片与节点值逐字对齐,反斜杠转义拆成记号 + 字。 */
  text(from: number, to: number, value: string, flags: InlineFlags, groups: readonly number[]): void {
    const slice = this.source.slice(from, to)
    if (slice === value) { this.push('text', from, to, flags, groups); return }
    let i = 0
    let j = 0
    while (i < slice.length) {
      if (j < value.length && slice[i] === value[j]) {
        this.push('text', from + i, from + i + 1, flags, groups)
        i++
        j++
      } else if (slice[i] === '\\' && i + 1 < slice.length && slice[i + 1] === value[j]) {
        const escape = this.group('escape', from + i, from + i + 2)
        this.push('mark', from + i, from + i + 1, flags, [...groups, escape])
        i++
      } else {
        // 认不出的对齐(实体引用等):剩下的原样当文字,不猜。
        this.push('text', from + i, to, flags, groups)
        return
      }
    }
  }
}

function sameFlags(a: InlineFlags, b: InlineFlags): boolean {
  return !!a.strong === !!b.strong && !!a.emphasis === !!b.emphasis && !!a.delete === !!b.delete
    && !!a.code === !!b.code && !!a.link === !!b.link
}

function sameGroups(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

function span(node: Nodes): [number, number] | null {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return start === undefined || end === undefined ? null : [start, end]
}

function childrenOf(node: Nodes): Nodes[] {
  return 'children' in node && Array.isArray(node.children) ? (node.children as Nodes[]) : []
}

/** 在 [from, to) 里铺 nodes:节点之间与之外的空隙按普通文字铺。 */
function lay(b: Builder, nodes: readonly Nodes[], from: number, to: number, flags: InlineFlags, groups: readonly number[]): void {
  let cursor = from
  for (const node of nodes) {
    const range = span(node)
    if (!range) continue
    const [start, end] = range
    if (start < cursor) continue
    b.push('text', cursor, start, flags, groups)
    visit(b, node, start, end, flags, groups)
    cursor = end
  }
  b.push('text', cursor, to, flags, groups)
}

function visit(b: Builder, node: Nodes, start: number, end: number, flags: InlineFlags, groups: readonly number[]): void {
  const kids = childrenOf(node)
  switch (node.type) {
    case 'text':
      b.text(start, end, node.value, flags, groups)
      return
    case 'strong':
    case 'emphasis':
    case 'delete': {
      const first = kids.length ? span(kids[0]) : null
      const last = kids.length ? span(kids[kids.length - 1]) : null
      if (!first || !last) { b.push('text', start, end, flags, groups); return }
      const id = b.group(node.type, start, end)
      const inner = [...groups, id]
      b.push('mark', start, first[0], flags, inner)
      lay(b, kids, first[0], last[1], { ...flags, [node.type]: true }, inner)
      b.push('mark', last[1], end, flags, inner)
      return
    }
    case 'inlineCode': {
      const slice = b.source.slice(start, end)
      const run = slice.match(/^`+/)?.[0].length ?? 1
      const id = b.group('code', start, end)
      const inner = [...groups, id]
      b.push('mark', start, start + run, { ...flags, code: true }, inner)
      b.push('text', start + run, end - run, { ...flags, code: true }, inner)
      b.push('mark', end - run, end, { ...flags, code: true }, inner)
      return
    }
    case 'link': {
      const first = kids.length ? span(kids[0]) : null
      const last = kids.length ? span(kids[kids.length - 1]) : null
      if (!first || !last) { b.push('text', start, end, flags, groups); return }
      if (first[0] === start && last[1] === end) {
        // GFM 裸链接(`https://…` / `www.…`):没有记号可藏,只是看起来是链接。
        lay(b, kids, start, end, { ...flags, link: true }, groups)
        return
      }
      const id = b.group('link', start, end)
      const inner = [...groups, id]
      b.push('mark', start, first[0], flags, inner)
      lay(b, kids, first[0], last[1], { ...flags, link: true }, inner)
      const tail = b.source.slice(last[1], end)
      if (tail.startsWith('](') && tail.endsWith(')')) {
        b.push('mark', last[1], last[1] + 2, flags, inner)
        b.push('url', last[1] + 2, end - 1, flags, inner)
        b.push('mark', end - 1, end, flags, inner)
      } else {
        b.push('mark', last[1], end, flags, inner)
      }
      return
    }
    default:
      // 段落 / 标题 / 列表这类容器:往里铺;其余叶子(图、HTML、换行、引用式链接)原样当文字。
      if (kids.length) lay(b, kids, start, end, flags, groups)
      else b.push('text', start, end, flags, groups)
  }
}

/** 一段行内原文的切分。`base` = 这段在整个编辑值里的起点。 */
function analyzeInline(b: Builder, text: string): void {
  const tree = parseMarkdownTree(text)
  lay(b, tree.children as Nodes[], 0, text.length, {}, [])
}

const LINE_PREFIX: Partial<Record<Unit['type'], RegExp>> = { heading: /^#{1,6}\s+/, quote: /^>\s?/ }

/** 一个单元的编辑值 → 切分。行首 `## ` / `> ` 自成一个 `prefix` 元素。 */
export function analyzeUnit(unit: Unit, value: string): Analysis {
  if (unit.type === 'code') {
    return { source: value, tokens: value ? [{ kind: 'text', from: 0, to: value.length, flags: { code: true }, groups: [] }] : [], groups: [] }
  }
  if (isList(unit) || unit.type === 'para') {
    const b = new Builder(value, 0)
    analyzeInline(b, value)
    return { source: value, tokens: b.tokens, groups: b.groups }
  }
  const tokens: Token[] = []
  const groups: Group[] = []
  const prefix = LINE_PREFIX[unit.type]
  let offset = 0
  value.split('\n').forEach((line, index) => {
    if (index > 0) tokens.push({ kind: 'text', from: offset - 1, to: offset, flags: {}, groups: [] })
    const head = prefix ? line.match(prefix)?.[0] ?? '' : ''
    if (head) {
      const id = groups.length
      groups.push({ id, kind: 'prefix', start: offset, end: offset + head.length })
      tokens.push({ kind: 'mark', from: offset, to: offset + head.length, flags: {}, groups: [id] })
    }
    const rest = line.slice(head.length)
    const b = new Builder(rest, offset + head.length)
    analyzeInline(b, rest)
    const shift = groups.length
    for (const g of b.groups) groups.push({ ...g, id: g.id + shift })
    for (const t of b.tokens) tokens.push({ ...t, groups: t.groups.map(id => id + shift) })
    offset += line.length + 1
  })
  return { source: value, tokens, groups }
}
