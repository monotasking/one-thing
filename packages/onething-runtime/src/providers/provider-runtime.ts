import {
  extractErrorDetails as extractCoreErrorDetails,
  formatProviderCredentialsError,
  getCustomProviderConfig as getCoreCustomProviderConfig,
  getEffectiveProviderConfig as getCoreEffectiveProviderConfig,
  getProviderApiKeyWithAdapters,
  getProviderApiType as getCoreProviderApiType,
  getProviderConfig as getCoreProviderConfig,
  resolveProviderAuthWithAdapters,
  resolveProviderConfigForChat as resolveCoreProviderConfigForChat,
  withResolvedProviderBaseUrl,
  type CoreAppSettingsWithAI,
  type CoreAppSettingsWithTitleModel,
  type CoreCustomProviderConfigLike,
  type CoreEffectiveProviderConfig,
  type CoreProviderAuthLike,
  type CoreProviderAuthLogger,
  type CoreProviderConfigLike,
  type CoreProviderErrorDetails,
  type CoreResolvedProviderConfigForChat,
  type CoreSessionProviderSelection,
  type CoreSpaceCredentialMarker,
  type CoreSpaceDefaultSelection,
  type CoreProviderSelectionOverride,
} from './provider-config.js'

export type { CoreProviderSelectionOverride, CoreSpaceDefaultSelection } from './provider-config.js'

export type OnethingProviderErrorDetails = CoreProviderErrorDetails

export interface OnethingOAuthTokenLike {
  accessToken: string
}

export interface OnethingProviderRuntimeAdapters<
  TProvider extends CoreProviderConfigLike = CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike = CoreProviderAuthLike,
  TSession extends CoreSessionProviderSelection = CoreSessionProviderSelection,
> {
  getSession?(sessionId: string): TSession | null | undefined
  /**
   * per-space 凭证覆盖(批 B3)。宿主注入 —— 产品层不认识「会话属于哪个空间」
   * 这件事的存储形态,它只知道**这一处**是两条解析链共用的注入口。
   * 缺省 = 恒等,即今天的行为(默认空间 = settings.ai)。
   */
  applySpaceCredentials?(
    sessionId: string,
    providerId: string,
    providerConfig: TProvider | undefined,
  ): TProvider | undefined
  /**
   * per-space 默认 provider/model(批 B9)。同一个宿主注入口的第二格:产品层依旧
   * 不认识「会话属于哪个空间」,它只知道**这一处**能拿到 sessionId。
   * 缺省 = 恒无,即今天的行为(会话没表达过就落全局)。
   */
  resolveSpaceDefaultSelection?(sessionId: string): CoreSpaceDefaultSelection | undefined
  isOAuthProvider(providerId: string): boolean
  /**
   * 末位是 B3 的运行期标记(批 B6)——「token 存在哪个空间的哪条 entry 上」。
   * 缺席 = settings 源,即默认空间的行为(一字未改)。
   */
  refreshOAuthToken(
    providerId: string,
    credential?: CoreSpaceCredentialMarker,
  ): Promise<OnethingOAuthTokenLike>
  resolveApiKey(providerId: string, providerConfig: TProvider | undefined): string | null | undefined
  resolveOAuthAuth(
    providerId: string,
    apiKey?: string,
    credential?: CoreSpaceCredentialMarker,
  ): Promise<TAuth | null>
  createApiKeyAuth?(apiKey: string): TAuth
  logger?: CoreProviderAuthLogger
}

export interface OnethingProviderConfigForChatOptions<
  TProvider extends CoreProviderConfigLike = CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike = CoreProviderAuthLike,
  TSession extends CoreSessionProviderSelection = CoreSessionProviderSelection,
> {
  sessionId: string
  settings: CoreAppSettingsWithAI<TProvider>
  adapters: Pick<OnethingProviderRuntimeAdapters<TProvider, TAuth, TSession>, 'getSession' | 'applySpaceCredentials'>
    & Pick<OnethingProviderRuntimeAdapters<TProvider, TAuth, TSession>, 'isOAuthProvider' | 'resolveApiKey' | 'resolveOAuthAuth' | 'createApiKeyAuth' | 'logger'>
}

export interface OnethingChatTitleProviderConfig<
  TProvider extends CoreProviderConfigLike = CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike = CoreProviderAuthLike,
> extends CoreProviderConfigLike {
  apiKey: string
  authContext: TAuth
  oauthToken?: unknown
  apiType?: 'openai' | 'anthropic'
  originalProviderConfig?: TProvider
}

export interface OnethingChatTitleGenerationAdapters<
  TProvider extends CoreProviderConfigLike = CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike = CoreProviderAuthLike,
> {
  isProviderSupported(providerId: string): boolean
  resolveAuth(providerId: string, providerConfig: TProvider | undefined): Promise<TAuth | null>
  getProviderApiType?(
    settings: CoreAppSettingsWithTitleModel<TProvider>,
    providerId: string
  ): 'openai' | 'anthropic' | undefined
  generateTitle(
    providerId: string,
    providerConfig: OnethingChatTitleProviderConfig<TProvider, TAuth>,
    userMessage: string,
    options: {
      thinking?: boolean
      thinkingEffort?: unknown
      onUsage?: (usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void
    },
  ): Promise<string>
  logger?: CoreProviderAuthLogger
}

export interface GenerateOnethingChatTitleOptions<
  TProvider extends CoreProviderConfigLike = CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike = CoreProviderAuthLike,
> {
  userMessage: string
  settings: CoreAppSettingsWithTitleModel<TProvider>
  adapters: OnethingChatTitleGenerationAdapters<TProvider, TAuth>
}

export interface GenerateOnethingChatTitleResult {
  title: string
  usedFallback: boolean
}

export interface GenerateOnethingChatTitleForIpcResult {
  success: true
  title: string
}

export function extractOnethingProviderErrorDetails(
  error: OnethingProviderErrorDetails | undefined,
): string | undefined {
  return extractCoreErrorDetails(error)
}

export function getOnethingCaughtErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return fallback
}

export function extractOnethingCaughtErrorDetails(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined

  const details: OnethingProviderErrorDetails = {
    message: getOnethingCaughtErrorMessage(error, ''),
    stack: error instanceof Error ? error.stack : undefined,
    responseBody: 'responseBody' in error && typeof error.responseBody === 'string'
      ? error.responseBody
      : undefined,
  }
  return extractOnethingProviderErrorDetails(details)
}

export function getOnethingProviderConfig<TProvider extends CoreProviderConfigLike>(
  settings: CoreAppSettingsWithAI<TProvider>,
): TProvider | undefined {
  return getCoreProviderConfig(settings)
}

export async function getOnethingApiKeyForProvider<TProvider extends CoreProviderConfigLike>(
  providerId: string,
  providerConfig: TProvider | undefined,
  adapters: Pick<
    OnethingProviderRuntimeAdapters<TProvider>,
    'isOAuthProvider' | 'refreshOAuthToken' | 'resolveApiKey' | 'logger'
  >,
): Promise<string | null> {
  return getProviderApiKeyWithAdapters({
    providerId,
    providerConfig,
    isOAuthProvider: adapters.isOAuthProvider,
    refreshOAuthToken: adapters.refreshOAuthToken,
    resolveApiKey: adapters.resolveApiKey,
    logger: adapters.logger,
  })
}

export async function resolveOnethingProviderAuth<
  TProvider extends CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike,
>(
  providerId: string,
  providerConfig: TProvider | undefined,
  adapters: Pick<
    OnethingProviderRuntimeAdapters<TProvider, TAuth>,
    'isOAuthProvider' | 'resolveApiKey' | 'resolveOAuthAuth' | 'createApiKeyAuth' | 'logger'
  >,
): Promise<TAuth | null> {
  return resolveProviderAuthWithAdapters({
    providerId,
    providerConfig,
    isOAuthProvider: adapters.isOAuthProvider,
    resolveApiKey: adapters.resolveApiKey,
    resolveOAuthAuth: adapters.resolveOAuthAuth,
    createApiKeyAuth: adapters.createApiKeyAuth,
    logger: adapters.logger,
  })
}

export async function hasValidOnethingProviderCredentials<
  TProvider extends CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike,
>(
  providerId: string,
  providerConfig: TProvider | undefined,
  adapters: Pick<
    OnethingProviderRuntimeAdapters<TProvider, TAuth>,
    'isOAuthProvider' | 'resolveApiKey' | 'resolveOAuthAuth' | 'createApiKeyAuth' | 'logger'
  >,
): Promise<boolean> {
  const auth = await resolveOnethingProviderAuth(providerId, providerConfig, adapters)
  return Boolean(auth)
}

export function getEffectiveOnethingProviderConfig<
  TProvider extends CoreProviderConfigLike,
  TSession extends CoreSessionProviderSelection = CoreSessionProviderSelection,
>(
  settings: CoreAppSettingsWithAI<TProvider>,
  sessionId: string,
  adapters: Pick<
    OnethingProviderRuntimeAdapters<TProvider, CoreProviderAuthLike, TSession>,
    'getSession' | 'applySpaceCredentials' | 'resolveSpaceDefaultSelection'
  >,
  override?: CoreProviderSelectionOverride | null,
): CoreEffectiveProviderConfig<TProvider> {
  // per-space 默认(批 B9)在选择解析里,不在凭证覆盖里:它决定「用哪个 provider
  // 的哪个模型」,凭证覆盖决定「用哪把钥匙」。同一个注入缝的两格,顺序上前者先。
  const resolved = getCoreEffectiveProviderConfig(
    settings,
    adapters.getSession?.(sessionId),
    override,
    adapters.resolveSpaceDefaultSelection?.(sessionId),
  )
  // per-space 凭证覆盖(批 B3)在 baseUrl 派生**之前**:entry 可以带自己的 apiMode,
  // 派生要看得见它,否则 zhipu coding-plan 的空间会被算回 standard 端点。
  const spaceScoped = adapters.applySpaceCredentials
    ? adapters.applySpaceCredentials(sessionId, resolved.providerId, resolved.providerConfig)
    : resolved.providerConfig
  let providerConfig = withResolvedProviderBaseUrl(resolved.providerId, spaceScoped)
  // This is the single chokepoint both resolution chains share (see the
  // deepseek-goes-codex incident), so a pinned think mode applied HERE is the
  // one place it cannot diverge: the turn's thinking is read off
  // providerConfig.thinkingByModel[model] downstream, for every provider that
  // supports it, and the caller's settings stay untouched.
  if (providerConfig && typeof override?.thinking === 'boolean') {
    const record = providerConfig as TProvider & {
      thinkingByModel?: Record<string, boolean | undefined>
      thinkingEffortByModel?: Record<string, unknown>
    }
    providerConfig = {
      ...record,
      thinkingByModel: { ...record.thinkingByModel, [resolved.model]: override.thinking },
      ...(override.thinking && override.thinkingEffort
        ? {
            thinkingEffortByModel: {
              ...record.thinkingEffortByModel,
              [resolved.model]: override.thinkingEffort,
            },
          }
        : {}),
    }
  }
  return { ...resolved, providerConfig }
}

export function getOnethingCustomProviderConfig<
  TProvider extends CoreProviderConfigLike,
  TCustomProvider extends CoreCustomProviderConfigLike = CoreCustomProviderConfigLike,
>(
  settings: CoreAppSettingsWithAI<TProvider> & { ai: { customProviders?: TCustomProvider[] } },
  providerId: string,
): TCustomProvider | undefined {
  return getCoreCustomProviderConfig(settings, providerId) as TCustomProvider | undefined
}

export function getOnethingProviderApiType<TProvider extends CoreProviderConfigLike>(
  settings: CoreAppSettingsWithAI<TProvider>,
  providerId: string,
): 'openai' | 'anthropic' | undefined {
  return getCoreProviderApiType(settings, providerId)
}

export async function resolveOnethingProviderConfigForChat<
  TProvider extends CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike,
  TSession extends CoreSessionProviderSelection = CoreSessionProviderSelection,
>(
  options: OnethingProviderConfigForChatOptions<TProvider, TAuth, TSession>,
): Promise<CoreResolvedProviderConfigForChat<TProvider, TAuth> | null> {
  const applySpaceCredentials = options.adapters.applySpaceCredentials
  const resolved = await resolveCoreProviderConfigForChat({
    settings: options.settings,
    session: options.adapters.getSession?.(options.sessionId),
    ...(applySpaceCredentials
      ? {
          applySpaceCredentials: (providerId: string, providerConfig: TProvider | undefined) =>
            applySpaceCredentials(options.sessionId, providerId, providerConfig),
        }
      : {}),
    resolveAuth: (providerId, providerConfig) =>
      resolveOnethingProviderAuth(providerId, providerConfig, options.adapters),
  })
  if (!resolved) return null
  const providerConfig = withResolvedProviderBaseUrl(resolved.providerId, resolved.providerConfig)
  return {
    ...resolved,
    providerConfig,
    baseUrl: providerConfig?.baseUrl,
  }
}

export function getOnethingCredentialsError(
  providerId: string,
  adapters: Pick<OnethingProviderRuntimeAdapters, 'isOAuthProvider'>,
): string {
  return formatProviderCredentialsError(providerId, adapters.isOAuthProvider(providerId))
}

export function fallbackOnethingChatTitle(userMessage: string, maxLength = 30): string {
  return userMessage.slice(0, maxLength) + (userMessage.length > maxLength ? '...' : '')
}

export async function generateOnethingChatTitle<
  TProvider extends CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike,
>(
  options: GenerateOnethingChatTitleOptions<TProvider, TAuth>,
): Promise<GenerateOnethingChatTitleResult> {
  const { userMessage, settings, adapters } = options

  try {
    const configuredProviderId = settings.tools?.toolCallModel?.providerId?.trim()
    const configuredModel = settings.tools?.toolCallModel?.model?.trim()
    const providerId = configuredProviderId && settings.ai.providers[configuredProviderId]
      ? configuredProviderId
      : settings.ai.provider
    const providerConfig = settings.ai.providers[providerId] || getOnethingProviderConfig(settings)
    const model = providerId === configuredProviderId && configuredModel
      ? configuredModel
      : providerConfig?.model || providerConfig?.selectedModels?.[0] || ''
    const authContext = await adapters.resolveAuth(providerId, providerConfig)

    if (!model || !authContext || !adapters.isProviderSupported(providerId)) {
      return {
        title: fallbackOnethingChatTitle(userMessage),
        usedFallback: true,
      }
    }

    const title = await adapters.generateTitle(
      providerId,
      {
        ...(providerConfig ?? {}),
        apiKey: authContext.kind === 'api-key' ? authContext.apiKey ?? '' : '',
        authContext,
        oauthToken: authContext.kind === 'oauth' ? (authContext as { token?: unknown }).token : providerConfig?.oauthToken,
        baseUrl: providerConfig?.baseUrl,
        model,
        apiType: adapters.getProviderApiType?.(settings, providerId),
        originalProviderConfig: providerConfig,
      },
      userMessage,
      {
        thinking: settings.tools?.toolCallModel?.thinking === true,
        thinkingEffort: settings.tools?.toolCallModel?.thinkingEffort,
      },
    )

    return { title, usedFallback: false }
  } catch (error) {
    adapters.logger?.error?.('Error generating title:', error)
    return {
      title: fallbackOnethingChatTitle(userMessage),
      usedFallback: true,
    }
  }
}

export async function generateOnethingChatTitleForIpc<
  TProvider extends CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike,
>(
  options: GenerateOnethingChatTitleOptions<TProvider, TAuth>,
): Promise<GenerateOnethingChatTitleForIpcResult> {
  const result = await generateOnethingChatTitle(options)
  return { success: true, title: result.title }
}
