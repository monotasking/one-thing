/**
 * Provider Helpers Module
 * Handles provider configuration and credential management
 */

import * as store from '../../store.js'
import type { AppSettings, ProviderConfig, CustomProviderConfig } from '@shared/ipc.js'
import { requiresOAuth } from '../../providers/index.js'
import { oauthManager } from '../../providers/auth/oauth-manager.js'
import { authService } from '../../auth/auth-service.js'
import type { ProviderAuthContext } from '../../auth/types.js'
import { resolveProviderApiKey } from '../../providers/env.js'
import { applySessionSpaceCredentials } from '../../providers/space-credentials.js'
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
    refreshOAuthToken: id => oauthManager.refreshTokenIfNeeded(id),
    resolveApiKey: (id, config) => resolveProviderApiKey(id, config),
    logger: console,
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
    resolveOAuthAuth: (id, apiKey) => authService.resolveProviderAuth(id, apiKey),
    createApiKeyAuth: apiKey => ({ kind: 'api-key', apiKey }),
    logger: console,
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
  return getEffectiveOnethingProviderConfig(settings, sessionId, {
    getSession: id => store.getSession(id),
    // per-space 凭证(批 B3):这一处与 core 引擎的 provider 适配器是**同一个**
    // 注入口 —— 两条解析链共用的那一处,别在别处再判一次。
    applySpaceCredentials: applySessionSpaceCredentials,
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
  const settings = store.getSettings()
  const resolved = await resolveOnethingProviderConfigForChat<ProviderConfig, ProviderAuthContext>({
    sessionId,
    settings,
    adapters: {
      getSession: id => store.getSession(id),
      applySpaceCredentials: applySessionSpaceCredentials,
      isOAuthProvider: requiresOAuth,
      resolveApiKey: (id, config) => resolveProviderApiKey(id, config),
      resolveOAuthAuth: (id, apiKey) => authService.resolveProviderAuth(id, apiKey),
      createApiKeyAuth: apiKey => ({ kind: 'api-key', apiKey }),
      logger: console,
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
