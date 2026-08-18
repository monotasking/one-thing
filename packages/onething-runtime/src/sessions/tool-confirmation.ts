import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

type MaybePromise<T> = T | Promise<T>

export interface OnethingResumeToolCallLike {
  status?: string
  requiresConfirmation?: boolean
}

export interface OnethingResumeMessageLike<TToolCall extends OnethingResumeToolCallLike = OnethingResumeToolCallLike> {
  id: string
  role?: string
  toolCalls?: TToolCall[]
}

export interface OnethingResumeSessionLike<TMessage extends OnethingResumeMessageLike = OnethingResumeMessageLike> {
  messages: TMessage[]
}

export type OnethingResumeAfterToolConfirmEvent =
  | { type: typeof SESSION_EVENT_TYPES.CONTENT_CONTINUATION }
  | {
      type: typeof SESSION_EVENT_TYPES.STREAM_ERROR
      data: {
        error: string
        errorDetails?: string
      }
    }

export interface ResumeOnethingAfterToolConfirmationOptions<
  TToolCall extends OnethingResumeToolCallLike = OnethingResumeToolCallLike,
  TMessage extends OnethingResumeMessageLike<TToolCall> = OnethingResumeMessageLike<TToolCall>,
  TSession extends OnethingResumeSessionLike<TMessage> = OnethingResumeSessionLike<TMessage>,
> {
  sessionId: string
  messageId: string
  getSession(sessionId: string): TSession | null | undefined
  emitEvent(sessionId: string, event: OnethingResumeAfterToolConfirmEvent): MaybePromise<unknown>
  resume(): MaybePromise<unknown>
  schedule(task: () => MaybePromise<void>): void
  errorMessage?(error: unknown, fallback: string): string
  errorDetails?(error: unknown): string | undefined
  logger?: {
    log?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
  }
}

export interface ResumeOnethingAfterToolConfirmationResult {
  success: boolean
  error?: string
  errorDetails?: string
}

export type ResumeOnethingAfterToolConfirmationForIpcOptions<
  TToolCall extends OnethingResumeToolCallLike = OnethingResumeToolCallLike,
  TMessage extends OnethingResumeMessageLike<TToolCall> = OnethingResumeMessageLike<TToolCall>,
  TSession extends OnethingResumeSessionLike<TMessage> = OnethingResumeSessionLike<TMessage>,
> = Omit<
  ResumeOnethingAfterToolConfirmationOptions<TToolCall, TMessage, TSession>,
  'schedule'
> & {
  schedule?(task: () => MaybePromise<void>): void
}

function defaultErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function defaultResumeSchedule(task: () => MaybePromise<void>): void {
  queueMicrotask(() => {
    void task()
  })
}

export async function resumeOnethingAfterToolConfirmation<
  TToolCall extends OnethingResumeToolCallLike,
  TMessage extends OnethingResumeMessageLike<TToolCall>,
  TSession extends OnethingResumeSessionLike<TMessage>,
>(
  options: ResumeOnethingAfterToolConfirmationOptions<TToolCall, TMessage, TSession>,
): Promise<ResumeOnethingAfterToolConfirmationResult> {
  const messageForError = options.errorMessage ?? defaultErrorMessage

  try {
    const session = options.getSession(options.sessionId)
    if (!session) return { success: false, error: 'Session not found' }

    const assistantMessage = session.messages.find(message => message.id === options.messageId)
    if (!assistantMessage || assistantMessage.role !== 'assistant') {
      return { success: false, error: 'Assistant message not found' }
    }

    const toolCalls = assistantMessage.toolCalls || []
    const completedToolCalls = toolCalls.filter(toolCall =>
      toolCall.status === 'completed' || toolCall.status === 'failed'
    )
    if (completedToolCalls.length === 0) {
      return { success: false, error: 'No completed tool calls to process' }
    }

    const pendingToolCalls = toolCalls.filter(toolCall =>
      toolCall.status === 'pending' && toolCall.requiresConfirmation
    )
    if (pendingToolCalls.length > 0) {
      options.logger?.log?.(
        `[OnethingRuntime] Still have ${pendingToolCalls.length} pending tool calls, not resuming yet`,
      )
      return { success: false, error: 'Still have pending tool calls awaiting confirmation' }
    }

    await options.emitEvent(options.sessionId, {
      type: SESSION_EVENT_TYPES.CONTENT_CONTINUATION,
    })

    options.schedule(async () => {
      try {
        await options.resume()
      } catch (error) {
        options.logger?.error?.('[OnethingRuntime] StreamEngine resume-after-confirm error:', error)
        await options.emitEvent(options.sessionId, {
          type: SESSION_EVENT_TYPES.STREAM_ERROR,
          data: {
            error: messageForError(error, 'Failed to resume streaming'),
            errorDetails: options.errorDetails?.(error),
          },
        })
      }
    })

    return { success: true }
  } catch (error) {
    options.logger?.error?.('Error resuming after tool confirm:', error)
    return {
      success: false,
      error: messageForError(error, 'Failed to resume streaming'),
      errorDetails: options.errorDetails?.(error),
    }
  }
}

export async function resumeOnethingAfterToolConfirmationForIpc<
  TToolCall extends OnethingResumeToolCallLike,
  TMessage extends OnethingResumeMessageLike<TToolCall>,
  TSession extends OnethingResumeSessionLike<TMessage>,
>(
  options: ResumeOnethingAfterToolConfirmationForIpcOptions<TToolCall, TMessage, TSession>,
): Promise<ResumeOnethingAfterToolConfirmationResult> {
  options.logger?.log?.(
    `[OnethingRuntime] Resuming after tool confirm for session: ${options.sessionId}, message: ${options.messageId}`,
  )

  return resumeOnethingAfterToolConfirmation({
    ...options,
    schedule: options.schedule ?? defaultResumeSchedule,
  })
}
