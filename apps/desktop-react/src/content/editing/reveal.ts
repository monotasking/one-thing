import type { Analysis, Group } from './inline-tokens'

/**
 * 显示档位(正本 `docs/todo-editor-2026-09.md` §6.5)。三档是三个规则对象,**唯一的区别是
 * 「此刻哪些记号画出来」**;光标规则三档逐字相同。
 */
export type RevealMode = 'element' | 'block' | 'none'

export const REVEAL_MODES: readonly RevealMode[] = ['element', 'block', 'none']

export interface RevealPolicy {
  /** 选区 [lo, hi] 时应该展开的元素 id。 */
  revealed(analysis: Analysis, lo: number, hi: number): ReadonlySet<number>
}

const NONE: ReadonlySet<number> = new Set()

export const REVEAL_POLICIES: Readonly<Record<RevealMode, RevealPolicy>> = {
  /** 光标所在或贴着光标的那个元素;有选区时选区碰到的都展开。 */
  element: {
    revealed: (analysis, lo, hi) => new Set(analysis.groups.filter(g => g.start <= hi && g.end >= lo).map(g => g.id)),
  },
  /** 这一项的全部记号(Typora「聚焦时显示简单块的源码」)。 */
  block: { revealed: analysis => new Set(analysis.groups.map(g => g.id)) },
  /** 永远不画(像 Notion)。 */
  none: { revealed: () => NONE },
}

/**
 * 不显示记号档里,光标此刻「在里面」的元素(严格在两端记号之间),由内到外。
 * 行首记号与转义不算格式,不参与。
 */
export function insideGroups(analysis: Analysis, pos: number): Group[] {
  return analysis.groups
    .filter(g => g.kind !== 'prefix' && g.kind !== 'escape' && g.start < pos && pos < g.end)
    .sort((x, y) => (x.end - x.start) - (y.end - y.start))
}

/**
 * 屏幕位置 → 原文位置(`vis[n]` = 屏幕第 n 个字在原文里的下标)。
 *
 * 两个看得见的字之间藏着记号时原文里有好几个位置,`bias` 决定取哪一头
 * (§6.0 规则 6:往右走取左侧、往左走取右侧、鼠标取左侧)。
 */
export function viewToSource(vis: readonly number[], length: number, viewOffset: number, bias: 'low' | 'high'): number {
  const lo = viewOffset <= 0 ? 0 : vis[viewOffset - 1] + 1
  const hi = viewOffset >= vis.length ? length : vis[viewOffset]
  return lo >= hi ? lo : bias === 'high' ? hi : lo
}

export function sourceToView(vis: readonly number[], source: number): number {
  let lo = 0
  let hi = vis.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (vis[mid] < source) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 不显示记号档的**规范位置**:一个屏幕位置只对应一个原文位置 —— 跟左边那个字走
 * (粗体末字后面打字仍是粗体,首字前面打字是普通字,与 Word / Google Docs 同);
 * 例外是行首的 `## ` / `> `:光标永远落在它们后面,否则打字会把标题拆坏。
 */
export function canonicalPosition(analysis: Analysis, vis: readonly number[], length: number, viewOffset: number): number {
  let pos = viewOffset <= 0 ? 0 : vis[viewOffset - 1] + 1
  for (let moved = true; moved;) {
    moved = false
    for (const g of analysis.groups) {
      if (g.kind === 'prefix' && g.start === pos) { pos = g.end; moved = true }
    }
  }
  return Math.min(pos, length)
}
