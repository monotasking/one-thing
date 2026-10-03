import type {
  AgentFinishReason,
  AgentProviderData,
  AgentStreamEvent,
  AgentToolMetadataUpdate,
  AgentToolPartialResultUpdate,
  AgentToolCall,
  AgentToolResult,
  AgentUsage,
  AgentJsonObject,
} from './types.js'

export type AgentProviderStreamFinishReason =
  | 'stop'
  | 'length'
  | 'tool-calls'
  | 'content-filter'
  | 'error'
  | 'other'
  | 'unknown'

export type AgentProviderToolArgsFinalizedBy = 'parse' | 'provider-done'

export interface AgentProviderToolCallChunk {
  toolCallId: string
  toolName: string
  args: AgentJsonObject
  /** Set on the fallback path: args settled by the provider's done event, not a mid-stream parse. */
  finalizedBy?: AgentProviderToolArgsFinalizedBy
}

export type AgentProviderStreamChunk =
  | { type: 'turn-start'; turnStart: { turn: number } }
  | { type: 'response-boundary'; responseBoundary: { turn: number } }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; reasoning: string }
  | { type: 'tool-call'; toolCall: AgentProviderToolCallChunk }
  | { type: 'tool-result'; toolResult: { toolCallId: string; result: AgentToolResult } }
  | { type: 'tool-input-start'; toolInputStart: { toolCallId: string; toolName: string } }
  | { type: 'tool-input-delta'; toolInputDelta: { toolCallId: string; argsTextDelta: string } }
  | { type: 'tool-input-end'; toolInputEnd: { toolCallId: string; finalizedBy: AgentProviderToolArgsFinalizedBy } }
  | { type: 'tool-metadata'; toolMetadata: { toolCallId: string; update: AgentToolMetadataUpdate } }
  | { type: 'tool-partial-result'; toolPartialResult: { toolCallId: string; update: AgentToolPartialResultUpdate } }
  | { type: 'provider-data'; providerData: AgentProviderData }
  | { type: 'finish'; finishReason: AgentProviderStreamFinishReason; usage?: AgentUsage }

export interface AgentProviderStreamAdapterOptions {
  emitToolInputEndOnCompleteJson?: boolean
}

interface ToolInputState {
  name: string
  arguments: string
  started: boolean
  ended: boolean
}

export function mapAgentProviderFinishReason(
  reason: AgentFinishReason,
): AgentProviderStreamFinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'error':
    case 'unknown':
      return reason
    case 'tool_calls':
      return 'tool-calls'
    case 'content_filter':
      return 'content-filter'
    case 'max_turns':
      return 'other'
    default:
      return 'unknown'
  }
}

export function safeParseAgentToolArguments(raw: string): AgentJsonObject {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {}
  } catch {
    return {}
  }
}

export function isCompleteAgentToolArguments(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function providerToolCallFromAgent(call: AgentToolCall): AgentProviderToolCallChunk {
  return {
    toolCallId: call.id,
    toolName: call.name,
    args: safeParseAgentToolArguments(call.arguments),
  }
}

function resultChunk(
  event: Extract<AgentStreamEvent, { type: 'tool-result' }>,
): AgentProviderStreamChunk {
  return {
    type: 'tool-result',
    toolResult: {
      toolCallId: event.toolCall.id,
      result: event.result,
    },
  }
}

export async function* agentEventsToProviderStreamChunks(
  events: AsyncIterable<AgentStreamEvent>,
  options: AgentProviderStreamAdapterOptions = {},
): AsyncGenerator<AgentProviderStreamChunk, void, void> {
  const emitToolInputEndOnCompleteJson = options.emitToolInputEndOnCompleteJson ?? true
  const streamedToolInputs = new Map<string, ToolInputState>()
  const finishedTurns = new Set<number>()

  for await (const event of events) {
    switch (event.type) {
      case 'turn-start':
        yield {
          type: 'turn-start',
          turnStart: { turn: event.turn },
        }
        break

      case 'response-boundary':
        yield {
          type: 'response-boundary',
          responseBoundary: { turn: event.turn },
        }
        break

      case 'reasoning-delta':
        if (event.delta) yield { type: 'reasoning', reasoning: event.delta }
        break

      case 'text-delta':
        if (event.delta) yield { type: 'text', text: event.delta }
        break

      case 'tool-call-start': {
        streamedToolInputs.set(event.toolCallId, {
          name: event.toolName,
          arguments: '',
          started: true,
          ended: false,
        })
        yield {
          type: 'tool-input-start',
          toolInputStart: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          },
        }
        break
      }

      case 'tool-call-delta': {
        let entry = streamedToolInputs.get(event.toolCallId)
        if (!entry) {
          entry = {
            name: event.toolName,
            arguments: '',
            started: false,
            ended: false,
          }
          streamedToolInputs.set(event.toolCallId, entry)
        }

        if (!entry.started) {
          entry.started = true
          entry.name = event.toolName
          yield {
            type: 'tool-input-start',
            toolInputStart: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            },
          }
        }

        if (event.argumentsDelta) {
          entry.arguments += event.argumentsDelta
          yield {
            type: 'tool-input-delta',
            toolInputDelta: {
              toolCallId: event.toolCallId,
              argsTextDelta: event.argumentsDelta,
            },
          }
        }

        if (
          emitToolInputEndOnCompleteJson &&
          !entry.ended &&
          isCompleteAgentToolArguments(entry.arguments)
        ) {
          entry.ended = true
          yield {
            type: 'tool-input-end',
            toolInputEnd: { toolCallId: event.toolCallId, finalizedBy: 'parse' },
          }
        }
        break
      }

      case 'tool-call-done': {
        const entry = streamedToolInputs.get(event.toolCall.id)
        if (entry?.ended) break

        yield {
          type: 'tool-call',
          toolCall: {
            ...providerToolCallFromAgent(event.toolCall),
            finalizedBy: 'provider-done',
          },
        }
        break
      }

      case 'tool-result':
        yield resultChunk(event)
        break

      case 'tool-metadata':
        yield {
          type: 'tool-metadata',
          toolMetadata: {
            toolCallId: event.toolCall.id,
            update: event.update,
          },
        }
        break

      case 'tool-partial-result':
        yield {
          type: 'tool-partial-result',
          toolPartialResult: {
            toolCallId: event.toolCall.id,
            update: event.update,
          },
        }
        break

      case 'provider-data':
        yield {
          type: 'provider-data',
          providerData: event.providerData,
        }
        break

      case 'finish':
        finishedTurns.add(event.turn)
        yield {
          type: 'finish',
          finishReason: mapAgentProviderFinishReason(event.finishReason),
          usage: event.usage,
        }
        break

      case 'turn-end':
        if (finishedTurns.has(event.turn)) break
        yield {
          type: 'finish',
          finishReason: mapAgentProviderFinishReason(event.finishReason),
          usage: event.usage,
        }
        break

    }
  }
}
