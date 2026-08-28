import { useSnapSide } from './snap-hint'
import type { ShelfSide } from '../stage/types'
import s from './SnapHint.module.css'

const SIDE_CLASS: Record<ShelfSide, string> = {
  left: s.left,
  right: s.right,
  top: s.top,
  bottom: s.bottom,
}

/**
 * 吸附预示:拖着一扇浮窗进了某条边的热带时,那条边上浮出一条半透明 accent 薄膜。
 *
 * 它只画「将要发生什么」,不参与判定 —— 判定是 transitions.snapSideAt,
 * 谁在拖由 snap-hint 那个瞬态说了算。离开热带薄膜就散,松手才真的落位。
 */
export function SnapHint() {
  const side = useSnapSide()
  if (!side) return null
  return <div className={`${s.film} ${SIDE_CLASS[side]}`} data-snap-hint={side} aria-hidden="true" />
}
