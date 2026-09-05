import { resolveIcon } from '../../components/icons'
import type { DragGhostSpec } from './DragSession'
import s from './DragGhost.module.css'

/**
 * **拖着的那个替身**(W3,设计 §3:「起一枚浮影(图标 + 名)」)。
 *
 * 纯呈现件:收一格 `ghost`(图标 + 名)与一格拒绝理由,不订阅任何东西 ——
 * 谁在拖、拖到哪儿由 `DragLayer` 判,这一层只负责长什么样。分成两件的理由与
 * `LeafStrip` / `PaneLeafStrip` 那一对逐字相同:**订阅住在外面,画法住在里面**。
 *
 * ── 它为什么不是一件可交互的东西 ────────────────────────────────────────
 * `pointer-events: none`(在样式表里)。落点判定问的是「指针底下是哪一片叶」,
 * 浮影要是接指针,那个答案永远是「浮影自己」。同一条也让它与
 * `-webkit-app-region: drag` 的顶栏和平共处:顶栏那格拖拽区判例说的是
 * `no-drag` 只在同分支子孙上生效 —— 而浮影根本不在 `.bar` 里,它是
 * `DragLayer` 的一个 fixed 元素,又不接指针,所以它一个像素都碰不到那件事。
 *
 * ── 拒绝态(裁定 7:结构化拒绝,不静默)────────────────────────────────
 * `data-refuse` 一格属性:整枚变灰、名字后面**补一句理由**。不是「不画高亮」——
 * 「松手什么都不会发生」这件事必须说出口,否则用户只会以为是自己没拖准。
 */
export function DragGhost({
  ghost,
  refuseLabel,
}: {
  ghost: DragGhostSpec
  /** 非空 = 这一帧落不下去,理由就是这一句。 */
  refuseLabel?: string
}) {
  const Icon = ghost.icon ? resolveIcon(ghost.icon) : null
  return (
    <div className={s.ghost} data-refuse={refuseLabel ? '' : undefined} data-testid="drag-ghost">
      {Icon && <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />}
      <span className={s.label}>{ghost.label}</span>
      {refuseLabel && (
        <span className={s.reason} data-testid="drag-refuse">
          {refuseLabel}
        </span>
      )}
    </div>
  )
}
