// 服务商解析:这条会话该用哪个 provider、凭证从哪来;解不出来时把原因交出去,并在账本上开一轮、
// 立刻收成 error。2026-10-04 从 `CoreStreamEngine` 拆出的协作件(拆分批 3,D227):方法正文原样,
// 从前读引擎字段的地方改读 `ProviderResolutionPort`(每一格在调用那一刻回引擎取,子类覆写照旧生效)。
import { SESSION_EVENT_TYPES } from '@shared/events/session-event-types.js'
import type {
  StreamEngineProviderAdapter,
  StreamEngineStoreAdapter,
  StreamEngineStreamsAdapter,
} from './agent-loop-engine-adapters.js'
import type {
  CoreEventBusEmitterLike,
  CoreProviderConfigWithKeyLike,
  CoreStreamMessage,
  CoreStreamSession,
  CoreStreamSettings,
} from './agent-loop-stream-engine-types.js'

/**
 * provider 解析**没解出来**的那一格(2026-08-31)。
 *
 * 从前解析失败只发一条 `stream:error` 浮窗就 `return` —— 账本上只剩一条
 * `user/message`,没有 `run/start` 也没有 `run/end`。翻账本的人(和只认账本的新壳)
 * 因此对"发了没反应"一个字都说不出来;而同一条会话里 provider 真的**答**了个 402,
 * 账本却是完整的 `run/start → request/error → run/end outcome=error`。
 * 同一件事(这一轮没有回答)在账本上有两种形状,其中一种是沉默。
 *
 * 这个描述符让"解不出来"走成与请求错误同一种形状:开 run,立刻 `run/end
 * outcome='error'`,`error.name` / `error.message` 是结构化原因。
 */
export interface CoreProviderResolutionFailure {
  failed: true
  /** `ProviderNotConfigured`(没凭证 / 没登录)| `ProviderUnsupported`。 */
  name: string
  /** 人话,**必须自带 providerId** —— 账本的读者手上没有别的上下文。 */
  message: string
  providerId: string
  /** 解析到失败那一刻手上的模型名(`getEffectiveConfig` 先于鉴权算出来)。 */
  model: string
}

export function isCoreProviderResolutionFailure(
  value: unknown,
): value is CoreProviderResolutionFailure {
  return !!value && (value as CoreProviderResolutionFailure).failed === true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function authKind(authContext: unknown): string | undefined {
  const record = asRecord(authContext)
  return typeof record.kind === 'string' ? record.kind : undefined
}

export function authApiKey(authContext: unknown): string {
  const record = asRecord(authContext)
  return typeof record.apiKey === 'string' ? record.apiKey : ''
}

export function authToken(authContext: unknown): unknown {
  return asRecord(authContext).token
}

/** 服务商解析向引擎要的东西:每一格都在调用那一刻回引擎取。 */
export interface ProviderResolutionPort<
  TSettings extends CoreStreamSettings,
  TMessage extends CoreStreamMessage,
  TSession extends CoreStreamSession<TMessage>,
  TProviderConfig,
  TAuthContext,
  THistoryMessage,
  TStreamResult,
> {
  store(): StreamEngineStoreAdapter<TSettings, TSession, TMessage>
  provider(): StreamEngineProviderAdapter<TSettings, TProviderConfig, TAuthContext>
  streams(): StreamEngineStreamsAdapter<THistoryMessage, TStreamResult>
  eventBus(): CoreEventBusEmitterLike | null
  createMessageId(): string
  now(): number
  emitStreamError(sessionId: string, error: string): void
}

export class ProviderResolution<
  TSettings extends CoreStreamSettings,
  TMessage extends CoreStreamMessage,
  TSession extends CoreStreamSession<TMessage>,
  TProviderConfig,
  TProviderConfigWithKey extends CoreProviderConfigWithKeyLike,
  TAuthContext,
  THistoryMessage,
  TStreamResult,
> {
  constructor(
    private readonly port: ProviderResolutionPort<
      TSettings, TMessage, TSession, TProviderConfig, TAuthContext, THistoryMessage, TStreamResult
    >,
  ) {}

  /**
   * 解析这条会话该用哪个 provider,**解不出来时把原因交出去**。
   *
   * 本体在 `resolveProviderOrFailure`;这一层保留 `| null` 的老形状,给那三个
   * 今天只需要"停下来"的入口(compact / edit-resend / retry / resume)用 ——
   * 它们的行为一字未改。
   */
  async resolveProvider(
    sessionId: string,
    override?: { providerId?: string; model?: string; thinking?: boolean; thinkingEffort?: string } | null,
  ): Promise<{
    configWithApiKey: TProviderConfigWithKey
    providerId: string
    settings: TSettings
  } | null> {
    const resolved = await this.resolveProviderOrFailure(sessionId, override)
    return isCoreProviderResolutionFailure(resolved) ? null : resolved
  }

  async resolveProviderOrFailure(
    sessionId: string,
    override?: { providerId?: string; model?: string; thinking?: boolean; thinkingEffort?: string } | null,
  ): Promise<{
    configWithApiKey: TProviderConfigWithKey
    providerId: string
    settings: TSettings
  } | CoreProviderResolutionFailure> {
    const settings = this.port.store().getSettings()
    const { providerId, providerConfig, model: effectiveModel } = this.port.provider().getEffectiveConfig(settings, sessionId, override)

    const authContext = await this.port.provider().resolveAuth(providerId, providerConfig)
    if (!authContext) {
      // The host may know a more specific reason than "no key" — e.g. this
      // session's workspace has its own credential pool and this provider is
      // not in it. Falling back keeps the message identical when it doesn't.
      const described = this.port.provider().describeMissingCredentials?.(
        providerId,
        providerConfig,
        sessionId,
      )
      const isOAuth = this.port.provider().requiresOAuth(providerId)
      this.port.emitStreamError(sessionId, described || (isOAuth
        ? `Not logged in to ${providerId}. Please login in settings.`
        : 'API Key not configured. Please configure your AI settings.'))
      return {
        failed: true,
        name: 'ProviderNotConfigured',
        // 账本上那一格与 `stream:error` 那一句**故意不是同一个字符串**:浮窗那句
        // 保持逐字不变(改它是一次没经裁定的可感知变化),而账本这句必须自己说清
        // 是哪个 provider —— 事后翻 events.jsonl 的人手上没有别的上下文。
        message: described || (isOAuth
          ? `Not logged in to ${providerId}. Please login in settings.`
          : `API key not configured for ${providerId}. Please configure your AI settings.`),
        providerId,
        model: effectiveModel,
      }
    }

    if (!this.port.provider().isSupported(providerId)) {
      this.port.emitStreamError(sessionId, `Unsupported provider: ${providerId}`)
      return {
        failed: true,
        name: 'ProviderUnsupported',
        message: `Unsupported provider: ${providerId}`,
        providerId,
        model: effectiveModel,
      }
    }

    const providerConfigRecord = asRecord(providerConfig)
    const selectedModels = Array.isArray(providerConfigRecord.selectedModels)
      ? providerConfigRecord.selectedModels.filter((model): model is string => typeof model === 'string')
      : [effectiveModel]

    const configWithApiKey = {
      ...providerConfigRecord,
      model: effectiveModel,
      selectedModels,
      apiKey: authKind(authContext) === 'api-key' ? authApiKey(authContext) : '',
      authContext,
      oauthToken: authKind(authContext) === 'oauth' ? authToken(authContext) : providerConfigRecord.oauthToken,
    } as TProviderConfigWithKey

    return { configWithApiKey, providerId, settings }
  }

  /**
   * 「这一轮没有回答,因为 provider 解不出来」——**在账本上说出来**(2026-08-31)。
   *
   * 形状与请求错误那条路逐格相同:占位入库 → `run/start` → 立刻
   * `run/end outcome='error'`。于是 `events.jsonl` 上不再是一条孤零零的
   * `user/message`,投影物化出的那条助手消息带着 `errorDetails`
   * (`materializeAssistantNode`),壳的错误卡路径因此有话可说。
   *
   * 三处纪律,少一条就是一个新 bug:
   *
   * 1. **`isStreaming: true` 必须盖**。命令面按它分流:流式 assistant 占位一条
   *    事件都不写(`run/start` 才是它那一格),不盖就会多写一条 `system/message`,
   *    账本上同一条消息出现两次(`command-events.ts` 的 `appendMessage`)。
   * 2. **入库与开账同一同步段**(c4-d):`addMessage` 与 `openAssistantRun` 之间
   *    不许有 `await`。
   * 3. **开了就得收**:预开的 run 是 `claimed:false`,而这条路根本不进
   *    `executeMessageStream`,没有 finally 会收它 —— `failAssistantRun` 就是那个
   *    收尾人。宿主没接这一口(没有账本)时整条路降级成本修之前的行为。
   */
  async failRunWithProviderError(
    sessionId: string,
    userMessage: TMessage,
    failure: CoreProviderResolutionFailure,
  ): Promise<void> {
    // **两口一起才成立**:开了没人收,账本上就留一条永远"在生成中"的 run;
    // 收得了却开不出,那条占位是流式的(纪律 1),命令面一条事件都不写 ——
    // 它在账本上根本不存在。缺一口就整条路退回本修之前的行为(浮窗已经发了)。
    if (!this.port.streams().openAssistantRun || !this.port.streams().failAssistantRun) return

    const trigger = userMessage as unknown as { id: string; origin?: unknown }
    const assistantMessageId = this.port.createMessageId()
    const assistantMessage = {
      id: assistantMessageId,
      role: 'assistant',
      model: failure.model,
      provider: failure.providerId,
      content: '',
      timestamp: this.port.now(),
      // 纪律 1 —— 见上。`run/end` 一落账,投影里这一格就是 `ended`,
      // 物化出去的那条消息上 `isStreaming` 整格不出现。
      isStreaming: true,
      toolCalls: [],
      errorDetails: failure.message,
      ...(trigger.origin !== undefined ? { origin: trigger.origin } : {}),
    } as unknown as TMessage

    // F4-a(§16.12):往下递的是**入库的那一条**,不是手里这条。
    const storedAssistantMessage = this.port.store().addMessage(sessionId, assistantMessage)
    // 纪律 2 —— 这一行与上一行之间不许有 await。
    this.port.streams().openAssistantRun!({
      sessionId,
      assistantMessageId,
      assistantMessage: storedAssistantMessage,
      runKind: 'send',
      triggerMessageId: trigger.id,
      providerId: failure.providerId,
      model: failure.model,
    })

    await this.port.eventBus()?.emit(sessionId, {
      type: SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED,
      message: assistantMessage,
    })

    const error = new Error(failure.message)
    error.name = failure.name
    // 纪律 3 —— 见上。
    await this.port.streams().failAssistantRun!({
      sessionId,
      assistantMessageId,
      error,
    })
  }
}
