/**
 * 配额源的形状与几件共用的小工具(§8.2)。叶子模块:五个源与注册表都 import 它,不成环。
 */
import type { ProviderQuota, ProviderQuotaErrorReason } from '@shared/contracts/quota.js'

export type QuotaFetchFn = typeof globalThis.fetch

/** 订阅账号的令牌里,配额接口要读的那几格。 */
export interface QuotaOAuthToken {
  accessToken: string
  accountId?: string
  isFedrampAccount?: boolean
}

/**
 * 一次取数的全部输入。**凭证由调用方(装配层的 `QuotaService`)从池里取好递进来** ——
 * 源不认识空间、不认识池、也不自己刷新令牌。
 */
export interface QuotaFetchContext {
  /** API 型凭证。 */
  apiKey?: string
  /** 订阅型凭证(已刷新好的)。 */
  oauthToken?: QuotaOAuthToken
  /**
   * 这条凭证 / 这家服务商生效的端点。源按它推出自己的配额接口地址(DeepSeek 的
   * `/user/balance`、Codex 的 `/backend-api/wham/usage`)—— 用户把端点指到中转站时,
   * 配额也跟着问那一台;门也是经这一格把请求指到本地假站上的。缺席 = 源自己的默认。
   */
  baseUrl?: string
  /**
   * 生效的那一份 provider 配置(凭证条目的档位 / 地区已经盖上去了)。只有「配额接口
   * 地址取决于档位」的家读它(Kimi:国内站 / 海外站 / 编程套餐)。
   */
  config?: Readonly<Record<string, unknown>>
  /** 托管 fetch(走代理与超时)。 */
  fetchImpl: QuotaFetchFn
  signal?: AbortSignal
  now?: () => number
}

export interface QuotaSource {
  /** 注册表里的 id;manifest 的 `quotaSource` 指向它。 */
  readonly id: string
  fetch(ctx: QuotaFetchContext): Promise<ProviderQuota>
}

/**
 * 源抛出的「服务商说不」。带归因(`reason`),`fetchProviderQuota` 把它原样落成
 * `{kind:'error'}`;其余异常一律按网络 / 未知处理。
 */
export class QuotaFetchError extends Error {
  constructor(
    readonly reason: ProviderQuotaErrorReason,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'QuotaFetchError'
  }
}

/** HTTP 状态 → 归因。401/403 是凭证的事;429 是「问太勤了」;其余是服务商那头的事。 */
export function quotaErrorReasonOfStatus(status: number): ProviderQuotaErrorReason {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'network'
  return 'unknown'
}

/** 错误体 → 一句给人看的话(截到 200 字,**永不含请求头**:请求头根本不在这里)。 */
export function quotaErrorDetailOf(body: string): string {
  if (!body) return ''
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const error = parsed.error
    const message =
      (typeof parsed.detail === 'string' && parsed.detail) ||
      (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
        ? (error as Record<string, unknown>).message as string
        : undefined) ||
      (typeof parsed.message === 'string' && parsed.message) ||
      (typeof error === 'string' && error)
    if (message) return message.slice(0, 200)
  } catch {
    // 不是 JSON:落到下面的纯文本预览。
  }
  return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * 发一次 GET、读 JSON。非 2xx 抛 `QuotaFetchError`(带归因与服务商原话)。
 * `label` 进错误句开头,让「哪一家的哪个接口」一眼可见。
 */
export async function getQuotaJson(
  ctx: QuotaFetchContext,
  url: string,
  headers: Record<string, string>,
  label: string,
): Promise<unknown> {
  const response = await ctx.fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...headers },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const detail = quotaErrorDetailOf(body)
    throw new QuotaFetchError(
      quotaErrorReasonOfStatus(response.status),
      `${label} ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
    )
  }
  return response.json()
}

export function quotaRecordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function quotaNumberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function quotaStringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 端点去尾斜杠;空 / 全空白 = 缺席。 */
export function quotaBaseOf(baseUrl: string | undefined, fallback: string): string {
  const trimmed = baseUrl?.trim()
  return (trimmed || fallback).replace(/\/+$/, '')
}

/** 端点的 origin(`https://host[:port]`)。解析不了就退回默认那一个的 origin。 */
export function quotaOriginOf(baseUrl: string | undefined, fallback: string): string {
  try {
    return new URL(quotaBaseOf(baseUrl, fallback)).origin
  } catch {
    return new URL(fallback).origin
  }
}

export function quotaNow(ctx: Pick<QuotaFetchContext, 'now'>): number {
  return ctx.now?.() ?? Date.now()
}
