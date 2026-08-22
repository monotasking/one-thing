import { SESSION_EVENT_TYPES } from '../events/session-event-types.js'
import { ContextManager, type AgentMessage } from '../context/context-manager.js'
import { EventBus } from '../events/event-bus.js'
import { StreamChannel } from '../events/stream-channel.js'
import type { EventBase, StreamChunkBase } from '../events/types.js'
import { ToolExecutor } from '../tools/executor.js'
import { DenyAllPolicy, type PermissionPolicy } from '../tools/policy.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ToolCall, ToolResult } from '../tools/types.js'
import type {
  Provider,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderUsage,
} from '../providers/types.js'

export type AgentEngineSessionEvent =
  | (EventBase & { type: typeof SESSION_EVENT_TYPES.MESSAGE_USER_CREATED; message: AgentMessage & { id: string } })
  | (EventBase & { type: typeof SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED; message: AgentMessage & { id: string } })
  | (EventBase & { type: typeof SESSION_EVENT_TYPES.MESSAGE_UPDATED; messageId: string; updates: Partial<AgentMessage> })
  | (EventBase & { type: typeof SESSION_EVENT_TYPES.STREAM_START; messageId: string; assistantMessageId: string; model?: string })
  | (EventBase & { type: typeof SESSION_EVENT_TYPES.CONTENT_PART; part: { type: 'text'; text: string } })
  | (EventBase & { type: typeof SESSION_EVENT_TYPES.TOOL_CALL; toolCall: ToolCall })
  | (EventBase & { type: typeof SESSION_EVENT_TYPES.TOOL_RESULT; toolCall: ToolCall; result: ToolResult })
  | (EventBase & { type: typeof SESSION_EVENT_TYPES.STREAM_COMPLETE; data: { sessionName?: string; usage?: AgentEngineUsage } })
  | (EventBase & { type: typeof SESSION_EVENT_TYPES.STREAM_ERROR; data: { error: string; errorDetails?: string } })

export type AgentEngineStreamChunk = StreamChunkBase & Extract<
  ProviderStreamEvent,
  { type: 'text-delta' | 'reasoning-delta' | 'tool-call-delta' }
>

export interface AgentEngineUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs?: number
}

export type AgentEngineRequest = ProviderRequest
export type AgentEngineProvider = Provider

export interface AgentEngineOptions {
  eventBus?: EventBus<AgentEngineSessionEvent>
  streamChannel?: StreamChannel<AgentEngineStreamChunk>
  contextManager?: ContextManager
  provider?: AgentEngineProvider
  toolRegistry?: ToolRegistry
  permissionPolicy?: PermissionPolicy
  maxToolIterations?: number
}

export interface SendMessageOptions {
  sessionId: string
  content: string
  signal?: AbortSignal
}

export interface SendMessageResult {
  sessionId: string
  messageId: string
  content: string
  toolCalls: ToolCall[]
}

export class AgentEngine {
  readonly eventBus: EventBus<AgentEngineSessionEvent>
  readonly streamChannel: StreamChannel<AgentEngineStreamChunk>
  readonly contextManager: ContextManager
  readonly toolRegistry: ToolRegistry
  private provider: AgentEngineProvider
  private permissionPolicy: PermissionPolicy
  private maxToolIterations: number

  constructor(options: AgentEngineOptions = {}) {
    this.eventBus = options.eventBus ?? new EventBus<AgentEngineSessionEvent>()
    this.streamChannel = options.streamChannel ?? new StreamChannel<AgentEngineStreamChunk>()
    this.contextManager = options.contextManager ?? new ContextManager()
    this.provider = options.provider ?? createEchoAgentProvider()
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry()
    this.permissionPolicy = options.permissionPolicy ?? new DenyAllPolicy()
    this.maxToolIterations = options.maxToolIterations ?? 4
  }

  setProvider(provider: AgentEngineProvider): void {
    this.provider = provider
  }

  setPermissionPolicy(policy: PermissionPolicy): void {
    this.permissionPolicy = policy
  }

  async sendMessage(options: SendMessageOptions): Promise<SendMessageResult> {
    const startedAt = Date.now()
    const userMessageId = createId('user')
    const assistantMessageId = createId('assistant')
    const userMessage: AgentMessage & { id: string } = {
      id: userMessageId,
      role: 'user',
      content: options.content,
    }
    const assistantMessage: AgentMessage & { id: string } = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
    }

    this.contextManager.appendMessage(options.sessionId, userMessage)
    await this.eventBus.emit(options.sessionId, {
      type: SESSION_EVENT_TYPES.MESSAGE_USER_CREATED,
      message: userMessage,
    })

    await this.eventBus.emit(options.sessionId, {
      type: SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED,
      message: assistantMessage,
    })
    await this.eventBus.emit(options.sessionId, {
      type: SESSION_EVENT_TYPES.STREAM_START,
      messageId: assistantMessageId,
      assistantMessageId,
      model: this.provider.model,
    })

    let content = ''
    let usage: AgentEngineUsage | undefined
    const allToolCalls: ToolCall[] = []

    try {
      const executor = new ToolExecutor({
        registry: this.toolRegistry,
        policy: this.permissionPolicy,
      })

      for (let turn = 0; turn <= this.maxToolIterations; turn++) {
        const turnResult = await this.runProviderTurn({
          sessionId: options.sessionId,
          input: options.content,
          signal: options.signal,
          turn,
        })

        content += turnResult.content
        usage = mergeUsage(usage, turnResult.usage)

        const assistantTurnMessage: AgentMessage = {
          id: turnResult.toolCalls.length ? createId('assistant-turn') : assistantMessageId,
          role: 'assistant',
          content: turnResult.content,
          ...(turnResult.toolCalls.length ? { toolCalls: turnResult.toolCalls } : {}),
        }
        this.contextManager.appendMessage(options.sessionId, assistantTurnMessage)

        if (!turnResult.toolCalls.length) {
          await this.eventBus.emit(options.sessionId, {
            type: SESSION_EVENT_TYPES.MESSAGE_UPDATED,
            messageId: assistantMessageId,
            updates: { content },
          })
          await this.eventBus.emit(options.sessionId, {
            type: SESSION_EVENT_TYPES.STREAM_COMPLETE,
            data: {
              usage: usage ?? estimateUsage(options.content, content, Date.now() - startedAt),
            },
          })

          return {
            sessionId: options.sessionId,
            messageId: assistantMessageId,
            content,
            toolCalls: allToolCalls,
          }
        }

        allToolCalls.push(...turnResult.toolCalls)
        for (const toolCall of turnResult.toolCalls) {
          await this.eventBus.emit(options.sessionId, {
            type: SESSION_EVENT_TYPES.TOOL_CALL,
            toolCall,
          })

          const result = await executor.execute(toolCall, {
            sessionId: options.sessionId,
            toolCallId: toolCall.id,
            signal: options.signal,
          })

          await this.eventBus.emit(options.sessionId, {
            type: SESSION_EVENT_TYPES.TOOL_RESULT,
            toolCall,
            result,
          })

          this.contextManager.appendMessage(options.sessionId, {
            role: 'tool',
            content: result.content,
            toolCallId: toolCall.id,
          })
        }
      }

      throw new Error(`AgentEngine exceeded max tool iterations (${this.maxToolIterations})`)
    } catch (error) {
      await this.eventBus.emit(options.sessionId, {
        type: SESSION_EVENT_TYPES.STREAM_ERROR,
        data: {
          error: error instanceof Error ? error.message : String(error),
          errorDetails: error instanceof Error ? error.stack : undefined,
        },
      })
      throw error
    }
  }

  shutdown(): void {
    this.eventBus.shutdown()
    this.streamChannel.shutdown()
    this.contextManager.clear()
    this.toolRegistry.clear()
  }

  private async runProviderTurn(options: {
    sessionId: string
    input: string
    signal?: AbortSignal
    turn: number
  }): Promise<{ content: string; toolCalls: ToolCall[]; usage?: AgentEngineUsage }> {
    const request: ProviderRequest = {
      sessionId: options.sessionId,
      messages: this.contextManager.getMessages(options.sessionId),
      input: options.input,
      tools: this.toolRegistry.list(),
      turn: options.turn,
      signal: options.signal,
    }

    let content = ''
    let usage: AgentEngineUsage | undefined
    const toolCalls: ToolCall[] = []

    for await (const event of this.provider.stream(request)) {
      if (options.signal?.aborted) {
        throw new Error('AgentEngine request aborted')
      }

      if (isStreamChannelChunk(event)) {
        this.streamChannel.push(options.sessionId, event)
      }

      switch (event.type) {
        case 'text-delta':
          content += event.text
          await this.eventBus.emit(options.sessionId, {
            type: SESSION_EVENT_TYPES.CONTENT_PART,
            part: { type: 'text', text: event.text },
          })
          break
        case 'reasoning-delta':
        case 'tool-call-delta':
        case 'finish':
          break
        case 'usage':
          usage = mergeUsage(usage, event.usage)
          break
        case 'tool-call-done':
          toolCalls.push(event.toolCall)
          break
      }
    }

    return { content, toolCalls, usage }
  }
}

export function createEchoAgentProvider(): AgentEngineProvider {
  return {
    id: 'echo',
    model: 'local-echo',
    async *stream(request) {
      const text = `Echo: ${request.input}`
      for (const token of splitForStreaming(text)) {
        await delay(12)
        yield { type: 'text-delta', text: token, turnIndex: request.turn }
      }
    },
  }
}

function isStreamChannelChunk(event: ProviderStreamEvent): event is AgentEngineStreamChunk {
  return event.type === 'text-delta' || event.type === 'reasoning-delta' || event.type === 'tool-call-delta'
}

function splitForStreaming(text: string): string[] {
  const parts = text.match(/\S+\s*/g)
  return parts?.length ? parts : [text]
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${randomId}`
}

function estimateUsage(input: string, output: string, durationMs: number): AgentEngineUsage {
  const inputTokens = roughTokenCount(input)
  const outputTokens = roughTokenCount(output)
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs,
  }
}

function roughTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function mergeUsage(current: AgentEngineUsage | undefined, next: ProviderUsage | AgentEngineUsage | undefined): AgentEngineUsage | undefined {
  if (!next) return current
  if (!current) return { ...next }
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    durationMs: Math.max(current.durationMs ?? 0, next.durationMs ?? 0) || undefined,
  }
}
