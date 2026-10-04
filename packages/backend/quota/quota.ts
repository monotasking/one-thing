/**
 * 配额服务的**真接线**(批 5 §8.3)。逻辑在 `service.ts`;这里只把它接到脊柱上:
 *
 *  - 凭证:密钥策略的只读 `decideSpaceProviderCredential`(不拨 round-robin 游标),或按 id
 *    直取池里那一条;OAuth 经 `authService.refreshTokenIfNeeded` 刷新好再递给源;
 *  - 端点:空间的 provider 设置盖上那条凭证的档位 / 地区 / 端点(与发送路
 *    `applySpaceProviderCredential` 同一个函数),于是配额问的是「这条凭证真在用的那一台」;
 *  - 取数:托管 fetch(`createRequiredAppFetch({ policy: 'default', retry: false })`,走代理与超时,不重试);
 *  - 推送:出网全局事件 `provider:quota`(**发送时才取总线**,装配前 warn 一行丢掉);
 *  - 冷却:`markSpaceCredentialCooldown(..., 'quota')`,只延长不缩短。
 *
 * 实例由 `OnethingBackend` 持有(`backend.quota`),`own()` 收尾 —— 计时器全在它身上。
 */
import type { ProviderQuotaPushPayload } from '@shared/contracts/quota.js'
import { fetchProviderQuota, getProviderEnvStatus, providerQuotaSourceOf } from '@onething/backend/provider'
import {
  applySpaceProviderCredential,
  toSpaceCredentialMarker,
  type SpaceProviderCredentialResolution,
  getSpaceCredentialEntry,
  markSpaceCredentialCooldown,
  parseSpaceOAuthToken,
  credentialTargetFromMarker,
  decideSpaceProviderCredential,
} from '@onething/backend/credentials'
import { readSpaceProviderSettings, DEFAULT_SPACE_ID } from '@onething/backend/space'
import { createRequiredAppFetch } from '@onething/backend/settings'
import { getEventBus, isEventSystemInitialized } from '@onething/backend/event'
import { getAuthService } from '../auth/auth.js'
import { getLogger } from '@onething/backend/logging'
import { QuotaService, type QuotaCredentialResolution, type QuotaServiceDeps } from './quota-service.js'

// 对外交出:配额服务类(逻辑在 `quota-service.ts`)、本文件的装配两只(`createQuotaService`、按 id 解析池里那条凭证),
// 以及引擎回合钩子里的两只观察口(收到服务商回包时顺手记额度、回合结束时记一笔)。
export { QuotaService } from './quota-service.js'
export { noteQuotaRunEnd, observeQuotaProviderData } from './quota-engine-hooks.js'

const log = getLogger('app.quota')

function describeUnavailable(resolution: SpaceProviderCredentialResolution): string {
  return resolution.kind === 'unavailable' ? resolution.message : 'no credential for this provider'
}

/** 池里那一条 → 解析形状(按 id 直取的那一支用;形状与 `decide` 答的同一种)。 */
function resolutionOfEntryId(
  providerId: string,
  spaceId: string,
  credentialId: string,
): SpaceProviderCredentialResolution {
  const entry = getSpaceCredentialEntry(spaceId, providerId, credentialId)
  if (!entry) return { kind: 'unavailable', spaceId, reason: 'no-entry', message: `credential ${credentialId} not found` }
  return entry.authType === 'oauth' ? { kind: 'oauth-entry', spaceId, entry } : { kind: 'entry', spaceId, entry }
}

export async function resolveQuotaCredential(
  providerId: string,
  spaceId: string,
  credentialId: string | undefined,
): Promise<QuotaCredentialResolution> {
  const space = spaceId || DEFAULT_SPACE_ID
  const resolution = credentialId
    ? resolutionOfEntryId(providerId, space, credentialId)
    : decideSpaceProviderCredential(providerId, space)
  const baseConfig = (readSpaceProviderSettings(space)?.providers[providerId] ?? {}) as Record<string, unknown>
  const effective = (applySpaceProviderCredential(
    baseConfig as { model?: string },
    resolution,
    providerId,
  ) ?? baseConfig) as Record<string, unknown>
  const baseUrl = typeof effective.baseUrl === 'string' && effective.baseUrl.trim() ? effective.baseUrl : undefined
  const common = { ...(baseUrl ? { baseUrl } : {}), config: effective }

  if (resolution.kind === 'entry') {
    const apiKey = resolution.entry.apiKey?.trim()
    if (!apiKey) return { kind: 'unavailable', credentialId: resolution.entry.id, message: 'credential has no API key' }
    return { kind: 'ready', credentialId: resolution.entry.id, context: { ...common, apiKey } }
  }
  if (resolution.kind === 'oauth-entry') {
    const target = credentialTargetFromMarker(toSpaceCredentialMarker(resolution))
    const token = parseSpaceOAuthToken(await getAuthService().refreshTokenIfNeeded(providerId, target))
    if (!token?.accessToken) return { kind: 'unavailable', credentialId: resolution.entry.id, message: 'Not logged in' }
    return {
      kind: 'ready',
      credentialId: resolution.entry.id,
      context: {
        ...common,
        oauthToken: {
          accessToken: token.accessToken,
          ...(token.accountId ? { accountId: token.accountId } : {}),
          ...(token.isFedrampAccount ? { isFedrampAccount: true } : {}),
        },
      },
    }
  }
  if (resolution.kind === 'env') {
    const envVar = getProviderEnvStatus(providerId).detectedEnvVar
    const apiKey = envVar ? process.env[envVar]?.trim() : undefined
    if (apiKey) return { kind: 'ready', context: { ...common, apiKey } }
  }
  return { kind: 'unavailable', message: describeUnavailable(resolution) }
}

function emitQuota(payload: ProviderQuotaPushPayload): void {
  if (!isEventSystemInitialized()) {
    log.warn('provider quota event dropped before assembly', { providerId: payload.providerId })
    return
  }
  getEventBus().emitGlobal({ type: 'provider:quota', ...payload })
}

export function createQuotaServiceDeps(overrides: Partial<QuotaServiceDeps> = {}): QuotaServiceDeps {
  return {
    hasSource: providerId => providerQuotaSourceOf(providerId) !== undefined,
    decide: (providerId, spaceId) => {
      const resolution = decideSpaceProviderCredential(providerId, spaceId)
      return resolution.kind === 'entry' || resolution.kind === 'oauth-entry' ? resolution.entry.id : undefined
    },
    resolve: resolveQuotaCredential,
    fetch: fetchProviderQuota,
    // 托管 fetch 走代理与超时,但**不重试**:`default` 档对 429 / 5xx 自动再打一次,而配额是
    // 一次读数 —— 读不到下次再问;对 Claude 那条 429 高发接口,自动重试正是在加码(门 ④ 实测:
    // 带重试时一次 force 打出两发)。
    fetchImpl: () => createRequiredAppFetch({ policy: 'default', retry: false }),
    emit: emitQuota,
    markCooldown: (spaceId, providerId, credentialId, until) => {
      markSpaceCredentialCooldown(spaceId, providerId, credentialId, until, 'quota')
    },
    now: () => Date.now(),
    setTimer: (run, ms) => {
      const handle = setTimeout(run, ms)
      // 去抖计时器不该吊住进程退出(它由 dispose 收,但 CLI 一类短命宿主也别被它拖住)。
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    },
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    logger: log,
    ...overrides,
  }
}

export function createQuotaService(overrides: Partial<QuotaServiceDeps> = {}): QuotaService {
  return new QuotaService(createQuotaServiceDeps(overrides))
}
