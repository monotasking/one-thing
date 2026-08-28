import { renderContent } from '../content'
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
 */
export function DockPreview({ id, title, side }: Props) {
  return (
    <div className={`${s.bubble} ${SIDE_CLASS[side]}`} data-preview={id} aria-hidden="true">
      <div className={s.head}>{title}</div>
      <div className={s.viewport}>
        <div className={s.stage}>{renderContent(id)}</div>
      </div>
    </div>
  )
}
