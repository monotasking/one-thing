import { parseUnits, type HeadingUnit, type Unit } from '../editing/units'

/**
 * 一份待办文档**怎么看**(待办 B 形 §2.3 / U4):哪些单元收起、哪几行提示行画在哪。
 * 纯函数 —— 原文一个字不动,偏好从外面给,结果交给 `EditableDoc` 的 `hidden` / `folds`。
 *
 * ── 小节 ──
 * 二、三级标题各开一节。一节**自己的**单元到下一个标题(不论几级)为止;折叠一节盖住的范围到下一个
 * 同级或更高级的标题为止(三级小节在二级小节里面)。第一个这样的标题之前(含一级大标题)是「根」
 * 那一节,键是空串。小节的键就是标题那一行的文字:改了标题 = 换了一节,折叠状态不跟过去
 * (与 Typora / Obsidian 按标题记同一个取舍)。
 *
 * ── 两件事 ──
 *  · **已完成收起**(`showDone` 关着时):每一节自己的单元里勾完的任务项收起来,紧跟在这一节自己的
 *    单元后面画一行「已完成 N 项」;这一节的键在 `doneOpen` 里就展开,行还在、换成 ▾;
 *  · **小节折叠**(`folded` 里有这一节的键):标题留着,盖住的范围整段收起,紧跟标题画一行
 *    「N 项未完成」。被折起来盖住的节不再单独说「已完成」,也不再单独折。
 */
export interface TodoViewPrefs {
  readonly showDone: boolean
  /** 展开了「已完成」的节。 */
  readonly doneOpen: ReadonlySet<string>
  /** 折起来的节。 */
  readonly folded: ReadonlySet<string>
}

export type TodoFoldSpec =
  | { readonly kind: 'done'; readonly key: string; readonly section: string; readonly at: number; readonly count: number; readonly open: boolean }
  | { readonly kind: 'section'; readonly key: string; readonly section: string; readonly at: number; readonly remaining: number }

export interface TodoView {
  readonly hidden: ReadonlySet<number>
  readonly folds: readonly TodoFoldSpec[]
}

export interface TodoSection {
  readonly key: string
  readonly heading: HeadingUnit | null
  /** 这一节自己的单元(不含标题、不含更深的小节)。 */
  readonly units: readonly Unit[]
  /** 自己的单元之后第一行(= 下一个标题的起始行,没有就是文档末尾)。 */
  readonly ownEnd: number
  /** 折叠盖住的范围之后第一行(下一个同级或更高级标题,没有就是文档末尾)。 */
  readonly foldEnd: number
}

export const EMPTY_TODO_VIEW: TodoView = { hidden: new Set(), folds: [] }

export function sectionsOf(lines: readonly string[]): TodoSection[] {
  const units = parseUnits(lines)
  const drafts: Array<{ key: string; heading: HeadingUnit | null; units: Unit[] }> = [{ key: '', heading: null, units: [] }]
  for (const unit of units) {
    if (unit.type === 'heading' && unit.level >= 2) {
      drafts.push({ key: lines[unit.start].replace(/^#{1,6}\s+/, '').trim(), heading: unit, units: [] })
      continue
    }
    drafts[drafts.length - 1].units.push(unit)
  }
  return drafts.map((draft, index) => {
    const ownEnd = drafts[index + 1]?.heading?.start ?? lines.length
    const level = draft.heading?.level ?? 0
    const closer = draft.heading ? drafts.slice(index + 1).find(next => (next.heading?.level ?? 0) <= level) : undefined
    return { ...draft, ownEnd, foldEnd: draft.heading ? (closer?.heading?.start ?? lines.length) : ownEnd }
  })
}

export function todoViewOf(lines: readonly string[], prefs: TodoViewPrefs): TodoView {
  if (prefs.showDone && prefs.folded.size === 0) return EMPTY_TODO_VIEW
  const hidden = new Set<number>()
  const folds: TodoFoldSpec[] = []
  const sections = sectionsOf(lines)
  const units = parseUnits(lines)
  const covered: Array<[number, number]> = []
  const isCovered = (line: number) => covered.some(([from, to]) => line > from && line < to)

  for (const section of sections) {
    const heading = section.heading
    if (!heading || !prefs.folded.has(section.key) || isCovered(heading.start)) continue
    covered.push([heading.start, section.foldEnd])
    const inside = units.filter(u => u.start > heading.start && u.start < section.foldEnd)
    for (const unit of inside) hidden.add(unit.start)
    const remaining = inside.filter(u => u.type === 'task' && !u.done).length
    folds.push({ kind: 'section', key: `section:${section.key}`, section: section.key, at: heading.end + 1, remaining })
  }

  if (!prefs.showDone) {
    for (const section of sections) {
      if (section.heading ? isCovered(section.heading.start) || prefs.folded.has(section.key) : false) continue
      const done = section.units.filter(u => u.type === 'task' && u.done)
      if (done.length === 0) continue
      const open = prefs.doneOpen.has(section.key)
      if (!open) for (const unit of done) hidden.add(unit.start)
      folds.push({ kind: 'done', key: `done:${section.key}`, section: section.key, at: section.ownEnd, count: done.length, open })
    }
  }

  folds.sort((a, b) => a.at - b.at)
  return { hidden, folds }
}
