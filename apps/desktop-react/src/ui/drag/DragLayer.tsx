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
 * 组件里,它自己只画一枚浮影,重渲一次的代价就是那一枚。
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
 *
 * ── 收笔那一程(W6-b,§5「落定卡片飞入空位」/「弹回」)────────────────────
 * 会话结束时如果消费方给了一块落点矩形,状态里会多出一格 `landing`:这一层把
 * 坐标一次性写到那块矩形的中心并挂上 `data-landing`,于是 `left/top` 的过渡
 * (`--dur-land`)自己把卡片送过去。**同一个节点在挪**,不是新造一枚飞行卡片
 * ——§4.5 第 3 条的字面兑现。飞完由会话那一头把状态归零(它有计时器)。
 */
export function DragLayer() {
  const drag = useDragState()
  /*
   * **条内换序时一个节点都不画**(W3-b 裁定 4)。用户报的第一句话是
   * 「手按着 tab,动的却是旁边一枚芯片」—— 那一形的根因不是浮影长得不对,
   * 而是屏幕上**同时有两个**「拖着的东西」。所以这一档不是「浮影跟着 tab 走」,
   * 是浮影**不存在**:拖着的那个东西就是那格 tab 自己。
   *
   * 从前这里还有第三档 `hint`(仍是那格 tab 在动、卡片不画、只留下面一行
   * 「与「X」二合一」),那是「放到标签上」那条带的画法。**U2 随那条带一起
   * 退役**(判词在 `ui/drag/constants.ts` 的 `ONTO_FROM_PX` 退役段),所以这里
   * 也不再有 `card={…}` 那一格开关:走到这一句下面的只剩 `ghost` 一档,而
   * `ghost` 恒画卡片。
   */
  if (!drag || drag.presentation === 'inline') return null
  const landing = drag.landing
  const refused = drag.drop?.tone === 'refuse'
  /*
   * 靠视口右缘那一档翻面(§5)。判据在这里而不在 CSS 里,理由是 CSS 问不到
   * 「视口有多宽」这件事的**结论**(容器查询问的是容器,而这一层是 fixed 的
   * 零身量点)。`GHOST_FLIP_PX` 与 `--drag-flip-edge` 由单测钉成相等。
   */
  const flip = typeof window !== 'undefined' && drag.pointer.x > window.innerWidth - GHOST_FLIP_PX
  const x = landing ? landing.left + landing.width / 2 : drag.pointer.x
  const y = landing ? landing.top + landing.height / 2 : drag.pointer.y
  return (
    <div
      className={s.layer}
      data-landing={landing ? '' : undefined}
      style={{ '--drag-x': `${x}px`, '--drag-y': `${y}px` } as CSSProperties}
      aria-hidden="true"
    >
      <DragGhost
        ghost={drag.ghost}
        hint={landing ? undefined : drag.drop?.hint}
        refused={refused}
        flip={flip && !landing}
        landing={Boolean(landing)}
      />
    </div>
  )
}

/**
 * 浮影靠视口右缘多近开始翻面(`--drag-flip-edge` 的判据镜像)。
 * 它必须在 JS 这一头有一份:翻面是一格**属性**,而属性只有 JS 写得动。
 */
export const GHOST_FLIP_PX = 260
