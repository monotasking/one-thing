import { resolveIcon } from '../../components/icons'
import type { DragGhostSpec } from './DragSession'
import s from './DragGhost.module.css'

/**
 * **拖着的那个替身**(W3,设计 §3:「起一枚浮影(图标 + 名)」;W6-b 加了
 * 下面那行字)。
 *
 * 纯呈现件:收一格 `ghost`(图标 + 名)、一行提示、一格拒绝理由,不订阅任何东西 ——
 * 谁在拖、拖到哪儿由 `DragLayer` 判,这一层只负责长什么样。分成两件的理由与
 * `LeafStrip` / `PaneLeafStrip` 那一对逐字相同:**订阅住在外面,画法住在里面**。
 *
 * ── 两层:卡片 + 提示行(W6-b,设计 v3 §5 贯穿规则 2)──────────────────────
 * 上面是**卡片**(图标 + 名,W3-b 那一枚原样),下面是**一行「松手会发生什么」**。
 * 它们是两个盒子而不是一行里的两段,理由有三:提示行要能在卡片不画时单独出现
 * (`hint` 那一档 —— 条内那一格压到条底缘下、要落到某个标签上时);提示行的字比名字小一档、
 * 颜色也退后一档;而且靠近视口右缘时提示行要挂到卡片**左侧**去,那件事只有它
 * 自己是一个盒子才做得到。
 *
 * 「永不空」这句话不是这一层的判据 —— 它由消费方保证(`DropFeedback.hint` 是必填)。
 * 这一层只做一件事:给了就画,没给就不画那个盒子(条内换序那一形整枚浮影都不在)。
 *
 * ── 它为什么不是一件可交互的东西 ────────────────────────────────────────
 * `pointer-events: none`(在样式表里)。落点判定问的是「指针底下是哪一片叶」,
 * 浮影要是接指针,那个答案永远是「浮影自己」。同一条也让它与
 * `-webkit-app-region: drag` 的顶栏和平共处:顶栏那格拖拽区判例说的是
 * `no-drag` 只在同分支子孙上生效 —— 而浮影根本不在 `.bar` 里,它是
 * `DragLayer` 的一个 fixed 元素,又不接指针,所以它一个像素都碰不到那件事。
 *
 * ── 拒绝态(裁定 7:结构化拒绝,不静默)────────────────────────────────
 * `data-refuse` 一格属性:卡片变灰 + 虚线边,提示行前面补一个 ✕。不是「不画高亮」
 * ——「松手什么都不会发生」这件事必须说出口,否则用户只会以为是自己没拖准。
 * 光标那一半不在这里(它要盖住整扇窗,由根属性 `data-drag-refuse` 驱动,规则在
 * `styles/global.css`)。
 */
export function DragGhost({
  ghost,
  hint,
  refused,
  card = true,
  flip,
  landing,
}: {
  ghost: DragGhostSpec
  /** 「松手会发生什么」那一行。空 = 不画那个盒子。 */
  hint?: string
  /** 这一帧落不下去(卡片变灰虚线、提示行前补 ✕)。 */
  refused?: boolean
  /** 画不画上面那张卡片。`false` = 只留提示行(「放到标签上」那一形)。 */
  card?: boolean
  /** 靠视口右缘:整枚右对齐,提示行挂到卡片左侧(§5)。判据在 `DragLayer`。 */
  flip?: boolean
  /** 正在飞完最后一程:去掉倾斜、淡出(§5「落定卡片飞入空位」)。 */
  landing?: boolean
}) {
  const Icon = ghost.icon ? resolveIcon(ghost.icon) : null
  return (
    <div
      className={s.ghost}
      data-refuse={refused ? '' : undefined}
      data-flip={flip ? '' : undefined}
      data-landing={landing ? '' : undefined}
      data-testid="drag-ghost"
    >
      {card && (
        <div className={s.card} data-testid="drag-ghost-card">
          {Icon && <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />}
          <span className={s.label}>{ghost.label}</span>
        </div>
      )}
      {hint && (
        <div className={s.hint} data-testid="drag-hint" data-refuse={refused ? '' : undefined}>
          {/* ✕ 是**装饰**:它说的话提示行自己已经说了,读屏软件念一遍就够。 */}
          {refused && <span aria-hidden="true">✕ </span>}
          {hint}
        </div>
      )}
    </div>
  )
}
