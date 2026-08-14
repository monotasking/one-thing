/**
 * per-space provider 凭证的**解析规则**(批 B3)——「这条会话该用哪把钥匙」。
 *
 * ## 两条不能记错的话
 *
 * 1. **default space 的凭证源就是 `settings.ai`,原地不动。** 这不是「回落」,是
 *    身份定义:settings 就是默认空间的凭证层。所以本模块对 default 空间返回
 *    `{ kind: 'settings' }`,一个字节都不改 —— 零迁移,老用户无感。
 * 2. **非 default space 严格隔离,不回落。** 该空间没有这个 provider 的 entry,
 *    就是「这个 provider 在这个空间**未配置**」——一等状态,起流前置拦截,
 *    绝不静默用默认空间的 key。连 `resolveOnethingProviderApiKey` 的环境变量兜底
 *    也一并挡掉:env 是机器级的,让它漏进空间等于隔离说了不算。
 *
 * ## 落地方式:在 config 上盖一个运行期标记
 *
 * 解析发生在 `getEffectiveOnethingProviderConfig`(两条 provider 解析链共用的那个
 * 唯一节流口 —— 见 provider-runtime.ts 里 deepseek-goes-codex 的注释),那里有
 * sessionId;而 `resolveAuth(providerId, providerConfig)` 没有。所以判定结果被盖成
 * `providerConfig.spaceCredential` 这个**运行期字段**(与 `providerOptions` 同一
 * 手法,永不落盘),下游的鉴权与错误文案都读它。
 *
 * 于是「未配置」这件事只判一次,却在三处生效:鉴权返回 null(起不了流)、
 * 错误文案说人话、账本 credentialId 归因。
 */

import type {
  CoreProviderConfigLike,
  CoreSpaceCredentialMarker,
} from '../providers/provider-config.js'
import {
  getSpaceProviderCredentials,
  selectSpaceCredentialEntry,
  type SpaceCredentialEntry,
} from './credentials.js'
import { DEFAULT_SPACE_ID, isValidSpaceId } from './types.js'

/** provider 自己的档位字段名 —— entry.apiMode 往哪一格里落。 */
const PROVIDER_API_MODE_FIELD: Record<string, string> = {
  zhipu: 'zhipuApiMode',
  qwen: 'qwenApiMode',
  kimi: 'kimiApiMode',
  'kimi-code': 'kimiApiMode',
}

export type SpaceCredentialUnavailableReason = 'no-entry' | 'oauth'

export type SpaceProviderCredentialResolution =
  /** default 空间:凭证源是 settings.ai,不改任何东西。 */
  | { kind: 'settings'; spaceId: string }
  /** 非 default 空间且配了 key:用这条 entry 覆盖。 */
  | { kind: 'entry'; spaceId: string; entry: SpaceCredentialEntry }
  /** 非 default 空间且没配 / 是 OAuth 型:未配置(一等状态)。 */
  | {
      kind: 'unavailable'
      spaceId: string
      reason: SpaceCredentialUnavailableReason
      message: string
    }

export interface ResolveSpaceProviderCredentialOptions {
  spaceId: string | undefined | null
  providerId: string
  /** provider 本身是不是 OAuth/订阅型(codex / claude-code / kimi-code 之类)。 */
  isOAuthProvider?: (providerId: string) => boolean
  /** 展示名。给错误文案用;缺省就用 providerId。 */
  providerLabel?: string
  /** 空间展示名。同上。 */
  spaceLabel?: string
  now?: number
}

/** 非 default 空间还没为这个 provider 配 key。 */
export function describeSpaceCredentialMissing(
  providerLabel: string,
  spaceLabel: string,
): string {
  return `当前空间「${spaceLabel}」未配置 ${providerLabel} 的凭证。请在「设置 → 模型服务」里为本空间添加密钥,或切回默认空间使用。`
}

/** 非 default 空间遇到 OAuth/订阅型 provider —— 本切片不支持 per-space 登录。 */
export function describeSpaceCredentialOAuthUnsupported(
  providerLabel: string,
  spaceLabel: string,
): string {
  return `${providerLabel} 使用登录授权(OAuth/订阅)方式,本空间「${spaceLabel}」暂不支持 OAuth 登录,请在默认空间使用。`
}

/**
 * 单一解析规则。所有「这条会话用哪把钥匙」的问题都必须走这里 ——
 * 两条 provider 解析链历史上就是因为各算各的才出过 "选 deepseek 走 codex"。
 */
export function resolveSpaceProviderCredential(
  options: ResolveSpaceProviderCredentialOptions,
): SpaceProviderCredentialResolution {
  const spaceId = options.spaceId && isValidSpaceId(options.spaceId)
    ? options.spaceId
    : DEFAULT_SPACE_ID
  if (spaceId === DEFAULT_SPACE_ID) return { kind: 'settings', spaceId }

  const providerLabel = options.providerLabel?.trim() || options.providerId
  const spaceLabel = options.spaceLabel?.trim() || spaceId

  if (options.isOAuthProvider?.(options.providerId)) {
    return {
      kind: 'unavailable',
      spaceId,
      reason: 'oauth',
      message: describeSpaceCredentialOAuthUnsupported(providerLabel, spaceLabel),
    }
  }

  const entry = selectSpaceCredentialEntry(
    getSpaceProviderCredentials(spaceId, options.providerId),
    options.now,
  )
  // OAuth 型 entry 与空 key 的 entry 在本切片同样算未配置:一个用不了的凭证
  // 被当成「配过了」,只会把失败推到 provider 那一侧变成一句看不懂的 401。
  if (!entry || entry.authType !== 'apiKey' || !entry.apiKey?.trim()) {
    return {
      kind: 'unavailable',
      spaceId,
      reason: entry && entry.authType === 'oauth' ? 'oauth' : 'no-entry',
      message: entry && entry.authType === 'oauth'
        ? describeSpaceCredentialOAuthUnsupported(providerLabel, spaceLabel)
        : describeSpaceCredentialMissing(providerLabel, spaceLabel),
    }
  }

  return { kind: 'entry', spaceId, entry }
}

/** 解析结果压成盖在 config 上的运行期标记。 */
export function toSpaceCredentialMarker(
  resolution: SpaceProviderCredentialResolution,
): CoreSpaceCredentialMarker | undefined {
  if (resolution.kind === 'settings') return undefined
  if (resolution.kind === 'entry') {
    return { spaceId: resolution.spaceId, entryId: resolution.entry.id }
  }
  return {
    spaceId: resolution.spaceId,
    unavailable: { reason: resolution.reason, message: resolution.message },
  }
}

/**
 * 把解析结果**覆盖进** provider config。
 *
 *  - `settings`:原样返回(default 空间 = 零改动)。
 *  - `entry`:覆盖 apiKey / baseUrl? / apiMode?,并盖上 entryId 标记。
 *  - `unavailable`:**抹掉** apiKey 与 oauthToken 再盖标记 —— 只盖标记不抹钥匙,
 *    等于把「别用这把钥匙」写在便签上再把钥匙递过去。
 */
export function applySpaceProviderCredential<TProvider extends CoreProviderConfigLike>(
  providerConfig: TProvider | undefined,
  resolution: SpaceProviderCredentialResolution,
  providerId: string,
): TProvider | undefined {
  if (resolution.kind === 'settings') return providerConfig
  if (!providerConfig) return providerConfig

  const marker = toSpaceCredentialMarker(resolution)

  if (resolution.kind === 'unavailable') {
    const next = { ...providerConfig } as Record<string, unknown>
    delete next.apiKey
    delete next.oauthToken
    next.spaceCredential = marker
    return next as TProvider
  }

  const entry = resolution.entry
  const apiModeField = PROVIDER_API_MODE_FIELD[providerId]
  return {
    ...providerConfig,
    apiKey: entry.apiKey,
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.apiMode && apiModeField ? { [apiModeField]: entry.apiMode } : {}),
    spaceCredential: marker,
  } as TProvider
}
