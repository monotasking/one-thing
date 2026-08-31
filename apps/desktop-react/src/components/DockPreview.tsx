import { renderContent } from '../content'
import type { PanelVisibility } from '../content/visibility'
import type { LabelSide } from './DockTile'
import s from './DockPreview.module.css'

const SIDE_CLASS: Record<LabelSide, string> = {
  top: s.atTop,
  bottom: s.atBottom,
  left: s.atLeft,
  right: s.atRight,
}

interface Props {
  /** 要预览的那块内容 —— 与舞台 / 架子 / 浮窗共用同一张 renderContent 表。 */
  id: string
  /** 已经过 i18n 的成品文案。 */
  title: string
  /** 朝内那一侧,由 Dock 按停靠边算好递进来(与名字标签同一个翻向)。 */
  side: LabelSide
  /**
   * 点泡就当点了那块瓦。缺席 = 泡只能看不能点(今天没有这种用法,
   * 留成可选是因为「能不能点」是**摆它的人**的决定,不是泡自己的)。
   */
  onOpen?: () => void
}

/**
 * Dock 预览泡:悬停久了给的那一眼「它现在长什么样」。
 *
 * 内容是**活视图**而不是截图 —— 同一张 renderContent 表渲染出来,再整块缩放,
 * 所以它永远与真的打开之后一致,不会有第二套「预览专用」的画法要维护。
 *
 * 「看得见但不算数」:泡里那一份是**惰性只读**的 —— 它渲染(所以 `visible: true`),
 * 但不许占用全局输入(`interactive: false`)。08-30 之前不是这样:悬停 Dock 上的
 * 会话总览时,泡里那一份 ExposeView 也在 window 上挂了一份键盘监听,于是方向键 /
 * Esc 会同时驱动**两份**同一个全局 store。指针进不来不等于键盘进不来。
 *
 * ── 指针:壳吃、内容不吃(08-31 改)───────────────────────────────────
 * 修前整个泡 `pointer-events: none`,后果是**它根本不能被悬停** —— 指针一离开
 * 那块 44px 的瓦,`.wrap` 的 mouseleave 就触发,泡当场消失(真机实测:离瓦
 * 3px 即没)。用户报的「移入即消失」就是这一条。
 *
 * 现在分两层说话:**壳吃指针**(所以停在泡上算作还在悬停,而且点得动),
 * **内容不吃**(`.viewport { pointer-events: none }`)。内容不吃是必须的:
 * 泡里那一份是不算数的副本,让它的按钮真的可点等于开了第二个操作入口,
 * 而且点哪儿都该是「打开这块面」——不是「点中副本里的某一行」。
 * 名字仍然 `aria-hidden`:它是一眼预览,不是第二份可读内容;壳本身不可聚焦,
 * 所以 aria-hidden 里没有落焦点,axe 的 aria-hidden-focus 不会红。
 * 键盘要打开这块面,走的是瓦那颗真按钮 —— 那条路一直都在。
 */

/** 泡里那一份的身份,恒定 —— 提到组件外,免得每次渲染造一个新对象白白打断 memo。 */
const PREVIEW_VISIBILITY: PanelVisibility = { visible: true, interactive: false }
export function DockPreview({ id, title, side, onOpen }: Props) {
  return (
    /*
     * 泡是**鼠标的顺手路**,不是一个控件:键盘打开这块面走的是瓦那颗真 <button>
     * (泡只在悬停时才存在,键盘根本到不了它)。刻意不给 role="button" 也不给
     * tabIndex —— 报成按钮会让读屏软件念出一个它永远够不着的控件,而
     * aria-hidden 里出现可聚焦元素才是真的 a11y 违例(axe: aria-hidden-focus)。
     *
     * jsx-a11y 的 click-events-have-key-events / no-static-element-interactions
     * 在这里**本来就不响**:两条规则都跳过 `aria-hidden` 的节点。所以这里没有
     * eslint-disable —— 一条压着不存在的违例的注释,下次读的人会以为真有违例。
     */
    <div
      className={`${s.bubble} ${SIDE_CLASS[side]}`}
      data-preview={id}
      aria-hidden="true"
      onClick={onOpen}
    >
      <div className={s.head}>{title}</div>
      <div className={s.viewport}>
        <div className={s.stage}>{renderContent(id, PREVIEW_VISIBILITY)}</div>
      </div>
    </div>
  )
}
