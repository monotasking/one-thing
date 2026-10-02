import type { AgentMessage } from '../context/context-manager.js'
import type { ToolCall, ToolDefinition } from '../tools/types.js'

export interface ProviderRequest {
  sessionId: string
  messages: AgentMessage[]
  input: string
  tools?: ToolDefinition[]
  turn: number
  signal?: AbortSignal
}

export interface ProviderUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs?: number
}

export type ProviderFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'unknown'

export type ProviderStreamEvent =
  | { type: 'text-delta'; text: string; turnIndex?: number }
  | { type: 'reasoning-delta'; reasoning: string; turnIndex?: number }
  | { type: 'tool-call-delta'; toolCallId?: string; index: number; toolName?: string; argumentsDelta?: string; turnIndex?: number }
  | { type: 'tool-call-done'; toolCall: ToolCall; turnIndex?: number }
  | { type: 'usage'; usage: ProviderUsage; turnIndex?: number }
  | { type: 'finish'; reason: ProviderFinishReason; turnIndex?: number }

export interface Provider {
  readonly id: string
  readonly model?: string
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>
}

export type AgentEngineProvider = Provider
