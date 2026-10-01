/**
 * Codex(ChatGPT 订阅)的配额源 —— 主动一条、被动一条(§8.2)。
 *
 *  - **主动**:`GET <origin>/backend-api/wham/usage`,OAuth Bearer + Codex CLI 那一组头。
 *    这就是从前 `providers/codex.ts`(今 `vendors/codex/models.ts`)里的 `fetchOnethingCodexUsage`,整段搬进来,
 *    产出从 Codex 自己的形状换成通用的 `ProviderQuota`。
 *  - **被动**:Responses 流的响应头(`x-codex-primary-used-percent` 一族),由 codex 方言的
 *    `quotaFromHeaders` 读 —— 每发一条消息顺手刷新一次,零额外请求。
 *
 * **窗口按时长归类,不按 primary / secondary 位置**(`@shared/quota-windows.ts` 头上那段)。
 * 没报时长的窗口归不了类,丢掉 —— 按位置猜一个正是这一批要消灭的那种错。
 */
import type { ProviderQuota, ProviderQuotaBalance, ProviderQuotaWindow } from '@shared/contracts/quota.js'
import { buildOnethingCodexHeaders, ONETHING_CODEX_BASE_URL } from './models.js'
import { classifyQuotaWindowSeconds, quotaEpochMsOf, sortQuotaWindows } from '@shared/quota-windows.js'
import {
  getQuotaJson,
  quotaNow,
  quotaNumberOf,
  quotaOriginOf,
  quotaRecordOf,
  quotaStringOf,
  QuotaFetchError,
  type QuotaSource,
} from '../../quota/source.js'

export const CODEX_QUOTA_SOURCE_ID = 'codex'
export const CODEX_USAGE_PATH = '/backend-api/wham/usage'

/** 配额接口地址:跟着 codex 端点的 origin 走(默认 `https://chatgpt.com`)。 */
export function codexUsageUrlOf(baseUrl: string | undefined): string {
  return `${quotaOriginOf(baseUrl, ONETHING_CODEX_BASE_URL)}${CODEX_USAGE_PATH}`
}

interface RawWindowFacts {
  usedPercent?: number
  seconds?: number
  resetsAt?: number
}

function windowOf(facts: RawWindowFacts, label?: string, labelKey?: string): ProviderQuotaWindow | undefined {
  if (facts.usedPercent === undefined || facts.seconds === undefined) return undefined
  const cls = classifyQuotaWindowSeconds(facts.seconds)
  if (!cls) return undefined
  return {
    id: labelKey ? `${labelKey}:${cls}` : cls,
    seconds: facts.seconds,
    usedPercent: facts.usedPercent,
    ...(facts.resetsAt !== undefined ? { resetsAt: facts.resetsAt } : {}),
    ...(label ? { label } : {}),
  }
}

function payloadWindowFacts(raw: unknown, now: number): RawWindowFacts {
  const record = quotaRecordOf(raw)
  const usedPercent = quotaNumberOf(record.used_percent ?? record.usedPercent)
  const seconds = quotaNumberOf(
    record.limit_window_seconds ?? record.limitWindowSeconds ?? record.window_seconds ?? record.windowSeconds,
  )
  const resetAt = quotaEpochMsOf(record.reset_at ?? record.resetAt)
  const resetAfter = quotaNumberOf(record.reset_after_seconds ?? record.resetAfterSeconds)
  return {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
    ...(resetAt !== undefined
      ? { resetsAt: resetAt }
      : resetAfter !== undefined
        ? { resetsAt: now + resetAfter * 1000 }
        : {}),
  }
}

/** 同一个 id 出现两次(两窗同长):留用得多的那一窗 —— 离用尽更近的才是要紧的那个数。 */
function dedupeWindows(windows: ProviderQuotaWindow[]): ProviderQuotaWindow[] {
  const byId = new Map<string, ProviderQuotaWindow>()
  for (const window of windows) {
    const previous = byId.get(window.id)
    if (!previous || window.usedPercent > previous.usedPercent) byId.set(window.id, window)
  }
  return sortQuotaWindows([...byId.values()])
}

function rateLimitWindows(raw: unknown, now: number, label?: string, labelKey?: string): ProviderQuotaWindow[] {
  const rateLimit = quotaRecordOf(raw)
  return [rateLimit.primary_window ?? rateLimit.primaryWindow, rateLimit.secondary_window ?? rateLimit.secondaryWindow]
    .map(window => windowOf(payloadWindowFacts(window, now), label, labelKey))
    .filter((window): window is ProviderQuotaWindow => window !== undefined)
}

/** credits:有余额数且不是「无限」才出一条 balance。无限 / 没这一格 = 不出。 */
function creditsBalanceOf(raw: unknown): ProviderQuotaBalance | undefined {
  const credits = quotaRecordOf(raw)
  if (credits.unlimited === true) return undefined
  const available = quotaNumberOf(credits.balance)
  if (available === undefined) return undefined
  return { currency: 'credits', available }
}

/** `wham/usage` 的响应 → `ProviderQuota`。纯函数,夹具测试直接喂它。 */
export function normalizeCodexUsagePayload(payload: unknown, now: number): ProviderQuota {
  const record = quotaRecordOf(payload)
  const windows = rateLimitWindows(record.rate_limit ?? record.rateLimit, now)
  const additional = record.additional_rate_limits ?? record.additionalRateLimits
  if (Array.isArray(additional)) {
    for (const detail of additional) {
      const detailRecord = quotaRecordOf(detail)
      const key = quotaStringOf(detailRecord.metered_feature ?? detailRecord.meteredFeature ?? detailRecord.id)
      if (!key) continue
      const label = quotaStringOf(detailRecord.limit_name ?? detailRecord.limitName ?? detailRecord.name) ?? key
      windows.push(...rateLimitWindows(detailRecord.rate_limit ?? detailRecord.rateLimit, now, label, key))
    }
  }
  const plan = quotaStringOf(record.plan_type ?? record.planType)
  const balance = creditsBalanceOf(record.credits)
  if (windows.length === 0 && balance) {
    return { kind: 'balance', ...balance, fetchedAt: now }
  }
  return {
    kind: 'windows',
    windows: dedupeWindows(windows),
    ...(plan ? { plan } : {}),
    ...(balance ? { balance } : {}),
    fetchedAt: now,
  }
}

export const codexQuotaSource: QuotaSource = {
  id: CODEX_QUOTA_SOURCE_ID,
  async fetch(ctx) {
    if (!ctx.oauthToken?.accessToken) {
      throw new QuotaFetchError('auth', 'Codex usage requires a signed-in ChatGPT account')
    }
    const payload = await getQuotaJson(
      ctx,
      codexUsageUrlOf(ctx.baseUrl),
      buildOnethingCodexHeaders(ctx.oauthToken),
      'Codex usage request failed:',
    )
    return normalizeCodexUsagePayload(payload, quotaNow(ctx))
  },
}

/* ── 被动源:响应头 ───────────────────────────────────────────────────────── */

/**
 * Codex 后端在每条 Responses 响应上带的限额头。**一张表,不是散落的字符串**:字段名是
 * 以夹具为准的外部事实,改名只改这里。`reset-at`(绝对时刻)与 `reset-after-seconds`
 * (相对秒数)两种写法都见过,有前者用前者。
 */
export const CODEX_QUOTA_HEADERS = {
  windows: ['primary', 'secondary'] as const,
  usedPercent: (slot: string) => `x-codex-${slot}-used-percent`,
  windowMinutes: (slot: string) => `x-codex-${slot}-window-minutes`,
  resetAfterSeconds: (slot: string) => `x-codex-${slot}-reset-after-seconds`,
  resetAt: (slot: string) => `x-codex-${slot}-reset-at`,
  creditsHasCredits: 'x-codex-credits-has-credits',
  creditsUnlimited: 'x-codex-credits-unlimited',
  creditsBalance: 'x-codex-credits-balance',
} as const

/**
 * 响应头 → `ProviderQuota`。一窗都读不出来就答 `null`(这条响应不带限额信息,
 * 不是「配额为零」)。
 */
export function codexQuotaFromHeaders(headers: Headers, now: number = Date.now()): ProviderQuota | null {
  const windows: ProviderQuotaWindow[] = []
  for (const slot of CODEX_QUOTA_HEADERS.windows) {
    const usedPercent = quotaNumberOf(headers.get(CODEX_QUOTA_HEADERS.usedPercent(slot)))
    const minutes = quotaNumberOf(headers.get(CODEX_QUOTA_HEADERS.windowMinutes(slot)))
    const resetAt = quotaEpochMsOf(headers.get(CODEX_QUOTA_HEADERS.resetAt(slot)) ?? undefined)
    const resetAfter = quotaNumberOf(headers.get(CODEX_QUOTA_HEADERS.resetAfterSeconds(slot)))
    const window = windowOf({
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(minutes !== undefined ? { seconds: minutes * 60 } : {}),
      ...(resetAt !== undefined
        ? { resetsAt: resetAt }
        : resetAfter !== undefined
          ? { resetsAt: now + resetAfter * 1000 }
          : {}),
    })
    if (window) windows.push(window)
  }
  if (windows.length === 0) return null
  const unlimited = headers.get(CODEX_QUOTA_HEADERS.creditsUnlimited)?.trim().toLowerCase() === 'true'
  const balance = creditsBalanceOf({
    unlimited,
    balance: headers.get(CODEX_QUOTA_HEADERS.creditsBalance) ?? undefined,
  })
  return {
    kind: 'windows',
    windows: dedupeWindows(windows),
    ...(balance ? { balance } : {}),
    fetchedAt: now,
  }
}
