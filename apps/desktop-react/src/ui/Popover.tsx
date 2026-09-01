import { useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { useFocusTrap } from './a11y/focus-trap'
import { useFloatDismiss, useFloatPosition } from './float'
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
 * 开时焦点移进容器(`tabIndex={-1}`)、Tab 圈在里面、关时还给锚点 —— 三件全由
 * `useFocusTrap` 白送。圈禁与 `aria-modal` 是两件事:前者管**键盘走不丢**,
 * 后者管**读屏能不能看见外面**。附属浮层要前者,不要后者。
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
}

export function Popover({ x, y, onClose, label, children, testId }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)

  useFocusTrap(ref, true)

  // 定位(按锚点画一帧、量到身量后同帧 clamp)、Esc 关、点外关三件与 Menu 同源:
  // 行为与判例见 ui/float。
  const pos = useFloatPosition(ref, { kind: 'point', x, y })
  useFloatDismiss(ref, onClose)

  return createPortal(
    <div
      ref={ref}
      className={s.pop}
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      role="dialog"
      /* ⚠ 这里**故意没有** aria-modal:理由写在文件头 ②。 */
      aria-label={label}
      tabIndex={-1}
      data-testid={testId}
    >
      {children}
    </div>,
    document.body,
  )
}
