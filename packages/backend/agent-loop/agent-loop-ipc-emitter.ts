import type { JsonObject } from '@shared/json.js'
import type { CoreToolArgsFinalizedBy } from './agent-loop-stream-processor.js'

export type CoreReasoningPlacement = 'top' | 'inline'

export interface CoreStreamCompleteData {
  [key: string]: unknown
}

export interface CoreStreamErrorData {
  [key: string]: unknown
}

export interface CoreIPCEmitter<
  TStep = unknown,
  TToolCall = unknown,
  TToolPartialResult = unknown,
  TToolResult = unknown,
  TContentPart = unknown,
  TStreamCompleteData = CoreStreamCompleteData,
  TStreamErrorData = CoreStreamErrorData,
> {
  sendTextChunk(text: string, turnIndex?: number, voiceSpeakText?: string): void
  sendReasoningChunk(reasoning: string, turnIndex?: number, placement?: CoreReasoningPlacement): void
  sendContentPart(part: TContentPart): void
  sendContinuation(turnIndex?: number): void
  sendToolCall(toolCall: TToolCall): void
  sendToolResult(toolCall: TToolCall): void
  sendToolInputStart(toolCallId: string, toolName: string, toolCall: TToolCall): void
  sendToolInputDelta(toolCallId: string, argsTextDelta: string): void
  sendToolInputEnd(
    toolCallId: string,
    stepId: string | undefined,
    toolCall: TToolCall,
    receivedAt: number,
    finalizedBy: CoreToolArgsFinalizedBy,
  ): void
  sendToolExecutionStart(toolCallId: string, stepId: string, toolName: string, args: JsonObject, startTime?: number): void
  sendToolExecutionUpdate(toolCallId: string, stepId: string, partialResult: TToolPartialResult): void
  sendToolExecutionEnd(toolCallId: string, stepId: string, result?: TToolResult, isError?: boolean, error?: string, durationMs?: number): void
  sendContextSizeUpdate(contextSize: number): void
  sendStepAdded(step: TStep): void
  sendStepUpdated(stepId: string, updates: Partial<TStep>): void
  sendStreamComplete(data: TStreamCompleteData): void
  sendStreamError(data: TStreamErrorData): void
  sendStreamAborted(reason?: string): void
  sendSkillActivated(skillName: string): void
}
