import s from './Progress.module.css'

/**
 * 一条进度条。规范画布「反馈态」板上 loading 分两层(区域级 = 骨架、控件级 =
 * spinner),**这是第三种,而它不与那两种争位置**:骨架与 spinner 说的都是「在忙」,
 * 这一件说的是「走到哪儿了」。**只有说得出「还有多少」的时候才用它** —— 说不出的
 * 时候该用 spinner,而不是在这儿画一条永远在滑的槽。
 *
 * (2026-09-17 建,第一个消费者是设置 → 搜索 → 模型那一行:112.8 MB 冷下 191 秒,
 * 那是一次说得出分子分母的等待。)
 *
 * ── 两态,判据是 `value` 在不在 ────────────────────────────────────────
 *
 * | 态 | 判据 | 画法 | 报法 |
 * | --- | --- | --- | --- |
 * | determinate | 给了 `value`(0–1,越界自己夹) | 那一段占 `value` 宽,120ms 过去 | `aria-valuenow` 真值 |
 * | indeterminate | `value` 缺席 = **不知道**(不是 0) | 一小段来回滑 | 不报 `aria-valuenow`,读屏念「忙」 |
 * | 降级 | `prefers-reduced-motion` | 都不动;滑那一档停在起点并变淡 | 同上 |
 *
 * **0 与「不知道」不是一回事**:画成 0% 会让人以为「开始了但一个字节没下」,
 * 而真相是「还没问出总数」。所以缺席就是缺席,一路缺到 ARIA。
 *
 * ── 无障碍(A11y 线 · A2)───────────────────────────────────────────────
 * 不进 Tab 序 —— 它不是控件,没有键盘表。`role="progressbar"` + 三个 aria 值,
 * `aria-label` **必填**:一条没有名字的进度条,读屏只能念「进度条,43%」,
 * 而「什么的进度」才是要的那半句。文案由调用方经 i18n 传进来,这件里不落字面。
 *
 * **屏幕上那句「43 MB / 113 MB · 38%」不归它画**:那是数据的读法(字节怎么念人话、
 * 要不要写百分号),归调用方。这件只画那条槽。
 */
interface ProgressProps {
  /** 0–1。**缺席 = 不知道**(画成来回滑的那一档),不是 0。 */
  value?: number
  /** 无障碍名(走 i18n)。 */
  label: string
  className?: string
}

export function Progress({ value, label, className }: ProgressProps) {
  const known = value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.min(1, Math.max(0, value))
  const fill = [s.fill, known === undefined ? s.indeterminate : ''].filter(Boolean).join(' ')
  return (
    <div
      className={[s.track, className ?? ''].filter(Boolean).join(' ')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      // 不知道就**不报这一格** —— 报一个 0 会被念成「0%」,那是在编。
      aria-valuenow={known}
    >
      <div className={fill} style={known === undefined ? undefined : { width: `${known * 100}%` }} />
    </div>
  )
}
