import { useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { FocusScope } from '../focus/FocusScope'
import { useFloatDismiss, useFloatPosition } from './float'
import type { FloatAnchor } from './float'
import s from './Popover.module.css'

/**
 * **附属浮层** —— 贴着某个条目弹出来的一小块面。规范画布「浮层族」里
 * Dialog 与 Menu 之间那一格,本批(08-31 文件面定稿)第一次有真消费方。
 *
 * ── 它与 Dialog 的差别是**语义**,不是尺寸 ──────────────────────────────────
 * Dialog 是**打断**:压一层遮罩,后面那一屏在你答完之前不许动,所以它带
 * `aria-modal`,读屏软件会把浮层外的一切藏起来。
 *
 * Popover 是**附属**:它贴着刚才那一行长出来,回答「这一项是什么」,
 * 而背后那棵树**照旧能看、能滚、能点**。点别处 = 看完了,它自己散掉。
 * 所以三条刻意的不同:
 *  ① **没有遮罩**(不遮树 —— 这正是定稿把详情从 Dialog 改成浮层的理由:
 *     一层遮罩把「瞄一眼」变成了「答一道题」);
 *  ② `role="dialog"` 但**不给 `aria-modal`** —— 它不打断,谎称打断会让读屏
 *     软件把整棵树从虚拟缓冲里摘掉;
 *  ③ 点浮层外面就关(与 Menu 同一条手势),而不是只有那颗关闭钮。
 *
 * ── 焦点照 Menu 的手 ────────────────────────────────────────────────────────
 * 开时焦点移进容器(`tabIndex={-1}`)、Tab 圈在里面、关时焦点回去 —— 三件全由
 * `modal` 作用域白送(09-02 R1;从前是 `ui/a11y/focus-trap`)。圈禁与 `aria-modal`
 * 是两件事:前者管**键盘走不丢**,后者管**读屏能不能看见外面**。附属浮层要前者,
 * 不要后者 —— 所以它在响应链上是 `modal` 档(Tab 圈禁),在 ARIA 上不是模态。
 * 两个「modal」不是同一个词:响应链的 kind 说的是**键盘走不走得出去**。
 * ──────────────────────────────────────────────────────────────────────────
 */
interface PopoverProps {
  /** 锚点(视口坐标)—— 通常是那一行的右下角。 */
  x: number
  y: number
  onClose: () => void
  /** 读屏念的名字。浮层里那个可见的大名字通常就是它。 */
  label: string
  children: ReactNode
  /** 挂在浮层根上的测试取件口(门与单测按它取,不按文案)。 */
  testId?: string
  /**
   * 给了它就换一档锚:浮层贴着这个**活矩形**的下缘,并且**跟着它滚**
   * (矩锚跟滚,点锚不跟滚 —— 两档的裁定写在 ui/float 的 `FloatAnchor` 上)。
   * 不给就是老行为:那一对坐标摆一次,不跟滚。
   *
   * 这一档与 `ui/Menu` 的**逐字同形**:同一件事(贴着一个元素开出去)不该在
   * 两件浮层上长出两套 prop 名 —— 产地越多越漂,那正是 09-01 库自审立
   * 「浮层行为单产地 = ui/float」时点名的病。
   */
  anchor?: () => DOMRect | null
  /**
   * `anchor` 档的对齐边。缺省 `below-start`(贴锚点下缘左对齐)。
   * **锚点自己贴着右边线时给 `below-end`** —— 一行尾巴上的钮左对齐开出去,
   * 浮层整个探到那块面外面(判例:密钥池的行菜单,09-02 批 12)。
   */
  anchorPlace?: 'below-start' | 'below-end'
  /**
   * 开出来之后焦点落在哪一件上(响应链的落点)。缺省 = 浮层根。浮层里第一件就是输入框时给它
   * (宠物那一格「跟黑豆说」,09-19)—— 开了还得再点一下才能打字,是一步白做的手势。
   */
  restingTarget?: () => HTMLElement | null
}

export function Popover({
  x,
  y,
  onClose,
  label,
  children,
  testId,
  anchor,
  anchorPlace = 'below-start',
  restingTarget,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)

  // 定位(按锚点画一帧、量到身量后同帧 clamp)与点外关两件与 Menu 同源:
  // 行为与判例见 ui/float。Esc 与 Tab 归响应链(同 Menu)。
  // x/y 在 anchor 在场时只当首帧兜底:矩形量得到就一次都用不上。
  const floatAnchor: FloatAnchor = anchor
    ? { kind: 'rect', get: anchor, place: anchorPlace }
    : { kind: 'point', x, y }
  const pos = useFloatPosition(ref, floatAnchor, { fallback: { left: x, top: y } })
  useFloatDismiss(ref, onClose)

  return createPortal(
    <FocusScope
      scope="popover"
      rootRef={ref}
      activateOnMount
      restingTarget={restingTarget}
      onEscape={() => (onClose(), true)}
    >
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={s.pop}
          style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
          role="dialog"
          /* ⚠ 这里**故意没有** aria-modal:理由写在文件头 ②。 */
          aria-label={label}
          tabIndex={-1}
          data-testid={testId}
        >
          {children}
        </div>
      )}
    </FocusScope>,
    document.body,
  )
}
