import { useCallback, useRef } from 'react'
import { useFloatPosition } from '../float'
import { useDragState } from './DragSession'
import type { DropFeedback } from './DragSession'
import s from './DropOverlay.module.css'

/**
 * **落区高亮**(W3,设计 §3.1「落区高亮是一层 `DropOverlay`(消费 `ui/float` 的
 * 定位原语,不手写)」)。整台壳挂一次(`AppShell`),排在 `DragLayer` **之前**
 * —— 两层同一档 z(`--z-drag`),谁在上由 DOM 序决定:浮影永远盖在高亮上。
 *
 * ── 裁定 2 的字面兑现:几何不在这只文件里 ────────────────────────────────
 * 派工令原话:「消费 `ui/float` 的定位原语(`useFloatPosition` 若无『盖住锚元素
 * 整个矩形』这一档,就在 ui/float 加那一档,**不在 DropOverlay 里手写几何**)」。
 * 所以 `ui/float` 多了 `place: 'cover'` 一档(它是唯一会交出身量的一档),
 * 这一层的全部工作就是把消费方交回来的那块矩形当成锚递进去。
 *
 * **落区的矩形本身也不在这里算**:五落区(中 / 上 / 下 / 左 / 右)、边带、
 * 撕浮窗的轮廓,四种形状全部由纯函数 `workbench/drop.ts` 的 `zoneRectOf` /
 * `targetRectOf` 算好,经 `setDropFeedback` 交回来。于是「拖到哪儿会发生什么」
 * 与「屏幕上高亮画在哪儿」读的是**同一个矩形** —— 两处各算一遍正是「高亮说的
 * 和松手做的不是一件事」那类 bug 的全部来源。
 *
 * ── 三张状态表 ①:生命周期 ──────────────────────────────────────────────
 *   挂载   整台壳挂载(恒在场,但不拖时**不画一个节点**)
 *   跟随   拖拽中每一帧:锚矩形换了就重摆(`cover` 档的重算键是矩形的四个数)
 *   卸载   松手 / 取消:拖拽会话归零,这一层当场答 null
 *
 * ── ②:UI 生命状态 ───────────────────────────────────────────────────────
 *   无     没在拖 / 这一帧没有落区(`feedback.rect === null`,比如撕浮窗前的空档)
 *   接受   `--drop-band-face` 一层薄膜 + 一圈 `--accent` 描边(+ 可选一句话)
 *   拒绝   不换底、只留一圈虚线灰边(裁定 7:说得出「这里落不下去」)
 *   轮廓   `outline` 档:只画一圈边不铺面 —— 撕成浮窗时它就是那扇窗的预示
 *
 * ── ③:UI 交互状态 ───────────────────────────────────────────────────────
 * 与浮影同理,这一列恒为空:它 `pointer-events: none`,不接指针。
 *
 * ── 挤压纪律:高亮不撑破叶 ───────────────────────────────────────────────
 * 它的身量**就是**锚矩形(`cover` 档交回来的两个数),而锚矩形是那片叶自己的
 * 矩形或它的一块子矩形 —— 结构上不可能比叶大。这一句由 `gate:squeeze` 的
 * DropOverlay 采样真机量着(高亮的四边一律落在叶的四边之内)。
 */
export function DropOverlay() {
  const drag = useDragState()
  return drag?.drop?.rect ? <DropBand feedback={drag.drop} /> : null
}

/**
 * 一块高亮。**单独一只组件**,理由是 hook 的纪律:上面那只在「没在拖」时要能
 * 直接 `return null`,而 `useFloatPosition` 一旦在那里调,它就得每帧带着一个
 * 假锚跑。分开之后:不拖 = 一只 hook 都不跑。
 */
function DropBand({ feedback }: { feedback: DropFeedback }) {
  const ref = useRef<HTMLDivElement>(null)
  const rect = feedback.rect
  /*
   * 锚是一块**由消费方每帧交回来的矩形**,不是页面上某个元素 —— 所以 getter
   * 就地把那四个数包成一个 DOMRect 形。`useFloatPosition` 的 rect 档只要求
   * getter 答得出 `left/top/width/height`,它不关心那块矩形是谁的。
   */
  const get = useCallback(
    () => (rect ? ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height } as DOMRect) : null),
    [rect],
  )
  const pos = useFloatPosition(ref, { kind: 'rect', get, place: 'cover' })
  if (!rect) return null
  return (
    <div
      ref={ref}
      className={s.band}
      data-testid="drop-overlay"
      data-tone={feedback.tone}
      data-outline={feedback.outline ? '' : undefined}
      style={{
        left: pos.left,
        top: pos.top,
        width: pos.width ?? rect.width,
        height: pos.height ?? rect.height,
      }}
      aria-hidden="true"
    >
      {feedback.label && <span className={s.label}>{feedback.label}</span>}
    </div>
  )
}
