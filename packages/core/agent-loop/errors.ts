import type { AgentToolCall, AgentToolResult } from './types.js'

/** A persistence boundary failed. Never retry a provider or convert it to a tool result. */
export class AgentExecutionCheckpointError extends Error {
  readonly code = 'AGENT_EXECUTION_CHECKPOINT_FAILED'

  constructor(public readonly phase: string, cause: unknown) {
    super(`Execution stopped because ${phase} was not durably saved: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'AgentExecutionCheckpointError'
  }
}

export function isAgentExecutionCheckpointError(error: unknown): error is AgentExecutionCheckpointError {
  return error instanceof AgentExecutionCheckpointError
    || (!!error && typeof error === 'object' && 'code' in error && error.code === 'AGENT_EXECUTION_CHECKPOINT_FAILED')
}

export async function awaitAgentExecutionCheckpoint(phase: string, checkpoint?: () => void | Promise<void>): Promise<void> {
  try {
    await checkpoint?.()
  } catch (error) {
    throw isAgentExecutionCheckpointError(error) ? error : new AgentExecutionCheckpointError(phase, error)
  }
}

export class AgentLoopPauseForConfirmationError extends Error {
  readonly toolCall: AgentToolCall
  readonly result: AgentToolResult

  constructor(toolCall: AgentToolCall, result: AgentToolResult) {
    super(`Agent loop paused for tool confirmation: ${toolCall.name}`)
    this.name = 'AgentLoopPauseForConfirmationError'
    this.toolCall = toolCall
    this.result = result
  }
}

export function isAgentLoopPauseForConfirmationError(
  error: Error | { name?: string } | null | undefined,
): error is AgentLoopPauseForConfirmationError {
  return error instanceof AgentLoopPauseForConfirmationError
    || error?.name === 'AgentLoopPauseForConfirmationError'
}
