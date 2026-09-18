import { locate } from '@onething/core/text'
import { focusElement } from '../../focus/target'
import { DocHistory, type EditKind, type HistoryEntry } from './doc-history'
import type { EditorDocument } from './editor-document'
import { analyzeUnit, type Analysis } from './inline-tokens'
import { paint, type PaintClasses } from './paint'
import { splitValueAt } from './split'
import { canonicalPosition, insideGroups, REVEAL_POLICIES, sourceToView, viewToSource, type RevealMode } from './reveal'
import {
  continuedPrefix,
  editValueOf,
  isList,
  isMultiline,
  linesFromEdit,
  parseUnits,
  prefixOf,
  renumberOrdered,
  startsBlock,
  type ListUnit,
  type Unit,
} from './units'

/**
 * 光标控制器 —— 光标的**唯一产地**(正本 `docs/todo-editor-2026-09.md` §6.0)。
 *
 * 总则:同一个画面 + 同一个动作 = 同一个结果。为此:
 *  · 光标是文档级的一个位置 { 哪一项, 原文第几个字(anchor / focus), 目标列 },屏幕选区只是投影,
 *    每次改完都由模型重新设一遍;
 *  · 导航键全部在 keydown 里由这里算完、画完、`preventDefault`;浏览器自带的 `selection.modify`
 *    只当量尺,在同一个事件里同步调一次;
 *  · 鼠标按下时按「当前画面」量,一律取靠左;
 *  · 输入一律改原文模型再从模型重画(`beforeinput` 全部拦下);绕过它的改动在 `input` 里丢弃重画;
 *  · 结构编辑每条都交回一个光标 —— 键盘动作永远不让光标消失,只有 Esc / ⌘↵ / 点到外面会;
 *  · 一条文档级撤销历史。
 *
 * 样例 `docs/todo-editor-reveal-2026-09-17.html` 是它的原型(页内一致性自测三档 27 / 27)。
 * 这一份是那份逻辑的类化,DOM 经 `EditorDom` 递进来,React 视图只负责按行渲染与提交。
 */

export interface EditorDom {
  /** 某一项的内容元素(没打开时是渲染态,打开时就是编辑区本身)。 */
  unitContent(start: number): HTMLElement | null
  /** 滚动容器。 */
  scroller(): HTMLElement | null
  /** 同步提交一次视图渲染(打开 / 关闭 / 结构编辑之后要立刻量 DOM)。 */
  commit(): void
}

export interface CaretControllerOptions {
  readonly mode: () => RevealMode
  readonly classes: PaintClasses
  /** 编辑开始 / 结束(视图据它认领键、画行底)。 */
  readonly onActiveChange?: (start: number | null) => void
  /**
   * 此刻**收起**的单元(起始行)。折叠小节、「已完成」收起都是视图事实,原文一个字不动 ——
   * 光标只在看得见的单元之间走,结构编辑也不许吃掉看不见的行(待办 B 形 U4)。缺席 = 全都看得见。
   */
  readonly hidden?: () => ReadonlySet<number>
}

interface ActiveState {
  start: number
  unit: Unit
  span: number
  value: string
  anchor: number
  focus: number
  analysis: Analysis
  vis: readonly number[]
  revealed: ReadonlySet<number>
  current: number | null
  goalX?: number
  goalFor?: number
  sticky?: number
  freshPair?: number
  composing: boolean
  compositionRange?: [number, number]
  pointer: boolean
  dragFrom: number
  /** 这一格是落脚空行时,当初为它垫的分隔空行(离开时没写字,连它们一起收掉)。 */
  pad?: { above: boolean; below: boolean }
  /** 结构编辑 / 撤销 / 外部改动之后,这份状态里的行号已经不再指向原来那一行:离开时不再按它收落脚空行。 */
  stale?: boolean
}

type Bias = 'low' | 'high'

/** 渲染态 HTML 缓存上限(一份几百行的清单足够;超了整份清掉重来,不做 LRU 记账)。 */
const RESTING_CACHE_LIMIT = 2000

const EMPTY_SET: ReadonlySet<number> = new Set()

const MARK_OF = { strong: '**', emphasis: '*', code: '`' } as const
type MarkKind = keyof typeof MARK_OF

let segmenter: Intl.Segmenter | null | undefined

function graphemeAt(text: string, index: number): [number, number] {
  if (segmenter === undefined) segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  if (!segmenter) return [index, index + 1]
  for (const part of segmenter.segment(text)) {
    if (part.index <= index && index < part.index + part.segment.length) return [part.index, part.index + part.segment.length]
  }
  return [index, index + 1]
}

function viewOffsetOf(root: Node, node: Node, offset: number): number {
  const range = document.createRange()
  range.setStart(root, 0)
  try { range.setEnd(node, offset) } catch { return 0 }
  return range.toString().length
}

function domPoint(root: HTMLElement, viewOffset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let acc = 0
  let last: Text | null = null
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    last = n
    if (acc + n.length >= viewOffset) return { node: n, offset: viewOffset - acc }
    acc += n.length
  }
  return last ? { node: last, offset: last.length } : { node: root, offset: 0 }
}

function rectAt(root: HTMLElement, viewOffset: number): DOMRect {
  const point = domPoint(root, viewOffset)
  const range = document.createRange()
  range.setStart(point.node, point.offset)
  range.collapse(true)
  let rect = range.getClientRects()[0]
  if (!rect) {
    // 折叠选区量不出矩形(空项、换行之后):临时插一个零宽字量完就拿掉。
    const marker = document.createElement('span')
    marker.textContent = '​'
    range.insertNode(marker)
    rect = marker.getBoundingClientRect()
    marker.remove()
    root.normalize()
  }
  return rect
}

function lineHeightOf(element: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(element).lineHeight) || 22
}

/** 屏幕上一点 → 这块元素里离它最近的第几个字(点在行尾空白 / 缝里 / 勾选框左边,都夹回元素里再量)。 */
function offsetAtPoint(element: HTMLElement, x: number, y: number): number {
  const box = element.getBoundingClientRect()
  const cx = Math.min(Math.max(x, box.left + 1), box.right - 1)
  const cy = Math.min(Math.max(y, box.top + 2), box.bottom - 2)
  let node: Node | null = null
  let offset = 0
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(cx, cy)
    if (position) { node = position.offsetNode; offset = position.offset }
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(cx, cy)
    if (range) { node = range.startContainer; offset = range.startOffset }
  }
  if (!node || !element.contains(node)) return cx > box.left + box.width / 2 ? Number.POSITIVE_INFINITY : 0
  return viewOffsetOf(element, node, offset)
}

/** 与 `unit` 同一种、同一层的空项(任务不带勾,有序用它自己的序号 —— 它自己往下挪一格)。 */
function blankItemLike(unit: ListUnit): string {
  return unit.type === 'ordered' ? prefixOf(unit) : continuedPrefix(unit)
}

export class CaretController {
  private active: ActiveState | null = null
  private readonly history = new DocHistory()
  private applying = false
  private readonly restingCache = new Map<string, string>()

  constructor(
    private readonly doc: EditorDocument,
    private readonly dom: EditorDom,
    private readonly options: CaretControllerOptions,
  ) {}

  /**
   * 订文档的外部改动(返回退订)。不放在构造里:React StrictMode 下挂载效应会跑「挂 → 拆 → 再挂」,
   * 订阅要跟着效应走,构造一次订一次的话拆掉之后就再也订不回来。
   */
  attach(): () => void {
    return this.doc.subscribe(change => { if (change.kind === 'server') this.rebaseAfterServerChange(change.previous) })
  }

  get activeStart(): number | null {
    return this.active?.start ?? null
  }

  /**
   * 光标正停着的**落脚空行**(回车退出列表 / 引用 / 段落之后停的那一个空行,见 `enter`):它此刻
   * 算一个空段落,有一行可画、可输入(`parseUnits` 的 `draft`)。状态是算出来的 —— 光标在一个段落上、
   * 那一行是空的,就是它。
   */
  get draftLine(): number | undefined {
    const a = this.active
    return a && a.unit.type === 'para' && (this.doc.lines[a.start] ?? 'x').trim() === '' ? a.start : undefined
  }

  /** 此刻的全部单元(落脚空行算一个)。控制器里切单元一律问它。 */
  private units(): Unit[] {
    return parseUnits(this.doc.lines, this.draftLine)
  }

  /** 此刻的光标(只读快照)。给实验台 / 真机门自检用:屏幕选区换算回原文要等于 `focus`。 */
  snapshot(): { start: number; anchor: number; focus: number; value: string; viewFocus: number; visible: readonly number[] } | null {
    const a = this.active
    return a ? { start: a.start, anchor: a.anchor, focus: a.focus, value: a.value, viewFocus: sourceToView(a.vis, a.focus), visible: a.vis } : null
  }


  /* ── 渲染态(没打开的项)的 HTML:与编辑态同一份切分,只是记号全收起 ─────── */

  restingHtml(unit: Unit, lines: readonly string[]): string {
    const value = editValueOf(unit, lines)
    // 每次按键整篇重渲一遍行,但只有一格的原文变了:按「类型 + 原文」缓存,其余各格不重新解析。
    const key = `${unit.type}\u0000${value}`
    const cached = this.restingCache.get(key)
    if (cached !== undefined) return cached
    const html = paint(analyzeUnit(unit, value), new Set(), null, this.options.classes).html
    if (this.restingCache.size > RESTING_CACHE_LIMIT) this.restingCache.clear()
    this.restingCache.set(key, html)
    return html
  }

  /* ── 进出一项 ─────────────────────────────────────────────────────────── */

  open(start: number, anchor: number | 'end', focus?: number | 'end'): void {
    const leaving = this.active
    if (leaving && leaving.start !== start) start = this.dropDraft(leaving, start)
    // 要打开的是一个空行 = 落脚空行(只有 `landDraft` 与撤销会这样要)。
    const unit = parseUnits(this.doc.lines, start).find(u => u.start === start)
    if (!unit) { this.close(); return }
    const value = editValueOf(unit, this.doc.lines)
    const clamp = (x: number | 'end') => Math.max(0, Math.min(value.length, x === 'end' ? value.length : x))
    const analysis = analyzeUnit(unit, value)
    const resting = paint(analysis, new Set(), null, this.options.classes)
    const state: ActiveState = {
      start, unit, span: unit.end - unit.start + 1, value, analysis, vis: resting.vis, revealed: new Set(), current: null,
      anchor: clamp(anchor), focus: clamp(focus ?? anchor), composing: false, pointer: false, dragFrom: 0,
    }
    if (this.options.mode() === 'none') {
      state.focus = canonicalPosition(analysis, resting.vis, value.length, sourceToView(resting.vis, state.focus))
      state.anchor = focus === undefined || focus === anchor
        ? state.focus
        : canonicalPosition(analysis, resting.vis, value.length, sourceToView(resting.vis, state.anchor))
    }
    const changed = this.active?.start !== start
    this.active = state
    if (changed) this.options.onActiveChange?.(start)
    this.dom.commit()
    this.refresh(true)
  }

  close(): void {
    if (!this.active) return
    this.dropDraft(this.active)
    this.active = null
    this.options.onActiveChange?.(null)
    this.dom.commit()
    void this.doc.flush()
  }

  /** 视图重画之后(档位变了、外部改了):把编辑区与选区再对一遍。 */
  repaint(): void {
    if (this.active) this.refresh(true)
  }

  /* ── 模型 → 屏幕 ─────────────────────────────────────────────────────── */

  private editor(): HTMLElement | null {
    return this.active ? this.dom.unitContent(this.active.start) : null
  }

  private resolve(a: ActiveState, viewOffset: number, bias: Bias): number {
    const length = a.value.length
    if (viewOffset === Number.POSITIVE_INFINITY) return length
    return this.options.mode() === 'none'
      ? canonicalPosition(a.analysis, a.vis, length, viewOffset)
      : viewToSource(a.vis, length, viewOffset, bias)
  }

  private refresh(force: boolean): void {
    const a = this.active
    const ed = this.editor()
    if (!a || !ed) return
    const analysis = analyzeUnit(a.unit, a.value)
    const lo = Math.min(a.anchor, a.focus)
    const hi = Math.max(a.anchor, a.focus)
    const mode = this.options.mode()
    const revealed = REVEAL_POLICIES[mode].revealed(analysis, lo, hi)
    const current = mode === 'none' ? (insideGroups(analysis, a.focus)[0]?.id ?? null) : null
    a.analysis = analysis
    const same = revealed.size === a.revealed.size && [...revealed].every(id => a.revealed.has(id))
    if (force || !same || current !== a.current) {
      a.revealed = revealed
      a.current = current
      const painted = paint(analysis, revealed, current, this.options.classes)
      a.vis = painted.vis
      ed.innerHTML = painted.html + (a.value.endsWith('\n') ? '<br>' : '')
    }
    this.applySelection()
    this.scrollCaretIntoView()
  }

  private applySelection(): void {
    const a = this.active
    const ed = this.editor()
    if (!a || !ed) return
    this.applying = true
    try {
      focusElement(ed)
      const pa = domPoint(ed, sourceToView(a.vis, a.anchor))
      const pf = domPoint(ed, sourceToView(a.vis, a.focus))
      getSelection()?.setBaseAndExtent(pa.node, pa.offset, pf.node, pf.offset)
    } finally {
      this.applying = false
    }
  }

  private scrollCaretIntoView(): void {
    const a = this.active
    const ed = this.editor()
    const scroller = this.dom.scroller()
    if (!a || !ed || !scroller) return
    const rect = rectAt(ed, sourceToView(a.vis, a.focus))
    // 整页滚动时量的是视口,不是整篇文档那只盒子。
    const box = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect()
    const pad = 8
    if (rect.bottom > box.bottom - pad) scroller.scrollTop += rect.bottom - box.bottom + pad
    else if (rect.top < box.top + pad) scroller.scrollTop -= box.top + pad - rect.top
  }

  /* ── 改原文 ───────────────────────────────────────────────────────────── */

  private caretMemo(): HistoryEntry['caret'] {
    const a = this.active
    return a ? { start: a.start, anchor: a.anchor, focus: a.focus } : null
  }

  private record(kind: EditKind): void {
    this.history.record(kind, { lines: this.doc.lines.slice(), caret: this.caretMemo() })
  }

  /** 正在编辑的这一项随改随写回文档(不等离开)。行数变了要整篇重画(后面各项的行号都变了)。 */
  private writeThrough(): void {
    const a = this.active
    if (!a) return
    const next = linesFromEdit(a.unit, a.value)
    const lines = this.doc.lines.slice()
    lines.splice(a.start, a.span, ...next)
    const spanChanged = next.length !== a.span
    a.span = next.length
    this.doc.setLines(lines)
    // 这一行改完之后不再是原来那一种单元了(比如标题删掉了空格变成段落):按新形重新打开,
    // 否则编辑区还按旧形画,文字会整行消失、光标丢掉(09-17 真机)。
    const reparsed = parseUnits(this.doc.lines, a.start).find(u => u.start === a.start)
    if (!reparsed || reparsed.type !== a.unit.type) {
      const keep = { anchor: a.anchor, focus: a.focus }
      this.dom.commit()
      this.open(a.start, keep.anchor, keep.focus)
      return
    }
    if (spanChanged) this.dom.commit()
  }

  private replaceRange(from: number, to: number, text: string, kind: EditKind = 'type'): void {
    const a = this.active
    if (!a) return
    this.record(kind)
    if (!isMultiline(a.unit)) text = text.replace(/\n/g, ' ')
    a.value = a.value.slice(0, from) + text + a.value.slice(to)
    a.anchor = a.focus = from + text.length
    if (this.options.mode() === 'none') {
      if (text) a.freshPair = undefined
      this.dropEmptyElements(a)
    }
    a.sticky = undefined
    a.goalX = undefined
    this.writeThrough()
    if (this.active === a) this.refresh(true)
  }

  /** 不显示记号档:内容被删空的元素连记号一起拿掉(刚用 ⌘B 插进来、光标还夹在中间的那一对留着)。 */
  private dropEmptyElements(a: ActiveState): void {
    const pattern = /\*\*\*\*|~~~~|``/g
    let out = ''
    let last = 0
    let caret = a.focus
    for (let m = pattern.exec(a.value); m; m = pattern.exec(a.value)) {
      const middle = m.index + m[0].length / 2
      if (a.freshPair !== undefined && middle === a.freshPair && middle === a.focus) continue
      out += a.value.slice(last, m.index)
      last = m.index + m[0].length
      if (m.index < a.focus) caret -= Math.min(m[0].length, a.focus - m.index)
    }
    a.value = out + a.value.slice(last)
    a.anchor = a.focus = caret
  }

  /** 光标左 / 右边**看得见的**那一个字形簇;没有返回 null(= 在这一项的头 / 尾)。 */
  private visibleCluster(a: ActiveState, direction: -1 | 1): [number, number] | null {
    let index: number | undefined
    if (direction < 0) {
      for (let i = a.vis.length - 1; i >= 0; i--) if (a.vis[i] < a.focus) { index = a.vis[i]; break }
    } else {
      index = a.vis.find(x => x >= a.focus)
    }
    return index === undefined ? null : graphemeAt(a.value, index)
  }

  private withLines(mutate: (lines: string[]) => void): void {
    this.record('struct')
    if (this.active) this.active.stale = true
    const lines = this.doc.lines.slice()
    mutate(lines)
    this.doc.setLines(lines)
  }

  private hiddenSet(): ReadonlySet<number> {
    return this.options.hidden?.() ?? EMPTY_SET
  }

  /** 看得见的单元(光标能停的那些)。 */
  private visibleUnits(): Unit[] {
    const hidden = this.hiddenSet()
    const units = this.units()
    return hidden.size ? units.filter(u => !hidden.has(u.start)) : units
  }

  /** 上一个 / 下一个**看得见的**单元:导航与「光标落到哪」都问它。 */
  private neighbour(delta: -1 | 1): Unit | undefined {
    const a = this.active
    if (!a) return undefined
    const hidden = this.hiddenSet()
    const units = this.units()
    const index = units.findIndex(u => u.start === a.start)
    for (let i = index + delta; i >= 0 && i < units.length; i += delta) if (!hidden.has(units[i].start)) return units[i]
    return undefined
  }

  /**
   * 紧挨着的那一个单元(不管看不看得见)。结构合并问它:紧挨着的是收起的单元时**不合并**,
   * 只拿掉中间的空行 —— 并进去就等于把看不见的行一起删了(与上一个是代码块同一种处置)。
   */
  private adjacent(delta: -1 | 1): { unit: Unit; hidden: boolean } | undefined {
    const a = this.active
    if (!a) return undefined
    const units = this.units()
    const unit = units[units.findIndex(u => u.start === a.start) + delta]
    return unit ? { unit, hidden: this.hiddenSet().has(unit.start) } : undefined
  }

  /**
   * 正在编辑的那一项被收起了(勾完之后的停留时间到了、外部改动、刚折叠了它所在的小节):
   * 就近重开下一个看得见的单元,没有就上一个,都没有就关。视图每次提交之后调一次。
   */
  ensureVisible(): void {
    const a = this.active
    if (!a || !this.hiddenSet().has(a.start)) return
    const units = this.visibleUnits()
    const next = units.find(u => u.start > a.start)
    if (next) { this.open(next.start, 0); return }
    const previous = [...units].reverse().find(u => u.start < a.start)
    if (previous) this.open(previous.start, 'end')
    else this.close()
  }

  /* ── 结构编辑(每一条都交回一个光标)───────────────────────────────────── */

  /**
   * 回车。一条规则管所有块:**有字 = 接着写同一种;空的 = 退出一层**,退到底是原地一个落脚空行
   * (光标不动,接着打字就是一段普通文字,打 `- [ ] ` / `## ` 又变回列表项 / 标题)。退出从不删掉
   * 你所在的那一行、也不把光标送回上一行(09-18 用户报:空任务项再按回车,整行被删、光标跳回上一项)。
   *
   *  · 列表项 有字:在光标处拆成两项,后一项同一种(任务 → 未勾,有序 → 序号 +1,后面的兄弟顺延);
   *    光标在字的最前面 → 上面插一个空的同类项,光标跟着字走(勾选状态留在原项上)。
   *  · 列表项 空:缩进的先退一层;顶层的去掉记号,原地变成落脚空行。
   *  · 标题 有字:光标后面的字另起一个任务项(待办文档的约定);光标在字的最前面 → 在标题上面开一行:
   *    上面紧挨着的是列表就接一项,否则一个落脚空行。标题 空:去掉 `#`,原地变成落脚空行。
   *  · 引用:当前行有字 → 另起一行 `> `;当前是空的 `>` 行 → 收掉这一行,在引用下面落脚。
   *  · 段落:段内换行;光标在末尾、当前行已经是空行(第二下回车)→ 收掉它,在下面另起一段落脚。
   *    落脚空行本身再按回车什么都不做。
   *  · 代码块:永远是换行,不退出(出代码块用 ↓ 或 ⌘↵)。
   *
   * 有选区时先删掉选中的字再按上面的规则走。Shift+↵ 是软换行(`softBreak`)。
   */
  private enter(): void {
    const a = this.active
    if (!a) return
    const unit = a.unit
    const lo = Math.min(a.anchor, a.focus)
    const hi = Math.max(a.anchor, a.focus)
    if (isMultiline(unit)) { this.enterMultiline(lo, hi); return }
    // 单行的块:先删掉选中的字(一步),再按光标处的规则走。
    if (lo !== hi) { this.replaceRange(lo, hi, '', 'struct'); if (this.active) this.enter(); return }
    const { value, analysis } = a
    if (isList(unit)) {
      if (!value.trim()) {
        if (unit.indent > 0) { this.indent(-1); return }
        this.landDraft(unit.start, 1, [])
        return
      }
      const { left, right } = splitValueAt(analysis, value, lo)
      if (!left.trim()) {
        this.withLines(lines => {
          lines.splice(unit.start, 1, blankItemLike(unit), (unit.type === 'ordered' ? continuedPrefix(unit) : prefixOf(unit)) + value.replace(/^\s+/, ''))
          if (unit.type === 'ordered') renumberOrdered(lines, unit.start + 1)
        })
        this.open(unit.start + 1, 0)
        return
      }
      this.withLines(lines => {
        lines.splice(unit.start, 1, prefixOf(unit) + left.replace(/\s+$/, ''), continuedPrefix(unit) + right.replace(/^\s+/, ''))
        if (unit.type === 'ordered') renumberOrdered(lines, unit.start + 1)
      })
      this.open(unit.start + 1, 0)
      return
    }
    if (unit.type === 'heading') {
      const head = value.match(/^#{1,6}\s+/)?.[0] ?? ''
      if (!value.slice(head.length).trim()) { this.landDraft(unit.start, 1, []); return }
      const { left, right } = splitValueAt(analysis, value, Math.max(lo, head.length))
      if (!left.slice(head.length).trim()) {
        // 上面那一项看不见(收在「已完成」里、或上一节折着)就不接 —— 接进去的新项当场也看不见。
        const before = this.adjacent(-1)
        const above = before && !before.hidden ? before.unit : undefined
        if (above && isList(above)) {
          this.withLines(lines => {
            lines.splice(above.end + 1, 0, continuedPrefix(above))
            if (above.type === 'ordered') renumberOrdered(lines, above.end + 1)
          })
          this.open(above.end + 1, 'end')
          return
        }
        this.landDraft(unit.start, 0, [])
        return
      }
      this.withLines(lines => { lines.splice(unit.start, 1, left.replace(/\s+$/, ''), `- [ ] ${right.replace(/^\s+/, '')}`) })
      this.open(unit.start + 1, 0)
    }
  }

  /** 回车落在段落 / 引用 / 代码块里(规则见 `enter`)。 */
  private enterMultiline(lo: number, hi: number): void {
    const a = this.active
    if (!a) return
    const unit = a.unit
    if (unit.type === 'code') { this.replaceRange(lo, hi, '\n', 'struct'); return }
    const value = a.value.slice(0, lo) + a.value.slice(hi)
    if (unit.type === 'para' && !value.trim()) return
    const lineStart = value.lastIndexOf('\n', lo - 1) + 1
    const newline = value.indexOf('\n', lo)
    const lineEnd = newline === -1 ? value.length : newline
    const current = value.slice(lineStart, lineEnd)
    const onLastLine = lineEnd === value.length
    if (unit.type === 'quote') {
      if (onLastLine && /^>\s?$/.test(current)) {
        const kept = value.slice(0, Math.max(0, lineStart - 1))
        this.landDraft(unit.start, a.span, kept.trim() ? linesFromEdit(unit, kept) : [])
        return
      }
      // 光标在这一行的 `> ` 记号里:拆在记号后面(上面留一个空的引用行,光标跟着字走)。
      if (lo !== hi) { this.replaceRange(lo, hi, '\n> ', 'struct'); return }
      const at = Math.max(lo, lineStart + (current.match(/^>\s?/)?.[0].length ?? 0))
      this.replaceRange(at, at, '\n> ', 'struct')
      return
    }
    if (onLastLine && lineStart > 0 && current.trim() === '' && lo === hi) {
      this.landDraft(unit.start, a.span, linesFromEdit(unit, value.slice(0, lineStart - 1)))
      return
    }
    this.replaceRange(lo, hi, '\n', 'struct')
  }

  /** Shift+↵:软换行。段落 / 代码块插一个换行,引用接一行 `> `;列表项装不下换行,不动;标题照回车。 */
  private softBreak(): void {
    const a = this.active
    if (!a) return
    const lo = Math.min(a.anchor, a.focus)
    const hi = Math.max(a.anchor, a.focus)
    if (a.unit.type === 'para' || a.unit.type === 'code') this.replaceRange(lo, hi, '\n', 'struct')
    else if (a.unit.type === 'quote') this.replaceRange(lo, hi, '\n> ', 'struct')
    else if (a.unit.type === 'heading') this.enter()
  }

  /**
   * 把 `from` 起的 `count` 行换成 `keep` 加一个**落脚空行**,光标放进去。上一行有字就先垫一个分隔空行
   * —— 不垫的话写下的字在 markdown 里会被读成上一项 / 上一段的续行;下一行是普通文字同理。
   * 垫的行记在光标状态上,落脚空行一个字没写就离开时一起收掉(`dropDraft`)。
   */
  private landDraft(from: number, count: number, keep: readonly string[]): void {
    let at = from
    let pad = { above: false, below: false }
    this.withLines(lines => {
      lines.splice(from, count, ...keep)
      const base = from + keep.length
      const previous = lines[base - 1]
      const next = lines[base]
      const above = base > 0 && !!previous?.trim()
      const below = next !== undefined && !!next.trim() && !startsBlock(next)
      lines.splice(base, 0, ...(above ? [''] : []), '', ...(below ? [''] : []))
      at = base + (above ? 1 : 0)
      pad = { above, below }
    })
    this.open(at, 0)
    if (this.active?.start === at) this.active.pad = pad
  }

  /**
   * 离开落脚空行时它还是空的:收掉它和当初垫的分隔空行 —— 它一个字没写过,不留痕迹(所以「空项回车、
   * 再点别处」的结果与从前一样是那一项没了,只是光标不再被送走)。两边剩下连着的空行时再收一行。
   * 不记撤销:撤销直接回到按回车之前。返回 `line` 收掉之后的新行号。
   */
  private dropDraft(a: ActiveState, line = -1): number {
    if (a.stale || a.unit.type !== 'para' || a.value.trim() || (this.doc.lines[a.start] ?? 'x').trim() !== '') return line
    const lines = this.doc.lines.slice()
    let from = a.start
    let to = a.start
    if (a.pad?.above && from > 0 && !lines[from - 1].trim()) from--
    if (a.pad?.below && to + 1 < lines.length && !lines[to + 1].trim()) to++
    lines.splice(from, to - from + 1)
    let removed = to - from + 1
    if (from > 0 && !lines[from - 1].trim() && (from === lines.length || !lines[from].trim())) {
      lines.splice(from - 1, 1)
      removed++
    }
    this.doc.setLines(lines)
    return line > to ? line - removed : line
  }

  private indent(delta: -1 | 1): void {
    const a = this.active
    if (!a || !isList(a.unit)) return
    const keep = { anchor: a.anchor, focus: a.focus }
    const start = a.start
    this.withLines(lines => {
      lines[start] = delta > 0 ? `  ${lines[start]}` : lines[start].replace(/^ {1,2}/, '')
    })
    this.open(start, keep.anchor, keep.focus)
  }

  /**
   * 删掉一个空的列表项,光标去上一项末尾(没有上一项就去下一项开头)。
   * 夹在两个空行之间的项,连它前面那一个空行一起拿掉 —— 否则松散列表里会留下两连空行。
   */
  private removeEmptyUnit(unit: Unit): void {
    const previous = this.neighbour(-1)
    const next = this.neighbour(1)
    let removedAbove = 0
    this.withLines(lines => {
      const before = unit.start - 1
      const after = unit.end + 1
      const blankAround = before >= 0 && !lines[before].trim() && (after >= lines.length || !lines[after].trim())
      const from = blankAround ? before : unit.start
      removedAbove = unit.start - from
      lines.splice(from, unit.end - from + 1)
    })
    if (previous) this.open(previous.start, 'end')
    else if (next) this.open(next.start - (unit.end - unit.start + 1) - removedAbove, 0)
    else this.close()
  }

  /**
   * 行首退格。规则与项在第几个位置无关(09-17 用户报「删除」:同一个动作,第一项是去记号、
   * 其余项是直接并进上一项,勾选状态跟着丢):
   *  1. 缩进的列表项先退一层;空的列表项整项删掉;
   *  2. 有字的列表项 / 标题 / 引用:先去掉行首记号,变成段落,光标留在开头;
   *  3. 段落:并进上一个有字的单元的末尾,中间的空行一起拿掉(空行是分隔,不是一个能停光标的东西);
   *     上一个是代码块就只拿掉空行。
   */
  private backspaceAtStart(): void {
    const a = this.active
    if (!a) return
    const unit = a.unit
    if (isList(unit)) {
      if (unit.indent > 0) { this.indent(-1); return }
      if (!a.value.trim()) { this.removeEmptyUnit(unit); return }
      this.withLines(lines => { lines[unit.start] = a.value })
      this.open(unit.start, 0)
      return
    }
    if (unit.type === 'heading' || unit.type === 'quote') {
      this.withLines(lines => {
        lines.splice(unit.start, unit.end - unit.start + 1, ...a.value.split('\n').map(line => line.replace(/^(#{1,6}\s+|>\s?)/, '')))
      })
      this.open(unit.start, 0)
      return
    }
    if (unit.type !== 'para') return
    const before = this.adjacent(-1)
    const previous = before?.unit
    if (!previous) {
      if (unit.start === 0) return
      const gap = unit.start
      this.withLines(lines => { lines.splice(0, gap) })
      this.open(0, 0)
      return
    }
    if (previous.type === 'code' || before?.hidden) {
      const gap = unit.start - previous.end - 1
      if (!gap) return
      this.withLines(lines => { lines.splice(previous.end + 1, gap) })
      this.open(unit.start - gap, 0)
      return
    }
    const previousValue = editValueOf(previous, this.doc.lines)
    const appended = isMultiline(previous) ? a.value : a.value.split('\n').join(' ')
    this.withLines(lines => {
      lines.splice(previous.start, unit.end - previous.start + 1, ...linesFromEdit(previous, previousValue + appended))
    })
    this.open(previous.start, previousValue.length)
  }

  /** 行尾 Delete:把下一个有字的单元的文字并上来(去掉它的行首记号,中间的空行一起拿掉),光标不动。 */
  private deleteAtEnd(): void {
    const a = this.active
    if (!a) return
    const unit = a.unit
    if (unit.type === 'code') return
    const after = this.adjacent(1)
    const next = after?.unit
    if (!next) return
    const keep = a.focus
    if (next.type === 'code' || after?.hidden) {
      const gap = next.start - unit.end - 1
      if (!gap) return
      this.withLines(lines => { lines.splice(unit.end + 1, gap) })
      this.open(unit.start, keep)
      return
    }
    const raw = editValueOf(next, this.doc.lines)
    const bare = next.type === 'heading' || next.type === 'quote'
      ? raw.split('\n').map(line => line.replace(/^(#{1,6}\s+|>\s?)/, '')).join('\n')
      : raw
    const appended = isMultiline(unit) ? bare : bare.split('\n').join(' ')
    this.withLines(lines => {
      lines.splice(unit.start, next.end - unit.start + 1, ...linesFromEdit(unit, a.value + appended))
    })
    this.open(unit.start, keep)
  }

  /** 粘贴多行进一个列表项:第一行接在光标处,其余每行各成一项(自带列表记号的行照它自己的写)。 */
  private pasteLines(text: string): boolean {
    const a = this.active
    if (!a || !isList(a.unit) || !text.includes('\n')) return false
    const unit = a.unit
    const pasted = text.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim())
    if (pasted.length < 2) return false
    const lo = Math.min(a.anchor, a.focus)
    const hi = Math.max(a.anchor, a.focus)
    const head = a.value.slice(0, lo)
    const tail = a.value.slice(hi)
    const LIST = /^\s*([-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/
    const rest = pasted.slice(1).map(line => (LIST.test(line) ? line : continuedPrefix(unit) + line.trim()))
    const lastIndex = rest.length - 1
    const caretInLast = rest[lastIndex].length
    rest[lastIndex] = rest[lastIndex] + tail
    this.withLines(lines => {
      lines.splice(unit.start, 1, prefixOf(unit) + head + pasted[0].replace(LIST, ''), ...rest)
    })
    const lastLine = unit.start + rest.length
    const lastUnit = parseUnits(this.doc.lines).find(u => u.start === lastLine)
    if (lastUnit) {
      const prefixLength = isList(lastUnit) ? this.doc.lines[lastLine].length - editValueOf(lastUnit, this.doc.lines).length : 0
      this.open(lastLine, Math.max(0, caretInLast - prefixLength))
    }
    return true
  }

  /** 点勾选框:只翻那一格;正在编辑时原地保留光标。 */
  toggleTask(line: number): void {
    const keep = this.active ? { start: this.active.start, anchor: this.active.anchor, focus: this.active.focus } : null
    this.withLines(lines => {
      lines[line] = lines[line].replace(/\[( |x|X)\]/, mark => (mark === '[ ]' ? '[x]' : '[ ]'))
    })
    if (keep) this.open(keep.start, keep.anchor, keep.focus)
    else this.dom.commit()
  }

  /** 「+ 添加一项」:在最后一个任务后面插一行,记号照文档里已有任务项的写法。 */
  insertAfterLastTask(): void {
    if (this.active) this.dropDraft(this.active)
    const units = parseUnits(this.doc.lines)
    const lastTask = [...units].reverse().find(u => u.type === 'task')
    const at = lastTask ? lastTask.end + 1 : this.doc.lines.length
    const marker = lastTask && isList(lastTask) ? lastTask.marker : '-'
    const indent = lastTask && isList(lastTask) ? ' '.repeat(lastTask.indent) : ''
    this.withLines(lines => {
      if (!lastTask && lines.length && lines[lines.length - 1].trim()) lines.push('')
      lines.splice(lastTask ? at : lines.length, 0, `${indent}${marker} [ ] `)
    })
    const inserted = parseUnits(this.doc.lines).find(u => u.type === 'task' && u.start >= (lastTask ? at : 0) && editValueOf(u, this.doc.lines) === '')
    if (inserted) this.open(inserted.start, 'end')
  }

  /** ⌘B / ⌘I / ⌘E(规则照 Word,§6.5)。 */
  private toggleMark(kind: MarkKind): void {
    const a = this.active
    if (!a) return
    const mark = MARK_OF[kind]
    const L = mark.length
    const analysis = analyzeUnit(a.unit, a.value)
    const v = a.value
    let lo = Math.min(a.anchor, a.focus)
    let hi = Math.max(a.anchor, a.focus)
    const groups = analysis.groups.filter(g => g.kind === kind)
    if (lo === hi) {
      const inner = groups.find(g => g.start < lo && lo < g.end)
      if (inner && (lo === inner.end - L || lo === inner.start + L)) {
        a.anchor = a.focus = a.sticky = lo === inner.end - L ? inner.end : inner.start
        this.refresh(true)
        return
      }
      const outer = groups.find(g => g.end === lo || g.start === lo)
      if (outer) {
        a.anchor = a.focus = a.sticky = outer.end === lo ? outer.end - L : outer.start + L
        this.refresh(true)
        return
      }
      this.record('struct')
      if (inner) {
        a.value = v.slice(0, inner.start) + v.slice(inner.start + L, inner.end - L) + v.slice(inner.end)
        a.anchor = a.focus = lo - L
      } else {
        a.value = v.slice(0, lo) + mark + mark + v.slice(lo)
        a.anchor = a.focus = a.freshPair = lo + L
      }
      this.writeThrough()
      this.refresh(true)
      return
    }
    while (lo < hi && /\s/.test(v[lo])) lo++
    while (hi > lo && /\s/.test(v[hi - 1])) hi--
    for (let grew = true; grew;) {
      grew = false
      for (const g of analysis.groups) {
        if (g.kind === 'prefix' || g.kind === 'escape') continue
        const inLo = g.start < lo && lo < g.end
        const inHi = g.start < hi && hi < g.end
        if (inLo !== inHi) {
          const nlo = Math.min(lo, g.start)
          const nhi = Math.max(hi, g.end)
          if (nlo !== lo || nhi !== hi) { lo = nlo; hi = nhi; grew = true }
        }
      }
    }
    this.record('struct')
    const same = groups.find(g => (g.start === lo && g.end === hi) || (g.start + L === lo && g.end - L === hi))
    if (same) {
      a.value = v.slice(0, same.start) + v.slice(same.start + L, same.end - L) + v.slice(same.end)
      a.anchor = same.start
      a.focus = same.end - 2 * L
    } else {
      a.value = v.slice(0, lo) + mark + v.slice(lo, hi) + mark + v.slice(hi)
      a.anchor = lo + L
      a.focus = hi + L
    }
    this.writeThrough()
    this.refresh(true)
  }

  private undoRedo(redo: boolean): void {
    const current: HistoryEntry = { lines: this.doc.lines.slice(), caret: this.caretMemo() }
    const entry = redo ? this.history.redo(current) : this.history.undo(current)
    if (!entry) return
    if (this.active) this.active.stale = true
    this.doc.setLines(entry.lines)
    const caret = entry.caret
    if (caret && parseUnits(this.doc.lines, caret.start).some(u => u.start === caret.start)) this.open(caret.start, caret.anchor, caret.focus)
    else this.close()
  }

  /* ── 导航 ───────────────────────────────────────────────────────────── */

  private moveHorizontal(direction: 'forward' | 'backward', granularity: 'character' | 'word' | 'lineboundary', extend: boolean): void {
    const a = this.active
    const ed = this.editor()
    const selection = getSelection()
    if (!a || !ed || !selection) return
    a.goalX = undefined
    a.sticky = undefined
    if (!extend && a.anchor !== a.focus && granularity === 'character') {
      a.anchor = a.focus = direction === 'forward' ? Math.max(a.anchor, a.focus) : Math.min(a.anchor, a.focus)
      this.refresh(false)
      return
    }
    const before = sourceToView(a.vis, a.focus)
    const modify = (selection as Selection & { modify?: (alter: string, direction: string, granularity: string) => void }).modify
    modify?.call(selection, extend ? 'extend' : 'move', direction, granularity)
    const viewOffset = selection.focusNode && ed.contains(selection.focusNode)
      ? viewOffsetOf(ed, selection.focusNode, selection.focusOffset)
      : before
    if (viewOffset === before && granularity !== 'lineboundary') {
      const target = this.neighbour(direction === 'forward' ? 1 : -1)
      if (!extend && target) { this.open(target.start, direction === 'forward' ? 0 : 'end'); return }
      this.applySelection()
      return
    }
    const bias: Bias = granularity === 'lineboundary' ? 'high' : direction === 'forward' ? 'low' : 'high'
    a.focus = this.resolve(a, viewOffset, bias)
    if (!extend) a.anchor = a.focus
    this.refresh(false)
  }

  /** 静止画面量尺:在「记号全收起」的同位置副本上量,一串 ↑↓ 用同一把尺子。 */
  private withResting<T>(measure: (clone: HTMLElement, vis: readonly number[], analysis: Analysis) => T): T | null {
    const a = this.active
    const ed = this.editor()
    if (!a || !ed || !ed.parentNode) return null
    const analysis = analyzeUnit(a.unit, a.value)
    const painted = paint(analysis, new Set(), null, this.options.classes)
    const clone = ed.cloneNode(false) as HTMLElement
    clone.removeAttribute('contenteditable')
    clone.setAttribute('aria-hidden', 'true')
    clone.innerHTML = painted.html + (a.value.endsWith('\n') ? '<br>' : '')
    Object.assign(clone.style, {
      position: 'absolute', left: `${ed.offsetLeft}px`, top: `${ed.offsetTop}px`, width: `${ed.offsetWidth}px`,
      margin: '0', opacity: '0', zIndex: '50',
    })
    ed.parentNode.insertBefore(clone, ed.nextSibling)
    try {
      return measure(clone, painted.vis, analysis)
    } finally {
      clone.remove()
    }
  }

  private moveVertical(up: boolean, extend: boolean): void {
    const a = this.active
    const ed = this.editor()
    if (!a || !ed) return
    ed.scrollIntoView({ block: 'nearest' })
    const goalValid = a.goalX !== undefined && a.goalFor === a.focus
    const measured = this.withResting((clone, vis, analysis) => {
      const caret = rectAt(clone, sourceToView(vis, a.focus))
      const lineHeight = lineHeightOf(clone)
      const box = clone.getBoundingClientRect()
      const x = goalValid ? (a.goalX as number) : caret.left
      const y = up ? caret.top - lineHeight / 2 : caret.bottom + lineHeight / 2
      if (y > box.top + 2 && y < box.bottom - 2) {
        const viewOffset = offsetAtPoint(clone, x, y)
        const length = a.value.length
        const focus = viewOffset === Number.POSITIVE_INFINITY
          ? length
          : this.options.mode() === 'none'
            ? canonicalPosition(analysis, vis, length, viewOffset)
            : viewToSource(vis, length, viewOffset, 'low')
        return { x, focus }
      }
      return { x, focus: undefined as number | undefined }
    })
    if (!measured) return
    if (measured.focus !== undefined) {
      a.focus = measured.focus
      if (!extend) a.anchor = a.focus
      this.refresh(false)
      a.goalX = measured.x
      a.goalFor = a.focus
      return
    }
    if (extend) {
      a.focus = up ? 0 : a.value.length
      this.refresh(false)
      return
    }
    const target = this.neighbour(up ? -1 : 1)
    if (!target) { a.goalX = measured.x; a.goalFor = a.focus; return }
    this.moveToUnit(target, measured.x, up ? 'bottom' : 'top')
  }

  /** 进到另一项:在它**还没打开**时按「当前画面」量(与鼠标点下去量的是同一个画面)。 */
  private moveToUnit(target: Unit, x: number, edge: 'top' | 'bottom'): void {
    const element = this.dom.unitContent(target.start)
    if (!element) { this.open(target.start, edge === 'bottom' ? 'end' : 0); return }
    element.scrollIntoView({ block: 'nearest' })
    const box = element.getBoundingClientRect()
    const viewOffset = offsetAtPoint(element, x, edge === 'bottom' ? box.bottom - 4 : box.top + 4)
    this.open(target.start, this.restingCaret(target, viewOffset))
    if (this.active) { this.active.goalX = x; this.active.goalFor = this.active.focus }
  }

  private restingCaret(unit: Unit, viewOffset: number): number {
    const value = editValueOf(unit, this.doc.lines)
    if (viewOffset === Number.POSITIVE_INFINITY) return value.length
    const analysis = analyzeUnit(unit, value)
    const { vis } = paint(analysis, new Set(), null, this.options.classes)
    return this.options.mode() === 'none'
      ? canonicalPosition(analysis, vis, value.length, viewOffset)
      : viewToSource(vis, value.length, viewOffset, 'low')
  }

  private moveDocumentEdge(toEnd: boolean, extend: boolean): void {
    const a = this.active
    if (!a) return
    if (extend) { a.focus = toEnd ? a.value.length : 0; a.goalX = undefined; this.refresh(false); return }
    const units = this.visibleUnits()
    const target = toEnd ? units[units.length - 1] : units[0]
    if (target) this.open(target.start, toEnd ? 'end' : 0)
  }

  /* ── 事件入口 ───────────────────────────────────────────────────────── */

  // ui-consume-allow: kbd-select-handwritten — 文本光标的走字 / 走行(量尺是 selection.modify),不是列表选择
  /** 编辑区上的 keydown(React `onKeyDown` 交进来)。返回 true = 已处理并 preventDefault。 */
  handleKeyDown(event: KeyboardEvent): boolean {
    const a = this.active
    if (!a) return false
    if (a.composing || event.isComposing || event.keyCode === 229) return false
    const mod = event.metaKey || event.ctrlKey
    const key = event.key
    if (key !== 'ArrowUp' && key !== 'ArrowDown') a.goalX = undefined
    const run = (action: () => void): boolean => { event.preventDefault(); action(); return true }
    switch (key) {
      case 'ArrowLeft':
        return run(() => this.moveHorizontal('backward', mod ? 'lineboundary' : event.altKey ? 'word' : 'character', event.shiftKey))
      case 'ArrowRight':
        return run(() => this.moveHorizontal('forward', mod ? 'lineboundary' : event.altKey ? 'word' : 'character', event.shiftKey))
      case 'ArrowUp':
        return run(() => (mod ? this.moveDocumentEdge(false, event.shiftKey) : this.moveVertical(true, event.shiftKey)))
      case 'ArrowDown':
        return run(() => (mod ? this.moveDocumentEdge(true, event.shiftKey) : this.moveVertical(false, event.shiftKey)))
      case 'Home':
        return run(() => this.moveHorizontal('backward', 'lineboundary', event.shiftKey))
      case 'End':
        return run(() => this.moveHorizontal('forward', 'lineboundary', event.shiftKey))
      case 'Escape':
        return run(() => this.close())
      case 'Enter':
        return run(() => {
          if (mod) this.close()
          else if (event.shiftKey) this.softBreak()
          else this.enter()
        })
      case 'Tab':
        if (!isList(a.unit)) return false
        return run(() => this.indent(event.shiftKey ? -1 : 1))
    }
    if (mod && !event.altKey) {
      const lower = key.toLowerCase()
      if (lower === 'z') return run(() => this.undoRedo(event.shiftKey))
      if (lower === 'b') return run(() => this.toggleMark('strong'))
      if (lower === 'i') return run(() => this.toggleMark('emphasis'))
      if (lower === 'e') return run(() => this.toggleMark('code'))
      if (lower === 'a') return run(() => { a.anchor = 0; a.focus = a.value.length; this.refresh(false) })
    }
    return false
  }

  handleBeforeInput(event: InputEvent): void {
    const a = this.active
    if (!a || a.composing || /Composition/.test(event.inputType)) return
    event.preventDefault()
    const lo = Math.min(a.anchor, a.focus)
    const hi = Math.max(a.anchor, a.focus)
    const ed = this.editor()
    const extendTo = (direction: 'forward' | 'backward', granularity: string): number => {
      const selection = getSelection()
      const modify = (selection as Selection & { modify?: (alter: string, direction: string, granularity: string) => void } | null)?.modify
      if (!selection || !modify || !ed) return a.focus
      modify.call(selection, 'extend', direction, granularity)
      const viewOffset = selection.focusNode && ed.contains(selection.focusNode) ? viewOffsetOf(ed, selection.focusNode, selection.focusOffset) : sourceToView(a.vis, a.focus)
      const position = this.resolve(a, viewOffset, direction === 'forward' ? 'low' : 'high')
      this.applySelection()
      return position
    }
    const text = event.data ?? event.dataTransfer?.getData('text/plain') ?? ''
    switch (event.inputType) {
      case 'insertText':
      case 'insertReplacementText':
        this.replaceRange(lo, hi, text)
        return
      case 'insertFromPaste':
      case 'insertFromDrop':
        if (!this.pasteLines(text)) this.replaceRange(lo, hi, text, 'struct')
        return
      case 'insertLineBreak':
        this.softBreak()
        return
      case 'insertParagraph':
        this.enter()
        return
      case 'deleteContentBackward': {
        if (lo !== hi) { this.replaceRange(lo, hi, ''); return }
        // 光标还在标题 / 引用的行首记号里(`## ` 展开着):不一个字一个字地删记号,整体降成段落。
        const prefix = a.analysis.groups.find(g => g.kind === 'prefix' && g.start === 0)
        if (prefix && a.focus <= prefix.end) { this.backspaceAtStart(); return }
        const cluster = this.visibleCluster(a, -1)
        if (cluster) this.replaceRange(cluster[0], cluster[1], '')
        else this.backspaceAtStart()
        return
      }
      case 'deleteContentForward': {
        if (lo !== hi) { this.replaceRange(lo, hi, ''); return }
        const cluster = this.visibleCluster(a, 1)
        if (cluster) this.replaceRange(cluster[0], cluster[1], '')
        else this.deleteAtEnd()
        return
      }
      case 'deleteWordBackward':
      case 'deleteSoftLineBackward':
      case 'deleteHardLineBackward': {
        if (lo !== hi) { this.replaceRange(lo, hi, ''); return }
        const position = extendTo('backward', event.inputType === 'deleteWordBackward' ? 'word' : 'lineboundary')
        if (position < lo) this.replaceRange(position, lo, '')
        else this.backspaceAtStart()
        return
      }
      case 'deleteWordForward':
      case 'deleteSoftLineForward':
      case 'deleteHardLineForward': {
        if (lo !== hi) { this.replaceRange(lo, hi, ''); return }
        const position = extendTo('forward', event.inputType === 'deleteWordForward' ? 'word' : 'lineboundary')
        if (position > hi) this.replaceRange(hi, position, '')
        else this.deleteAtEnd()
        return
      }
      case 'historyUndo':
        this.undoRedo(false)
        return
      case 'historyRedo':
        this.undoRedo(true)
        return
    }
  }

  /** 兜底:任何没经过 beforeinput 的改动(拼写纠正、脚本 execCommand)一律丢弃,从模型重画。 */
  handleInput(): void {
    if (this.active && !this.active.composing) this.refresh(true)
  }

  handleCompositionStart(): void {
    const a = this.active
    if (!a) return
    a.composing = true
    a.compositionRange = [Math.min(a.anchor, a.focus), Math.max(a.anchor, a.focus)]
  }

  handleCompositionEnd(data: string): void {
    const a = this.active
    if (!a) return
    a.composing = false
    const [from, to] = a.compositionRange ?? [a.focus, a.focus]
    this.replaceRange(from, to, data, 'struct')
  }

  selectedText(): string | null {
    const a = this.active
    return a ? a.value.slice(Math.min(a.anchor, a.focus), Math.max(a.anchor, a.focus)) : null
  }

  cutSelection(): void {
    const a = this.active
    if (!a) return
    this.replaceRange(Math.min(a.anchor, a.focus), Math.max(a.anchor, a.focus), '', 'struct')
  }

  /**
   * 鼠标按下(文档区域里)。一切在按下那一刻完成 —— 不等 click:click 要求按下与松开落在同一个
   * 元素上,而保存上一项会换掉 DOM(第一版样例「要点两次」的病根)。
   *
   * @returns 是否处理了(处理了由调用方 preventDefault)。
   */
  handlePointerDown(event: MouseEvent, unitStart: number | null): boolean {
    if (event.button !== 0 || unitStart === null) {
      if (this.active && unitStart === null) { this.close(); return true }
      return false
    }
    const element = this.dom.unitContent(unitStart)
    if (!element) return false
    const viewOffset = offsetAtPoint(element, event.clientX, event.clientY)
    const a = this.active
    if (a && a.start === unitStart) {
      // 正在编辑的这一项:按它此刻(展开后)的画面量,取靠左。
      a.focus = a.anchor = this.resolve(a, viewOffset, 'low')
      a.goalX = undefined
      a.sticky = undefined
      a.pointer = true
      a.dragFrom = a.anchor
      this.refresh(false)
      return true
    }
    const unit = parseUnits(this.doc.lines).find(u => u.start === unitStart)
    if (!unit) return false
    this.open(unitStart, this.restingCaret(unit, viewOffset))
    if (this.active) { this.active.pointer = true; this.active.dragFrom = this.active.anchor }
    return true
  }

  /** 按住拖动:在按下的那一项里扩选区(跨项不做);量法与按下相同。 */
  handlePointerMove(event: MouseEvent): void {
    const a = this.active
    const ed = this.editor()
    if (!a || !ed || !a.pointer || !(event.buttons & 1)) return
    const focus = this.resolve(a, offsetAtPoint(ed, event.clientX, event.clientY), 'low')
    if (focus === a.focus) return
    a.anchor = a.dragFrom
    a.focus = focus
    this.applySelection()
  }

  handlePointerUp(): void {
    const a = this.active
    if (a?.pointer) { a.pointer = false; this.refresh(false) }
  }

  /**
   * 选区变了但不是我们设的(应用菜单的「全选」、辅助技术):读回来,按靠左换算。
   * 我们自己设的那一次回声读回来与模型相同,是恒等变换。
   */
  handleSelectionChange(): void {
    const a = this.active
    const ed = this.editor()
    const selection = getSelection()
    if (!a || !ed || !selection || this.applying || a.composing || a.pointer) return
    if (!selection.focusNode || !ed.contains(selection.focusNode) || !selection.anchorNode || !ed.contains(selection.anchorNode)) return
    const focus = this.resolve(a, viewOffsetOf(ed, selection.focusNode, selection.focusOffset), 'low')
    const anchor = selection.isCollapsed ? focus : this.resolve(a, viewOffsetOf(ed, selection.anchorNode, selection.anchorOffset), 'low')
    if (focus === a.focus && anchor === a.anchor) return
    if (sourceToView(a.vis, focus) === sourceToView(a.vis, a.focus) && sourceToView(a.vis, anchor) === sourceToView(a.vis, a.anchor)) return
    a.focus = focus
    a.anchor = anchor
    a.goalX = undefined
    this.refresh(false)
  }

  /* ── 外部改动:正在编辑的那一项按原文找回来 ──────────────────────────── */

  private rebaseAfterServerChange(previous: readonly string[]): void {
    // 撤销栈里存的是外部改动之前的整份原文:留着的话 ⌘Z 会把别人(AI)刚写的东西一起撤掉。
    this.history.clear()
    const a = this.active
    if (!a) return
    a.stale = true
    const lostEdits = this.doc.takeLostEdits()
    const mine = previous.slice(a.start, a.start + a.span)
    const found = locate(this.doc.lines, { start: a.start, expect: mine, lines: mine })
    if (found.ok) {
      const unit = parseUnits(this.doc.lines).find(u => u.start === found.start)
      if (unit) {
        a.start = found.start
        a.unit = unit
        this.options.onActiveChange?.(a.start)
        this.dom.commit()
        this.refresh(true)
        return
      }
    }
    /*
     * 那几行被别人改了或删了。**后端版本为准**:走到这里时本地改动一定已经落盘(文档只在
     * 没有待发改动时才接后端版本),编辑区里的字文件里本来就有过 —— 从前在这里把它「放回原处」,
     * 等于把别人刚删掉 / 改掉的内容当新行写回文件(09-17 真机:清单里多出一整行重复)。
     * 唯一要救的是**冲突时没存进去**、而新文件里也确实找不到的那段字。
     */
    const text = a.value.trim()
    if (lostEdits && text && !this.doc.lines.some(line => line.includes(text))) {
      const lines = this.doc.lines.slice()
      const at = Math.min(a.start, lines.length)
      lines.splice(at, 0, ...linesFromEdit(a.unit, a.value))
      a.start = at
      this.doc.setLines(lines)
      this.options.onActiveChange?.(a.start)
      this.dom.commit()
      this.refresh(true)
      return
    }
    const units = this.visibleUnits()
    const target = units.find(u => u.end >= a.start) ?? units[units.length - 1]
    const focus = a.focus
    this.dom.commit()
    if (target) this.open(target.start, focus)
    else this.close()
  }

}
