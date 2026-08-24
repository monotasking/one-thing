/**
 * Provider facade.
 *
 * onething-runtime owns provider orchestration; Electron main only binds host
 * adapters such as OAuth, ACP prompt streaming, request dumps, and app fetch.
 */

import type { ThinkingEffort, UIMessage } from '@shared/ipc.js'
import {
  createOnethingProviderFacade,
  type OnethingAIMessageContent,
  type OnethingProviderFacadeChatResponseResult,
  type OnethingProviderFacadeRawRecord,
  type OnethingProviderFacadeReasoningStreamChunk,
  type OnethingProviderFacadeStreamCallbacks,
  type OnethingProviderFacadeStreamChunkWithTools,
  type OnethingProviderFacadeToolCall,
  type OnethingToolChatMessage,
} from '@onething/runtime/providers'
import { ACPManager } from '@onething/runtime/acp'
import type {
  AgentProvider,
} from '@onething/core/agent-loop'
import { oauthManager } from './auth/oauth-manager.js'
import * as modelRegistry from './model-registry.js'
import {
  createRequiredAppFetch,
} from '../../provider-binding/bound-fetch.js'
import {
  isACPProviderRuntime as isACPProvider,
  resolveProviderRuntimeRoute,
  type AgentRuntimeProviderConfig,
  type ProviderToolDefinitionMap,
  type ProviderToolSourceDefinition,
} from './agent-runtime.js'
import {
  dumpProviderRequest,
  type ProviderRequestDumpMode,
} from '../../provider-binding/request-dump.js'
import {
  getAvailableProviders as getProvidersFromRegistry,
  getProviderInfo as getInfoFromRegistry,
  initializeRegistry,
  isProviderSupported as isSupportedFromRegistry,
  requiresOAuth as requiresOAuthFromRegistry,
  requiresSystemMerge as requiresSystemMergeFromRegistry,
} from './registry.js'
import type {
  ProviderConfig,
  ProviderInfo,
} from '@onething/runtime/providers/types.wiring'
import { consolePort, getLogger } from '../logging/index.js'
import type { OnethingChatGenerationOptions, OnethingProviderFacadeAdapters } from '@onething/runtime/providers/provider-facade'

const log = getLogger('providers')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


type RuntimeProviderConfig = ProviderConfig & AgentRuntimeProviderConfig & {
  fetchImpl?: typeof globalThis.fetch
}

export type {
  ProviderExecutableToolDefinition,
  ProviderToolDefinitionInput,
  ProviderToolDefinitionMap,
  ProviderToolParameter,
  ProviderToolSourceDefinition,
} from './agent-runtime.js'

export type {
  ProviderInfo,
  ProviderConfig,
  ProviderDefinition,
} from '@onething/runtime/providers/types.wiring'

export type AIMessageContent = OnethingAIMessageContent
export type AIToolCall = OnethingProviderFacadeToolCall
export type ChatResponseResult = OnethingProviderFacadeChatResponseResult
export type StreamChunkWithTools = OnethingProviderFacadeStreamChunkWithTools
export type ReasoningStreamChunk = OnethingProviderFacadeReasoningStreamChunk
export type StreamCallbacks = OnethingProviderFacadeStreamCallbacks
export type ToolChatMessage = OnethingToolChatMessage

let providerRegistryInitialized = false

/** Explicit assembly step; also self-ensured by this module's accessors. */
export function configureAppProviderRegistry(): void {
  if (providerRegistryInitialized) return
  providerRegistryInitialized = true
  initializeRegistry()
}

export function getAvailableProviders(): ProviderInfo[] {
  configureAppProviderRegistry()
  return getProvidersFromRegistry()
}

export function getProviderInfo(providerId: string): ProviderInfo | undefined {
  return getInfoFromRegistry(providerId)
}

export function isProviderSupported(providerId: string): boolean {
  return isSupportedFromRegistry(providerId)
}

export function requiresOAuth(providerId: string): boolean {
  return requiresOAuthFromRegistry(providerId)
}

async function dumpRuntimeProviderRequest(context: Parameters<typeof createOnethingProviderFacade>[0] extends {
  dumpProviderRequest?: infer TDumper
} ? TDumper extends (context: infer TContext) => unknown ? TContext : never : never): Promise<void> {
  await dumpProviderRequest({
    providerId: context.providerId,
    model: context.model,
    mode: context.mode as ProviderRequestDumpMode,
    metadata: context.metadata as OnethingProviderFacadeRawRecord | undefined,
    requestBody: context.requestBody,
  })
}

const providerFacadeAdapters: OnethingProviderFacadeAdapters<RuntimeProviderConfig, AgentProvider> = {
  requiresOAuth,
  refreshOAuthToken: id => oauthManager.refreshTokenIfNeeded(id),
  requiresSystemMerge: requiresSystemMergeFromRegistry,
  resolveRuntimeRoute: resolveProviderRuntimeRoute,
  createRequiredFetch: () => createRequiredAppFetch({ policy: 'streaming' }),
  dumpProviderRequest: dumpRuntimeProviderRequest,
  streamACPPrompt: (agentId, request) => ACPManager.streamPrompt(agentId, request),
  defaultWorkingDirectory: () => process.cwd(),
  isACPProvider,
  logger: consoleLog,
};
const providerFacade = createOnethingProviderFacade<RuntimeProviderConfig, AgentProvider>(providerFacadeAdapters)


export async function generateChatResponse(
  providerId: string,
  config: RuntimeProviderConfig,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  options: {
    temperature?: number
    maxTokens?: number
    abortSignal?: AbortSignal
    thinking?: boolean
    thinkingEffort?: ThinkingEffort
    serviceTier?: string
    debugPurpose?: string
    debugSessionId?: string
    /** Side channel for token usage, so side-line callers can bill their calls. */
    onUsage?: (usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void
    /** Side channel for the stop reason ('length' = truncated by max_tokens). */
    onFinish?: (info: { finishReason?: string }) => void
  } = {},
): Promise<string> {
  // No hidden 4096 anywhere on this path (2026-08-15 ruling). A caller that says
  // nothing about maxTokens gets the model's real max output when the registry
  // knows it; when it doesn't, nothing is sent and the provider decides.
  const maxTokens = options.maxTokens
    ?? await modelRegistry.getKnownModelMaxOutputTokens(config.model, providerId)
  const chatGenerationOptions: OnethingChatGenerationOptions = {
    ...options,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
  return providerFacade.generateChatResponse(providerId, config, messages, chatGenerationOptions)
}





export async function generateChatTitle(
  providerId: string,
  config: RuntimeProviderConfig,
  userMessage: string,
  options: Pick<
    NonNullable<Parameters<typeof generateChatResponse>[3]>,
    'thinking' | 'thinkingEffort' | 'serviceTier' | 'debugSessionId' | 'onUsage'
  > = {},
): Promise<string> {
  return providerFacade.generateChatTitle(providerId, config, userMessage, options)
}




export const providerRegistry: Record<string, ProviderInfo> =
  Object.fromEntries(getProvidersFromRegistry().map(provider => [provider.id, provider]))
