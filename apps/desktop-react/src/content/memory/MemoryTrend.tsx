import { useState } from 'react'
import type { PointerEvent } from 'react'
import { formatBytes } from '../../format/quantity'
import { useT } from '../../i18n'
import type { MemoryReportResponse } from '@shared/ipc/memory'
import { nearestIndex, trendGeometry, type MemorySample } from './memory-model'
import s from './MemoryPanel.module.css'

/** SVG 坐标系为 1000 × 100,拉伸填满容器;线宽用 `non-scaling-stroke` 保持不变。 */
const W = 1000
const H = 100

/**
 * 最近几分钟的总占用曲线。纵轴不从 0 开始,因此只画线,不画面积(原因见 `trendGeometry`)。
 *
 * 右侧固定宽度的区域显示软 / 硬上限的名称和数值,不与曲线重叠。曲线末端的点表示当前值。
 * 鼠标悬停时显示最近数据点的数值与时间;当前值同时显示在概览卡片中,
 * 整段的最低 / 最高值写在图下方和 `aria-label` 中。
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
  const end = geometry.points[geometry.points.length - 1]
  const marker = point ?? end
  const last = history[history.length - 1].at
  const pct = (y: number): string => `${(y / H) * 100}%`

  return (
    <div className={s.trend}>
      <div className={s.trendFrame}>
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
            {point ? (
              <line className={s.trendCrosshair} x1={point.x} x2={point.x} y1={0} y2={H} vectorEffect="non-scaling-stroke" />
            ) : null}
            <path className={s.trendLine} d={geometry.line} vectorEffect="non-scaling-stroke" />
          </svg>
          <span
            className={s.trendDot}
            style={{ left: `${(marker.x / W) * 100}%`, top: pct(marker.y) }}
            aria-hidden="true"
          />
          {point ? (
            <div
              className={s.trendReadout}
              style={{ left: `${(point.x / W) * 100}%` }}
              data-flip={point.x > W * 0.6 ? 'left' : undefined}
              aria-hidden="true"
            >
              <strong>{formatBytes(point.sample.bytes)}</strong>
              <span>{agoText(t, last - point.sample.at)}</span>
            </div>
          ) : null}
        </div>
        {/* 软 / 硬上限的标签,与对应参考线同高。 */}
        <div className={s.trendGutter} aria-hidden="true">
          <span className={s.trendRuleLabel} style={{ top: pct(geometry.hardY) }}>
            {t('memory.hardLine')} <b>{formatBytes(budget.hardBytes)}</b>
          </span>
          <span className={s.trendRuleLabel} style={{ top: pct(geometry.softY) }}>
            {t('memory.softLine')} <b>{formatBytes(budget.softBytes)}</b>
          </span>
        </div>
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
