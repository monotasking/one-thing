import type { StreamEngineProviderAdapter } from '@onething/core/engine'
import type {
  CoreAppSettingsWithAI,
  CoreProviderAuthLike,
  CoreProviderAuthLogger,
  CoreProviderConfigLike,
  CoreSessionProviderSelection,
} from './provider-config.js'
import {
  getEffectiveOnethingProviderConfig,
  getOnethingProviderApiType,
  resolveOnethingProviderAuth,
} from './provider-runtime.js'

export interface OnethingStreamProviderAdapterOptions<
  TProvider extends CoreProviderConfigLike = CoreProviderConfigLike,
  TSettings extends CoreAppSettingsWithAI<TProvider> = CoreAppSettingsWithAI<TProvider>,
  TAuth extends CoreProviderAuthLike = CoreProviderAuthLike,
  TSession extends CoreSessionProviderSelection = CoreSessionProviderSelection,
> {
  getSession(sessionId: string): TSession | null | undefined
  /** per-space 凭证覆盖(批 B3)。缺省 = 恒等,即默认空间语义。 */
  applySpaceCredentials?(
    sessionId: string,
    providerId: string,
    providerConfig: TProvider | undefined,
  ): TProvider | undefined
  isProviderSupported(providerId: string): boolean
  isOAuthProvider(providerId: string): boolean
  resolveApiKey(providerId: string, providerConfig: TProvider | undefined): string | null | undefined
  resolveOAuthAuth(providerId: string, apiKey?: string): Promise<TAuth | null>
  createApiKeyAuth?(apiKey: string): TAuth
  generateTitle(
    providerId: string,
    providerConfig: TProvider | undefined,
    content: string,
    options?: Record<string, unknown>,
  ): Promise<string>
  logger?: CoreProviderAuthLogger
}

export function createOnethingStreamProviderAdapter<
  TProvider extends CoreProviderConfigLike = CoreProviderConfigLike,
  TSettings extends CoreAppSettingsWithAI<TProvider> = CoreAppSettingsWithAI<TProvider>,
  TAuth extends CoreProviderAuthLike = CoreProviderAuthLike,
  TSession extends CoreSessionProviderSelection = CoreSessionProviderSelection,
>(
  options: OnethingStreamProviderAdapterOptions<TProvider, TSettings, TAuth, TSession>,
): StreamEngineProviderAdapter<TSettings, TProvider | undefined, TAuth> {
  return {
    getEffectiveConfig(settings, sessionId, override) {
      return getEffectiveOnethingProviderConfig<TProvider, TSession>(settings, sessionId, {
        getSession: options.getSession,
        applySpaceCredentials: options.applySpaceCredentials,
      }, override)
    },
    /**
     * 标题生成不走 `getEffectiveConfig`(它自己从 settings 取工具模型),
     * 所以那条路要单独把同一个注入函数再用一次 —— 否则非默认空间的会话会拿
     * 全局的 key 去生成标题。缺省 = 恒等。
     */
    applySpaceCredentials(sessionId, providerId, providerConfig) {
      return options.applySpaceCredentials
        ? options.applySpaceCredentials(sessionId, providerId, providerConfig as TProvider | undefined)
        : providerConfig
    },
    /**
     * 「这个 provider 在这个空间未配置」的文案(批 B3)。核心引擎在
     * `resolveAuth` 返回 null 时问一句;不实现 / 返回 undefined 就落回原来那两句
     * 通用文案 —— 默认空间因此一个字都没变。
     */
    describeMissingCredentials(_providerId, providerConfig) {
      return (providerConfig as TProvider | undefined)?.spaceCredential?.unavailable?.message
    },
    resolveAuth(providerId, providerConfig) {
      return resolveOnethingProviderAuth<TProvider, TAuth>(providerId, providerConfig, {
        isOAuthProvider: options.isOAuthProvider,
        resolveApiKey: options.resolveApiKey,
        resolveOAuthAuth: options.resolveOAuthAuth,
        createApiKeyAuth: options.createApiKeyAuth,
        logger: options.logger,
      })
    },
    getApiType(settings, providerId) {
      return getOnethingProviderApiType(settings, providerId)
    },
    isSupported(providerId) {
      return options.isProviderSupported(providerId)
    },
    requiresOAuth(providerId) {
      return options.isOAuthProvider(providerId)
    },
    generateTitle(providerId, providerConfig, content, titleOptions) {
      return options.generateTitle(providerId, providerConfig as TProvider | undefined, content, titleOptions)
    },
  }
}
