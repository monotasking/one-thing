import type { ButtonHTMLAttributes, ReactNode } from 'react'
import s from './Button.module.css'

/**
 * 规范画布「按钮族」的唯一实现:两个变体 × 两档高度,别的都是这四格的组合。
 * primary = accent 实底(一屏只该有一个);ghost = 描边空底(其余全部)。
 * sm 28 / md 32、r-1、字重 600、disabled 只降透明度到 0.45 不换色。
 *
 * 三个开关,各只管一件事,不互相耦合:
 * - pill    只换圆角 → r-full(总览的「＋ Project」、Quick Look 的「进入 ↵」)
 * - iconOnly只换成正方 + 去边框去内边距(组头那个 ＋)
 * - size    只换高度
 *
 * 它不认识业务:文案由调用方经 i18n 传进来,图标由调用方当 children 传进来
 * (图标尺寸也归调用方 —— 同一个按钮在不同面上图标可以不一样大)。
 */
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost'
  size?: 'sm' | 'md'
  /** 丸形:只影响圆角 */
  pill?: boolean
  /** 只有一个图标的方形按钮 */
  iconOnly?: boolean
  children?: ReactNode
}

export function Button({
  variant = 'ghost',
  size = 'sm',
  pill,
  iconOnly,
  className,
  type,
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    s.btn,
    s[variant],
    size === 'md' ? s.md : '',
    pill ? s.pill : '',
    iconOnly ? s.iconOnly : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button type={type ?? 'button'} className={cls} {...rest}>
      {children}
    </button>
  )
}
