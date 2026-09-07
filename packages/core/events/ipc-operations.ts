import type { SessionCommandType } from './session-command-types.js'
import type { EventBase, EventDeliveryOptions } from './types.js'

type MaybePromise<T> = T | Promise<T>

/**
 * 命令的最小形状。`EventBase` 的 `type: string` 对**命令**来说太松 —— 任何字符串
 * 都能过,词汇表就管不住这条出口了。这里收紧到 `SessionCommandType`:能进这个
 * 函数的 `type`,只能是 `SESSION_COMMAND_TYPES` 里那 12 条之一。
 */
export interface SessionCommandLike extends EventBase {
  type: SessionCommandType
}

export interface CoreSessionCommandEmitterLike<
  TCommand extends SessionCommandLike = SessionCommandLike,
  TResult = unknown,
> {
  emit(sessionId: string, command: TCommand, options?: EventDeliveryOptions): MaybePromise<TResult>
}

export interface CoreSessionEventEmitterLike<
  TEvent extends EventBase = EventBase,
  TResult = unknown,
> {
  emit(sessionId: string, event: TEvent): MaybePromise<TResult>
}

export interface EmitCoreSessionCommandForIpcOptions<
  TCommand extends SessionCommandLike = SessionCommandLike,
  TResult = unknown,
> {
  sessionId: string
  command: TCommand
  executionContext?: unknown
  /**
   * `NoInfer`:`TCommand` 由 `command` 一处决定。总线的 `emit` 收的是事件 ∪ 命令
   * 的并集,让它也参与推断会把 `TCommand` 拽回并集(或直接退回约束默认值)。
   */
  eventBus: CoreSessionCommandEmitterLike<NoInfer<TCommand>, TResult>
  logger?: {
    error?: (...args: unknown[]) => void
  }
}

export type CoreSessionCommandIpcResult<TResult = unknown> =
  | { success: true; result: TResult }
  | { success: false; error: string }

export interface EmitCoreSessionEventSafelyOptions<
  TEvent extends EventBase = EventBase,
  TResult = unknown,
> {
  sessionId: string
  event: TEvent
  eventBus: CoreSessionEventEmitterLike<TEvent, TResult>
  logger?: {
    error?: (...args: unknown[]) => void
  }
  errorLabel?: string
}

export async function emitCoreSessionCommandForIpc<
  TCommand extends SessionCommandLike,
  TResult,
>(
  options: EmitCoreSessionCommandForIpcOptions<TCommand, TResult>,
): Promise<CoreSessionCommandIpcResult<TResult>> {
  try {
    const result = options.executionContext === undefined
      ? await options.eventBus.emit(options.sessionId, options.command)
      : await options.eventBus.emit(options.sessionId, options.command, { executionContext: options.executionContext })
    return { success: true, result }
  } catch (error) {
    options.logger?.error?.('[CoreEvents] session command emit failed:', error)
    return {
      success: false,
      error: error instanceof Error && error.message
        ? error.message
        : 'Failed to handle command',
    }
  }
}

export async function emitCoreSessionEventSafely<
  TEvent extends EventBase,
  TResult,
>(
  options: EmitCoreSessionEventSafelyOptions<TEvent, TResult>,
): Promise<TResult | undefined> {
  try {
    return await options.eventBus.emit(options.sessionId, options.event)
  } catch (error) {
    options.logger?.error?.(options.errorLabel ?? '[CoreEvents] session event emit failed:', error)
    return undefined
  }
}
