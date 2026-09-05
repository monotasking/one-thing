import { useCallback, useRef } from 'react'
import { useFloatPosition } from '../float'
import { useDragState } from './DragSession'
import type { DragRect, DropFeedback } from './DragSession'
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
 *   无     没在拖 / 这一帧没有落区(`feedback.rect === null`)—— 落在一条标签条
 *          上就是这一形:那一档的预示是**条自己腾出来的空位**,不是盖一块高亮
 *   薄膜   `film`:窗口边带那一档(一层膜 + 一圈实线 + 一句话),W3 的原样
 *   细环   `ring`:并入一片叶 —— 只描一圈,叶里一个像素都不盖(W3-b 裁定 7)
 *   杠     `bar`:在这一侧分屏 —— 那块矩形本身就是一根 4px 的杠
 *   轮廓   `outline`:只画一圈虚线边不铺面 —— 撕成浮窗时那扇窗的预示
 *   拒绝   不换底、只留一圈虚线灰边(裁定 7:说得出「这里落不下去」)
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
  if (!drag) return null
  return (
    <>
      {/*
        **氛围**(W6-b,设计 v3 §5 贯穿规则 1)。它排在实亮那一块**之前** ——
        两者同一档 z(`--z-drag`),谁在上由 DOM 序决定,而「悬到的那一处亮到实」
        这句话要求实亮的那块盖在淡亮之上。
        它们是**同一批节点在挪**而不是每帧重建:`key` 取那块矩形的四个数
        (氛围只在起拖那一刻算一次,整场不变),所以 React 一次都不会拆掉重建。
      */}
      {drag.ambient.map((rect) => (
        <AmbientBand key={`${rect.left},${rect.top},${rect.width},${rect.height}`} rect={rect} />
      ))}
      {drag.drop?.rect ? <DropBand feedback={drag.drop} /> : null}
    </>
  )
}

/**
 * 一块**淡亮**(§5:「所有能放的地方先淡淡亮一层」)。它与 `DropBand` 是两只
 * 组件而不是一格 `tone`,理由与那边分家同源:这一块**不跟随、不换矩形**
 * (起拖时算一次),所以它不必每帧跑一次 `useFloatPosition`。
 */
function AmbientBand({ rect }: { rect: DragRect }) {
  return (
    <div
      className={s.ambient}
      data-testid="drop-ambient"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      aria-hidden="true"
    />
  )
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
      data-shape={feedback.shape ?? 'film'}
      style={{
        left: pos.left,
        top: pos.top,
        width: pos.width ?? rect.width,
        height: pos.height ?? rect.height,
      }}
      aria-hidden="true"
    />
  )
}
