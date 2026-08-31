import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { useMeterView } from '../../data/meter-source'
import type { MeterView } from '../../data/meter-source'
import { formatCount, formatUsd, percent, ringDash, ringUnknownDash } from '../transitions'
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
 *
 * D2 波一起数是真的(`data/meter-source.ts`),并且多了一条同级的裁定:
 * **拿不到的数是缺席,不是 0**。窗口不知道时环画成一串点(不是一圈空环 ——
 * 那与 0% 长得一样);卡上那些算不出来的行直接不出现。
 */
export function ContextRing({ onEnter, onLeave }: { onEnter: () => void; onLeave: () => void }) {
  const t = useT()
  const view = useMeterView()
  const pct =
    view.contextUsed === null || view.contextMax === null
      ? null
      : percent(view.contextUsed, view.contextMax)

  return (
    <span
      className={s.ctxRing}
      /* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex --
       * 刻意的。这个圆环是「悬停出读数明细」的那个把手,role="img" 说的是它**画的是什么**
       * (一圈用量),tabIndex=0 给的是**键盘用户同样的那一眼**(onFocus/onBlur 与
       * onMouseEnter/onMouseLeave 一一对应)。规则说非交互元素不该可 tab —— 一般对,
       * 但那正好会把键盘用户唯一的入口拆掉。不改成 role="button":它不执行任何动作,
       * 报成按钮是对读屏软件说谎。 */
      tabIndex={0}
      role="img"
      /* 读屏软件听见的也得是实话:不知道用量时说的是「未知」,不是「0%」。 */
      aria-label={pct === null ? t('composer.contextUnknown') : t('composer.context')}
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
          /* 缺席态:底圈画成点线。有读数时给 undefined = 实线整圈。 */
          strokeDasharray={pct === null ? ringUnknownDash(RING_R) : undefined}
        />
        {pct !== null && (
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
        )}
      </svg>
    </span>
  )
}

/** 卡上的一行。`dim` = 这一行说的是「不知道」,灰置。 */
interface MeterRow {
  key: string
  value: string
  ok?: boolean
  dim?: boolean
}

/**
 * 六格事实 → 卡上的行。**算不出来的行不出现**,只有两种例外各出一行诚实的话:
 *  - 整份读数缺席(草稿态 / 两口都没答上话)→ 一行「还没有读数」;
 *  - 用量有、窗口不知道 → 上下文那行只写用量,并说明窗口未知。
 */
export function meterRowsOf(view: MeterView, t: TFn): MeterRow[] {
  if (!view.present) return [{ key: t('meter.context'), value: t('meter.empty'), dim: true }]

  const rows: MeterRow[] = []

  if (view.contextUsed !== null) {
    const pct = view.contextMax === null ? null : percent(view.contextUsed, view.contextMax)
    rows.push(
      pct === null
        ? {
            key: t('meter.context'),
            value: t('meter.contextNoWindow', { used: formatCount(view.contextUsed) }),
            dim: true,
          }
        : {
            key: t('meter.context'),
            value: t('meter.contextValue', {
              used: formatCount(view.contextUsed),
              max: formatCount(view.contextMax ?? 0),
              pct,
            }),
          },
    )
  }

  if (view.tokensIn !== null || view.tokensOut !== null) {
    rows.push({
      key: t('meter.tokens'),
      value: t('meter.tokensValue', {
        sent: formatCount(view.tokensIn ?? 0),
        received: formatCount(view.tokensOut ?? 0),
      }),
    })
  }

  if (view.costUsd !== null) {
    rows.push({ key: t('meter.cost'), value: t('meter.costValue', { cost: formatUsd(view.costUsd) }) })
  }

  // 厂商报价与本地估算**并存**:报了才多这一行,永不替换上面那一行。
  if (view.providerCostUsd !== null) {
    rows.push({
      key: t('meter.costProvider'),
      value: t('meter.costValue', { cost: formatUsd(view.providerCostUsd) }),
    })
  }

  if (view.cacheHitPct !== null) {
    rows.push({
      key: t('meter.cache'),
      value: t('meter.cacheValue', { pct: view.cacheHitPct }),
      ok: true,
    })
  }

  return rows
}

export function MeterCard({ open }: { open: boolean }) {
  const t = useT()
  const view = useMeterView()
  const rows = meterRowsOf(view, t)

  return (
    <div className={open ? `${s.meterCard} ${s.meterOn}` : s.meterCard}>
      {rows.map((r) => (
        <div key={r.key} className={s.meterRow}>
          <span className={s.meterKey}>{r.key}</span>
          <span
            className={
              r.dim
                ? `${s.meterVal} ${s.meterDim}`
                : r.ok
                  ? `${s.meterVal} ${s.meterOk}`
                  : s.meterVal
            }
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  )
}
