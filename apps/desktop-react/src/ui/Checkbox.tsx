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
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   Tab               进出(原生 input)
 *   Space             勾 / 取消勾
 *   焦点环             `.box:has(.native:focus-visible)` —— 环画在**看得见的方框**上,
 *                     因为真 input 是视觉隐藏的(A2 核对:已在,不动)
 * 一件都不自造。三态(未勾 / 已勾 / 半勾)全由原生 checked + DOM indeterminate 表达,
 * 读屏软件念的是「已选中 / 未选中 / 混合」,不是我们编的词。
 * ──────────────────────────────────────────────────────────────────────
 */
interface CheckboxProps {
  checked: boolean
  onChange: (v: boolean) => void
  indeterminate?: boolean
  disabled?: boolean
  /**
   * 只读:画法与可勾时逐字相同(**不**像 disabled 那样变淡 —— 它说的是「这是一个事实」,
   * 不是「此刻用不了」),不进 Tab 序,点了不变,读屏念「只读」。第一个消费者是消息里
   * AI 写的任务清单(`content/blocks/kinds/list`)。
   */
  readOnly?: boolean
  /** 无障碍名。有可见文字标签时由调用方传 children 更好,这里只管纯图形那种。 */
  label?: string
  className?: string
}

export function Checkbox({
  checked,
  onChange,
  indeterminate,
  disabled,
  readOnly,
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
    // 焦点落在看不见的原生 input 上,环要画在**看得见的盒**上:载体 within。
    <span
      className={cls}
      data-focus-ring="within"
      /* 打了勾的盒底就是强调色 —— 同色的环看不见,换 --on-accent 那一档。 */
      data-focus-ring-tone={on ? 'on-accent' : undefined}
    >
      <input
        ref={ref}
        type="checkbox"
        className={s.native}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-readonly={readOnly || undefined}
        tabIndex={readOnly ? -1 : undefined}
        // 原生 checkbox 不认 readOnly 属性。不在 click 上 preventDefault:那会连 change 一起吞掉,
        // React 就不做受控回填(jsdom 实测框被翻过去了);受控 + 不转发 onChange,React 自己把它按回去。
        onChange={(e) => { if (!readOnly) onChange(e.target.checked) }}
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
