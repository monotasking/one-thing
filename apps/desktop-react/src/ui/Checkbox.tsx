import { useEffect, useRef } from 'react'
import { Check, Minus } from '../components/icons'
import s from './Checkbox.module.css'

/**
 * 规范画布「控件 · 勾选族」板的 Checkbox:16×16、r-1、1.5px --line-2 边、底抬升面;
 * 选中转 accent 实底 + 11px 白勾(板上原话「选中转 accent 实底」)。
 *
 * indeterminate 板上未定,按同一条配方推导:它和选中一样是「已表态」,
 * 所以同样是 accent 实底,只把勾换成一横 —— 不自造第三种底色。
 *
 * 真的用 input[type=checkbox](视觉隐藏,不是 display:none),
 * 键盘、label 关联、表单语义全部白拿;indeterminate 只能由 DOM 属性表达,
 * 所以那一句副作用是必须的,不是绕路。
 */
interface CheckboxProps {
  checked: boolean
  onChange: (v: boolean) => void
  indeterminate?: boolean
  disabled?: boolean
  /** 无障碍名。有可见文字标签时由调用方传 children 更好,这里只管纯图形那种。 */
  label?: string
  className?: string
}

export function Checkbox({
  checked,
  onChange,
  indeterminate,
  disabled,
  label,
  className,
}: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null)

  // indeterminate 在 HTML 里没有属性,只有 DOM 上的那个字段 —— 只能这么写。
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate)
  }, [indeterminate])

  const on = checked || Boolean(indeterminate)
  const cls = [s.box, on ? s.on : '', disabled ? s.disabled : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <span className={cls}>
      <input
        ref={ref}
        type="checkbox"
        className={s.native}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={s.mark} aria-hidden="true">
        {indeterminate ? (
          <Minus className={s.icon} strokeWidth={3} />
        ) : (
          checked && <Check className={s.icon} strokeWidth={3} />
        )}
      </span>
    </span>
  )
}
