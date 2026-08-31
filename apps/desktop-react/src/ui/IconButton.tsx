import { ButtonBase } from './ButtonBase'
import { Tooltip } from './Tooltip'
import type { LucideIcon } from '../components/icons'
import s from './IconButton.module.css'

/**
 * **IconButton —— 组件库第 18 件**(09-01 立件)。
 *
 * ── 它为什么必须是一件库件 ────────────────────────────────────────────────
 * 09-01 报障:「copy 文件路径、编辑,他们的 hover 有遵循规范吗?」——核下来
 * 病根不在某一颗钮,而在**每块面各自画一套图标钮**:有的 hover 只换字色不换底、
 * 有的没有 `:active`(按住与悬停长得一样)、有的把提示写成 native `title=`。
 * 于是 CLAUDE.md 立法「图标按钮必须消费 ui 库件」,这件就是那条法的落点:
 * 配方(rest / hover / active / pressed / disabled / focus)随件走,业务面只声明
 * 「哪个图标、叫什么、按下去干什么」。
 *
 * ── 与 `Button iconOnly` 的分工 ──────────────────────────────────────────
 * `Button` 是**动作钮**:有边框、有 primary/ghost 变体、28/32 两档、进表单与
 * 动作组。`IconButton` 是**檐上那种钮**:无边框、无变体、更小的三档、贴着标题
 * 和状态栏站。两者不是一件东西的两种写法 —— 把 Button 缩到 20px 会让边框、
 * 内边距、字重那一整套配方全部失去意义。
 *
 * ── 三条硬规矩 ──────────────────────────────────────────────────────────
 * ① **`label` 必填**:一颗只有图标的钮必须说得出自己叫什么(它同时是 aria-label
 *    和 Tooltip 的内容)。这不是可选项 —— 无名图标钮在读屏里念作「按钮」。
 * ② **提示走 `ui/Tooltip`,禁 native `title=`**(全仓禁令)。要关掉提示只有一种
 *    正当理由:这颗钮**旁边就写着**同一句话,那时传 `tip={false}`。
 * ③ **焦点环不自绘**:全局 `:focus-visible` 那一圈管所有控件,这里一个字都不写
 *    (禁裸删 outline 是四轴第一条)。
 */
export function IconButton({
  icon: Icon,
  label,
  size = 'sm',
  tone,
  pressed,
  disabled,
  tip = true,
  className,
  testId,
  onClick,
  onPointerDown,
}: {
  icon: LucideIcon
  /** 这颗钮叫什么。aria-label 与 Tooltip 共用它 —— 说给眼睛和说给读屏的是同一句。 */
  label: string
  /** xs = 行内挂件(树行尾的 ⋯);sm = 檐上;md = 与 Button 同高的场合。 */
  size?: 'xs' | 'sm' | 'md'
  /** 危险动作只换字色不换底(四轴:状态色永不换底)。 */
  tone?: 'danger'
  /** 开着(aria-pressed)。缺席 = 这颗钮没有开关语义,不报 aria-pressed。 */
  pressed?: boolean
  disabled?: boolean
  /** 旁边已经写着同一句话时关掉提示 —— 唯一正当的关法。 */
  tip?: boolean
  className?: string
  testId?: string
  onClick?: () => void
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void
}) {
  const cls = [s.btn, s[size], pressed && s.on, tone === 'danger' && s.danger, className]
    .filter(Boolean)
    .join(' ')

  /* 底座走 `ui/ButtonBase`(只清 UA):清 UA 这件事全仓一处,这件只画配方。 */
  const button = (
    <ButtonBase
      className={cls}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      onPointerDown={onPointerDown}
    >
      <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />
    </ButtonBase>
  )

  // 禁用的钮不挂提示:它不响应指针事件,提示永远出不来,挂着只是自欺
  // (「禁用元素本来就不该只靠 tooltip 说话」—— Tooltip 文件头那条)。
  if (!tip || disabled) return button
  return <Tooltip content={label}>{button}</Tooltip>
}
