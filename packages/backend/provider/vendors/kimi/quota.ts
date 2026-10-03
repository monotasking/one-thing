/**
 * Kimi(Moonshot 国际站)的余额源(§8.2)。`GET https://api.moonshot.ai/v1/users/me/balance`,Bearer。
 *
 * 响应 `{ code, data: { available_balance, voucher_balance, cash_balance }, status }`,
 * `available_balance` 是能花的那一格(现金 + 代金券),币种 USD。
 *
 * **只开国际站**:官方文档写这条接口只支持 `.ai`;国内站(`.cn`,人民币)待真机核
 * (§11 留账),核过之前答 `unsupported` —— 拿国际站的形状去读国内站,币种就是编的。
 * 编程套餐(`api.kimi.com/coding`)没有余额这回事,同样 `unsupported`。
 */
import type { ProviderQuota } from '@shared/contracts/quota.js'
import { resolveOnethingKimiBaseUrl, type OnethingKimiEndpointConfig } from './endpoint.js'
import {
  getQuotaJson,
  quotaNow,
  quotaNumberOf,
  quotaRecordOf,
  QuotaFetchError,
  type QuotaSource,
} from '../../quota/source.js'

export const KIMI_QUOTA_SOURCE_ID = 'kimi'
const KIMI_INTL_HOST = 'api.moonshot.ai'

/**
 * 这条凭证生效的端点 → 余额接口地址;不是国际站就答 `undefined`(= unsupported)。
 * 用户手填的端点只要不是认得的三个之一就原样用(与发送路 `resolveOnethingKimiBaseUrl` 同判据),
 * 于是门可以把它指到本地假站上。
 */
export function kimiBalanceUrlOf(
  baseUrl: string | undefined,
  config?: Readonly<Record<string, unknown>>,
): string | undefined {
  const endpoint = resolveOnethingKimiBaseUrl({
    ...(config as OnethingKimiEndpointConfig | undefined),
    ...(baseUrl ? { baseUrl } : {}),
  })
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return undefined
  }
  if (url.hostname.endsWith('.cn') || url.hostname === 'api.kimi.com') return undefined
  // 国际站本尊或用户自填的中转 / 假站:都按国际站的路径问。
  if (url.hostname !== KIMI_INTL_HOST && !baseUrl) return undefined
  return `${url.origin}/v1/users/me/balance`
}

export function normalizeKimiBalancePayload(payload: unknown, now: number): ProviderQuota {
  const data = quotaRecordOf(quotaRecordOf(payload).data)
  const available = quotaNumberOf(data.available_balance)
  if (available === undefined) {
    throw new QuotaFetchError('unknown', 'Kimi balance response carried no available_balance')
  }
  return { kind: 'balance', currency: 'USD', available, fetchedAt: now }
}

export const kimiQuotaSource: QuotaSource = {
  id: KIMI_QUOTA_SOURCE_ID,
  async fetch(ctx) {
    const url = kimiBalanceUrlOf(ctx.baseUrl, ctx.config)
    if (!url) return { kind: 'unsupported' }
    if (!ctx.apiKey) throw new QuotaFetchError('auth', 'Kimi balance requires an API key')
    const payload = await getQuotaJson(ctx, url, { Authorization: `Bearer ${ctx.apiKey}` }, 'Kimi balance request failed:')
    return normalizeKimiBalancePayload(payload, quotaNow(ctx))
  },
}
