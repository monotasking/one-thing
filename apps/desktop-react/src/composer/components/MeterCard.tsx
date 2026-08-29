import { useT } from '../../i18n'
import { MOCK_METER } from '../data'
import { formatCount, percent, ringDash } from '../transitions'
import s from './Composer.module.css'

/** 圆环的几何:与 --ctx-ring / --ctx-ring-w 是同一份事实(SVG 的 r 算不了 var())。 */
const RING_BOX = 18
const RING_R = 7
const RING_W = 2.6

/**
 * context 圆环 + 悬停出来的读数明细卡。
 *
 * 两条设计裁定照搬:**裸数不许要人猜**(所以卡里每一行都带完整标签),
 * **money 不常显**(所以花费只在这张卡里,环上永远只有一圈)。
 * 数来自 data.ts 的 MOCK_METER —— 接遥测账本时换那里,这个文件不动。
 */
export function ContextRing({ onEnter, onLeave }: { onEnter: () => void; onLeave: () => void }) {
  const t = useT()
  const pct = percent(MOCK_METER.contextUsed, MOCK_METER.contextMax)

  return (
    <span
      className={s.ctxRing}
      tabIndex={0}
      role="img"
      aria-label={t('composer.context')}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
    >
      <svg
        width={RING_BOX}
        height={RING_BOX}
        viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
        style={{ transform: 'rotate(-90deg)' }}
        aria-hidden="true"
      >
        <circle
          cx={RING_BOX / 2}
          cy={RING_BOX / 2}
          r={RING_R}
          fill="none"
          stroke="var(--line-1)"
          strokeWidth={RING_W}
        />
        <circle
          cx={RING_BOX / 2}
          cy={RING_BOX / 2}
          r={RING_R}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={RING_W}
          strokeLinecap="round"
          strokeDasharray={ringDash(pct, RING_R)}
        />
      </svg>
    </span>
  )
}

export function MeterCard({ open }: { open: boolean }) {
  const t = useT()
  const m = MOCK_METER
  const rows: { key: string; value: string; ok?: boolean }[] = [
    {
      key: t('meter.context'),
      value: t('meter.contextValue', {
        used: formatCount(m.contextUsed),
        max: formatCount(m.contextMax),
        pct: percent(m.contextUsed, m.contextMax),
      }),
    },
    {
      key: t('meter.tokens'),
      value: t('meter.tokensValue', {
        sent: formatCount(m.tokensIn),
        received: formatCount(m.tokensOut),
      }),
    },
    { key: t('meter.cost'), value: t('meter.costValue', { cost: m.costUsd.toFixed(2) }) },
    {
      key: t('meter.cache'),
      value: t('meter.cacheValue', { pct: m.cacheHitPct, saved: m.cacheSavedUsd.toFixed(2) }),
      ok: true,
    },
  ]

  return (
    <div className={open ? `${s.meterCard} ${s.meterOn}` : s.meterCard}>
      {rows.map((r) => (
        <div key={r.key} className={s.meterRow}>
          <span className={s.meterKey}>{r.key}</span>
          <span className={r.ok ? `${s.meterVal} ${s.meterOk}` : s.meterVal}>{r.value}</span>
        </div>
      ))}
    </div>
  )
}
