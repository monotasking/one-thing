type MaybePromise<T> = T | Promise<T>

export interface OnethingToolCallStateIpcLogger {
  error?: (...args: unknown[]) => void
}

export type OnethingToolStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'awaiting-confirmation'
  | 'cancelled'

export interface OnethingToolCallStateLike {
  id: string
  status?: string
  result?: unknown
  error?: string
  rejected?: boolean
  rejectionReason?: string
  requiresConfirmation?: boolean
}

export interface OnethingToolStepStateLike<
  TToolCall extends OnethingToolCallStateLike = OnethingToolCallStateLike,
> {
  id: string
  status: OnethingToolStepStatus
  toolCallId?: string
  toolCall?: TToolCall
  result?: string
  error?: string
  rejected?: boolean
  rejectionReason?: string
}

export interface OnethingToolMessageStateLike<
  TToolCall extends OnethingToolCallStateLike = OnethingToolCallStateLike,
  TStep extends OnethingToolStepStateLike<TToolCall> = OnethingToolStepStateLike<TToolCall>,
> {
  id: string
  toolCalls?: TToolCall[]
  steps?: TStep[]
}

export interface OnethingToolSessionStateLike<
  TMessage extends OnethingToolMessageStateLike = OnethingToolMessageStateLike,
> {
  messages: TMessage[]
}

export interface ApplyOnethingToolCallUpdateOptions<
  TToolCall extends OnethingToolCallStateLike = OnethingToolCallStateLike,
  TStep extends OnethingToolStepStateLike<TToolCall> = OnethingToolStepStateLike<TToolCall>,
  TMessage extends OnethingToolMessageStateLike<TToolCall, TStep> = OnethingToolMessageStateLike<TToolCall, TStep>,
  TSession extends OnethingToolSessionStateLike<TMessage> = OnethingToolSessionStateLike<TMessage>,
> {
  sessionId: string
  messageId: string
  toolCallId: string
  updates: Partial<TToolCall>
  getSession(sessionId: string): TSession | null | undefined
  updateMessageToolCalls(
    sessionId: string,
    messageId: string,
    toolCalls: TToolCall[],
  ): MaybePromise<unknown>
  updateMessageStep(
    sessionId: string,
    messageId: string,
    stepId: string,
    updates: Partial<TStep>,
  ): MaybePromise<unknown>
}

export interface ApplyOnethingToolCallUpdateResult {
  success: boolean
  error?: string
}

export function mapOnethingToolCallStatusToStepStatus(
  toolCallStatus: string | undefined,
  requiresConfirmation: boolean | undefined,
  fallback: OnethingToolStepStatus,
): OnethingToolStepStatus {
  if (toolCallStatus === 'executing') return 'running'
  if (toolCallStatus === 'completed') return 'completed'
  if (toolCallStatus === 'failed') return 'failed'
  if (toolCallStatus === 'cancelled') return 'cancelled'
  if (toolCallStatus === 'pending' && requiresConfirmation) return 'awaiting-confirmation'
  return fallback
}

export function formatOnethingToolCallResult(result: unknown): string | undefined {
  if (typeof result === 'string') return result
  return result ? JSON.stringify(result) : undefined
}

export async function applyOnethingToolCallUpdate<
  TToolCall extends OnethingToolCallStateLike,
  TStep extends OnethingToolStepStateLike<TToolCall>,
  TMessage extends OnethingToolMessageStateLike<TToolCall, TStep>,
  TSession extends OnethingToolSessionStateLike<TMessage>,
>(
  options: ApplyOnethingToolCallUpdateOptions<TToolCall, TStep, TMessage, TSession>,
): Promise<ApplyOnethingToolCallUpdateResult> {
  const session = options.getSession(options.sessionId)
  if (!session) {
    return { success: false, error: 'Session not found' }
  }

  const message = session.messages.find(item => item.id === options.messageId)
  if (!message?.toolCalls) {
    return { success: false, error: 'Message or tool calls not found' }
  }

  const toolCalls = message.toolCalls.map(toolCall => {
    if (toolCall.id !== options.toolCallId) return toolCall
    return { ...toolCall, ...options.updates } as TToolCall
  })

  await options.updateMessageToolCalls(options.sessionId, options.messageId, toolCalls)

  const step = message.steps?.find(item => item.toolCallId === options.toolCallId)
  if (!step) {
    return { success: true }
  }

  const stepStatus = mapOnethingToolCallStatusToStepStatus(
    options.updates.status,
    options.updates.requiresConfirmation,
    step.status,
  )
  const mergedToolCall = {
    ...(step.toolCall ?? {}),
    ...options.updates,
  } as TToolCall
  const stepUpdates = {
    status: stepStatus,
    result: formatOnethingToolCallResult(options.updates.result),
    error: options.updates.error,
    rejected: options.updates.rejected,
    rejectionReason: options.updates.rejectionReason,
    toolCall: mergedToolCall,
  } as Partial<TStep>

  await options.updateMessageStep(options.sessionId, options.messageId, step.id, stepUpdates)
  return { success: true }
}

export async function applyOnethingToolCallUpdateForIpc<
  TToolCall extends OnethingToolCallStateLike,
  TStep extends OnethingToolStepStateLike<TToolCall>,
  TMessage extends OnethingToolMessageStateLike<TToolCall, TStep>,
  TSession extends OnethingToolSessionStateLike<TMessage>,
>(
  options: ApplyOnethingToolCallUpdateOptions<TToolCall, TStep, TMessage, TSession> & {
    logger?: OnethingToolCallStateIpcLogger
  },
): Promise<ApplyOnethingToolCallUpdateResult> {
  try {
    return await applyOnethingToolCallUpdate(options)
  } catch (error) {
    options.logger?.error?.('[Tools IPC] Error updating tool call:', error)
    return {
      success: false,
      error: error instanceof Error && error.message ? error.message : 'Failed to update tool call',
    }
  }
}
