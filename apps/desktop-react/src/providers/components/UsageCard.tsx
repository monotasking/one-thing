import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Spinner } from '../../ui/Spinner'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import type { ProviderQuota, ProviderQuotaWindow } from '@shared/contracts/quota'
import type { SourceStatus } from '../store'
import { quotaAmountText, quotaBalanceOf, quotaResetText, quotaWindowName, quotaWindowsOf } from '../quota'
import s from './UsageCard.module.css'

/**
 * 订阅用量(批 5 §8.5 起读通用的 `ProviderQuota`)。**有配额源的家才有这张卡** ——
 * 后端答 `unsupported` 时那一格是 `null`,卡整块不画;「这家没有用量卡」是后端说的,
 * 不是这块面猜的。窗口按时长命名(「5 小时」「本周」),不再是 Primary / Secondary ——
 * 同一个位置在不同套餐里装的是不同的窗。
 *
 * ── 一条纪律:拿不到的读数如实缺席 ────────────────────────────────────────
 * 没有窗口就不画条,**不画 0%**。0% 是「一点没用」,缺席是「不知道」。
 *
 * 多账号时每个账号一张(`account` 给标题);卡只吃一份 `ProviderQuota`,不认 store。
 */
export function UsageCard({
  quota,
  account,
  status,
  error,
  onRefresh,
}: {
  quota: ProviderQuota
  /** 多账号时这一张属于哪个账号(标题里说);单账号不给。 */
  account?: string
  status: SourceStatus
  error?: string
  onRefresh: () => void
}) {
  const t = useT()
  const loading = status === 'loading'
  const windows = quotaWindowsOf(quota)
  const balance = quotaBalanceOf(quota)
  const plan = quota.kind === 'windows' ? quota.plan : undefined
  const failed = status === 'error' || quota.kind === 'error'
  const failure = error || (quota.kind === 'error' ? quota.message : '')

  return (
    <Card
      title={account ? t('providers.usageFor', { account }) : t('providers.usage')}
      actions={
        /* ui-consume-allow: spinner-placement — 它在这颗「刷新」钮的 children 里:
           忙时整颗钮换成转圈 + disabled(律③)。允许位「按钮内」。 */
        <Button size="sm" disabled={loading} onClick={onRefresh}>
          {loading ? <Spinner label={t('providers.usageRefresh')} /> : t('providers.usageRefresh')}
        </Button>
      }
    >
      {failed && (
        <p className={s.error}>
          {t('providers.usageFailed')}
          {failure ? ` · ${failure}` : ''}
        </p>
      )}

      {(plan || balance) && (
        <div className={s.facts}>
          {plan && <Fact label={t('providers.usagePlan')} value={plan} />}
          {balance && (
            <Fact
              label={balance.currency === 'credits' ? t('providers.usageCredits') : t('providers.usageBalance')}
              value={quotaAmountText(t, balance)}
            />
          )}
        </div>
      )}

      {windows.map((window) => (
        <Meter key={window.id} t={t} window={window} />
      ))}
    </Card>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className={s.fact}>
      <span className={s.factLabel}>{label}</span>
      <span className={s.factValue}>{value}</span>
    </span>
  )
}

/** 一根用量条:名(「5 小时」)/ 轨 / 百分比 / 重置时刻(给了才有)。 */
function Meter({ t, window }: { t: TFn; window: ProviderQuotaWindow }) {
  const reset = window.resetsAt !== undefined ? quotaResetText(t, window.resetsAt) : null
  return (
    <div className={s.meterRow}>
      <span className={s.meterLabel}>{quotaWindowName(t, window)}</span>
      <span className={s.meterTrack}>
        <span className={s.meterFill} style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} />
      </span>
      <span className={s.meterValue}>{`${Math.round(window.usedPercent)}%`}</span>
      {reset && <span className={s.meterReset}>{t('providers.usageReset', { time: reset })}</span>}
    </div>
  )
}
