import s from './Switch.module.css'

/**
 * 规范画布「控件 · 勾选族」板的 Switch:轨 36×20、r-full、内边距 2、钮 16 白圆。
 * 板上原话:「轨道 120ms 换色,钮 120ms 位移」—— 所以这里只有两条 transition,
 * 都走全局唯一手势 var(--dur) var(--ease),没有第三种时长。
 *
 * 关态轨 --line-2,开态轨 --accent;钮永远是 --surface-2 白圆,不跟着换色。
 * 钮的位移由 transform 表达,不动 flex 布局 —— 轨的几何一帧都不变。
 * (无位移原则约束的是 hover/active 的**反馈**;开关的钮位移是它的语义本身。)
 *
 * 用 <button role="switch"> 而不是 input[type=checkbox]:开关不是勾选框,
 * 屏幕阅读器该念「开/关」而不是「已选中」。aria-label 由调用方传。
 */
interface SwitchProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  /** 无障碍名。组件里不落字面文案,所以它必须由调用方经 i18n 传进来。 */
  label?: string
  className?: string
}

export function Switch({ checked, onChange, disabled, label, className }: SwitchProps) {
  const cls = [s.track, checked ? s.on : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cls}
      onClick={() => onChange(!checked)}
    >
      <span className={s.knob} aria-hidden="true" />
    </button>
  )
}
