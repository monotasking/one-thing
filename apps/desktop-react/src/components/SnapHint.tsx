import type { CSSProperties } from 'react'
import { useSnapSide } from './snap-hint'
import { useStageStore } from '../stage/store'
import { edgeExtentAfterDrop } from '../workbench/drop-commit'
import type { ShelfSide } from '../stage/types'
import s from './SnapHint.module.css'

const SIDE_CLASS: Record<ShelfSide, string> = {
  left: s.left,
  right: s.right,
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
  /*
   * **膜画的是那条架子将来占的地方**(09-25):已有的架子是它自己的厚度,空边是新架子的
   * 30% —— 与拖一格标签到边带时那层膜同一个数(`edgeExtentAfterDrop`)。订阅架子那一格
   * 只为在它变化时重画;读数本身走那只函数,不在这里再算一遍。
   */
  useStageStore((st) => (side ? st.shelves[side] : null))
  if (!side) return null
  const extent = Math.round(edgeExtentAfterDrop(side))
  return (
    <div
      className={`${s.film} ${SIDE_CLASS[side]}`}
      style={{ '--snap-film': `${extent}px` } as CSSProperties}
      data-snap-hint={side}
      aria-hidden="true"
    />
  )
}
