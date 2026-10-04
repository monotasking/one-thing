/**
 * OpenRouter 的余额源(§8.2)。`GET <origin>/api/v1/auth/key`,Bearer —— 普通密钥就能问
 * (`/credits` 疑要管理密钥,§11 留账,核过再换)。
 *
 * 响应 `{ data: { usage, limit, limit_remaining, is_free_tier, … } }`,单位 USD。
 * 余额 = `limit − usage`(有 `limit_remaining` 就用它,两者本是同一个数)。
 *
 * **`limit` 为 null** = 这把密钥没设额度上限:它能花到账户余额见底,而账户余额这条接口
 * 说不出来。`ProviderQuota` 的余额一支 `available` 必填,编一个数比不画更坏,所以答
 * `unsupported`,并在日志里记一行原因(卡片上改显本月本地估算)。
 */
import type { ProviderQuota } from '@shared/contracts/quota.js'
import { getLogger } from '../../../logging/logging.js'
import {
  getQuotaJson,
  quotaNow,
  quotaNumberOf,
  quotaOriginOf,
  quotaRecordOf,
  QuotaFetchError,
  type QuotaSource,
} from '../../quota/provider-quota-source.js'

const log = getLogger('providers.quota')

export const OPENROUTER_QUOTA_SOURCE_ID = 'openrouter'
const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

export function openrouterKeyUrlOf(baseUrl: string | undefined): string {
  return `${quotaOriginOf(baseUrl, OPENROUTER_DEFAULT_BASE_URL)}/api/v1/auth/key`
}

export function normalizeOpenRouterKeyPayload(payload: unknown, now: number): ProviderQuota {
  const data = quotaRecordOf(quotaRecordOf(payload).data)
  const limit = quotaNumberOf(data.limit)
  if (limit === undefined) {
    log.debug('openrouter key has no spending limit; balance unsupported', { hasUsage: data.usage !== undefined })
    return { kind: 'unsupported' }
  }
  const remaining = quotaNumberOf(data.limit_remaining)
  const usage = quotaNumberOf(data.usage) ?? 0
  const available = remaining ?? limit - usage
  return { kind: 'balance', currency: 'USD', available, granted: limit, fetchedAt: now }
}

export const openrouterQuotaSource: QuotaSource = {
  id: OPENROUTER_QUOTA_SOURCE_ID,
  async fetch(ctx) {
    if (!ctx.apiKey) throw new QuotaFetchError('auth', 'OpenRouter balance requires an API key')
    const payload = await getQuotaJson(
      ctx,
      openrouterKeyUrlOf(ctx.baseUrl),
      { Authorization: `Bearer ${ctx.apiKey}` },
      'OpenRouter key request failed:',
    )
    return normalizeOpenRouterKeyPayload(payload, quotaNow(ctx))
  },
}
