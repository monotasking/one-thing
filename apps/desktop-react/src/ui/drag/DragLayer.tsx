import type { CSSProperties } from 'react'
import { DragGhost } from './DragGhost'
import { useDragState } from './DragSession'
import s from './DragLayer.module.css'

/**
 * **浮影的挂载点**(W3)。整台壳挂一次(`AppShell`),与 `SnapHint` / `FloatLayer`
 * 同一排。
 *
 * ── 它为什么是一只独立的零 DOM 叶子 ─────────────────────────────────────
 * 它订阅拖拽会话,而那格状态**每一发 pointermove 都变**。挂在外壳身上等于
 * 「拖一次整棵壳重渲上百遍」——09-03「面自己不许订阅焦点树、交给叶子」那条判例
 * 的同型(`StageFocusFollow` 就是照这条抽出去的)。这里再走一遍:订阅住在这只
 * 组件里,它自己只画一枚 28px 的浮影,重渲一次的代价就是那一枚。
 *
 * ── 不拖的时候一个节点都不画 ────────────────────────────────────────────
 * 不是「画一个 opacity: 0 的」:一个常驻的 fixed 元素会一直参与合成,而且
 * 「屏幕上有没有这个东西」在门与用例里必须是可断言的事实
 * (`[data-testid="drag-ghost"]` 在不在 DOM 里)。
 *
 * ── 位置一帧都不经过布局 ────────────────────────────────────────────────
 * 坐标写进 `left/top`(fixed,视口坐标),偏移在 CSS 里用 `transform` 做 ——
 * 于是浏览器每帧只需要重合成这一层。它 `pointer-events: none`,所以不参与命中
 * 测试,也就不会把落点判定的答案变成「浮影自己」。
 */
export function DragLayer() {
  const drag = useDragState()
  if (!drag) return null
  const refuse = drag.drop?.tone === 'refuse' ? (drag.drop.label ?? '') : undefined
  return (
    <div
      className={s.layer}
      style={{ '--drag-x': `${drag.pointer.x}px`, '--drag-y': `${drag.pointer.y}px` } as CSSProperties}
      aria-hidden="true"
    >
      <DragGhost ghost={drag.ghost} refuseLabel={refuse || undefined} />
    </div>
  )
}
