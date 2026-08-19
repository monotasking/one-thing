/**
 * Provider Helpers Module
 * Handles provider configuration and credential management
 */

import * as store from '../../store.js'
import type { AppSettings, ProviderConfig, CustomProviderConfig } from '@shared/ipc.js'
import { requiresOAuth } from '../../providers/index.js'
import { oauthManager } from '../../providers/auth/oauth-manager.js'
import type { ProviderAuthContext } from '../../auth/types.js'
import { resolveProviderApiKey } from '../../providers/env.js'
import {
  applySessionSpaceCredentials,
  credentialTargetFromMarker,
  resolveSessionSpaceOAuthAuth,
} from '../../providers/space-credentials.js'
import { resolveSessionSpaceDefaultSelection } from '../../providers/space-defaults.js'
import { getSessionSettings } from '../../providers/space-ai-settings.js'
import {
  extractOnethingProviderErrorDetails,
  getEffectiveOnethingProviderConfig,
  getOnethingApiKeyForProvider,
  getOnethingCredentialsError,
  getOnethingCustomProviderConfig,
  getOnethingProviderApiType,
  getOnethingProviderConfig,
  resolveOnethingProviderAuth,
  resolveOnethingProviderConfigForChat,
  type OnethingProviderErrorDetails,
} from '@onething/runtime/providers'
import { consolePort, getLogger } from '../../logging/index.js'

const log = getLogger('engine.stream')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


/**
 * Extract detailed error information from API responses
 */
export type ProviderErrorDetails = OnethingProviderErrorDetails

export function extractErrorDetails(error: ProviderErrorDetails | undefined): string | undefined {
  return extractOnethingProviderErrorDetails(error)
}

/**
 * Get current provider config from settings
 */
export function getProviderConfig(settings: AppSettings): ProviderConfig | undefined {
  return getOnethingProviderConfig(settings)
}

/**
 * Get the API key for a provider, handling OAuth providers
 * For OAuth providers, returns the OAuth access token
 * For regular providers, returns the configured API key
 */
export async function getApiKeyForProvider(providerId: string, providerConfig: ProviderConfig | undefined): Promise<string | null> {
  return getOnethingApiKeyForProvider<ProviderConfig>(providerId, providerConfig, {
    isOAuthProvider: requiresOAuth,
    // per-space OAuth(批 B6):标记在就去那个空间的 entry 上刷新,缺席才走 settings。
    refreshOAuthToken: (id, credential) =>
      oauthManager.refreshTokenIfNeeded(id, credentialTargetFromMarker(credential)),
    resolveApiKey: (id, config) => resolveProviderApiKey(id, config),
    logger: consoleLog,
  })
}

/**
 * Resolve runtime auth without forcing OAuth providers through the API-key path.
 */
export async function resolveProviderAuth(
  providerId: string,
  providerConfig: ProviderConfig | undefined,
): Promise<ProviderAuthContext | null> {
  return resolveOnethingProviderAuth<ProviderConfig, ProviderAuthContext>(providerId, providerConfig, {
    isOAuthProvider: requiresOAuth,
    resolveApiKey: (id, config) => resolveProviderApiKey(id, config),
    resolveOAuthAuth: (id, apiKey, credential) => resolveSessionSpaceOAuthAuth(id, apiKey, credential),
    createApiKeyAuth: apiKey => ({ kind: 'api-key', apiKey }),
    logger: consoleLog,
  })
}

/**
 * Check if a provider has valid credentials (API key or OAuth token)
 */
export async function hasValidCredentials(providerId: string, providerConfig: ProviderConfig | undefined): Promise<boolean> {
  const auth = await resolveProviderAuth(providerId, providerConfig)
  return !!auth
}

/**
 * Get effective provider and model for a session (session-level overrides global)
 */
export function getEffectiveProviderConfig(
  settings: AppSettings,
  sessionId: string,
  override?: { providerId?: string; model?: string } | null
): { providerId: string; providerConfig: ProviderConfig | undefined; model: string } {
  // **换源(C2)**:provider 设置整套 per-space 之后,`settings.ai` 必须是**这条
  // 会话所在空间**的那一份。调用方递进来的 settings 只保证是「一份 settings」,
  // 它的 `ai` 可能是 default 空间的(`store.getSettings()` 的缺省)。换源放在
  // 这条唯一的解析缝里 —— 让每个调用方各自记得换,就是漏一个的开始。
  const scoped = { ...settings, ai: getSessionSettings(sessionId).ai }
  return getEffectiveOnethingProviderConfig(scoped, sessionId, {
    getSession: id => store.getSession(id),
    // per-space 凭证(批 B3):这一处与 core 引擎的 provider 适配器是**同一个**
    // 注入口 —— 两条解析链共用的那一处,别在别处再判一次。
    applySpaceCredentials: applySessionSpaceCredentials,
    // per-space 默认 provider/model(批 B9):同一个注入口的第二格。会话没表达过
    // 选择时,先问所在空间的默认,再落全局 —— 默认空间恒无,那一支零变化。
    resolveSpaceDefaultSelection: resolveSessionSpaceDefaultSelection,
  }, override)
}

/**
 * Get custom provider config by ID
 */
export function getCustomProviderConfig(settings: AppSettings, providerId: string): CustomProviderConfig | undefined {
  return getOnethingCustomProviderConfig<ProviderConfig, CustomProviderConfig>(settings, providerId)
}

/**
 * Get apiType for a provider
 */
export function getProviderApiType(settings: AppSettings, providerId: string): 'openai' | 'anthropic' | undefined {
  return getOnethingProviderApiType(settings, providerId)
}

// ============================================================================
// Optimized Provider Config for Chat (Session-Level Caching)
// ============================================================================

export interface ResolvedProviderConfig {
  providerId: string
  model: string
  apiKey: string
  authContext: ProviderAuthContext
  baseUrl?: string
  temperature: number
}

/**
 * Get provider config for a chat request.
 *
 * Resolution order:
 * 1. Session lastProvider/lastModel (per-session override)
 * 2. Global settings (fallback)
 *
 * Note: API key is always fetched fresh (handles OAuth token refresh)
 */
export async function getProviderConfigForChat(
  sessionId: string
): Promise<ResolvedProviderConfig | null> {
  // 换源(C2):第二条解析链,与 `getEffectiveProviderConfig` 同一句话。
  const settings = getSessionSettings(sessionId)
  const resolved = await resolveOnethingProviderConfigForChat<ProviderConfig, ProviderAuthContext>({
    sessionId,
    settings,
    adapters: {
      getSession: id => store.getSession(id),
      applySpaceCredentials: applySessionSpaceCredentials,
      isOAuthProvider: requiresOAuth,
      resolveApiKey: (id, config) => resolveProviderApiKey(id, config),
      resolveOAuthAuth: (id, apiKey, credential) => resolveSessionSpaceOAuthAuth(id, apiKey, credential),
      createApiKeyAuth: apiKey => ({ kind: 'api-key', apiKey }),
      logger: consoleLog,
    },
  })
  return resolved as ResolvedProviderConfig | null
}

/**
 * Check if credentials are missing and provide appropriate error message
 */
export function getCredentialsError(providerId: string): string {
  return getOnethingCredentialsError(providerId, { isOAuthProvider: requiresOAuth })
}
