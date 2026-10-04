/**
 * 把 onething 的选项形状转给 `createCoreStreamProcessor` 的工厂(`createOnethingStreamProcessor`)。它从前是 runtime
 * 根上的 `engine-stream-processor.ts`;收尾整理 3(2026-10-03)搬进 `engine/` 时与处理器本体那只撞名,按内容改名。
 */
import type { JsonObject } from '@shared/json'
import {
  createCoreStreamProcessor,
  type CoreReasoningPlacement,
  type CoreResolvedTool,
  type CoreStreamProcessor,
  type CoreStreamProcessorEmitter,
  type CoreStreamProcessorLogger,
  type CoreStreamProcessorStore,
  type CoreStreamStepLike,
  type CoreStreamToolCallLike,
  type CreateCoreStreamProcessorOptions,
} from '@onething/backend/agent-loop'

export interface CreateOnethingStreamProcessorOptions<
  TToolCall extends CoreStreamToolCallLike = CoreStreamToolCallLike,
  TStep = CoreStreamStepLike<TToolCall>,
  TReasoningPlacement extends string = CoreReasoningPlacement,
> {
  sessionId: string
  assistantMessageId: string
  initialContent?: {
    content?: string
    reasoning?: string
  }
  store: CoreStreamProcessorStore<TToolCall>
  emitter: CoreStreamProcessorEmitter<TToolCall, TStep, TReasoningPlacement>
  resolveToolIdentity(toolName: string, args?: JsonObject): CoreResolvedTool
  logger?: CoreStreamProcessorLogger
}

export function createOnethingStreamProcessor<
  TToolCall extends CoreStreamToolCallLike = CoreStreamToolCallLike,
  TStep = CoreStreamStepLike<TToolCall>,
  TReasoningPlacement extends string = CoreReasoningPlacement,
>(
  options: CreateOnethingStreamProcessorOptions<TToolCall, TStep, TReasoningPlacement>,
): CoreStreamProcessor<TToolCall, TReasoningPlacement> {
  const createCoreStreamProcessorOptions: CreateCoreStreamProcessorOptions<TToolCall, TStep, TReasoningPlacement> = {
    ctx: {
      sessionId: options.sessionId,
      assistantMessageId: options.assistantMessageId,
    },
    initialContent: options.initialContent,
    resolveToolIdentity: options.resolveToolIdentity,
    store: options.store,
    emitter: options.emitter,
    logger: options.logger,
  };
  return createCoreStreamProcessor<TToolCall, TStep, TReasoningPlacement>(createCoreStreamProcessorOptions)
}
