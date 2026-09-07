/**
 * Forced opening tool choice, as it travels through the engine (W18b, narrowed
 * to a NAMED tool by W22). Structurally a subset of the agent loop's
 * `AgentToolChoice`: 'auto'/'none' are the loop's own defaults and never ride
 * down a drive. Nothing on this path READS it — it is a passthrough from the
 * send-message command to `runAgentLoop`.
 */
import type { Principal } from '../permission/principal.js'

export type CoreInitialToolChoice =
  | 'required'
  | { type: 'function'; function: { name: string } }

export interface CoreStreamExecutionRoute {
  kind: 'special' | 'text'
}

export interface CoreStreamExecutionResult {
  handled: boolean
  usedSpecialStream: boolean
  pausedForConfirmation?: boolean
  shouldRemoveController: boolean
}

export interface CoreStreamProviderConfigWithKey {
  apiKey: string
  model: string
  baseUrl?: string
}

export interface CoreStreamControllerLike<TSignal = unknown> {
  signal: TSignal
}

export interface CoreStreamControllerRegistry<
  TController extends CoreStreamControllerLike,
  TQueue = unknown,
> {
  registerController(sessionId: string, controller: TController): void
  removeController(sessionId: string, expectedController?: TController): void
  getSteeringQueue(sessionId: string): TQueue | undefined
  getFollowUpQueue(sessionId: string): TQueue | undefined
}

export interface CoreMessageStreamParams<
  TSender,
  TSettings,
  TProviderConfig extends CoreStreamProviderConfigWithKey,
  TToolSettings,
  THistoryMessage,
  TOutputModality,
> {
  sender: TSender
  sessionId: string
  assistantMessageId: string
  messageContent: string
  historyMessages: THistoryMessage[]
  configWithApiKey: TProviderConfig
  providerId: string
  requestedOutputModalities?: TOutputModality[]
  settings: TSettings
  toolSettings?: TToolSettings
  sessionName?: string
  voiceConversation?: boolean
  speakMode?: boolean
  /** Billing attribution label for this turn ('chat' when absent). */
  usageSource?: string
  /** Force the run's first model call into a (named) tool call — drives only. */
  initialToolChoice?: CoreInitialToolChoice
  /** Actor behind this turn; minted at the host boundary (permission/principal.ts). */
  principal?: Principal
  executionContext?: unknown
}

export type CoreTextStreamContext<
  TSender,
  TSettings,
  TProviderConfig extends CoreStreamProviderConfigWithKey,
  TToolSettings,
  TOutputModality,
  TQueue,
  TSignal,
> = {
  sender: TSender
  sessionId: string
  assistantMessageId: string
  abortSignal: TSignal
  settings: TSettings
  providerConfig: TProviderConfig
  providerId: string
  requestedOutputModalities?: TOutputModality[]
  toolSettings?: TToolSettings
  steeringQueue?: TQueue
  followUpQueue?: TQueue
  voiceConversation?: boolean
  speakMode?: boolean
  /** Billing attribution label for this turn ('chat' when absent). */
  usageSource?: string
  /** Force the run's first model call into a (named) tool call — drives only. */
  initialToolChoice?: CoreInitialToolChoice
  /** Actor behind this turn; minted at the host boundary (permission/principal.ts). */
  principal?: Principal
  executionContext?: unknown
}

export interface CoreSpecialStreamExecutionInput<
  TSender,
  TProviderConfig extends CoreStreamProviderConfigWithKey,
> {
  sender: TSender
  sessionId: string
  assistantMessageId: string
  prompt: string
  providerId: string
  apiKey: string
  model: TProviderConfig['model']
  baseUrl?: TProviderConfig['baseUrl']
  sessionName?: string
}

export interface ExecuteCoreMessageStreamOptions<
  TSender,
  TSettings,
  TProviderConfig extends CoreStreamProviderConfigWithKey,
  TToolSettings,
  THistoryMessage,
  TOutputModality,
  TQueue,
  TSignal,
  TController extends CoreStreamControllerLike<TSignal>,
  TTextGenerationResult extends { pausedForConfirmation?: boolean },
> {
  params: CoreMessageStreamParams<TSender, TSettings, TProviderConfig, TToolSettings, THistoryMessage, TOutputModality>
  controller?: TController
  createController: () => TController
  registry: CoreStreamControllerRegistry<TController, TQueue>
  supportsSpecialStream(model: TProviderConfig['model'], providerId: string): Promise<boolean>
  processSpecialStream(input: CoreSpecialStreamExecutionInput<TSender, TProviderConfig>): Promise<boolean>
  executeTextStream(
    ctx: CoreTextStreamContext<TSender, TSettings, TProviderConfig, TToolSettings, TOutputModality, TQueue, TSignal>,
    historyMessages: THistoryMessage[],
    sessionName?: string,
  ): Promise<TTextGenerationResult>
  logger?: {
    log?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
  }
}

export function resolveStreamExecutionRoute(options: {
  supportsSpecialStream: boolean
}): CoreStreamExecutionRoute {
  return { kind: options.supportsSpecialStream ? 'special' : 'text' }
}

export function specialStreamExecutionResult(handled: boolean): CoreStreamExecutionResult {
  return {
    handled,
    usedSpecialStream: true,
    pausedForConfirmation: false,
    shouldRemoveController: true,
  }
}

export function textStreamExecutionResult(result: { pausedForConfirmation?: boolean }): CoreStreamExecutionResult {
  const pausedForConfirmation = result.pausedForConfirmation
  return {
    handled: true,
    usedSpecialStream: false,
    pausedForConfirmation,
    shouldRemoveController: !pausedForConfirmation,
  }
}

export function streamExecutionErrorResult(): Pick<CoreStreamExecutionResult, 'shouldRemoveController'> {
  return {
    shouldRemoveController: true,
  }
}

export function buildTextStreamContext<TBase extends object, TQueue>(options: {
  base: TBase
  steeringQueue?: TQueue
  followUpQueue?: TQueue
  voiceConversation?: boolean
  speakMode?: boolean
}): TBase & {
  steeringQueue?: TQueue
  followUpQueue?: TQueue
  voiceConversation?: boolean
  speakMode?: boolean
} {
  return {
    ...options.base,
    steeringQueue: options.steeringQueue,
    followUpQueue: options.followUpQueue,
    voiceConversation: options.voiceConversation,
    speakMode: options.speakMode ?? options.voiceConversation,
  }
}

export async function executeCoreMessageStream<
  TSender,
  TSettings,
  TProviderConfig extends CoreStreamProviderConfigWithKey,
  TToolSettings,
  THistoryMessage,
  TOutputModality,
  TQueue,
  TSignal,
  TController extends CoreStreamControllerLike<TSignal>,
  TTextGenerationResult extends { pausedForConfirmation?: boolean },
>(
  options: ExecuteCoreMessageStreamOptions<
    TSender,
    TSettings,
    TProviderConfig,
    TToolSettings,
    THistoryMessage,
    TOutputModality,
    TQueue,
    TSignal,
    TController,
    TTextGenerationResult
  >,
): Promise<CoreStreamExecutionResult> {
  const {
    sender,
    sessionId,
    assistantMessageId,
    messageContent,
    historyMessages,
    configWithApiKey,
    providerId,
    requestedOutputModalities,
    settings,
    toolSettings,
    sessionName,
    voiceConversation,
    speakMode,
    usageSource,
    initialToolChoice,
    principal,
    executionContext,
  } = options.params
  const logger = options.logger ?? console
  const controller = options.controller ?? options.createController()
  options.registry.registerController(sessionId, controller)

  try {
    const supportsSpecialStream = await options.supportsSpecialStream(configWithApiKey.model, providerId)
    const route = resolveStreamExecutionRoute({ supportsSpecialStream })

    if (route.kind === 'special') {
      logger.log?.(`[StreamExecutor] Using special stream route for model: ${configWithApiKey.model}`)
      const handled = await options.processSpecialStream({
        sender,
        sessionId,
        assistantMessageId,
        prompt: messageContent,
        providerId,
        apiKey: configWithApiKey.apiKey,
        model: configWithApiKey.model,
        baseUrl: configWithApiKey.baseUrl,
        sessionName,
      })

      const result = specialStreamExecutionResult(handled)
      if (result.shouldRemoveController) options.registry.removeController(sessionId, controller)
      return result
    }

    logger.log?.(`[StreamExecutor] Using text streaming for model: ${configWithApiKey.model}`)
    const ctx = buildTextStreamContext({
      base: {
        sender,
        sessionId,
        assistantMessageId,
        abortSignal: controller.signal,
        settings,
        providerConfig: configWithApiKey,
        providerId,
        requestedOutputModalities,
        toolSettings,
        usageSource,
        initialToolChoice,
        principal,
        executionContext,
      },
      steeringQueue: options.registry.getSteeringQueue(sessionId),
      followUpQueue: options.registry.getFollowUpQueue(sessionId),
      voiceConversation,
      speakMode,
    })

    const generationResult = await options.executeTextStream(
      ctx,
      historyMessages,
      sessionName,
    )
    const result = textStreamExecutionResult(generationResult)
    if (result.shouldRemoveController) {
      options.registry.removeController(sessionId, controller)
    }
    return result
  } catch (error) {
    logger.error?.('[StreamExecutor] Error:', error)
    if (streamExecutionErrorResult().shouldRemoveController) {
      options.registry.removeController(sessionId, controller)
    }
    throw error
  }
}
