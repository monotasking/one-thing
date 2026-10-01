/**
 * 配额与余额(批 5,`docs/design/provider-settings-rework-2026-09.md` §8)的产品半边。
 *
 * `fetchProviderQuota` 是**唯一**的取数入口:读 manifest 的 `quotaSource` → 注册表 → 源。
 * 没登记源的家一律 `unsupported`;源抛的错落成 `{kind:'error'}`(带归因),**不往上抛** ——
 * 调用方(`QuotaService`)只处理一种形状。
 */
import type { ProviderQuota } from '@shared/contracts/quota.js'
import { getProviderManifest } from '../manifest.js'
import { getQuotaSource } from './registry.js'
import { QuotaFetchError, type QuotaFetchContext } from './source.js'

export * from './classify-windows.js'
export * from './registry.js'
export * from './source.js'

/** 这家有没有配额源(manifest 指了、且注册表里真有)。壳据后端的 `unsupported` 判,不问这个。 */
export function providerQuotaSourceOf(providerId: string): string | undefined {
  const id = getProviderManifest(providerId)?.quotaSource
  return id && getQuotaSource(id) ? id : undefined
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** 异常 → `{kind:'error'}`。源自己归过因的照用;fetch 层的 TypeError / 超时是网络。 */
export function quotaErrorOf(error: unknown, now: number): ProviderQuota {
  if (error instanceof QuotaFetchError) {
    return { kind: 'error', reason: error.reason, message: error.message, fetchedAt: now }
  }
  const message = error instanceof Error && error.message ? error.message : String(error)
  const network = isAbortError(error) || error instanceof TypeError
  return { kind: 'error', reason: network ? 'network' : 'unknown', message: message.slice(0, 200), fetchedAt: now }
}

export async function fetchProviderQuota(providerId: string, ctx: QuotaFetchContext): Promise<ProviderQuota> {
  const source = getQuotaSource(getProviderManifest(providerId)?.quotaSource)
  if (!source) return { kind: 'unsupported' }
  try {
    return await source.fetch(ctx)
  } catch (error) {
    return quotaErrorOf(error, ctx.now?.() ?? Date.now())
  }
}
