/**
 * DeepSeek 的余额源(§8.2)。公开文档接口:`GET <origin>/user/balance`,Bearer apiKey。
 *
 * 响应 `{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }`。
 * 取**第一条**(一个账号一种币种;真有两条时第一条是主币种),`currency` 照给(`CNY` / `USD`)。
 */
import type { ProviderQuota } from '@shared/contracts/quota.js'
import {
  getQuotaJson,
  quotaNow,
  quotaNumberOf,
  quotaOriginOf,
  quotaRecordOf,
  quotaStringOf,
  QuotaFetchError,
  type QuotaSource,
} from '../../quota/provider-quota-source.js'

export const DEEPSEEK_QUOTA_SOURCE_ID = 'deepseek'
const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com'

export function deepseekBalanceUrlOf(baseUrl: string | undefined): string {
  return `${quotaOriginOf(baseUrl, DEEPSEEK_DEFAULT_BASE_URL)}/user/balance`
}

export function normalizeDeepseekBalancePayload(payload: unknown, now: number): ProviderQuota {
  const infos = quotaRecordOf(payload).balance_infos
  const first = Array.isArray(infos) ? quotaRecordOf(infos[0]) : {}
  const available = quotaNumberOf(first.total_balance)
  if (available === undefined) {
    throw new QuotaFetchError('unknown', 'DeepSeek balance response carried no balance_infos')
  }
  const currency = quotaStringOf(first.currency)?.toUpperCase() === 'USD' ? 'USD' : 'CNY'
  return { kind: 'balance', currency, available, fetchedAt: now }
}

export const deepseekQuotaSource: QuotaSource = {
  id: DEEPSEEK_QUOTA_SOURCE_ID,
  async fetch(ctx) {
    if (!ctx.apiKey) throw new QuotaFetchError('auth', 'DeepSeek balance requires an API key')
    const payload = await getQuotaJson(
      ctx,
      deepseekBalanceUrlOf(ctx.baseUrl),
      { Authorization: `Bearer ${ctx.apiKey}` },
      'DeepSeek balance request failed:',
    )
    return normalizeDeepseekBalancePayload(payload, quotaNow(ctx))
  },
}
