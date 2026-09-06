import { Menu, MenuItem } from '../../ui/Menu'
import type { TFn } from '../../i18n'
import { continuationEnabled } from '../continuations'
import type { SearchContinuation } from '../continuations'
import { resolveTargetRenderer } from '../targets'
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
}

const continuationsOf = (row: SearchRow): SearchContinuation[] =>
  resolveTargetRenderer(row.target.kind)?.continuations?.(row) ?? []

export function SearchRowMenu({
  state,
  available,
  t,
  onClose,
  onOpen,
  onContinuation,
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
      {continuationsOf(state.row).map(continuation => (
        <MenuItem
          key={`${continuation.kind}:${continuation.labelKey}`}
          disabled={!continuationEnabled(continuation, available)}
          onClick={() => { onClose(); onContinuation(continuation) }}
        >
          {t(continuation.labelKey)}
        </MenuItem>
      ))}
    </Menu>
  )
}
