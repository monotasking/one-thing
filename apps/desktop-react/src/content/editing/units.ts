/**
 * 一份 markdown 按行切成**可编辑单元**(正本 `docs/todo-editor-2026-09.md` §3.3)。
 *
 * 一个单元对应原文里连续的几行:列表项(一行)/ 标题(一行)/ 段落(连续几行)/
 * 引用(连续的 `>` 行)/ 代码块(整个围栏)。编辑、光标、结构命令都以单元为粒度;
 * 行内的解析(粗体、行内码……)交给 `inline-tokens.ts`,用的是消息那一份 mdast。
 *
 * 块级这一层用行规则而不是 mdast:每个单元必须精确对应几行原文(改完要变成
 * `LineEdit`),而待办文档的块形状就是这几种。认不出的形状一律当段落 —— 它照样能改,
 * 只是不画成特殊块。
 */

export type UnitType = 'heading' | 'task' | 'bullet' | 'ordered' | 'quote' | 'para' | 'code'

interface UnitBase {
  readonly type: UnitType
  /** 第一行的行号(0 起)。 */
  readonly start: number
  /** 最后一行的行号(含)。 */
  readonly end: number
}

export interface HeadingUnit extends UnitBase { readonly type: 'heading'; readonly level: 1 | 2 | 3 }
export interface ListUnit extends UnitBase {
  readonly type: 'task' | 'bullet' | 'ordered'
  /** 行首空白的字符数。 */
  readonly indent: number
  /** `-` / `*` / `+`;有序列表是 `.` 或 `)`。 */
  readonly marker: string
  readonly num: number
  readonly done: boolean
  /** 前缀之后的那段文字。 */
  readonly content: string
}
export interface QuoteUnit extends UnitBase { readonly type: 'quote' }
export interface ParaUnit extends UnitBase { readonly type: 'para' }
export interface CodeUnit extends UnitBase {
  readonly type: 'code'
  readonly lang: string
  readonly open: string
  readonly close: string | null
  readonly body: string
}

export type Unit = HeadingUnit | ListUnit | QuoteUnit | ParaUnit | CodeUnit

const HEADING = /^(#{1,6})\s+(.*)$/
const TASK = /^(\s*)([-*+])\s+\[( |x|X)\]\s?(.*)$/
const BULLET = /^(\s*)([-*+])\s+(.*)$/
const ORDERED = /^(\s*)(\d+)([.)])\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const FENCE = /^(`{3,}|~{3,})(.*)$/

export function startsBlock(line: string): boolean {
  return HEADING.test(line) || BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line) || FENCE.test(line)
}

export function isList(unit: Unit): unit is ListUnit {
  return unit.type === 'task' || unit.type === 'bullet' || unit.type === 'ordered'
}

/**
 * 按行切成单元。空行不是单元(它是分隔),**唯一的例外是 `draft`**:光标正停在上面的那一个空行
 * (回车退出列表 / 段落之后落脚的「空段落」,见 `CaretController.enter`)算一个空段落,好让它有一行
 * 可画、可输入。光标一离开,那一行要么已经有字、要么被收掉,不会留下一个空段落单元。
 */
export function parseUnits(lines: readonly string[], draft?: number): Unit[] {
  const units: Unit[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    let m: RegExpMatchArray | null
    if (!line.trim()) {
      if (i === draft) units.push({ type: 'para', start: i, end: i })
      i++
      continue
    }
    if ((m = line.match(FENCE))) {
      const fence = m[1]
      let j = i + 1
      while (j < lines.length && !lines[j].startsWith(fence[0].repeat(fence.length))) j++
      const closed = j < lines.length
      units.push({
        type: 'code', start: i, end: closed ? j : lines.length - 1, lang: m[2].trim(),
        open: line, close: closed ? lines[j] : null, body: lines.slice(i + 1, closed ? j : lines.length).join('\n'),
      })
      i = closed ? j + 1 : lines.length
      continue
    }
    if ((m = line.match(HEADING))) {
      units.push({ type: 'heading', start: i, end: i, level: Math.min(3, m[1].length) as 1 | 2 | 3 })
      i++
      continue
    }
    if ((m = line.match(TASK))) {
      units.push({ type: 'task', start: i, end: i, indent: m[1].length, marker: m[2], num: 0, done: m[3] !== ' ', content: m[4] })
      i++
      continue
    }
    if ((m = line.match(BULLET))) {
      units.push({ type: 'bullet', start: i, end: i, indent: m[1].length, marker: m[2], num: 0, done: false, content: m[3] })
      i++
      continue
    }
    if ((m = line.match(ORDERED))) {
      units.push({ type: 'ordered', start: i, end: i, indent: m[1].length, marker: m[3], num: Number(m[2]), done: false, content: m[4] })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      let j = i
      while (j < lines.length && QUOTE.test(lines[j])) j++
      units.push({ type: 'quote', start: i, end: j - 1 })
      i = j
      continue
    }
    let j = i
    while (j < lines.length && lines[j].trim() && (j === i || !startsBlock(lines[j]))) j++
    units.push({ type: 'para', start: i, end: j - 1 })
    i = j
  }
  return units
}

/** 列表项的行首(保留原来的记号与缩进)。 */
export function prefixOf(unit: ListUnit): string {
  const indent = ' '.repeat(unit.indent)
  if (unit.type === 'ordered') return `${indent}${unit.num}${unit.marker} `
  return `${indent}${unit.marker} ${unit.type === 'task' ? `[${unit.done ? 'x' : ' '}] ` : ''}`
}

/** 回车新起一项用的行首:任务 → 未勾选任务;有序 → 序号 +1;记号与缩进不变。 */
export function continuedPrefix(unit: ListUnit): string {
  const indent = ' '.repeat(unit.indent)
  if (unit.type === 'ordered') return `${indent}${unit.num + 1}${unit.marker} `
  return `${indent}${unit.marker} ${unit.type === 'task' ? '[ ] ' : ''}`
}

/**
 * 有序列表拆出 / 插进一项之后,把 `from` 那一项**后面**同一层的兄弟项顺着往下编号
 * (更深的子项跳过,遇到更浅的一层、空行、别的块就停)。只动序号,别的一个字不动。
 */
export function renumberOrdered(lines: string[], from: number): void {
  const head = lines[from]?.match(ORDERED)
  if (!head) return
  const indent = head[1].length
  let num = Number(head[2])
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) return
    const list = line.match(ORDERED) ?? line.match(BULLET)
    if (!list) return
    const depth = list[1].length
    if (depth > indent) continue
    if (depth < indent) return
    const m = line.match(ORDERED)
    if (!m || m[3] !== head[3]) return
    num += 1
    if (Number(m[2]) !== num) lines[i] = line.replace(/^(\s*)\d+/, `$1${num}`)
  }
}

/** 编辑时这一单元「放进编辑区的原文」。列表项不含前缀(前缀在外面画成勾选框 / 圆点)。 */
export function editValueOf(unit: Unit, lines: readonly string[]): string {
  if (isList(unit)) return unit.content
  if (unit.type === 'code') return unit.body
  return lines.slice(unit.start, unit.end + 1).join('\n')
}

/** 编辑区里的原文 → 回写成几行。 */
export function linesFromEdit(unit: Unit, value: string): string[] {
  if (isList(unit)) return [prefixOf(unit) + value.replace(/\n/g, ' ')]
  if (unit.type === 'heading') return [value.replace(/\n/g, ' ')]
  if (unit.type === 'code') return unit.close === null ? [unit.open, ...value.split('\n')] : [unit.open, ...value.split('\n'), unit.close]
  return value.split('\n')
}

/** 能不能装多行(段落 / 引用 / 代码):决定回车是换行还是结构命令、粘贴时换行保不保留。 */
export function isMultiline(unit: Unit): boolean {
  return unit.type === 'para' || unit.type === 'quote' || unit.type === 'code'
}
