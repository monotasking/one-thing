import { createContext, useContext, useId, useMemo } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
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
 *
 * ── 09-05 补两口(庚:输入框里的思考阶梯,库件先行)──────────────────────
 * ① **RadioGroup 摊 `HTMLAttributes`**(照 `ui/Card` / `ui/Button` 的既有先例)。
 *    它开的是**落点自己的身份**:一发档位在飞时那一组要挂 `aria-busy`,而
 *    「这一组此刻在不在飞」是落点的事实,不是这件的事实 —— 不该变成第 N 个 prop。
 *    `onChange` 被 Omit 掉:这件的 `onChange` 是「选中了哪个 value」,与 div 上
 *    那个 `FormEventHandler` 词义不可能共存,留下的是这件的那一个。
 * ② **Radio 收 `className` 皮肤**。判据与「样式只走 className」那条一致:
 *    一颗的**内容**由消费方决定(两行的档名 + 注就是一例),而两行内容要的
 *    「点与首行对齐」是那一处的排版,不是这件的形态。库件不长 `align` 那种
 *    presentational prop —— 皮肤覆盖的写法是 `.<组皮肤> .<颗皮肤>`(0,2,0),
 *    稳赢库件自己的 `.row`(0,1,0),不靠样式表顺序。
 * ──────────────────────────────────────────────────────────────────────
 */
interface RadioGroupCtx {
  name: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}

const Ctx = createContext<RadioGroupCtx | null>(null)

export interface RadioGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
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
  ...rest
}: RadioGroupProps) {
  // 同一组必须共享 name,方向键才成一组;name 是实现细节,不让调用方操心。
  const name = useId()
  const ctx = useMemo(() => ({ name, value, onChange, disabled }), [name, value, onChange, disabled])
  return (
    <Ctx.Provider value={ctx}>
      {/* `className` / `role` / `aria-label` 显式在前:透传开的是落点的身份
          (`aria-busy` / `data-testid`),不是覆盖这件形态的口子。 */}
      <div
        className={className ? `${s.group} ${className}` : s.group}
        role="radiogroup"
        aria-label={label}
        {...rest}
      >
        {children}
      </div>
    </Ctx.Provider>
  )
}

export interface RadioProps {
  value: string
  disabled?: boolean
  /** 可见文字标签(走 i18n 由调用方传);不给就是纯图形,那时请给 label。 */
  children?: ReactNode
  label?: string
  /** 这一颗的皮肤(排版由内容决定时用它,见文件头 ②)。 */
  className?: string
}

export function Radio({ value, disabled, children, label, className }: RadioProps) {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('Radio must be used inside RadioGroup')
  const on = ctx.value === value
  const off = disabled || ctx.disabled
  const cls = [s.row, off ? s.disabled : '', className ?? ''].filter(Boolean).join(' ')

  return (
    <label className={cls}>
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
