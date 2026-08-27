import { coreToolCallSnapshot, patchCoreToolCall } from './tool-call-cow.js'
import type { JsonObject } from '../json.js'
import type { CoreReasoningPlacement } from './ipc-emitter.js'
import { coreStepIdForToolCall } from './tool-step.js'
import { toLogger, type CompatLogger } from '../logging/index.js'

export interface CoreResolvedTool {
  toolId: string
  displayName: string
  isMcp: boolean
}

export type CoreStreamToolCallStatus =
  | 'pending'
  | 'queued'
  | 'received'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'input-streaming'

/**
 * How the tool call's streamed arguments were finalized. 'parse' is the honest
 * path (accumulated JSON became parseable mid-stream); 'provider-done' means
 * the provider's done event settled them without a mid-stream parse — the
 * whole-blob and stream-end fallback paths land here.
 */
export type CoreToolArgsFinalizedBy = 'parse' | 'provider-done'

export interface CoreStreamToolCallLike {
  id: string
  toolId: string
  toolName: string
  arguments: JsonObject
  status: CoreStreamToolCallStatus
  timestamp: number
  streamingArgs?: string
  /** When the argument stream finished (tool:input-end), before execution. */
  receivedAt?: number
  argsFinalizedBy?: CoreToolArgsFinalizedBy
}

export type CoreStreamStepType = 'command' | 'tool-call'

export interface CoreStreamStepLike<TToolCall extends CoreStreamToolCallLike = CoreStreamToolCallLike> {
  id: string
  type: CoreStreamStepType
  title: string
  status: 'running'
  timestamp: number
  toolCallId: string
  toolCall: TToolCall
  turnIndex?: number
}

export interface CoreToolIdentityResolver {
  normalizeToolName?: (toolName: string) => string
  isMCPTool?: (toolId: string) => boolean
  findMCPToolIdByShortName?: (shortName: string, args?: JsonObject) => string | null
  parseMCPToolId?: (toolId: string) => { serverId: string; toolName: string } | null
  getMCPServerName?: (serverId: string) => string | undefined
}

export function resolveToolIdentity(
  toolName: string,
  args: JsonObject = {},
  resolver: CoreToolIdentityResolver = {},
): CoreResolvedTool {
  const originalToolName = resolver.normalizeToolName?.(toolName) ?? toolName
  let toolId = originalToolName
  let displayName = originalToolName
  let isMcp = false

  if (resolver.isMCPTool?.(originalToolName)) {
    toolId = originalToolName
    isMcp = true
  } else {
    const fullId = resolver.findMCPToolIdByShortName?.(originalToolName, args)
    if (fullId) {
      toolId = fullId
      isMcp = true
    }
  }

  if (isMcp) {
    if (toolId === 'mcp_search' || toolId === 'tool_function') {
      displayName = toolId
      return { toolId, displayName, isMcp }
    }
    const parsed = resolver.parseMCPToolId?.(toolId)
    if (parsed) {
      displayName = resolver.getMCPServerName?.(parsed.serverId) || parsed.serverId
    }
  }

  return { toolId, displayName, isMcp }
}

export function coreStepTypeForToolName(toolName: string): CoreStreamStepType {
  return toolName.toLowerCase() === 'bash' ? 'command' : 'tool-call'
}

/**
 * 占位 step 的标题(`tool_input_start` 那一刻)。参数还没到,派生标题无从谈起
 * —— 引擎写的就是这一句,之后由工具自报的 `annotate{title}` 盖掉。
 *
 * 单独成一个函数是因为**投影也要说出同一句话**:一次"参数流到一半被打断"的
 * 调用永远停在这个标题上(§10.14 第 7 类),投影不许手抄这条字面量。
 */
export function coreToolInputStartStepTitle(displayName: string): string {
  return `调用工具: ${displayName}`
}

export function createCoreStreamToolCall(input: {
  toolCallId: string
  resolved: Pick<CoreResolvedTool, 'toolId' | 'displayName'>
  args?: JsonObject
  status?: CoreStreamToolCallStatus
  streamingArgs?: string
  timestamp?: number
}): CoreStreamToolCallLike {
  return {
    id: input.toolCallId,
    toolId: input.resolved.toolId,
    toolName: input.resolved.displayName,
    arguments: input.args ?? {},
    status: input.status ?? 'pending',
    ...(input.streamingArgs !== undefined ? { streamingArgs: input.streamingArgs } : {}),
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function applyCoreToolCallChunk<TToolCall extends CoreStreamToolCallLike>(
  toolCalls: TToolCall[],
  input: {
    toolCallId: string
    resolved: Pick<CoreResolvedTool, 'toolId' | 'displayName'>
    args: JsonObject
    publish?: boolean
    timestamp?: number
    status?: CoreStreamToolCallStatus
  },
): TToolCall {
  const status = input.status ?? 'pending'
  const existingIndex = toolCalls.findIndex(toolCall => toolCall.id === input.toolCallId)

  if (existingIndex >= 0) {
    // COW(F3):换出新对象换掉这一格 —— 老对象可能已经被交给 store 并冻结。
    // `streamingArgs` 是「解构掉」而不是 delete:参数已经收全了,占位文本不该留。
    const { streamingArgs: _finishedStreamingArgs, ...rest } = toolCalls[existingIndex]
    const toolCall = {
      ...rest,
      toolId: input.resolved.toolId,
      toolName: input.resolved.displayName,
      arguments: input.args,
      status,
    } as TToolCall
    toolCalls[existingIndex] = toolCall
    return toolCall
  }

  const toolCall = createCoreStreamToolCall({
    toolCallId: input.toolCallId,
    resolved: input.resolved,
    args: input.args,
    status,
    timestamp: input.timestamp,
  }) as TToolCall

  if (input.publish !== false) {
    toolCalls.push(toolCall)
  }

  return toolCall
}

export function createCoreToolInputStartArtifacts<TToolCall extends CoreStreamToolCallLike = CoreStreamToolCallLike>(
  input: {
    toolCallId: string
    resolved: Pick<CoreResolvedTool, 'toolId' | 'displayName'>
    stepId: string
    rawToolName: string
    turnIndex?: number
    timestamp?: number
  },
): {
  placeholderToolCall: TToolCall
  placeholderStep: CoreStreamStepLike<TToolCall>
  stepType: CoreStreamStepType
} {
  const timestamp = input.timestamp ?? Date.now()
  const placeholderToolCall = createCoreStreamToolCall({
    toolCallId: input.toolCallId,
    resolved: input.resolved,
    args: {},
    status: 'input-streaming',
    streamingArgs: '',
    timestamp,
  }) as TToolCall
  const stepType = coreStepTypeForToolName(input.rawToolName)
  return {
    placeholderToolCall,
    stepType,
    placeholderStep: {
      id: input.stepId,
      type: stepType,
      title: coreToolInputStartStepTitle(input.resolved.displayName),
      status: 'running',
      timestamp,
      toolCallId: input.toolCallId,
      toolCall: { ...placeholderToolCall },
      ...(input.turnIndex !== undefined ? { turnIndex: input.turnIndex } : {}),
    },
  }
}

export interface CoreToolInputStartOptions {
  stepId?: string
  visible?: boolean
}

export interface CoreToolInputBufferEntry {
  toolName: string
  argsText: string
  stepId?: string
  visible: boolean
}

export type CoreToolInputFinishResult =
  | {
      ok: true
      toolCallId: string
      toolName: string
      args: JsonObject
      visible: boolean
    }
  | {
      ok: false
      toolCallId: string
      rawArgsText: string
      error: unknown
    }

export class CoreStreamingToolInputBuffer {
  private readonly buffers = new Map<string, CoreToolInputBufferEntry>()

  start(toolCallId: string, toolName: string, options: CoreToolInputStartOptions = {}): CoreToolInputBufferEntry {
    const entry: CoreToolInputBufferEntry = {
      toolName,
      argsText: '',
      stepId: options.visible === false ? undefined : options.stepId,
      visible: options.visible !== false,
    }
    this.buffers.set(toolCallId, entry)
    return entry
  }

  append(toolCallId: string, argsTextDelta: string): CoreToolInputBufferEntry | null {
    const entry = this.buffers.get(toolCallId)
    if (!entry) return null
    entry.argsText += argsTextDelta
    return entry
  }

  finish(toolCallId: string): CoreToolInputFinishResult | null {
    const entry = this.buffers.get(toolCallId)
    if (!entry) return null

    let args: JsonObject = {}
    try {
      if (entry.argsText.trim()) {
        args = JSON.parse(entry.argsText) as JsonObject
      }
    } catch (error) {
      this.buffers.delete(toolCallId)
      return {
        ok: false,
        toolCallId,
        rawArgsText: entry.argsText,
        error,
      }
    }

    this.buffers.delete(toolCallId)
    return {
      ok: true,
      toolCallId,
      toolName: entry.toolName,
      args,
      visible: entry.visible,
    }
  }

  getStepId(toolCallId: string): string | undefined {
    return this.buffers.get(toolCallId)?.stepId
  }

  get(toolCallId: string): CoreToolInputBufferEntry | undefined {
    return this.buffers.get(toolCallId)
  }

  clear(): void {
    this.buffers.clear()
  }
}

export interface CoreStreamProcessorStore<TToolCall extends CoreStreamToolCallLike> {
  updateMessageContent(sessionId: string, assistantMessageId: string, content: string): void
  updateMessageReasoning(sessionId: string, assistantMessageId: string, reasoning: string): void
  updateMessageToolCalls(sessionId: string, assistantMessageId: string, toolCalls: TToolCall[]): void
  updateMessageStreaming(sessionId: string, assistantMessageId: string, streaming: boolean): void
  flushSessionSave(sessionId: string): Promise<void> | void
}

export interface CoreStreamProcessorEmitter<
  TToolCall extends CoreStreamToolCallLike,
  TStep,
  TReasoningPlacement extends string = CoreReasoningPlacement,
> {
  sendTextChunk(text: string, turnIndex?: number): void
  sendReasoningChunk(reasoning: string, turnIndex?: number, placement?: TReasoningPlacement): void
  sendToolCall(toolCall: TToolCall): void
  sendStepAdded(step: TStep): void
  sendToolInputStart(toolCallId: string, displayName: string, toolCall: TToolCall): void
  sendToolInputDelta(toolCallId: string, argsTextDelta: string): void
  sendToolInputEnd?(
    toolCallId: string,
    stepId: string | undefined,
    toolCall: TToolCall,
    receivedAt: number,
    finalizedBy: CoreToolArgsFinalizedBy,
  ): void
}

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CoreStreamProcessorLogger = CompatLogger

export interface CoreStreamProcessorContext {
  sessionId: string
  assistantMessageId: string
}

export interface CreateCoreStreamProcessorOptions<
  TToolCall extends CoreStreamToolCallLike = CoreStreamToolCallLike,
  TStep = CoreStreamStepLike<TToolCall>,
  TReasoningPlacement extends string = CoreReasoningPlacement,
> {
  ctx: CoreStreamProcessorContext
  store: CoreStreamProcessorStore<TToolCall>
  emitter: CoreStreamProcessorEmitter<TToolCall, TStep, TReasoningPlacement>
  resolveToolIdentity: (toolName: string, args?: JsonObject) => CoreResolvedTool
  initialContent?: {
    content?: string
    reasoning?: string
  }
  logger?: CoreStreamProcessorLogger
}

export interface CoreStreamProcessor<
  TToolCall extends CoreStreamToolCallLike = CoreStreamToolCallLike,
  TReasoningPlacement extends string = CoreReasoningPlacement,
> {
  readonly accumulatedContent: string
  readonly accumulatedReasoning: string
  readonly toolCalls: TToolCall[]
  handleTextChunk(text: string, turnContent?: { value: string }, turnIndex?: number): string
  handleReasoningChunk(
    reasoning: string,
    turnReasoning?: { value: string },
    turnIndex?: number,
    placement?: TReasoningPlacement,
  ): void
  handleToolCallChunk(toolCallData: {
    toolCallId: string
    toolName: string
    args: JsonObject
  }, options?: { publish?: boolean; status?: CoreStreamToolCallStatus }): TToolCall
  /**
   * Settle a tool call whose arguments are complete: applies the chunk with
   * status 'received', stamps receivedAt/argsFinalizedBy, and emits
   * tool:input-end so every host learns the real receive-complete moment.
   */
  handleToolCallComplete(toolCallData: {
    toolCallId: string
    toolName: string
    args: JsonObject
  }, options?: { publish?: boolean; finalizedBy?: CoreToolArgsFinalizedBy }): TToolCall
  handleToolInputStart(toolCallId: string, toolName: string, turnIndex?: number, options?: { publish?: boolean }): void
  handleToolInputDelta(toolCallId: string, argsTextDelta: string): void
  handleToolInputEnd(toolCallId: string, options?: { finalizedBy?: CoreToolArgsFinalizedBy }): TToolCall | null
  getStepIdForToolCall(toolCallId: string): string | undefined
  /**
   * A11(§13.1):这次调用被藏起来了吗(`publish:false`)。
   *
   * 藏 = 占位卡、`toolCalls.push`、step 三样一起不做,消息上因此**没有**它。
   * 会话事件账本要记同一件事(不然投影会凭空多出一张卡),而记录器挂在
   * provider 流上、看不见呈现层的决定 —— 所以判定点仍然只有一个(下面那个
   * `rememberVisibility`),外面只能**问**。
   */
  isToolCallHidden(toolCallId: string): boolean
  finalize(): Promise<void>
}

export function createCoreStreamProcessor<
  TToolCall extends CoreStreamToolCallLike = CoreStreamToolCallLike,
  TStep = CoreStreamStepLike<TToolCall>,
  TReasoningPlacement extends string = CoreReasoningPlacement,
>(
  options: CreateCoreStreamProcessorOptions<TToolCall, TStep, TReasoningPlacement>,
): CoreStreamProcessor<TToolCall, TReasoningPlacement> {
  const {
    ctx,
    store,
    emitter,
    initialContent,
  } = options
  const logger = toLogger(options.logger)
  let accumulatedContent = initialContent?.content || ''
  let accumulatedReasoning = initialContent?.reasoning || ''
  const toolCalls: TToolCall[] = []
  const toolInputBuffers = new CoreStreamingToolInputBuffer()
  /**
   * A11:被藏起来的调用 id。`toolInputBuffers` 的那一格会在参数收齐时被删掉,
   * 而"这次调用在不在消息上"要一直答得出来(工具结果、收尾都会回头问)。
   */
  const hiddenToolCallIds = new Set<string>()
  /**
   * `publish` 这个入参**只在这里被解释一次**:返回可见性,顺便记下不可见的那些。
   * 三个入口(`handleToolCallChunk` / `handleToolCallComplete` /
   * `handleToolInputStart`)都走它 —— 各判各的就是三个判定点。
   */
  function rememberVisibility(toolCallId: string, publish: boolean | undefined): boolean {
    const visible = publish !== false
    if (!visible) hiddenToolCallIds.add(toolCallId)
    return visible
  }

  return {
    get accumulatedContent() { return accumulatedContent },
    get accumulatedReasoning() { return accumulatedReasoning },
    get toolCalls() { return toolCalls },

    handleTextChunk(text: string, turnContent?: { value: string }, turnIndex?: number): string {
      if (!text) return ''

      accumulatedContent += text
      if (turnContent) turnContent.value += text
      store.updateMessageContent(ctx.sessionId, ctx.assistantMessageId, accumulatedContent)
      emitter.sendTextChunk(text, turnIndex)
      return text
    },

    handleReasoningChunk(
      reasoning: string,
      turnReasoning?: { value: string },
      turnIndex?: number,
      placement: TReasoningPlacement = 'top' as TReasoningPlacement,
    ): void {
      accumulatedReasoning += reasoning
      if (turnReasoning) turnReasoning.value += reasoning
      if (placement === 'top') {
        store.updateMessageReasoning(ctx.sessionId, ctx.assistantMessageId, accumulatedReasoning)
      }
      emitter.sendReasoningChunk(reasoning, turnIndex, placement)
    },

    handleToolCallChunk(toolCallData: {
      toolCallId: string
      toolName: string
      args: JsonObject
    }, handleOptions: { publish?: boolean; status?: CoreStreamToolCallStatus } = {}): TToolCall {
      const publish = rememberVisibility(toolCallData.toolCallId, handleOptions.publish)
      const resolved = options.resolveToolIdentity(toolCallData.toolName, toolCallData.args)
      const toolCall = applyCoreToolCallChunk(toolCalls, {
        toolCallId: toolCallData.toolCallId,
        resolved,
        args: toolCallData.args,
        publish,
        status: handleOptions.status,
      })

      if (publish) {
        store.updateMessageToolCalls(ctx.sessionId, ctx.assistantMessageId, coreToolCallSnapshot(toolCalls))
        emitter.sendToolCall(toolCall)
      }

      return toolCall
    },

    handleToolCallComplete(toolCallData: {
      toolCallId: string
      toolName: string
      args: JsonObject
    }, completeOptions: { publish?: boolean; finalizedBy?: CoreToolArgsFinalizedBy } = {}): TToolCall {
      const finalizedBy = completeOptions.finalizedBy ?? 'parse'
      const receivedAt = Date.now()
      const toolCall = patchCoreToolCall(
        toolCalls,
        this.handleToolCallChunk(toolCallData, {
          publish: completeOptions.publish,
          status: 'received',
        }),
        { receivedAt, argsFinalizedBy: finalizedBy } as Partial<TToolCall>,
      )

      const publish = rememberVisibility(toolCallData.toolCallId, completeOptions.publish)
      if (publish) {
        store.updateMessageToolCalls(ctx.sessionId, ctx.assistantMessageId, coreToolCallSnapshot(toolCalls))
        emitter.sendToolInputEnd?.(
          toolCallData.toolCallId,
          toolInputBuffers.getStepId(toolCallData.toolCallId),
          toolCall,
          receivedAt,
          finalizedBy,
        )
      }

      return toolCall
    },

    handleToolInputStart(toolCallId: string, toolName: string, turnIndex?: number, handleOptions: { publish?: boolean } = {}): void {
      const visible = rememberVisibility(toolCallId, handleOptions.publish)
      const resolved = options.resolveToolIdentity(toolName)
      // F4-b1(§16.16):step 的身份 = 它那次调用的身份。从前这里现生一个 uuid,
      // 与投影物化的 `step-${callId}` 是两套说法(§16.13 硬阻塞①)。
      const stepId = coreStepIdForToolCall(toolCallId)
      const {
        placeholderToolCall,
        placeholderStep,
      } = createCoreToolInputStartArtifacts<TToolCall>({
        toolCallId,
        resolved,
        stepId,
        rawToolName: toolName,
        turnIndex,
      })
      if (visible) {
        toolCalls.push(placeholderToolCall)
      }

      toolInputBuffers.start(toolCallId, toolName, { stepId, visible })

      if (visible) {
        store.updateMessageToolCalls(ctx.sessionId, ctx.assistantMessageId, coreToolCallSnapshot(toolCalls))
        emitter.sendStepAdded(placeholderStep as TStep)
        emitter.sendToolInputStart(toolCallId, resolved.displayName, placeholderToolCall)
      }
    },

    handleToolInputDelta(toolCallId: string, argsTextDelta: string): void {
      const buffer = toolInputBuffers.append(toolCallId, argsTextDelta)
      if (buffer?.visible) {
        emitter.sendToolInputDelta(toolCallId, argsTextDelta)
      }
    },

    handleToolInputEnd(toolCallId: string, endOptions: { finalizedBy?: CoreToolArgsFinalizedBy } = {}): TToolCall | null {
      const result = toolInputBuffers.finish(toolCallId)
      if (!result) {
        logger.warn(`[StreamProcessor] No buffer found for tool input end: ${toolCallId}`)
        return null
      }

      if (!result.ok) {
        logger.error('[StreamProcessor] Failed to parse tool args JSON:', { rawArgsText: result.rawArgsText }, result.error)
        // Surface the failure instead of leaving the placeholder card in
        // input-streaming forever — the receive state must never lie.
        const placeholder = toolCalls.find(toolCall => toolCall.id === toolCallId)
        if (placeholder && placeholder.status === 'input-streaming') {
          const failed = patchCoreToolCall(toolCalls, placeholder, { status: 'failed' } as Partial<TToolCall>)
          store.updateMessageToolCalls(ctx.sessionId, ctx.assistantMessageId, coreToolCallSnapshot(toolCalls))
          emitter.sendToolCall(failed)
        }
        return null
      }

      return this.handleToolCallComplete({
        toolCallId,
        toolName: result.toolName,
        args: result.args,
      }, { publish: result.visible, finalizedBy: endOptions.finalizedBy })
    },

    isToolCallHidden(toolCallId: string): boolean {
      return hiddenToolCallIds.has(toolCallId)
    },

    getStepIdForToolCall(toolCallId: string): string | undefined {
      return toolInputBuffers.getStepId(toolCallId)
    },

    async finalize(): Promise<void> {
      store.updateMessageStreaming(ctx.sessionId, ctx.assistantMessageId, false)
      await store.flushSessionSave(ctx.sessionId)
    },
  }
}
