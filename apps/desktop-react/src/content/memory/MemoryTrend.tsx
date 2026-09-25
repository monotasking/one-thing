import { useState } from 'react'
import type { PointerEvent } from 'react'
import { formatBytes } from '../../format/quantity'
import { useT } from '../../i18n'
import type { MemoryReportResponse } from '@shared/ipc/memory'
import { nearestIndex, trendGeometry, type MemorySample } from './memory-model'
import s from './MemoryPanel.module.css'

/** 画布坐标系:宽 1000 × 高 100,`preserveAspectRatio="none"` 拉满格子;线宽靠 `non-scaling-stroke` 保 2px。 */
const W = 1000
const H = 100

/**
 * 最近几分钟的总量。单一系列、**只有线**(纵轴不从 0 起,判词在 `trendGeometry`);
 * soft / hard 两根发丝线是参照,不是系列,所以不进图例,名字与数值直接标在左端 ——
 * 最新的数据在右端,标签放左边才不压着它。
 *
 * 悬停:十字线吸附到最近的点,读数「值在前、时间在后」。读数不是唯一的出口 ——
 * 此刻的值就在上面的大数字里,整段的最低 / 最高在 `aria-label` 与图下那一行里。
 */
export function MemoryTrend({ history, budget }: { history: readonly MemorySample[]; budget: MemoryReportResponse['budget'] }) {
  const t = useT()
  const [hover, setHover] = useState<number | undefined>(undefined)
  const geometry = trendGeometry(history, budget, W, H)

  if (!geometry) {
    return <p className={s.trendEmpty}>{t('memory.trendWarming')}</p>
  }

  const values = history.map(sample => sample.bytes)
  const low = Math.min(...values)
  const high = Math.max(...values)
  const spanMs = history[history.length - 1].at - history[0].at
  const minutes = Math.max(1, Math.round(spanMs / 60_000))
  const summary = t('memory.trendSummary', { minutes, low: formatBytes(low), high: formatBytes(high) })

  const onMove = (event: PointerEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const x = ((event.clientX - rect.left) / rect.width) * W
    setHover(nearestIndex(geometry.points.map(point => point.x), x))
  }

  const point = hover === undefined ? undefined : geometry.points[hover]
  const last = history[history.length - 1].at

  return (
    <div className={s.trend}>
      <div className={s.trendPlot}>
        <svg
          className={s.trendSvg}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={summary}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(undefined)}
        >
          <line className={s.trendRuleHard} x1={0} x2={W} y1={geometry.hardY} y2={geometry.hardY} vectorEffect="non-scaling-stroke" />
          <line className={s.trendRuleSoft} x1={0} x2={W} y1={geometry.softY} y2={geometry.softY} vectorEffect="non-scaling-stroke" />
          <path className={s.trendLine} d={geometry.line} vectorEffect="non-scaling-stroke" />
          {point ? (
            <line className={s.trendCrosshair} x1={point.x} x2={point.x} y1={0} y2={H} vectorEffect="non-scaling-stroke" />
          ) : null}
        </svg>
        {/* 参照线的名字标在左端,不进图例(它们不是系列)。百分比定位 = 与画布同一套坐标。 */}
        <span className={s.trendRuleLabel} style={{ top: `${(geometry.hardY / H) * 100}%` }} aria-hidden="true">
          hard {formatBytes(budget.hardBytes)}
        </span>
        <span className={s.trendRuleLabel} style={{ top: `${(geometry.softY / H) * 100}%` }} aria-hidden="true">
          soft {formatBytes(budget.softBytes)}
        </span>
        {point ? (
          <>
            <span
              className={s.trendDot}
              style={{ left: `${(point.x / W) * 100}%`, top: `${(point.y / H) * 100}%` }}
              aria-hidden="true"
            />
            <div
              className={s.trendReadout}
              style={{ left: `${(point.x / W) * 100}%` }}
              data-flip={point.x > W * 0.7 ? 'left' : undefined}
              aria-hidden="true"
            >
              <strong>{formatBytes(point.sample.bytes)}</strong>
              <span>{agoText(t, last - point.sample.at)}</span>
            </div>
          </>
        ) : null}
      </div>
      <p className={s.trendCaption}>{summary}</p>
    </div>
  )
}

function agoText(t: ReturnType<typeof useT>, ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 2) return t('memory.agoNow')
  if (seconds < 60) return t('memory.agoSeconds', { count: seconds })
  return t('memory.agoMinutes', { count: Math.round(seconds / 60) })
}
