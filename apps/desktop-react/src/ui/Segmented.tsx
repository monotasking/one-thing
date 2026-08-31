import { useRef } from 'react'
import { useRoving } from './a11y/roving'
import s from './Segmented.module.css'

/**
 * 规范画布「分段器族」的唯一实现:少量互斥选项的就地切换(不是下拉、不是开关)。
 * 槽底 --st-hover,选中段抬起为 --surface-2 + sh-1;非选中 --text-2。
 * 受控且泛型:值是什么由消费方决定,组件只认 value / options / onChange。
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   ← / →             在段之间移动焦点(循环),整组只占**一个** Tab 位
 *   Home / End        到首段 / 末段
 *   Enter / Space     选中当前段(原生 <button>)
 * 语义:role=radiogroup / radio + aria-checked。
 * **移到不等于选中**:与 Tabs 同一条口径(手动激活)—— 一路方向键走过去
 * 不该沿途把每一档都真的切一遍,那是可见的副作用,不是浏览。
 * ──────────────────────────────────────────────────────────────────────
 */
export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

interface SegmentedProps<T extends string> {
  options: Array<SegmentedOption<T>>
  value: T
  onChange: (v: T) => void
  label?: string
}

export function Segmented<T extends string>({ options, value, onChange, label }: SegmentedProps<T>) {
  const group = useRef<HTMLDivElement>(null)
  useRoving(group, { axis: 'horizontal' })
  return (
    <div ref={group} className={s.group} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          // roving 入组标记 + 初值(选中的那一段才在 Tab 序里)。
          data-roving-item
          tabIndex={o.value === value ? 0 : -1}
          className={o.value === value ? `${s.seg} ${s.segOn}` : s.seg}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
