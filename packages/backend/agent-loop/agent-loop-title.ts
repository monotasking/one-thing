// 会话标题:这里的纯函数(从首条消息截标题、规范模型给的标题、能不能覆盖现名、标题用哪个模型),以及
// 引擎「第一条消息之后起标题」那件旁路事的协作件 `SessionTitleGenerator`(2026-10-04 从 `CoreStreamEngine`
// 拆进来,拆分批 3,D227:方法正文原样,从前读引擎字段的地方改读 `SessionTitlePort`,每一格在调用那一刻回引擎取)。
import { SESSION_EVENT_TYPES } from '@shared/events/session-event-types.js'
import { isAgentExecutionCheckpointError } from './agent-loop-errors.js'
import { asRecord, authApiKey, authKind, authToken } from './agent-loop-provider-resolution.js'
import type { StreamEngineProviderAdapter, StreamEngineStoreAdapter } from './agent-loop-engine-adapters.js'
import type {
  CoreEventBusEmitterLike,
  CoreStreamMessage,
  CoreStreamSession,
  CoreStreamSettings,
} from './agent-loop-stream-engine-types.js'

export interface StreamEngineProviderConfigLike {
  model?: string
  selectedModels?: string[]
}

export interface StreamEngineToolCallModelSettings {
  providerId?: string
  model?: string
}

export interface StreamEngineSettingsWithProviders<TProviderConfig extends StreamEngineProviderConfigLike> {
  ai: {
    provider?: string
    providers: Record<string, TProviderConfig | undefined>
  }
  tools?: {
    toolCallModel?: StreamEngineToolCallModelSettings
  }
}

export function generateTitleFromMessage(content: string, maxLength: number = 30): string {
  const cleaned = content.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return cleaned.slice(0, maxLength).trim() + '...'
}

export function resolveToolCallModel<TProviderConfig extends StreamEngineProviderConfigLike>(
  settings: StreamEngineSettingsWithProviders<TProviderConfig>,
): {
  providerId: string
  providerConfig: TProviderConfig | undefined
  model: string
} {
  const configuredProviderId = settings.tools?.toolCallModel?.providerId?.trim()
  const configuredModel = settings.tools?.toolCallModel?.model?.trim()
  const fallbackProviderId = settings.ai.provider ||
    Object.entries(settings.ai.providers).find(([, config]) => Boolean(config?.model || config?.selectedModels?.[0]))?.[0] ||
    ''
  const providerId = configuredProviderId && settings.ai.providers[configuredProviderId]
    ? configuredProviderId
    : fallbackProviderId
  const providerConfig = providerId ? settings.ai.providers[providerId] : undefined
  const model = providerId === configuredProviderId && configuredModel
    ? configuredModel
    : providerConfig?.model || providerConfig?.selectedModels?.[0] || ''

  return { providerId, providerConfig, model }
}

export function normalizeSessionTitle(title: string): string {
  const cleaned = title
    .replace(/\s+/g, ' ')
    .replace(/^[`"'\u201c\u201d\u2018\u2019#:\-\s]+/, '')
    .replace(/[`"'\u201c\u201d\u2018\u2019\s]+$/, '')
    .replace(/^title\s*:\s*/i, '')
    .trim()
  return Array.from(cleaned).slice(0, 60).join('').trim()
}

export function canApplyGeneratedSessionTitle(currentName: string | undefined, expectedName: string): boolean {
  const current = (currentName || '').trim()
  const expected = (expectedName || '').trim()
  if (current === expected) return true
  return (current === '' || current === 'New Chat') && (expected === '' || expected === 'New Chat')
}

/** 起标题向引擎要的东西:每一格都在调用那一刻回引擎取。 */
export interface SessionTitlePort<
  TSettings extends CoreStreamSettings,
  TMessage extends CoreStreamMessage,
  TSession extends CoreStreamSession<TMessage>,
  TProviderConfig,
  TAuthContext,
> {
  store(): StreamEngineStoreAdapter<TSettings, TSession, TMessage>
  provider(): StreamEngineProviderAdapter<TSettings, TProviderConfig, TAuthContext>
  eventBus(): CoreEventBusEmitterLike | null
  logError(message: string, error: unknown): void
}

/**
 * 第一条用户消息之后给会话起标题(发后不管的旁路,失败只记日志)。同一会话后起的一次顶掉先起的一次:
 * 每次起标题领一个序号,落名之前核对序号还是不是自己的。
 */
export class SessionTitleGenerator<
  TSettings extends CoreStreamSettings,
  TMessage extends CoreStreamMessage,
  TSession extends CoreStreamSession<TMessage>,
  TProviderConfig,
  TAuthContext,
> {
  private sessionTitleGenerations = new Map<string, number>()

  private titleGenerationSeq = 0


  constructor(
    private readonly port: SessionTitlePort<TSettings, TMessage, TSession, TProviderConfig, TAuthContext>,
  ) {}

  /** 这条会话没了:它在飞的那次起标题不再落名。 */
  forgetSession(sessionId: string): void {
    this.sessionTitleGenerations.delete(sessionId)
  }

  /** 引擎收摊:所有在飞的起标题都不再落名。 */
  clear(): void {
    this.sessionTitleGenerations.clear()
  }

  async generateAndApplySessionTitle(
    sessionId: string,
    displayContent: string,
    expectedSessionName: string,
  ): Promise<void> {
    const requestId = ++this.titleGenerationSeq
    this.sessionTitleGenerations.set(sessionId, requestId)

    try {
      const generatedTitle = await this.generateSessionTitle(sessionId, displayContent)
      const title = normalizeSessionTitle(generatedTitle) || generateTitleFromMessage(displayContent)
      if (!title) return

      if (this.sessionTitleGenerations.get(sessionId) !== requestId) return

      const session = this.port.store().getSession(sessionId)
      if (!session) return
      if (!canApplyGeneratedSessionTitle(session.name, expectedSessionName)) {
        return
      }
      if (session.name === title) return

      this.port.store().renameSession(sessionId, title)
      await this.port.eventBus()?.emit(sessionId, {
        type: SESSION_EVENT_TYPES.SESSION_RENAMED,
        name: title,
      })
    } catch (error) {
      if (isAgentExecutionCheckpointError(error)) throw error
      const fallbackTitle = generateTitleFromMessage(displayContent)
      const session = this.port.store().getSession(sessionId)
      if (
        session &&
        fallbackTitle &&
        this.sessionTitleGenerations.get(sessionId) === requestId &&
        canApplyGeneratedSessionTitle(session.name, expectedSessionName)
      ) {
        this.port.store().renameSession(sessionId, fallbackTitle)
        await this.port.eventBus()?.emit(sessionId, {
          type: SESSION_EVENT_TYPES.SESSION_RENAMED,
          name: fallbackTitle,
        })
      }
      this.port.logError('Falling back to local chat title:', error)
    } finally {
      if (this.sessionTitleGenerations.get(sessionId) === requestId) {
        this.sessionTitleGenerations.delete(sessionId)
      }
    }
  }

  private async generateSessionTitle(sessionId: string, displayContent: string): Promise<string> {
    // Title generation resolves off settings directly, so it needs the same
    // session-scoped view the send path gets — otherwise a session in another
    // workspace titles itself with a model that workspace never selected.
    const settings = this.port.store().getSettingsForSession?.(sessionId) ?? this.port.store().getSettings()
    const { providerId, providerConfig: rawProviderConfig, model } = resolveToolCallModel(
      settings as unknown as StreamEngineSettingsWithProviders<{ model?: string; selectedModels?: string[] }>,
    )
    if (!providerId || !rawProviderConfig || !model) {
      return generateTitleFromMessage(displayContent)
    }

    if (!this.port.provider().isSupported(providerId)) {
      return generateTitleFromMessage(displayContent)
    }

    // Title generation resolves its provider straight off settings rather than
    // through getEffectiveConfig, so the host's per-session credential scoping
    // has to be applied here too — otherwise a session whose workspace has its
    // own keys would still bill its title to the global ones.
    const providerConfig = this.port.provider().applySpaceCredentials?.(
      sessionId,
      providerId,
      rawProviderConfig as TProviderConfig,
    ) ?? (rawProviderConfig as TProviderConfig)

    const authContext = await this.port.provider().resolveAuth(providerId, providerConfig)
    if (!authContext) {
      return generateTitleFromMessage(displayContent)
    }

    const apiType = this.port.provider().getApiType(settings, providerId)
    const providerConfigRecord = asRecord(providerConfig)
    return this.port.provider().generateTitle(
      providerId,
      {
        ...providerConfigRecord,
        apiKey: authKind(authContext) === 'api-key' ? authApiKey(authContext) : '',
        authContext,
        oauthToken: authKind(authContext) === 'oauth' ? authToken(authContext) : providerConfigRecord.oauthToken,
        baseUrl: providerConfigRecord.baseUrl,
        model,
        apiType,
      },
      displayContent,
      {
        thinking: settings.tools?.toolCallModel?.thinking === true,
        thinkingEffort: settings.tools?.toolCallModel?.thinkingEffort,
        debugSessionId: sessionId,
      },
    )
  }
}
