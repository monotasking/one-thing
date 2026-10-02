import type {
  AgentFinishReason,
  AgentProviderData,
  AgentStreamEvent,
  AgentToolCall,
  AgentToolMetadataUpdate,
  AgentToolPartialResultUpdate,
  AgentToolResult,
  AgentUsage,
} from './types.js'

export type AgentLoopStreamChunk =
  | { type: 'turn-start'; turn: number }
  | { type: 'response-boundary'; turn: number }
  | { type: 'reasoning'; turn: number; reasoning: string }
  | { type: 'text'; turn: number; text: string }
  | { type: 'tool-input-start'; turn: number; toolCallId: string; toolName: string }
  | { type: 'tool-input-delta'; turn: number; toolCallId: string; toolName: string; argumentsDelta: string }
  | { type: 'tool-call'; turn: number; toolCall: AgentToolCall }
  | { type: 'tool-metadata'; turn: number; toolCall: AgentToolCall; update: AgentToolMetadataUpdate }
  | { type: 'tool-partial-result'; turn: number; toolCall: AgentToolCall; update: AgentToolPartialResultUpdate }
  | { type: 'provider-data'; turn: number; providerData: AgentProviderData }
  | { type: 'tool-result'; turn: number; toolCall: AgentToolCall; result: AgentToolResult }
  | { type: 'turn-end'; turn: number; finishReason: AgentFinishReason; usage?: AgentUsage }
  | { type: 'finish'; turn: number; finishReason: AgentFinishReason; usage?: AgentUsage }
  | { type: 'auto-retry'; turn: number; attempt: number; maxAttempts: number; delayMs: number; error: string }

export function agentEventToChunk(event: AgentStreamEvent): AgentLoopStreamChunk {
  switch (event.type) {
    case 'turn-start':
      return { type: 'turn-start', turn: event.turn }
    case 'response-boundary':
      return { type: 'response-boundary', turn: event.turn }
    case 'reasoning-delta':
      return { type: 'reasoning', turn: event.turn, reasoning: event.delta }
    case 'text-delta':
      return { type: 'text', turn: event.turn, text: event.delta }
    case 'tool-call-start':
      return {
        type: 'tool-input-start',
        turn: event.turn,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      }
    case 'tool-call-delta':
      return {
        type: 'tool-input-delta',
        turn: event.turn,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argumentsDelta: event.argumentsDelta,
      }
    case 'tool-call-done':
      return { type: 'tool-call', turn: event.turn, toolCall: event.toolCall }
    case 'tool-metadata':
      return {
        type: 'tool-metadata',
        turn: event.turn,
        toolCall: event.toolCall,
        update: event.update,
      }
    case 'tool-partial-result':
      return {
        type: 'tool-partial-result',
        turn: event.turn,
        toolCall: event.toolCall,
        update: event.update,
      }
    case 'provider-data':
      return {
        type: 'provider-data',
        turn: event.turn,
        providerData: event.providerData,
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        turn: event.turn,
        toolCall: event.toolCall,
        result: event.result,
      }
    case 'turn-end':
      return {
        type: 'turn-end',
        turn: event.turn,
        finishReason: event.finishReason,
        usage: event.usage,
      }
    case 'finish':
      return {
        type: 'finish',
        turn: event.turn,
        finishReason: event.finishReason,
        usage: event.usage,
      }
    case 'auto-retry':
      return {
        type: 'auto-retry',
        turn: event.turn,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        error: event.error,
      }
    default:
      {
        const exhaustive: never = event
        return exhaustive
      }
  }
}
