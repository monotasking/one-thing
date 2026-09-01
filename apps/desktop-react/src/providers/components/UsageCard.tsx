import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Spinner } from '../../ui/Spinner'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { formatMoment } from '../auth'
import type { CodexUsageLimit, CodexUsageWindow, ProviderUsageResponse } from '@shared/ipc/providers'
import type { SourceStatus } from '../store'
import s from './UsageCard.module.css'

/**
 * 订阅用量。**今天只有 Codex 真有数** —— 别家后端直接回 `unsupported: true`,
 * 那时这块整个不画(`usage[providerId] === null`)。「这家没有用量卡」是后端
 * 说的,不是这块面猜的,所以别家不会看到一张全是「—」的空卡。
 *
 * ── 一条纪律:拿不到的读数如实缺席 ────────────────────────────────────────
 * 百分比缺席就不画那根条,**不画 0%**。0% 是「一点没用」,缺席是「不知道」——
 * 在屏幕上长得像,在事实上差得远(设计稿第 8 帧脚注说的就是这件事)。
 *
 * 这块信息将来还要出现在输入框区域(交接稿 §6),所以它只吃一个
 * `ProviderUsageResponse`,不认识 store、不认识哪一坑 —— 换个地方挂就能用。
 */

export function UsageCard({
  usage,
  status,
  error,
  onRefresh,
}: {
  usage: ProviderUsageResponse
  status: SourceStatus
  error?: string
  onRefresh: () => void
}) {
  const t = useT()
  const loading = status === 'loading'
  const limits = usage.usage?.limits ?? []
  // 主限额:codex 那一条,没有就取第一条(与 Vue 壳 ProviderUsageCard.vue:135 同一手)。
  const main = limits.find((limit) => limit.id === 'codex') ?? limits[0]
  const extras = main ? limits.filter((limit) => limit.id !== main.id) : limits

  return (
    <Card>
      <div className={s.head}>
        <h3 className={s.title}>{t('providers.usage')}</h3>
        {/* 缓存寿命写在脸上:这一口是真去问服务商的,读数不是每次开面都新鲜。 */}
        <span className={s.cache}>{t('providers.usageCache')}</span>
        <Button size="sm" disabled={loading} onClick={onRefresh}>
          {loading ? <Spinner label={t('providers.usageRefresh')} /> : t('providers.usageRefresh')}
        </Button>
      </div>

      {status === 'error' && (
        <p className={s.error}>
          {t('providers.usageFailed')}
          {error ? ` · ${error}` : ''}
        </p>
      )}

      <div className={s.facts}>
        <Fact label={t('providers.usagePlan')} value={planOf(t, usage)} />
        <Fact label={t('providers.usageCredits')} value={creditsOf(t, usage)} />
      </div>

      {main?.primary && (
        <Meter
          t={t}
          label={t('providers.usageWindow', {
            name: t('providers.usagePrimary'),
            window: windowNameOf(main.primary),
          })}
          window={main.primary}
        />
      )}
      {main?.secondary && (
        <Meter
          t={t}
          label={t('providers.usageWindow', {
            name: t('providers.usageSecondary'),
            window: windowNameOf(main.secondary),
          })}
          window={main.secondary}
        />
      )}

      {extras.length > 0 && (
        <details className={s.more}>
          <summary className={s.summary}>
            {t('providers.usageMore', { count: extras.length })}
          </summary>
          {extras.map((limit) => (
            <ExtraLimit key={limit.id} t={t} limit={limit} />
          ))}
        </details>
      )}
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

/**
 * 一根用量条。**没有 `usedPercent` 就不画条** —— 一根 0 宽的条看起来是
 * 「用了 0%」,而事实是「不知道用了多少」。
 */
function Meter({ t, label, window }: { t: TFn; label: string; window: CodexUsageWindow }) {
  const percent = Number.isFinite(window.usedPercent) ? window.usedPercent : null
  const reset = resetMomentOf(window)
  return (
    <div className={s.meterRow}>
      <span className={s.meterLabel}>{label}</span>
      {percent === null ? (
        <span className={s.meterUnknown}>{t('providers.usageUnavailable')}</span>
      ) : (
        <>
          <span className={s.meterTrack}>
            <span
              className={s.meterFill}
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          </span>
          <span className={s.meterValue}>{`${Math.round(percent)}%`}</span>
        </>
      )}
      {reset && <span className={s.meterReset}>{t('providers.usageReset', { time: reset })}</span>}
    </div>
  )
}

function ExtraLimit({ t, limit }: { t: TFn; limit: CodexUsageLimit }) {
  return (
    <div className={s.extra}>
      <span className={s.meterLabel}>{limit.name || limit.id}</span>
      {limit.primary && <Meter t={t} label={windowNameOf(limit.primary)} window={limit.primary} />}
    </div>
  )
}

/** 「5h」「7d」。窗口长度是数据,秒数换成人读得动的那一档。 */
function windowNameOf(window: CodexUsageWindow): string {
  const seconds = window.windowSeconds
  if (!seconds || !Number.isFinite(seconds)) return '—'
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  return `${Math.round(seconds / 60)}m`
}

/**
 * 重置时刻。后端给绝对时间戳就用它,只给「还有多少秒」就现算 ——
 * 两格都没有就没有这句话,不编一个。
 */
function resetMomentOf(window: CodexUsageWindow): string | null {
  if (typeof window.resetAt === 'number') return formatMoment(window.resetAt)
  if (typeof window.resetAfterSeconds === 'number') {
    return formatMoment(Date.now() + window.resetAfterSeconds * 1000)
  }
  return null
}

/** 套餐。usage 上没有就退到 account 上那一份,都没有才说「未给数」。 */
function planOf(t: TFn, usage: ProviderUsageResponse): string {
  const plan = usage.usage?.planType || usage.account?.planType
  return plan ? plan : t('providers.usageUnavailable')
}

/** Credits 四态:没这一格 / 无限 / 有余额数 / 有没有额度。 */
function creditsOf(t: TFn, usage: ProviderUsageResponse): string {
  const credits = usage.usage?.credits
  if (!credits) return t('providers.usageUnavailable')
  if (credits.unlimited) return t('providers.usageUnlimited')
  if (credits.balance) return credits.balance
  return credits.hasCredits ? t('providers.usageHasCredits') : t('providers.usageNoCredits')
}
