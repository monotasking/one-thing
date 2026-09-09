import { useShallow } from 'zustand/react/shallow'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { useMeterSource, useMeterView } from '../../data/meter-source'
import type { MeterView } from '../../data/meter-source'
import { useChatSourceOf } from '../../data/chat-source'
import { selectCompactingReadout } from '../../content/compact/marker'
import type { CompactingReadout } from '../../content/compact/marker'
import { formatQuantity } from '../../format/quantity'
import { formatUsd, percent, ringDash, ringUnknownDash } from '../transitions'
import s from './Composer.module.css'

/** 圆环的几何:与 --ctx-ring / --ctx-ring-w 是同一份事实(SVG 的 r 算不了 var())。 */
const RING_BOX = 18
const RING_R = 7
const RING_W = 2.6

/**
 * **「这条会话此刻在压缩吗」的订阅口。**
 *
 * 判据一个字都不在这里 —— 它在 `content/compact/marker.ts`(账本上最新一条压缩
 * 标记的 status)。这只 hook 做的只有两件:问的是**读数自己开着的那条会话**
 * (与 `useMeterView` 同源,不就地再读一次总览 —— 那会多一条会漂的读法),
 * 以及用 `useShallow` 把那份**扁平**读数变成可比的快照(三个原始值,一次订阅)。
 */
function useCompacting(): CompactingReadout {
  const sessionId = useMeterSource((st) => st.sessionId)
  return useChatSourceOf(sessionId, useShallow(selectCompactingReadout))
}

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
  const compacting = useCompacting()
  const pct =
    view.contextUsed === null || view.contextMax === null
      ? null
      : percent(view.contextUsed, view.contextMax)

  return (
    <span
      className={s.ctxRing}
      /* 压缩中:弧脉动(皮肤在 CSS 里,这里只说事实)。压完 / 失败这一格自己消失 ——
       * 判据是账本上那条 marker 的 status,不需要谁来「关掉」它。 */
      data-compacting={compacting.on ? '' : undefined}
      /* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex --
       * 刻意的。这个圆环是「悬停出读数明细」的那个把手,role="img" 说的是它**画的是什么**
       * (一圈用量),tabIndex=0 给的是**键盘用户同样的那一眼**(onFocus/onBlur 与
       * onMouseEnter/onMouseLeave 一一对应)。规则说非交互元素不该可 tab —— 一般对,
       * 但那正好会把键盘用户唯一的入口拆掉。不改成 role="button":它不执行任何动作,
       * 报成按钮是对读屏软件说谎。 */
      tabIndex={0}
      role="img"
      /* 读屏软件听见的也得是实话:不知道用量时说的是「未知」,不是「0%」;
       * 压缩中那一句也要说出来 —— 脉动是给眼睛看的,读屏软件得听见同一件事。 */
      aria-label={
        compacting.on
          ? pct === null
            ? t('composer.contextUnknownCompacting')
            : t('composer.contextCompacting')
          : pct === null
            ? t('composer.contextUnknown')
            : t('composer.context')
      }
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
            /* 弧自己有一份皮肤:读数变化时 dasharray 滑过去(不再跳变),
             * 压缩中脉动。两条都在 `.ctxArc` / `[data-compacting] .ctxArc` 里。 */
            className={s.ctxArc}
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
 *
 * 压缩中多**一行**,排在最前面:它说的是「下面这些数马上要变」,
 * 是一件正在发生的事,不是第七格读数。不在压缩时这一行连同它的判据一起不存在
 * (`compacting` 缺省 = 没人问过压缩这件事,例如 `meterRowsOf` 的既有调用方)。
 */
export function meterRowsOf(view: MeterView, t: TFn, compacting?: CompactingReadout): MeterRow[] {
  const compactRow: MeterRow[] = compacting?.on
    ? [{
        key: t('meter.compact'),
        // k/N 只有多块压缩才有(后端单块不写 progress)—— 编一个「1 / 1」是撒谎。
        value: compacting.totalChunks > 0
          ? t('meter.compactingProgress', { chunk: compacting.chunk, total: compacting.totalChunks })
          : t('meter.compacting'),
      }]
    : []

  if (!view.present) {
    return [...compactRow, { key: t('meter.context'), value: t('meter.empty'), dim: true }]
  }

  const rows: MeterRow[] = [...compactRow]

  if (view.contextUsed !== null) {
    const pct = view.contextMax === null ? null : percent(view.contextUsed, view.contextMax)
    rows.push(
      pct === null
        ? {
            key: t('meter.context'),
            value: t('meter.contextNoWindow', { used: formatQuantity(view.contextUsed) }),
            dim: true,
          }
        : {
            key: t('meter.context'),
            value: t('meter.contextValue', {
              used: formatQuantity(view.contextUsed),
              max: formatQuantity(view.contextMax ?? 0),
              pct,
            }),
          },
    )
  }

  if (view.tokensIn !== null || view.tokensOut !== null) {
    rows.push({
      key: t('meter.tokens'),
      value: t('meter.tokensValue', {
        sent: formatQuantity(view.tokensIn ?? 0),
        received: formatQuantity(view.tokensOut ?? 0),
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
  const rows = meterRowsOf(view, t, useCompacting())

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
