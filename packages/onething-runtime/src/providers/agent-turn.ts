import {
  agentContentToText,
  agentEventsToProviderStreamChunks,
  agentModelToolsFromDefinitions,
  collectAgentTurnFromStream,
  streamAgentProviderTurnEvents,
  type AgentFinishReason,
  type AgentJsonObject,
  type AgentMessage,
  type AgentProvider,
  type AgentProviderStreamChunk,
  type AgentTool,
  type AgentTurnRequest,
  type AgentUsage,
} from '@onething/core/agent-loop'
import { createDeepSeekAgentProvider } from '../agent-loop/providers/deepseek.js'
import {
  onethingAgentMessagesFromToolChatMessages,
  onethingUtilityAgentMessagesFromMessages,
  type OnethingAIMessageContent,
  type OnethingDeepSeekAgentSourceMessage,
  type OnethingProviderToolDefinitionMap,
  type OnethingToolChatMessage,
} from './message-conversion.js'
import {
  normalizeOnethingDeepSeekAgentReasoningEffort,
  normalizeOnethingAgentReasoningEffort,
  resolveOnethingDeepSeekAgentThinking,
  resolveOnethingAgentThinking,
  type OnethingAgentReasoningEffort,
  type OnethingAgentThinking,
  type OnethingThinkingEffort,
} from './provider-routing.js'

export type OnethingProviderRequestDumpMode =
  | 'stream'
  | 'stream-reasoning'
  | 'stream-tools'
  | 'stream-ui-messages'
  | 'generate'
  | 'codex-http'

export type OnethingProviderRequestDumpValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | bigint
  | Error
  | object
  | OnethingProviderRequestDumpValue[]
  | { [key: string]: OnethingProviderRequestDumpValue }

export interface OnethingProviderRequestDumpContext {
  providerId: string
  model: string
  mode: OnethingProviderRequestDumpMode
  metadata?: Record<string, OnethingProviderRequestDumpValue>
  requestBody: OnethingProviderRequestDumpValue
}

export interface OnethingUtilityAgentConfig {
  model: string
}


export interface OnethingUtilityAgentOptions {
  temperature?: number
  maxTokens?: number
  abortSignal?: AbortSignal
  thinking?: boolean
  thinkingEffort?: OnethingThinkingEffort
  debugPurpose?: string
  debugSessionId?: string
  debugTurn?: number
}

export type OnethingUtilityAgentMessage = {
  role: 'user' | 'assistant' | 'system'
  content: OnethingAIMessageContent
  reasoningContent?: string
}

export interface OnethingChatResponseResult {
  text: string
  reasoning?: string
  toolCalls?: Array<{
    toolCallId: string
    toolName: string
    args: AgentJsonObject
  }>
  /**
   * Token usage for this turn, when the provider reported it. Side-line
   * callers (title generation, memory capture/review) need this to bill their
   * calls — without it their tokens are invisible in the usage ledger.
   */
  usage?: AgentUsage
  /**
   * How the provider ended the turn. `'length'` means max_tokens truncated the
   * output — callers that must not accept a half answer (context compaction)
   * read this instead of guessing from an empty/short text.
   */
  finishReason?: AgentFinishReason
}

export type OnethingReasoningStreamChunk =
  | { type: 'text'; text: string; reasoning?: string }
  | {
      type: 'finish'
      usage: { inputTokens: number; outputTokens: number; totalTokens: number }
    }

export interface OnethingUtilityAgentTurnRunnerOptions {
  providerId: string
  provider: AgentProvider
  config: OnethingUtilityAgentConfig
  messages: OnethingUtilityAgentMessage[]
  options?: OnethingUtilityAgentOptions
  mode: OnethingProviderRequestDumpMode
  onRequestPrepared?: (context: OnethingProviderRequestDumpContext) => void | Promise<void>
}




interface PreparedUtilityAgentTurn {
  agentMessages: AgentMessage[]
  agentTools?: AgentTool[]
  thinking: OnethingAgentThinking | undefined
  reasoningEffort: OnethingAgentReasoningEffort | undefined
  maxTokens: number | undefined
  toolChoice: 'auto' | 'none'
  request: AgentTurnRequest
}

function parseToolArgs(value: string): AgentJsonObject {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as AgentJsonObject
      : {}
  } catch {
    return {}
  }
}

function prepareUtilityAgentTurn(options: {
  config: OnethingUtilityAgentConfig
  messages: AgentMessage[]
  agentTools?: AgentTool[]
  runnerOptions?: OnethingUtilityAgentOptions
  toolChoice: 'auto' | 'none'
  turn?: number
}): PreparedUtilityAgentTurn {
  const runnerOptions = options.runnerOptions ?? {}
  const thinking = resolveOnethingAgentThinking(runnerOptions)
  const reasoningEffort = normalizeOnethingAgentReasoningEffort(runnerOptions.thinkingEffort)
  // No invented default (2026-08-15): a caller that says nothing about maxTokens
  // means "no artificial cap". The app-level generateChatResponse fills in the
  // model's real max when the registry knows it; otherwise nothing is sent and
  // the provider's own default (or its own "field required" error) applies.
  const maxTokens = runnerOptions.maxTokens
  return {
    agentMessages: options.messages,
    agentTools: options.agentTools,
    thinking,
    reasoningEffort,
    maxTokens,
    toolChoice: options.toolChoice,
    request: {
      model: options.config.model,
      messages: options.messages,
      ...(options.agentTools?.length ? { tools: options.agentTools } : {}),
      toolChoice: options.toolChoice,
      maxTokens,
      temperature: runnerOptions.temperature,
      thinking,
      reasoningEffort,
      abortSignal: runnerOptions.abortSignal,
      turn: options.turn ?? 1,
    },
  }
}

function utilityAgentRequestDumpContext(options: {
  providerId: string
  config: OnethingUtilityAgentConfig
  mode: OnethingProviderRequestDumpMode
  prepared: PreparedUtilityAgentTurn
  metadata?: Record<string, OnethingProviderRequestDumpValue>
}): OnethingProviderRequestDumpContext {
  return {
    providerId: options.providerId,
    model: options.config.model,
    mode: options.mode,
    metadata: {
      ...options.metadata,
      transport: 'agent-provider',
    },
    requestBody: {
      model: options.config.model,
      messages: options.prepared.agentMessages,
      stream: true,
      tools: options.prepared.agentTools?.length
        ? options.prepared.agentTools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          }))
        : undefined,
      tool_choice: options.prepared.toolChoice,
      temperature: options.prepared.request.temperature,
      max_tokens: options.prepared.maxTokens,
      thinking: options.prepared.thinking,
      reasoning_effort: options.prepared.reasoningEffort,
    },
  }
}


function metadataFromOptions(
  options: OnethingUtilityAgentOptions | undefined,
): Record<string, OnethingProviderRequestDumpValue> | undefined {
  if (!options?.debugPurpose && !options?.debugSessionId) return undefined
  return {
    purpose: options.debugPurpose,
    sessionId: options.debugSessionId,
  }
}

export async function runOnethingUtilityAgentTurn(
  runnerOptions: OnethingUtilityAgentTurnRunnerOptions,
): Promise<OnethingChatResponseResult | undefined> {
  const options = runnerOptions.options ?? {}
  const agentMessages = onethingUtilityAgentMessagesFromMessages(runnerOptions.messages)
  const prepared = prepareUtilityAgentTurn({
    config: runnerOptions.config,
    messages: agentMessages,
    runnerOptions: options,
    toolChoice: 'none',
  })

  await runnerOptions.onRequestPrepared?.(utilityAgentRequestDumpContext({
    providerId: runnerOptions.providerId,
    config: runnerOptions.config,
    mode: runnerOptions.mode,
    prepared,
    metadata: metadataFromOptions(options),
  }))

  const turn = await collectAgentTurnFromStream(
    streamAgentProviderTurnEvents(runnerOptions.provider, prepared.request),
  )

  return {
    text: agentContentToText(turn.message.content),
    reasoning: turn.message.reasoningContent || undefined,
    toolCalls: turn.message.toolCalls?.map(toolCall => ({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: parseToolArgs(toolCall.arguments),
    })),
    usage: turn.usage,
    finishReason: turn.finishReason,
  }
}





