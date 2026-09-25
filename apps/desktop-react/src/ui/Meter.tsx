import s from './Meter.module.css'

/**
 * 量表(meter):显示一个数值在已知范围内的位置,例如内存占用与预算、缓存用量与上限。
 *
 * 与 `ui/Progress` 的区别:Progress 表示任务进度,会完成并消失;Meter 表示当前量,
 * 可以超过刻度,填满通常意味着需要注意。因此 ARIA 角色是 `meter`,填充色由调用方
 * 通过 `tone` 指定。
 *
 * - `tone`:`accent` / `warn` / `danger`,轨道使用同色的浅色;
 * - `size`:`md`(默认)/ `sm`,只影响粗细;
 * - `value` 未提供表示无法测量:只显示轨道,不设置 `aria-valuenow`;
 * - `ticks`:范围内的标记位置,可带标签,标签显示在刻度下方。
 *
 * 无障碍:`aria-label` 必填;`valueText` 提供可读的数值(如「1.7 GB」);刻度标签对读屏
 * 软件隐藏,相关数值应由调用方在正文中给出。
 */
export type MeterTone = 'accent' | 'warn' | 'danger'

export interface MeterTick {
  /** 位置,取值范围 [0, max]。 */
  at: number
  label?: string
}

interface MeterProps {
  /** 当前值;未提供表示无法测量。超过 `max` 时按满格显示。 */
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
