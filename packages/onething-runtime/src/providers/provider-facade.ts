import type {
  AgentJsonObject,
  AgentProvider,
  AgentProviderData,
} from '@onething/core/agent-loop'
import {
  runOnethingUtilityAgentTurn,
  type OnethingProviderRequestDumpContext,
  type OnethingProviderRequestDumpMode,
  type OnethingUtilityAgentMessage,
} from './agent-turn.js'
import {
  isOnethingACPProviderRuntime,
  type OnethingAgentRuntimeProviderConfig,
} from './agent-runtime-route.js'
import {
  type OnethingProviderOpaqueValue,
  type OnethingToolChatMessage,
} from './message-conversion.js'
import {
  generateOnethingChatResponseWithReasoning,
  generateOnethingProviderChatTitle,
  generateOnethingTextChatResponse,
  mergeOnethingSystemMessagesForGenerateIfNeeded,
  streamOnethingACPChatResponseWithTools,
  type OnethingACPPromptStreamEvent,
  type OnethingACPReasoningStreamChunk,
  type OnethingACPStreamPromptRequest,
  type OnethingProviderRuntimeChatRoute,
  type OnethingProviderTokenUsage,
  type OnethingThinkingEffort,
} from './provider-routing.js'
import { resolveOnethingOAuthProviderConfig } from './oauth-config.js'

export type OnethingProviderFacadeConfig = OnethingAgentRuntimeProviderConfig & {
  model: string
  fetchImpl?: typeof globalThis.fetch
}

export interface OnethingProviderFacadeToolCall {
  toolCallId: string
  toolName: string
  args: AgentJsonObject
}

export interface OnethingProviderFacadeChatResponseResult {
  text: string
  reasoning?: string
  toolCalls?: OnethingProviderFacadeToolCall[]
}

export interface OnethingProviderFacadeStreamChunkWithTools {
  type:
    | 'text'
    | 'reasoning'
    | 'tool-call'
    | 'tool-result'
    | 'finish'
    | 'tool-input-start'
    | 'tool-input-delta'
    | 'tool-input-end'
    | 'provider-data'
  text?: string
  reasoning?: string
  toolCall?: OnethingProviderFacadeToolCall
  toolResult?: {
    toolCallId: string
    result: OnethingProviderOpaqueValue
  }
  toolInputStart?: { toolCallId: string; toolName: string }
  toolInputDelta?: { toolCallId: string; argsTextDelta: string }
  toolInputEnd?: { toolCallId: string }
  finishReason?:
    | 'stop'
    | 'length'
    | 'tool-calls'
    | 'content-filter'
    | 'error'
    | 'other'
    | 'unknown'
  providerData?: AgentProviderData
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
}

export type OnethingProviderFacadeReasoningStreamChunk =
  | { type: 'text'; text: string; reasoning?: string }
  | {
      type: 'finish'
      usage: { inputTokens: number; outputTokens: number; totalTokens: number }
    }

export interface OnethingProviderFacadeStreamCallbacks {
  onReasoningDelta?: (delta: string) => void
  onTextDelta?: (delta: string) => void
  onComplete?: (result: OnethingProviderFacadeChatResponseResult) => void
  onError?: (error: Error) => void
}

export type OnethingProviderFacadeRawPrimitive = string | number | boolean | null | undefined
export type OnethingProviderFacadeRawRecord = { [key: string]: OnethingProviderFacadeRawValue }
export type OnethingProviderFacadeRawValue =
  | OnethingProviderFacadeRawPrimitive
  | OnethingProviderFacadeRawRecord
  | OnethingProviderFacadeRawValue[]
  | Error
  | object

export interface OnethingChatGenerationOptions {
  temperature?: number
  maxTokens?: number
  abortSignal?: AbortSignal
  thinking?: boolean
  thinkingEffort?: OnethingThinkingEffort
  serviceTier?: string
  debugPurpose?: string
  debugSessionId?: string
  /**
   * Side channel for token usage. generateChatResponse returns the text (a
   * contract with callers across the repo), so side-line callers that need to
   * bill their tokens — title generation, memory capture/review — read them
   * here instead. Stripped before the options reach the provider.
   */
  onUsage?: (usage: OnethingProviderTokenUsage) => void
  /**
   * Side channel for the provider's stop reason. `'length'` = max_tokens cut
   * the output. Compaction fails loudly on it instead of storing a half summary.
   */
  onFinish?: (info: { finishReason?: string }) => void
}

export interface OnethingProviderFacadeAdapters<
  TConfig extends OnethingProviderFacadeConfig = OnethingProviderFacadeConfig,
  TProvider extends AgentProvider = AgentProvider,
> {
  requiresOAuth(providerId: string): boolean
  refreshOAuthToken(providerId: string): Promise<{ accessToken: string }>
  requiresSystemMerge(providerId: string): boolean
  resolveRuntimeRoute(providerId: string, config: TConfig): OnethingProviderRuntimeChatRoute<TProvider>
  createRequiredFetch(): typeof globalThis.fetch
  dumpProviderRequest?(context: OnethingProviderRequestDumpContext): void | Promise<void>
  streamACPPrompt(
    agentId: string,
    request: OnethingACPStreamPromptRequest,
  ): AsyncIterable<OnethingACPPromptStreamEvent>
  defaultWorkingDirectory?(): string
  isACPProvider?(providerId: string): boolean
  logger?: Pick<Console, 'error'>
}

export interface OnethingProviderFacade<
  TConfig extends OnethingProviderFacadeConfig = OnethingProviderFacadeConfig,
  TProvider extends AgentProvider = AgentProvider,
> {
  generateChatResponse(
    providerId: string,
    config: TConfig,
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    options?: OnethingChatGenerationOptions,
  ): Promise<string>
  generateChatTitle(
    providerId: string,
    config: TConfig,
    userMessage: string,
    options?: Pick<
      OnethingChatGenerationOptions,
      'thinking' | 'thinkingEffort' | 'serviceTier' | 'debugSessionId' | 'onUsage'
    >,
  ): Promise<string>
}

function withDeepSeekFetch<TConfig extends OnethingProviderFacadeConfig>(
  config: TConfig,
  adapters: Pick<OnethingProviderFacadeAdapters<TConfig>, 'createRequiredFetch'>,
): TConfig {
  return {
    ...config,
    fetchImpl: config.fetchImpl ?? adapters.createRequiredFetch(),
  }
}

export function createOnethingProviderFacade<
  TConfig extends OnethingProviderFacadeConfig = OnethingProviderFacadeConfig,
  TProvider extends AgentProvider = AgentProvider,
>(
  adapters: OnethingProviderFacadeAdapters<TConfig, TProvider>,
): OnethingProviderFacade<TConfig, TProvider> {
  const onRequestPrepared = adapters.dumpProviderRequest

  const runUtilityTurn = async (
    providerId: string,
    provider: TProvider,
    config: TConfig,
    messages: OnethingUtilityAgentMessage[],
    options: OnethingChatGenerationOptions,
    mode: OnethingProviderRequestDumpMode,
  ): Promise<OnethingProviderFacadeChatResponseResult | undefined> =>
    runOnethingUtilityAgentTurn({
      providerId,
      provider,
      config,
      messages,
      options,
      mode,
      onRequestPrepared,
    }) as Promise<OnethingProviderFacadeChatResponseResult | undefined>

  const mergeMessagesForGenerate = (
    providerId: string,
    messages: OnethingUtilityAgentMessage[],
  ): OnethingUtilityAgentMessage[] =>
    mergeOnethingSystemMessagesForGenerateIfNeeded(
      adapters.requiresSystemMerge(providerId),
      messages,
    ) as OnethingUtilityAgentMessage[]

  const streamACPWithTools = async function* (
    config: TConfig,
    messages: OnethingToolChatMessage[],
    options: {
      abortSignal?: AbortSignal
      debugSessionId?: string
      workingDirectory?: string
    } = {},
  ): AsyncGenerator<OnethingProviderFacadeStreamChunkWithTools, void, void> {
    yield* (streamOnethingACPChatResponseWithTools({
      config,
      messages,
      options,
      defaultWorkingDirectory: adapters.defaultWorkingDirectory?.() ?? process.cwd(),
      streamPrompt: (agentId, request) => adapters.streamACPPrompt(agentId, request),
    }) as AsyncGenerator<OnethingProviderFacadeStreamChunkWithTools, void, void>)
  }

  /**
   * Not part of the facade surface: the only caller is `generateChatResponse`
   * below. It stays a distinct function because it is where the acp/deepseek
   * generate routes live — see docs/design/provider-abstraction.md §9.
   */
  const generateChatResponseWithReasoning = (
    providerId: string,
    config: TConfig,
    messages: OnethingUtilityAgentMessage[],
    options: OnethingChatGenerationOptions = {},
  ): Promise<OnethingProviderFacadeChatResponseResult> =>
    generateOnethingChatResponseWithReasoning({
      providerId,
      config,
      messages,
      options,
      streamACPResponse: (runtimeConfig, runtimeMessages, runtimeOptions) =>
        streamACPWithTools(
          runtimeConfig,
          runtimeMessages as OnethingToolChatMessage[],
          runtimeOptions,
        ) as AsyncIterable<OnethingACPReasoningStreamChunk>,
      mergeMessagesForGenerate,
      resolveRuntimeRoute: adapters.resolveRuntimeRoute,
      runUtilityAgentTurn: runUtilityTurn,
    }) as Promise<OnethingProviderFacadeChatResponseResult>

  const facade: OnethingProviderFacade<TConfig, TProvider> = {
    generateChatResponse(providerId, config, messages, options = {}) {
      // onUsage is ours, not the provider's — keep it out of the request.
      const { onUsage, onFinish, ...providerOptions } = options
      return generateOnethingTextChatResponse({
        providerId,
        config,
        messages,
        options: providerOptions,
        onUsage,
        onFinish,
        generateWithReasoning: generateChatResponseWithReasoning,
      })
    },

    generateChatTitle(providerId, config, userMessage, options = {}) {
      return generateOnethingProviderChatTitle({
        providerId,
        config,
        userMessage,
        options,
        isACPProvider: adapters.isACPProvider ?? isOnethingACPProviderRuntime,
        generateChatResponse: facade.generateChatResponse,
      })
    },
  }

  return facade
}
