import s from './Segmented.module.css'

/**
 * 规范画布「分段器族」的唯一实现:少量互斥选项的就地切换(不是下拉、不是开关)。
 * 槽底 --st-hover,选中段抬起为 --surface-2 + sh-1;非选中 --text-2。
 * 受控且泛型:值是什么由消费方决定,组件只认 value / options / onChange。
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
  return (
    <div className={s.group} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? `${s.seg} ${s.segOn}` : s.seg}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
