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
}

/**
 * Dock 预览泡:悬停久了给的那一眼「它现在长什么样」。
 *
 * 内容是**活视图**而不是截图 —— 同一张 renderContent 表渲染出来,再整块缩放,
 * 所以它永远与真的打开之后一致,不会有第二套「预览专用」的画法要维护。
 * 它不吃指针(pointer-events: none),所以泡里的东西不可点、也挡不住瓦。
 *
 * 「看得见但不算数」:泡里那一份是**惰性只读**的 —— 它渲染(所以 `visible: true`),
 * 但不许占用全局输入(`interactive: false`)。08-30 之前不是这样:悬停 Dock 上的
 * 会话总览时,泡里那一份 ExposeView 也在 window 上挂了一份键盘监听,于是方向键 /
 * Esc 会同时驱动**两份**同一个全局 store。指针进不来不等于键盘进不来。
 */

/** 泡里那一份的身份,恒定 —— 提到组件外,免得每次渲染造一个新对象白白打断 memo。 */
const PREVIEW_VISIBILITY: PanelVisibility = { visible: true, interactive: false }
export function DockPreview({ id, title, side }: Props) {
  return (
    <div className={`${s.bubble} ${SIDE_CLASS[side]}`} data-preview={id} aria-hidden="true">
      <div className={s.head}>{title}</div>
      <div className={s.viewport}>
        <div className={s.stage}>{renderContent(id, PREVIEW_VISIBILITY)}</div>
      </div>
    </div>
  )
}
