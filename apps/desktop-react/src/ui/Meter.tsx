import s from './Meter.module.css'

/**
 * 一条**表**(meter):一个量落在一个已知范围里的哪儿(2026-09-25 立件,第一个消费者是
 * 内存监视器 —— 总量对预算、每只缓存的条数对上限)。
 *
 * ── 它与 `ui/Progress` 不是一回事 ───────────────────────────────────────
 * Progress 说「一件事走到哪儿了」(下载 43%),它会走完、会消失;Meter 说「一个量现在
 * 有多满」(内存 1.7 GB / 1.5 GB 线),它不走完、可以超线、满了是**坏消息**而不是好消息。
 * 所以 ARIA 角色不同(`meter` vs `progressbar`),填充色也由调用方按状态说(`tone`)——
 * Progress 永远是强调色。
 *
 * ── 三态 × 两档 ─────────────────────────────────────────────────────────
 *
 * | 格 | 取值 | 画法 |
 * | --- | --- | --- |
 * | `tone` | `accent` / `warn` / `danger` | 填充是那一色;**轨道是同一色的浅一档**(不是一条灰槽),状态在整条上都读得出来 |
 * | `size` | `md`(缺省,领头那一条)/ `sm`(列表行里的细表) | 只有粗细不同 |
 * | `value` 缺席 | = 量不到 | 只画轨道,不画一段 0 宽的填充;ARIA 不报 `aria-valuenow` |
 *
 * **刻线**(`ticks`)是范围里几个有名字的位置(预算线、上限):比轨道高出一截、用底色
 * 描一圈缝,压在填充上也看得见;名字标在刻线下方,最后一个右对齐,不出格。
 *
 * ── 无障碍 ──────────────────────────────────────────────────────────────
 * `role="meter"` + `aria-label`(**必填**,经 i18n)+ min / max / now;`valueText`
 * 给读屏一句人话(「1.7 GB」,而不是「1825361100」)。刻线的名字对读屏隐藏 —— 它们是
 * 画面上的参照,数在调用方自己的正文里说。
 */
export type MeterTone = 'accent' | 'warn' | 'danger'

export interface MeterTick {
  /** 在 [0, max] 里的位置。 */
  at: number
  label?: string
}

interface MeterProps {
  /** 当前量。**缺席 = 量不到**,不是 0。超过 `max` 的按满画。 */
  value?: number
  max: number
  label: string
  valueText?: string
  tone?: MeterTone
  size?: 'sm' | 'md'
  ticks?: readonly MeterTick[]
  className?: string
}

export function Meter({ value, max, label, valueText, tone = 'accent', size = 'md', ticks, className }: MeterProps) {
  const safeMax = max > 0 ? max : 1
  const ratio = value === undefined || !Number.isFinite(value) ? undefined : Math.min(1, Math.max(0, value / safeMax))
  const at = (x: number): string => `${Math.min(100, Math.max(0, (x / safeMax) * 100))}%`
  const labelled = ticks?.filter(tick => tick.label) ?? []
  return (
    <div
      className={[s.meter, size === 'sm' ? s.sm : '', className ?? ''].filter(Boolean).join(' ')}
      data-tone={tone}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(safeMax)}
      aria-valuenow={value === undefined ? undefined : Math.round(value)}
      aria-valuetext={value === undefined ? undefined : valueText}
    >
      <div className={s.track}>
        {ratio === undefined ? null : <div className={s.fill} style={{ width: `${ratio * 100}%` }} />}
        {ticks?.map(tick => <span key={tick.at} className={s.tick} style={{ left: at(tick.at) }} />)}
      </div>
      {labelled.length > 0 ? (
        <div className={s.scale} aria-hidden="true">
          {labelled.map(tick => (
            <span key={tick.at} className={s.tickLabel} style={{ left: at(tick.at) }}>{tick.label}</span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
