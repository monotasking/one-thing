import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { FocusScope } from '../../../focus/FocusScope'
import { useT } from '../../../i18n'
import { SvgCanvas } from './SvgCanvas'
import s from './ZoomOverlay.module.css'

/**
 * 放大 —— **一件自足的浮层,不是一套新的浮层体系**。
 *
 * 三处配方与 Dialog / StageOverlay 逐字对齐(那是这条规矩在本仓的先例):
 * 遮罩层级 `--z-overlay`、画布 `--z-modal`、遮罩点击判 `mousedown` 且
 * `target === currentTarget`(从画布里拖出去松手不该关)、Esc 可关。
 *
 * ── 为什么不直接复用 `ui/Dialog` ──────────────────────────────────────
 * Dialog 是**问一句话**的形状:定宽 400、有标题行、有底部动作区,内容被 padding
 * 框在中间。放大要的恰恰相反 —— 画布尽量大、可滚动、周围什么都别有。用 Dialog
 * 去装它,最后会是一串把 Dialog 掰弯的 props。
 *
 * ── 留账:与 QuickLook 并族是后续 ────────────────────────────────────
 * 壳里已经有一个「按一下看大图」的族(QuickLook / StageOverlay 的两段式)。本批
 * 不去动它:并族要先拍板「块的放大是不是 QuickLook 的一种」,那是设计件,
 * 不该被一个 P3 的顺手改动替用户回答。今天这件只在块壳里用,一个组件、
 * 一份状态,并族时整件换掉即可。
 */
export function ZoomOverlay({ svg, onClose }: { svg: string; onClose: () => void }) {
  const canvas = useRef<HTMLDivElement | null>(null)
  const t = useT()

  /*
   * ── 开出来入焦 + Esc 关掉:两句**声明**(09-03 R2)────────────────────────
   * 从前这里是一条 `useEffect`:一句 `canvas.focus()` 加一个 window keydown。
   * 两件事现在都归响应链上这一格 `float`:`activateOnMount` + `restingTarget`
   * 说「刚开出来就把焦点送到画布上」,`onEscape` 说「这一下 Esc 归我」——
   * 认领(preventDefault)与「这一层在不在最上面」由那唯一的派发器按活动路径答,
   * 不再由「谁的 window 监听后挂」决定。
   *
   * 关掉之后焦点回哪儿也不必这里管:它在树上是开出它的那块内容的孩子,
   * 路径缩回去,焦点回那块面上次所在的元素(§4.5 的结构归还)。
   */
  return createPortal(
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
     * 与 Dialog 同一条:遮罩点击是鼠标的顺手路,不是唯一出口(Esc 已经能关)。
     * 刻意不给 role="button" —— 遮罩不是按钮,报成按钮会让读屏念出不存在的控件。 */
    <div
      className={s.scrim}
      data-testid="block-zoom-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <FocusScope
        scope="zoom"
        rootRef={canvas}
        activateOnMount
        onEscape={() => (onClose(), true)}
      >
        {({ scopeProps }) => (
          <div
            {...scopeProps}
            className={s.canvas}
            role="dialog"
            aria-modal="true"
            aria-label={t('block.zoom.label')}
          >
            <SvgCanvas svg={svg} className={s.figure} />
          </div>
        )}
      </FocusScope>
    </div>,
    document.body,
  )
}
