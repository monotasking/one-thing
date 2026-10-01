import {
  extractErrorDetails,
  extractResponseBodyDetails,
  type CoreErrorDetails,
} from '@onething/core/engine/error-details'
import { pickOnethingProviderOptions, type OnethingProviderOptions } from './provider-options.js'
import { resolveOnethingProviderBaseUrl } from './endpoint.js'
// 鉴权豁免改问执行器能力面(E0):判据是「它是不是外部执行体」,
// 不是「它的 id 在不在某张名单里」。表在 agents/executor/capabilities.ts。
import { isExternalAgentExecutorProvider } from '../agents/executor/registry.js'

/**
 * 错误详情的提取只有一份,在 core(`@onething/core/engine` 的 `extractErrorDetails`)。
 * 这里从前逐字抄了一份,连智谱的错误码表也抄了一份;现在错误码说明归各家自己的
 * manifest(`errorDescriptions`),经 core 的查询口接进去(见 `manifest.ts`)。
 */
export type CoreProviderErrorDetails = CoreErrorDetails
export { extractErrorDetails, extractResponseBodyDetails }

/**
 * per-space 凭证解析的**运行期标记**(批 B3),由
 * `spaces/provider-credentials.ts` 盖上,**永不落盘** —— 与 `providerOptions`
 * 同一手法。存在的理由:解析点(`getEffectiveProviderConfig`)有 sessionId,
 * 鉴权点(`resolveAuth`)没有,判定只能顺着 config 往下走。
 *
 * `spaceId === 'default'` 时根本不会有这个字段:默认空间的凭证源是 settings.ai,
 * 那条路一个字节都不改。
 */
export interface CoreSpaceCredentialMarker {
  spaceId: string
  /** 命中的凭证池 entry id。账本 `credentialId` 归因用的就是它。 */
  entryId?: string
  /**
   * 命中的 entry 是哪一类凭证(批 B6)。鉴权点靠它知道该走 OAuth 那一支
   * (拿 `{spaceId, entryId}` 去 auth 层换 token,必要时先刷新)还是直接用
   * 已经盖进 config 的 apiKey。
   */
  authType?: 'apiKey' | 'oauth'
  /**
   * 「这个 provider 在这个空间未配置」——一等状态,不是错误的近似。
   * 存在即表示鉴权必须失败,且失败文案用这里的 `message`(说清去哪儿配)。
   */
  unavailable?: { reason: 'no-entry' | 'oauth' | 'exhausted' | 'disabled'; message: string }
  /**
   * 这份 config **属于另一家**(批 6 轮转 v2,§9.1):用户选的是订阅那一家,它的账号额度
   * 全用完了,`pickRoute` 把这一发接力给了同家的 API 半边。config 里的端点 / 头 / 方言与
   * `entryId` 都是那一家的;鉴权点与造 provider 的那一处据它换家,其余一切(会话、模型、账本
   * 归属)仍记在用户选的那一家名下。缺席 = config 就是请求那一家的(今天的一切路径)。
   */
  route?: { providerId: string; reason: 'subscription' | 'sibling-api' | 'api' }
}

/** 这份 config 真正要去的那一家:被轮转接力过就是接力的那一家,否则就是请求的那一家。 */
export function routedProviderIdOf(
  providerId: string,
  providerConfig: { spaceCredential?: CoreSpaceCredentialMarker } | undefined | null,
): string {
  return providerConfig?.spaceCredential?.route?.providerId || providerId
}

export interface CoreProviderConfigLike {
  model?: string
  selectedModels?: string[]
  baseUrl?: string
  /** 批 M §5.3:每个请求都带的头;值里 `{{apiKey}}` 发送时换成当前凭证。 */
  headers?: Record<string, string>
  /** 批 M §5.3:覆盖 manifest.models 的端点;空 = baseUrl + '/models'。 */
  modelsUrl?: string
  /** 批 M §5.3:覆盖 manifest.dialect(内置家指向中转站时也可能要换)。 */
  dialect?: string
  /** Runtime-only: stamped by per-space credential resolution, never persisted. */
  spaceCredential?: CoreSpaceCredentialMarker
  // 存档里还有各家的档位格(接口模式 / 地区),键名由那一家 manifest 的 `dials.apiModeKey` /
  // `regionKey` 声明,读的人按键取(`endpoint.pickOptions` / `resolveBaseUrl` 收 `Record<string,
  // unknown>`)。这里不点名(服务商自述试点 P3)。
  /** Runtime-only: packed by withResolvedProviderBaseUrl, never persisted. */
  providerOptions?: OnethingProviderOptions
  temperature?: number
  oauthToken?: unknown
}

/**
 * 带着各家档位格的配置形状:档位格的键名由那一家 manifest 的 `dials.apiModeKey` / `regionKey`
 * 声明(`zhipuApiMode` / `qwenRegion` ……),类型上不点名,按键读出来是 `unknown`、由那一家的
 * 归一函数收窄。要把这几格放在类型上带着走的地方(按键读写的宿主、测试夹具)用它。
 */
export type ProviderConfigWithDials<T extends CoreProviderConfigLike = CoreProviderConfigLike> = T & {
  readonly [dialKey: string]: unknown
}

export interface CoreCustomProviderConfigLike extends CoreProviderConfigLike {
  id: string
  name?: string
  description?: string
  apiType?: 'openai' | 'anthropic'
}

export interface CoreAISettingsLike<TProvider extends CoreProviderConfigLike = CoreProviderConfigLike> {
  provider: string
  providers: Record<string, TProvider | undefined>
  customProviders?: CoreCustomProviderConfigLike[]
  temperature?: number
}

export interface CoreAppSettingsWithAI<TProvider extends CoreProviderConfigLike = CoreProviderConfigLike> {
  ai: CoreAISettingsLike<TProvider>
}

export interface CoreToolCallModelSettingsLike {
  providerId?: string
  model?: string
  thinking?: boolean
  thinkingEffort?: unknown
}

export interface CoreAppSettingsWithTitleModel<TProvider extends CoreProviderConfigLike = CoreProviderConfigLike>
  extends CoreAppSettingsWithAI<TProvider> {
  tools?: {
    toolCallModel?: CoreToolCallModelSettingsLike
  }
}

export interface CoreSessionProviderSelection {
  lastProvider?: string
  lastModel?: string
}

/**
 * Explicit provider/model chosen by the caller at the moment of sending
 * (e.g. what the renderer's model picker showed). When present and its
 * config exists, this wins over session/global resolution outright —
 * the caller already computed the answer, the engine just uses it. This
 * is what makes "the picker showed X, the request went to Y" structurally
 * impossible for the send path: there is no second independent computation
 * of the same rule to diverge from the first.
 */
export interface CoreProviderSelectionOverride {
  providerId?: string
  model?: string
  /**
   * Pin the think mode for this one resolution, independent of the global
   * per-model toggle. System-internal drives (the radio DJ wake) run in
   * sessions nobody's ThinkToggle points at — this is how their settings
   * panel's think switch reaches the turn without mutating
   * settings.ai.providers[*].thinkingByModel for everyone.
   */
  thinking?: boolean
  /** Effort used only when the pinned thinking is enabled. */
  thinkingEffort?: string
}

export interface CoreEffectiveProviderConfig<TProvider extends CoreProviderConfigLike = CoreProviderConfigLike> {
  providerId: string
  providerConfig: TProvider | undefined
  model: string
}

export interface CoreProviderAuthLike {
  kind: string
  apiKey?: string
}

export interface CoreProviderAuthLogger {
  error?: (...args: unknown[]) => void
}



export interface CoreResolvedProviderConfigForChat<
  TProvider extends CoreProviderConfigLike = CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike = CoreProviderAuthLike,
> {
  providerId: string
  model: string
  providerConfig: TProvider | undefined
  authContext: TAuth
  apiKey: string
  baseUrl?: string
  temperature: number
}




export function getProviderConfig<TProvider extends CoreProviderConfigLike>(
  settings: CoreAppSettingsWithAI<TProvider>,
): TProvider | undefined {
  return settings.ai.providers[settings.ai.provider]
}

export async function getProviderApiKeyWithAdapters<TProvider extends CoreProviderConfigLike>(
  options: {
    providerId: string
    providerConfig: TProvider | undefined
    acpProviderId?: string
    isOAuthProvider: (providerId: string) => boolean
    /**
     * 第二参是 B3 盖在 config 上的运行期标记(批 B6)——「这条会话的 token 存在
     * 哪儿」。缺席 = settings(默认空间),即本参数出现之前的行为。
     */
    refreshOAuthToken: (
      providerId: string,
      credential?: CoreSpaceCredentialMarker,
    ) => Promise<{ accessToken: string }>
    resolveApiKey: (providerId: string, providerConfig: TProvider | undefined) => string | null | undefined
    logger?: CoreProviderAuthLogger
  },
): Promise<string | null> {
  // 严格隔离闸(批 B3):非 default 空间没有这个 provider 的 entry,就是未配置。
  // 挡在最前面 —— 后面每一条路(OAuth 刷新、env 兜底)都会绕过隔离。
  if (options.providerConfig?.spaceCredential?.unavailable) return null
  // 轮转 v2(批 6):config 被接力给同家另一半时,鉴权按那一家来(它是 API 密钥,不是登录)。
  const providerId = routedProviderIdOf(options.providerId, options.providerConfig)

  // External agent providers authenticate through their own CLI login;
  // the engine-side credential is deliberately empty.
  if (
    providerId === (options.acpProviderId ?? 'acp')
    || isExternalAgentExecutorProvider(providerId)
  ) {
    return ''
  }

  if (options.isOAuthProvider(providerId)) {
    try {
      const token = await options.refreshOAuthToken(
        providerId,
        options.providerConfig?.spaceCredential,
      )
      return token.accessToken
    } catch (error) {
      options.logger?.error?.(`Failed to get OAuth token for ${providerId}:`, error)
      return null
    }
  }

  return options.resolveApiKey(providerId, options.providerConfig) ?? null
}

export async function resolveProviderAuthWithAdapters<
  TProvider extends CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike,
>(
  options: {
    providerId: string
    providerConfig: TProvider | undefined
    acpProviderId?: string
    isOAuthProvider: (providerId: string) => boolean
    resolveApiKey: (providerId: string, providerConfig: TProvider | undefined) => string | null | undefined
    /** 第三参见 `refreshOAuthToken` 的同一句(批 B6)。 */
    resolveOAuthAuth: (
      providerId: string,
      apiKey?: string,
      credential?: CoreSpaceCredentialMarker,
    ) => Promise<TAuth | null>
    createApiKeyAuth?: (apiKey: string) => TAuth
    logger?: CoreProviderAuthLogger
  },
): Promise<TAuth | null> {
  const createApiKeyAuth = options.createApiKeyAuth ?? ((apiKey: string) => ({ kind: 'api-key', apiKey }) as TAuth)

  // 严格隔离闸(批 B3):见 getProviderApiKeyWithAdapters 的同一句。这里是**唯一**
  // 让「未配置」变成「起不了流」的地方 —— 上游只负责判定,不负责阻断。
  if (options.providerConfig?.spaceCredential?.unavailable) return null
  // 同上一句(批 6):被接力的 config 按接力的那一家鉴权。
  const providerId = routedProviderIdOf(options.providerId, options.providerConfig)

  if (
    providerId === (options.acpProviderId ?? 'acp')
    || isExternalAgentExecutorProvider(providerId)
  ) {
    return createApiKeyAuth('')
  }

  if (options.isOAuthProvider(providerId)) {
    try {
      return await options.resolveOAuthAuth(
        providerId,
        options.resolveApiKey(providerId, options.providerConfig) ?? undefined,
        options.providerConfig?.spaceCredential,
      )
    } catch (error) {
      options.logger?.error?.(`Failed to resolve OAuth credentials for ${providerId}:`, error)
      return null
    }
  }

  const apiKey = options.resolveApiKey(providerId, options.providerConfig) || ''
  return apiKey ? createApiKeyAuth(apiKey) : null
}

/**
 * 「这个空间的默认选择」(批 B9)。宿主注入 —— 产品层不认识「会话属于哪个空间」
 * 这件事的存储形态。缺席 = 这个空间没表达过默认(回落全局),即默认空间的行为。
 */
export interface CoreSpaceDefaultSelection {
  provider?: string
  model?: string
}

/**
 * THE resolution rule for "which provider/model does this session use":
 * an explicit override (when its config exists) wins outright — see
 * CoreProviderSelectionOverride; otherwise session.lastProvider (when its
 * config exists) wins, with lastModel falling back to that provider's
 * configured default; then the SPACE default (batch B9, when its config
 * exists); anything else is the global selection. Deliberately no inference
 * or "repair" of mismatched pairs — a wrong pair must fail loudly at the
 * provider, not silently reroute.
 *
 * The override is expected to be the renderer's own
 * resolveProviderModelSelection (packages/renderer/stores/helpers/provider-model.ts)
 * result, passed through unchanged — the send path no longer needs a second,
 * independent computation of "what should this session use" to potentially
 * diverge from what the picker showed.
 *
 * 空间默认插在**会话之下、全局之上**(批 B9):agent 绑定与会话置顶都是「这一条
 * 会话的选择」,比「这个空间的缺省」更具体;而空间默认比全局默认更具体。默认空间
 * 的调用方一律传 `undefined`,那一支一字未变。
 */
export function getEffectiveProviderConfig<TProvider extends CoreProviderConfigLike>(
  settings: CoreAppSettingsWithAI<TProvider>,
  session?: CoreSessionProviderSelection | null,
  override?: CoreProviderSelectionOverride | null,
  spaceDefault?: CoreSpaceDefaultSelection | null,
): CoreEffectiveProviderConfig<TProvider> {
  if (override?.providerId) {
    const providerId = override.providerId
    const providerConfig = settings.ai.providers[providerId]

    if (providerConfig) {
      const model = override.model || providerConfig.model || ''
      const effectiveConfig = withResolvedProviderBaseUrl(providerId, {
        ...providerConfig,
        model,
      })
      return {
        providerId,
        providerConfig: effectiveConfig,
        model,
      }
    }
    // override points at a provider with no config (e.g. deleted since the
    // picker rendered) — fall through to session/global rather than trust
    // a dangling override, same invariant as the session.lastProvider case
    // below.
  }

  if (session?.lastProvider) {
    const providerId = session.lastProvider
    const providerConfig = settings.ai.providers[providerId]

    if (providerConfig) {
      const model = session.lastModel || providerConfig.model || ''
      const effectiveConfig = withResolvedProviderBaseUrl(providerId, {
        ...providerConfig,
        model,
      })
      return {
        providerId,
        providerConfig: effectiveConfig,
        model,
      }
    }
  }

  if (spaceDefault?.provider) {
    const providerId = spaceDefault.provider
    const providerConfig = settings.ai.providers[providerId]

    if (providerConfig) {
      // 空间只钉了 provider 没钉 model 时,落回该 provider 的全局默认模型 ——
      // 与 override / session 两支同一句,不为空间另发明一条。
      const model = spaceDefault.model || providerConfig.model || ''
      const effectiveConfig = withResolvedProviderBaseUrl(providerId, {
        ...providerConfig,
        model,
      })
      return {
        providerId,
        providerConfig: effectiveConfig,
        model,
      }
    }
    // 空间默认指着一个 settings 里根本没有的 provider(删掉了 / 从没配过):
    // 与 override、session 两支同一条不变式 —— 落到全局,不去猜。注意这**不是**
    // 「这个空间没配凭证」那一档:那一档 provider 配置在,只是 entry 不在,由
    // B3 的隔离闸在下游诚实拦截(不静默改选别的)。
  }

  const providerId = settings.ai.provider
  const providerConfig = settings.ai.providers[providerId]
  const effectiveConfig = withResolvedProviderBaseUrl(providerId, providerConfig)
  return {
    providerId,
    providerConfig: effectiveConfig,
    model: effectiveConfig?.model || '',
  }
}

/**
 * Stored shape → runtime shape. Two things happen here and nowhere else:
 * the endpoint is resolved from the provider's own dials, and those dials are
 * packed into the opaque `providerOptions` bag the runtime carries.
 *
 * This is the boundary: above it configs are what the user saved (flat, named
 * fields the settings UI edits); below it they are what the runtime forwards
 * (one bag nobody in between opens). See providers/provider-options.ts.
 */
export function withResolvedProviderBaseUrl<TProvider extends CoreProviderConfigLike>(
  providerId: string,
  providerConfig: TProvider | undefined,
): TProvider | undefined {
  if (!providerConfig) return providerConfig
  const baseUrl = resolveOnethingProviderBaseUrl(providerId, providerConfig)
  const providerOptions = pickOnethingProviderOptions(
    providerId,
    providerConfig as unknown as Record<string, unknown>,
  )
  if (baseUrl === providerConfig.baseUrl && !providerOptions) return providerConfig
  return {
    ...providerConfig,
    baseUrl,
    ...(providerOptions ? { providerOptions } : {}),
  }
}

export function getCustomProviderConfig(
  settings: CoreAppSettingsWithAI,
  providerId: string,
): CoreCustomProviderConfigLike | undefined {
  return settings.ai.customProviders?.find(provider => provider.id === providerId)
}

export function getProviderApiType(
  settings: CoreAppSettingsWithAI,
  providerId: string,
): 'openai' | 'anthropic' | undefined {
  // 自定义服务商就是设置里 `customProviders[]` 有这一条的那一家 —— 按 id 查到即是,
  // 不再看 id 前缀(批 M)。
  return getCustomProviderConfig(settings, providerId)?.apiType
}

export async function resolveProviderConfigForChat<
  TProvider extends CoreProviderConfigLike,
  TAuth extends CoreProviderAuthLike,
>(
  options: {
    settings: CoreAppSettingsWithAI<TProvider>
    session?: CoreSessionProviderSelection | null
    resolveAuth: (providerId: string, providerConfig: TProvider | undefined) => TAuth | null | Promise<TAuth | null>
    /**
     * per-space 凭证覆盖(批 B3)。缺省 = 恒等,即默认空间语义。
     * 这条路径与 `getEffectiveProviderConfig` 各自读 settings,所以隔离闸也得
     * 各挂一次 —— 少挂的那一条就是漏出去的那一条。
     */
    applySpaceCredentials?: (providerId: string, providerConfig: TProvider | undefined) => TProvider | undefined
  },
): Promise<CoreResolvedProviderConfigForChat<TProvider, TAuth> | null> {
  const settings = options.settings
  const applySpace = options.applySpaceCredentials ?? ((_id: string, config: TProvider | undefined) => config)

  if (options.session?.lastProvider && options.session.lastModel) {
    const providerId = options.session.lastProvider
    const providerConfig = applySpace(providerId, settings.ai.providers[providerId])
    const authContext = await options.resolveAuth(providerId, providerConfig)

    if (authContext) {
      const effectiveConfig = withResolvedProviderBaseUrl(routedProviderIdOf(providerId, providerConfig), providerConfig)
      return {
        providerId,
        model: options.session.lastModel,
        providerConfig: effectiveConfig,
        authContext,
        apiKey: authContext.kind === 'api-key' ? authContext.apiKey ?? '' : '',
        baseUrl: effectiveConfig?.baseUrl,
        temperature: effectiveConfig?.temperature ?? settings.ai.temperature ?? 0,
      }
    }
  }

  const providerId = settings.ai.provider
  const providerConfig = applySpace(providerId, settings.ai.providers[providerId])
  const authContext = await options.resolveAuth(providerId, providerConfig)

  if (!authContext) return null
  const effectiveConfig = withResolvedProviderBaseUrl(routedProviderIdOf(providerId, providerConfig), providerConfig)

  return {
    providerId,
    model: effectiveConfig?.model || '',
    providerConfig: effectiveConfig,
    authContext,
    apiKey: authContext.kind === 'api-key' ? authContext.apiKey ?? '' : '',
    baseUrl: effectiveConfig?.baseUrl,
    temperature: effectiveConfig?.temperature ?? settings.ai.temperature ?? 0,
  }
}

export function formatProviderCredentialsError(
  providerId: string,
  isOAuthProvider: boolean,
): string {
  if (isOAuthProvider) {
    return `Not logged in to ${providerId}. Please login in settings.`
  }
  return 'API Key not configured. Please configure your AI settings.'
}
