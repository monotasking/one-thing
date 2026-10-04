/**
 * 引擎收尾链上的两个「顺手」口(批 5 §8.3)。引擎只喊一声,判据全在 `QuotaService`:
 *
 *  - `observeQuotaProviderData` —— 流里的 `provider-data { type: 'quota' }`(被动源,响应头)
 *    直接进缓存;返回 `true` = 这一条是配额、已经收了(调用方不再把它交给别人);
 *  - `noteQuotaRunEnd` —— 一轮跑完(`run/end` 那一刻),那条凭证那一格 30 秒去抖。
 *
 * 两口都**永不抛**:配额是读数卡上的附加信息,不许拖垮一轮对话的收尾。没有活实例
 * (轻量单测 / 已经收尾)就什么都不做。
 */
import type { ProviderQuota } from '@shared/contracts/quota.js'
import { ONETHING_QUOTA_PROVIDER_DATA_TYPE } from '@onething/backend/provider'
import { getCurrentBackendInstance } from '@onething/backend/backend-current.js'
import { resolveSessionSpaceId } from '@onething/backend/session'
import { getLogger } from '@onething/backend/logging/logging-configure'

const log = getLogger('app.quota')

function spaceOf(sessionId: string): string | undefined {
  try {
    return resolveSessionSpaceId(sessionId)
  } catch {
    return undefined
  }
}

export function observeQuotaProviderData(input: {
  sessionId: string
  providerId: string
  credentialId?: string
  providerData: { type?: unknown; quota?: unknown }
}): boolean {
  if (input.providerData.type !== ONETHING_QUOTA_PROVIDER_DATA_TYPE) return false
  try {
    const service = getCurrentBackendInstance()?.quota
    const quota = input.providerData.quota as ProviderQuota | undefined
    if (service && quota && typeof quota === 'object') {
      const spaceId = spaceOf(input.sessionId)
      service.observe({
        providerId: input.providerId,
        ...(spaceId ? { spaceId } : {}),
        ...(input.credentialId ? { credentialId: input.credentialId } : {}),
        quota,
      })
    }
  } catch (error) {
    log.warn('passive quota observe failed', { providerId: input.providerId }, error)
  }
  return true
}

export function noteQuotaRunEnd(input: { sessionId: string; providerId: string; credentialId?: string }): void {
  try {
    const service = getCurrentBackendInstance()?.quota
    if (!service || !input.providerId) return
    service.noteRunEnd({
      providerId: input.providerId,
      spaceId: spaceOf(input.sessionId) ?? '',
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    })
  } catch (error) {
    log.warn('quota run-end note failed', { providerId: input.providerId }, error)
  }
}
