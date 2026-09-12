import type { MessageKey } from '../i18n'
import type { PickResult, ReferenceKind, ReferenceStatus, RowSpec } from './kind'

/**
 * **抽屉里那一列长什么样** —— 纯函数,一个种类名都不认得(正本 §2)。
 *
 * 09-12 之前这件事分在两处枚举:`transitions.groupCommands` 的三组固定表,
 * 与 `DrawerPickList` 里按 `kind === 'files'` 分岔的六处。今天组就是**种类**:
 * 同一个触发字符下每一种自己查自己的候选、自己说组头念什么,这里只做三件事 ——
 * 排序(登记序)、算扁平下标、按四态挑那一行说什么。
 *
 * ── 分组只许一次(禁令区)────────────────────────────────────────────────
 * 一种引用恰好产出一组,所以「同一个组头出现两次」在结构上不可表达 ——
 * 从前那条「按相邻切段会切出命令 / 技能 / 命令」的病,今天连表达它的形状都没有。
 *
 * ── 扁平序 = 各组顺次相连 ───────────────────────────────────────────────
 * 键盘位、`↵` 落点、`applyPick` 的下标全按它算:**一条列表不许有两种序**。
 * `offset` 就是那条序在每一组上的起点。
 */

export interface PickEntry {
  row: RowSpec
  /** 这条候选本身(`applyPick` 要把它交回它那一种的 `draft`)。 */
  hit: unknown
}

export interface PickGroup {
  kindId: string
  headKey?: MessageKey
  hintKey?: MessageKey
  entries: PickEntry[]
  status: ReferenceStatus
  /** 扁平序里这一组第一行的下标。 */
  offset: number
}

export interface PickView {
  groups: PickGroup[]
  /** 扁平序的长度(键盘位夹范围按它)。 */
  total: number
  /** 一行候选都没有时那一行说什么(null = 不说)。 */
  note: MessageKey | null
  /** 候选还在屏上、但这一发失败了:错误与它**并陈**,不抹掉旧答案(律②)。 */
  errorNote: MessageKey | null
}

export const PICK_EMPTY: PickView = { groups: [], total: 0, note: null, errorNote: null }

/** 一种引用这一拍的取数结果。 */
export interface PickInput {
  kind: ReferenceKind
  result: PickResult<unknown>
}

/**
 * 装配这一列。
 *
 * **空组不出现,除非它自述 `always`**:那一档给「这个触发字符下只有这一组」的
 * 那一族(今天是 `@`)—— 组头说的是**整列是什么**,不是「这里有几条」,所以空着
 * 也画,底下跟着那句「无匹配」。其余的空组直接不出现(「只当那组非空时画」落在
 * 这里,不落在渲染层)。
 */
export function buildPickView(inputs: readonly PickInput[]): PickView {
  const groups: PickGroup[] = []
  let offset = 0
  for (const { kind, result } of inputs) {
    const source = kind.source
    if (!source) continue
    const hits = result.hits
    if (hits.length === 0 && !source.group?.always) continue
    const entries = hits.map((hit) => ({ row: source.row(hit), hit }))
    groups.push({
      kindId: kind.id,
      headKey: source.group?.key,
      hintKey: source.hint,
      entries,
      status: result.status,
      offset,
    })
    offset += entries.length
  }

  const total = offset
  /*
   * 四态那张表的下半截(整表在 `DrawerPickList` 文件头)。**只有「问完了、确实
   * 一条都没有」才说「无匹配」**:刚敲下那一瞬候选恰好是 0,而那时说这句话是
   * 一句不成立的话,改口就是用户报的那种「突兀」。
   */
  const statuses = inputs.map((i) => i.result.status)
  const note: MessageKey | null =
    total > 0
      ? null
      : statuses.some((s) => s === 'idle' || s === 'loading')
        ? 'composer.searching'
        : statuses.some((s) => s === 'error')
          ? 'composer.searchFailed'
          : 'composer.noMatch'

  const errorNote: MessageKey | null =
    total > 0 && groups.some((g) => g.entries.length > 0 && g.status === 'error')
      ? 'composer.searchFailed'
      : null

  return { groups, total, note, errorNote }
}

/** 扁平下标 → 它属于哪一组的哪一条。走出范围 = undefined。 */
export function pickEntryAt(
  view: PickView,
  index: number,
): { kindId: string; entry: PickEntry } | undefined {
  for (const group of view.groups) {
    const at = index - group.offset
    if (at >= 0 && at < group.entries.length) {
      return { kindId: group.kindId, entry: group.entries[at] }
    }
  }
  return undefined
}
