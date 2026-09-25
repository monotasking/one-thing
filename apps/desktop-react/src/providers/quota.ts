import type {
  ProviderQuota,
  ProviderQuotaBalance,
  ProviderQuotaWindow,
} from '@shared/contracts/quota'
import {
  QUOTA_WINDOW_5H,
  QUOTA_WINDOW_7D,
  classifyQuotaWindowSeconds,
  quotaWindowDaysOf,
} from '@onething/runtime/providers/quota/classify-windows'
import type { MessageKey, TFn } from '../i18n'

/**
 * 配额的**读法**(批 5 §8.4 / §8.5)—— composer 读数卡与设置页共用这一份,
 * 两处画的是同一件事,措辞也就只许有一处产地。纯函数,不认 store、不认端口。
 *
 * 一条纪律照旧:**拿不到的数是缺席**。窗口没有重置时刻就不写「重置」那半句;
 * 服务商不支持就不画配额行(改画本月本地估算)。
 */

/** 「5 小时」「本周」「30 天」;附加窗口前面带它的名字(「Sonnet 本周」)。 */
export function quotaWindowName(t: TFn, window: ProviderQuotaWindow): string {
  const cls = classifyQuotaWindowSeconds(window.seconds)
  const base =
    cls === QUOTA_WINDOW_5H
      ? t('meter.quotaWindow5h')
      : cls === QUOTA_WINDOW_7D
        ? t('meter.quotaWindow7d')
        : cls
          ? t('meter.quotaWindowDays', { n: quotaWindowDaysOf(cls) ?? Math.round(window.seconds / 86_400) })
          : ''
  return window.label ? `${window.label} ${base}`.trim() : base
}

const WEEKDAY_KEYS: readonly MessageKey[] = [
  'meter.weekday0',
  'meter.weekday1',
  'meter.weekday2',
  'meter.weekday3',
  'meter.weekday4',
  'meter.weekday5',
  'meter.weekday6',
]

const two = (n: number) => String(n).padStart(2, '0')

/**
 * 重置时刻的人话:今天 →「14:30」;一周以内 →「周一 08:00」;更远 →「10-03 08:00」。
 * 本机时区(用户看的是自己的钟)。
 */
export function quotaResetText(t: TFn, resetsAt: number, now: number = Date.now()): string {
  const at = new Date(resetsAt)
  const clock = `${two(at.getHours())}:${two(at.getMinutes())}`
  const today = new Date(now)
  const sameDay =
    at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
  if (sameDay) return clock
  if (resetsAt > now && resetsAt - now < 6.5 * 86_400_000) return `${t(WEEKDAY_KEYS[at.getDay()])} ${clock}`
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${clock}`
}

/** 「62%」—— 小数压成整数;略超 100 照写(服务商允许透支一点,那是真话)。 */
export function quotaPercentText(window: ProviderQuotaWindow): string {
  return String(Math.round(window.usedPercent))
}

/** 「¥123.45」「$4.12」「12.5 点」。币种符号按 currency。 */
export function quotaAmountText(t: TFn, balance: Pick<ProviderQuotaBalance, 'currency' | 'available'>): string {
  const amount = balance.available.toFixed(2)
  if (balance.currency === 'CNY') return `¥${amount}`
  if (balance.currency === 'USD') return `$${amount}`
  return t('meter.quotaCredits', { amount })
}

/** 一份配额里「有数的窗口」(按短窗在前排好的,后端已排)。 */
export function quotaWindowsOf(quota: ProviderQuota | null | undefined): ProviderQuotaWindow[] {
  return quota?.kind === 'windows' ? quota.windows.filter((w) => Number.isFinite(w.usedPercent)) : []
}

/** 一份配额里的余额(余额一支本身,或窗口一支附带的 credits)。 */
export function quotaBalanceOf(quota: ProviderQuota | null | undefined): ProviderQuotaBalance | null {
  if (quota?.kind === 'balance') return { currency: quota.currency, available: quota.available }
  if (quota?.kind === 'windows' && quota.balance) return quota.balance
  return null
}

/** 余额警示线:¥10 / $2(点数不设线 —— 不知道一「点」值多少)。 */
const LOW_BALANCE: Partial<Record<ProviderQuotaBalance['currency'], number>> = { CNY: 10, USD: 2 }
/** 窗口警示线:最紧的那一窗 ≥ 80%。 */
export const QUOTA_WARN_PERCENT = 80

/**
 * 圆环要不要换警示底色(§8.4):最紧的窗口 ≥ 80%,或余额低于 ¥10 / $2。
 * 失败 / 不支持 / 取数中都不警示 —— 警示色说的是「快用完了」,不是「不知道」。
 */
export function quotaWarns(quota: ProviderQuota | null | undefined): boolean {
  if (quotaWindowsOf(quota).some((w) => w.usedPercent >= QUOTA_WARN_PERCENT)) return true
  const balance = quotaBalanceOf(quota)
  if (!balance) return false
  const floor = LOW_BALANCE[balance.currency]
  return floor !== undefined && balance.available < floor
}
