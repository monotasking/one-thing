/**
 * Stream Processor Module
 * Handles stream context, processor, and active stream management
 */

import * as store from '../../../store.js'
import type { AppSettings, ProviderConfig, ToolSettings, Step } from '@shared/ipc.js'
import type { Principal } from '@onething/core/permission'
import type { ToolCall } from '@shared/ipc.js'
import type { ReasoningPlacement } from '@shared/events/index.js'
import { isMCPTool, parseMCPToolId, findMCPToolIdByShortName, MCPManager } from '@onething/runtime/mcp/index.wiring'
import { resolveAIToolName } from '@onething/core/agent-loop'
import { createEventOnlyEmitter } from '../../../events/event-only-emitter.js'
import type { PendingMessageQueue, CoreToolIdentityResolver, CoreStreamProcessorStore } from '@onething/core/engine'
import type { CoreAgentLoopToolInputProcessor } from '@onething/core/engine'
import type { AgentJsonObject, AgentOutputModality } from '@onething/core/agent-loop'
import type { AgentRuntimeProviderConfig } from '../../providers/agent-runtime.js'
import {
  resolveToolIdentity as resolveCoreToolIdentity,
} from '@onething/core/engine'
import type { CoreInitialToolChoice } from '@onething/core/engine'
import type { EffectiveAgentProfile } from '@onething/runtime/agents'
import type { CoreSpaceCredentialMarker } from '@onething/runtime/providers'
import {
  createOnethingStreamProcessor, type CreateOnethingStreamProcessorOptions,
} from '@onething/runtime/stream-processor'

export type StreamProviderConfig = ProviderConfig & AgentRuntimeProviderConfig & {
  /**
   * per-space 凭证解析盖上的**运行期标记**(批 B3),永不落盘 —— 所以它声明在
   * 这条"活的" stream config 上,而不是 `ProviderConfig`(那是设置的落盘形状)。
   * 批 D 的轮换从这里读「本次流用的是哪一条 entry」。
   */
  spaceCredential?: CoreSpaceCredentialMarker
}

export type StreamSenderPayload =
  | string
  | number
  | boolean
  | null
  | undefined
  | object

export interface StreamSender {
  isDestroyed(): boolean
  send(channel: string, ...args: StreamSenderPayload[]): void
}

// ============================================================
// Active Streams Registry
// ============================================================
// MCP Tool Identity Resolution
// ============================================================

/**
 * Resolved tool identity with display name and ID information
 */
export interface ResolvedTool {
  toolId: string      // Full tool ID for execution (e.g., "mcp_search")
  displayName: string // Human-readable display name
  isMcp: boolean      // Whether this is an MCP tool
}

/**
 * Resolve tool identity from a tool name
 *
 * AI models usually call the single MCP router tool (`mcp_search`), but
 * persisted/legacy calls may still contain old MCP ids. This function resolves
 * the full ID and provides a display name.
 *
 * @param toolName The tool name from the AI model
 * @param args Optional tool arguments for context-aware resolution
 * @returns Resolved tool identity with full ID and display name
 */
export function resolveToolIdentity(toolName: string, args: AgentJsonObject = {}): ResolvedTool {
  const toolIdentityResolver: CoreToolIdentityResolver = {
    normalizeToolName: resolveAIToolName,
    isMCPTool,
    findMCPToolIdByShortName,
    parseMCPToolId,
    getMCPServerName(serverId) {
      return MCPManager.getServerState(serverId)?.config.name
    },
  };
  return resolveCoreToolIdentity(toolName, args, toolIdentityResolver)
}

/**
 * Context for streaming operations
 */
export interface StreamContext {
  sender: StreamSender
  sessionId: string
  assistantMessageId: string
  abortSignal: AbortSignal
  settings: AppSettings
  providerConfig: StreamProviderConfig
  providerId: string
  requestedOutputModalities?: AgentOutputModality[]
  toolSettings: ToolSettings | undefined
  // Note: skills are resolved by the active stream runtime, not stored here.
  // Accumulated token usage across all turns (for statistics)
  accumulatedUsage?: { inputTokens: number; outputTokens: number; totalTokens: number; durationMs?: number }
  // Last turn's token usage (for context size - NOT accumulated)
  lastTurnUsage?: { inputTokens: number; outputTokens: number }
  /** Steering message queue — messages injected mid-stream (after each turn) */
  steeringQueue?: PendingMessageQueue
  /** Follow-up message queue — messages injected only after agent would stop */
  followUpQueue?: PendingMessageQueue
  /** The current generation is answering a spoken user turn. */
  voiceConversation?: boolean
  /** The current assistant text should be treated as TTS-ready visible text. */
  speakMode?: boolean
  /**
   * Billing attribution for this turn's usage records (W13.3). Absent = 'chat'.
   * Only the collab drives set it ('collab-room' / 'collab-work') so the usage
   * panel can tell room spend from ordinary chat spend.
   */
  usageSource?: string
  /**
   * Force this run's FIRST model call into a (named) tool call — W18b, narrowed
   * to `say` by name in W22. Only the collab room drive sets it; the agent loop
   * applies it to iteration 1 alone.
   */
  initialToolChoice?: CoreInitialToolChoice
  /**
   * Who is running this turn. Minted at the engine boundary
   * (app/engine/stream-engine.ts) after the sender's right to name an actor is
   * proven, and carried down to the tool executor. Deliberately NOT derived
   * from `session.agentId` here: that field is stamped on every session, so
   * its presence proves nothing (docs/design/agent-permission-system-2026-08.md §1.1).
   */
  principal?: Principal
  /**
   * This turn's agent capability profile (tool surface, turn budget, model
   * binding), resolved once when the run starts —
   * docs/design/agent-capability-profile.md. The permission mode deliberately
   * does NOT ride this snapshot: it is read live on every ask.
   */
  agentProfile?: EffectiveAgentProfile
}

/**
 * Stream processor that handles chunk accumulation and event sending
 */
export interface StreamProcessor extends CoreAgentLoopToolInputProcessor<ToolCall> {
  accumulatedContent: string
  accumulatedReasoning: string
  toolCalls: ToolCall[]
  handleTextChunk(text: string, turnContent?: { value: string }, turnIndex?: number): string
  handleReasoningChunk(reasoning: string, turnReasoning?: { value: string }, turnIndex?: number, placement?: ReasoningPlacement): void
  handleToolCallChunk(toolCallData: {
    toolCallId: string
    toolName: string
    args: AgentJsonObject
  }, options?: { publish?: boolean }): ToolCall
  /** Handle streaming tool input start - creates a pending tool call */
  handleToolInputStart(toolCallId: string, toolName: string, turnIndex?: number, options?: { publish?: boolean }): void
  /** Handle streaming tool input delta - accumulates args JSON text */
  handleToolInputDelta(toolCallId: string, argsTextDelta: string): void
  /** Handle streaming tool input end - parses accumulated JSON and returns ToolCall */
  handleToolInputEnd(toolCallId: string): ToolCall | null
  /** Get step ID for a tool call (if placeholder was created during streaming) */
  getStepIdForToolCall(toolCallId: string): string | undefined
  /** A11(§13.1):这次调用被藏起来了吗(`publish:false`)—— 会话事件账本要记同一件事。 */
  isToolCallHidden(toolCallId: string): boolean
  /** Mark message as no longer streaming and force-flush pending async writes */
  finalize(): Promise<void>
}

/**
 * Create a stream processor for handling chunks
 */
export function createStreamProcessor(ctx: StreamContext, initialContent?: { content?: string; reasoning?: string }): StreamProcessor {
  const emitter = createEventOnlyEmitter(ctx)

  const storePort: CoreStreamProcessorStore<ToolCall> = {
    updateMessageContent: store.updateMessageContent,
    updateMessageReasoning: store.updateMessageReasoning,
    updateMessageToolCalls: store.updateMessageToolCalls,
    updateMessageStreaming: store.updateMessageStreaming,
    flushSessionSave: store.flushSessionSave,
  };
  const createOnethingStreamProcessorOptions: CreateOnethingStreamProcessorOptions<ToolCall, Step, ReasoningPlacement> = {
    sessionId: ctx.sessionId,
    assistantMessageId: ctx.assistantMessageId,
    initialContent,
    resolveToolIdentity: (toolName, args) => resolveToolIdentity(toolName, args as AgentJsonObject),
    store: storePort,
    emitter,
  };
  return createOnethingStreamProcessor<ToolCall, Step, ReasoningPlacement>(createOnethingStreamProcessorOptions)
}
