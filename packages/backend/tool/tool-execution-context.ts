type MaybePromise<T> = T | Promise<T>

export interface OnethingToolExecutionIpcLogger {
  error?: (...args: unknown[]) => void
}

export interface OnethingToolExecutionSessionLike {
  workingDirectory?: string
  workingDirectoryRoots?: unknown[]
}

export interface OnethingSessionToolExecutionContext {
  sessionId: string
  messageId: string
  workingDirectory?: string
  workingDirectoryRoots?: unknown[]
}

export interface OnethingToolExecutionAdapterResult<TResult = unknown> {
  success: boolean
  data?: TResult
  error?: string
}

export interface ExecuteOnethingToolWithSessionContextOptions<
  TArgs = unknown,
  TResult = unknown,
  TSession extends OnethingToolExecutionSessionLike = OnethingToolExecutionSessionLike,
> {
  toolId: string
  args: TArgs
  sessionId: string
  messageId: string
  getSession(sessionId: string): TSession | null | undefined
  executeTool(
    toolId: string,
    args: TArgs,
    context: OnethingSessionToolExecutionContext,
  ): MaybePromise<OnethingToolExecutionAdapterResult<TResult>>
}

export interface ExecuteOnethingToolWithSessionContextResult<TResult = unknown> {
  success: boolean
  result?: TResult
  error?: string
}

export async function executeOnethingToolWithSessionContext<
  TArgs,
  TResult,
  TSession extends OnethingToolExecutionSessionLike,
>(
  options: ExecuteOnethingToolWithSessionContextOptions<TArgs, TResult, TSession>,
): Promise<ExecuteOnethingToolWithSessionContextResult<TResult>> {
  const session = options.getSession(options.sessionId)
  const result = await options.executeTool(options.toolId, options.args, {
    sessionId: options.sessionId,
    messageId: options.messageId,
    workingDirectory: session?.workingDirectory,
    workingDirectoryRoots: session?.workingDirectoryRoots,
  })

  return {
    success: result.success,
    result: result.data,
    error: result.error,
  }
}

export async function executeOnethingToolWithSessionContextForIpc<
  TArgs,
  TResult,
  TSession extends OnethingToolExecutionSessionLike,
>(
  options: ExecuteOnethingToolWithSessionContextOptions<TArgs, TResult, TSession> & {
    logger?: OnethingToolExecutionIpcLogger
  },
): Promise<ExecuteOnethingToolWithSessionContextResult<TResult>> {
  try {
    return await executeOnethingToolWithSessionContext(options)
  } catch (error) {
    options.logger?.error?.('[Tools IPC] Error executing tool:', error)
    return {
      success: false,
      error: error instanceof Error && error.message ? error.message : 'Failed to execute tool',
    }
  }
}
