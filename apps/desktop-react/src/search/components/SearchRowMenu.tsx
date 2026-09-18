import { Menu, MenuItem } from '../../ui/Menu'
import type { TFn } from '../../i18n'
import { continuationEnabled } from '../continuations'
import type { SearchContinuation } from '../continuations'
import { resolveTargetRenderer } from '../targets'
import type { SearchRowAction } from '../targets'
import type { SearchRow } from '../types'

/**
 * **行的动作表(右键)**:「打开」+ 这一类自报的续搜(§4.6)。
 *
 * 09-01 判例:**动作单产地 = 右键上下文菜单** —— 一行的全部动作收进同一张表,
 * 不散在行尾挂几颗钮。浮层是 `ui/Menu`(**点锚不跟滚**那一档:光标坐标开出的
 * 菜单滚动时维持原位),`menu` 是 `modal` 档,Esc 由它自己缺省关掉。
 *
 * 第 ⑥ 步从 `SearchPanel.tsx:999-1019` 原样搬出来 —— props 原样、DOM 原样。
 * 「这一行有哪几条续搜」由**目标渲染器**自报,「按不按得动」由**自述**答
 * (`continuationEnabled(continuation, available)`),所以这只文件里没有一个
 * 能力 id。
 *
 * **P5 多一段:后端动作**(`rowActions`)。同一条判据的第三次应用 —— 这一行能让
 * 后端做哪几件事也由目标渲染器自报,菜单只负责画出来并把动作号原样回传。
 * 它排在续搜后面:续搜是「接着搜」(留在这块面里),后端动作是「离开这块面去做
 * 一件事」,后者更远。
 */

/** 行的右键菜单开在哪儿(点锚)。 */
export interface RowMenuState {
  row: SearchRow
  x: number
  y: number
}

export interface SearchRowMenuProps {
  /** `null` = 没开;整只不画。 */
  state: RowMenuState | null
  /** 这一档认得哪几个 facet 键 —— 续搜按不按得动读它。 */
  available: ReadonlySet<string>
  t: TFn
  onClose(): void
  /** 「打开」这一行。 */
  onOpen(row: SearchRow): void
  /** 走一条续搜。 */
  onContinuation(continuation: SearchContinuation): void
  /**
   * **只看这一类**(R1)。从前它是组头右边那颗「查看全部」——组头退役之后,
   * 「把清单收成这一类」这件事唯一诚实的落点就是这一行自己的动作表
   * (09-01 判例:动作单产地 = 右键上下文菜单)。
   */
  onScopeOnly(capability: string): void
  /** 跑一条这一行自报的后端动作(P5)。 */
  onRowAction(row: SearchRow, action: SearchRowAction): void
}

const continuationsOf = (row: SearchRow): SearchContinuation[] =>
  resolveTargetRenderer(row.target.kind)?.continuations?.(row) ?? []

const rowActionsOf = (row: SearchRow): SearchRowAction[] =>
  resolveTargetRenderer(row.target.kind)?.rowActions?.(row) ?? []

export function SearchRowMenu({
  state,
  available,
  t,
  onClose,
  onOpen,
  onContinuation,
  onScopeOnly,
  onRowAction,
}: SearchRowMenuProps) {
  if (state === null) return null
  return (
    <Menu
      x={state.x}
      y={state.y}
      label={t('search.rowActions')}
      onClose={onClose}
    >
      <MenuItem onClick={() => { onClose(); onOpen(state.row) }}>
        {t('search.rowOpen')}
      </MenuItem>
      <MenuItem onClick={() => { onClose(); onScopeOnly(state.row.capability) }}>
        {t('search.onlyThisKind')}
      </MenuItem>
      {continuationsOf(state.row).map(continuation => (
        <MenuItem
          key={`${continuation.kind}:${continuation.labelKey}`}
          disabled={!continuationEnabled(continuation, available)}
          onClick={() => { onClose(); onContinuation(continuation) }}
        >
          {t(continuation.labelKey)}
        </MenuItem>
      ))}
      {rowActionsOf(state.row).map(action => (
        <MenuItem
          key={action.actionId}
          onClick={() => { onClose(); onRowAction(state.row, action) }}
        >
          {t(action.labelKey)}
        </MenuItem>
      ))}
    </Menu>
  )
}
