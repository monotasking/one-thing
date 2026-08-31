import { createContext, useContext, useId, useMemo } from 'react'
import type { ReactNode } from 'react'
import s from './Radio.module.css'

/**
 * 规范画布「控件 · 勾选族」板的 Radio:16×16、r-full、1.5px --line-2 边;
 * 选中态板上写得很死 ——「Radio 用环不用点」:不是白底中间一个 accent 圆点,
 * 而是**一圈 5px 的 accent 边**把中心挤成一个白芯。所以这里换的是 border-width,
 * 不是往里塞一个子元素。
 *
 * 分工:RadioGroup 管一组的事(name / value / onChange / 无障碍名),
 * Radio 只表达一颗的形态与它自己的 value。
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   Tab               整组只占**一个** Tab 位(原生 radio 的行为,不是我们做的)
 *   ↑ ↓ ← →           组内切换,**并且同时选中**(原生 radio 就是自动激活档)
 *   Space             选中当前颗
 *   焦点环             `.dot:has(.native:focus-visible)`(A2 核对:已在,不动)
 * **键盘不自造**:同名 name 的一组原生 radio,上面这几行全是浏览器白送的 ——
 * 自造的 roving 那套永远比原生少几个边角(输入法组合键、表单重置、右到左布局)。
 * 这也是 Segmented 与它的分工线:Segmented 是「看起来像分段器的一组按钮」,
 * 要自己写 roving;这件是真 radio,一行都不用写。
 * ──────────────────────────────────────────────────────────────────────
 */
interface RadioGroupCtx {
  name: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}

const Ctx = createContext<RadioGroupCtx | null>(null)

interface RadioGroupProps {
  value: string
  onChange: (v: string) => void
  /** 无障碍名。组件里不落字面文案,由调用方经 i18n 传。 */
  label?: string
  /** 整组禁用;单颗也可以自己禁用。 */
  disabled?: boolean
  children: ReactNode
  className?: string
}

export function RadioGroup({
  value,
  onChange,
  label,
  disabled,
  children,
  className,
}: RadioGroupProps) {
  // 同一组必须共享 name,方向键才成一组;name 是实现细节,不让调用方操心。
  const name = useId()
  const ctx = useMemo(() => ({ name, value, onChange, disabled }), [name, value, onChange, disabled])
  return (
    <Ctx.Provider value={ctx}>
      <div className={className ? `${s.group} ${className}` : s.group} role="radiogroup" aria-label={label}>
        {children}
      </div>
    </Ctx.Provider>
  )
}

interface RadioProps {
  value: string
  disabled?: boolean
  /** 可见文字标签(走 i18n 由调用方传);不给就是纯图形,那时请给 label。 */
  children?: ReactNode
  label?: string
}

export function Radio({ value, disabled, children, label }: RadioProps) {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('Radio must be used inside RadioGroup')
  const on = ctx.value === value
  const off = disabled || ctx.disabled

  return (
    <label className={off ? `${s.row} ${s.disabled}` : s.row}>
      <span className={on ? `${s.dot} ${s.on}` : s.dot}>
        <input
          type="radio"
          className={s.native}
          name={ctx.name}
          value={value}
          checked={on}
          disabled={off}
          aria-label={children ? undefined : label}
          onChange={() => ctx.onChange(value)}
        />
      </span>
      {children && <span className={s.label}>{children}</span>}
    </label>
  )
}
