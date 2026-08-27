import { CORE_ABORTED_TOOL_ERROR } from '@onething/core'
import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

type MaybePromise<T> = T | Promise<T>

export interface OnethingAbortToolCallLike {
  status?: string
  requiresConfirmation?: boolean
  canRespond?: boolean
  error?: string
  endTime?: number
}

export interface OnethingAbortStepLike<TToolCall extends OnethingAbortToolCallLike = OnethingAbortToolCallLike> {
  id: string
  status?: string
  error?: string
  toolCall?: TToolCall
}

export interface OnethingAbortMessageLike<TStep extends OnethingAbortStepLike = OnethingAbortStepLike> {
  id: string
  isStreaming?: boolean
  steps?: TStep[]
}

export interface OnethingAbortSessionLike<TMessage extends OnethingAbortMessageLike = OnethingAbortMessageLike> {
  messages: TMessage[]
}

export type OnethingAbortCleanupEvent<TStep extends OnethingAbortStepLike = OnethingAbortStepLike> =
  | {
      type: typeof SESSION_EVENT_TYPES.STEP_UPDATED
      stepId: string
      updates: Partial<TStep>
    }
  | {
      type: typeof SESSION_EVENT_TYPES.MESSAGE_UPDATED
      messageId: string
      updates: { isStreaming: false }
    }
  | {
      type: typeof SESSION_EVENT_TYPES.STREAM_COMPLETE
      data: { aborted: true }
    }

export interface CancelOnethingStreamingStepsForAbortOptions<
  TToolCall extends OnethingAbortToolCallLike = OnethingAbortToolCallLike,
  TStep extends OnethingAbortStepLike<TToolCall> = OnethingAbortStepLike<TToolCall>,
  TMessage extends OnethingAbortMessageLike<TStep> = OnethingAbortMessageLike<TStep>,
  TSession extends OnethingAbortSessionLike<TMessage> = OnethingAbortSessionLike<TMessage>,
> {
  sessionId: string
  /**
   * **这条会话正在跑的那次执行,写的是哪条 assistant 消息**(F4-c c4-b,§16.25 钥匙②)。
   *
   * 从前这里是 `getSession(sessionId).messages.find(m => m.isStreaming)` —— 按
   * `isStreaming` **反查**消息。那条寻址把停止按钮钉死在"内存 store 上那一格布尔"
   * 上:`updateMessageStreaming(false)` 一旦空转,这一格就永远留着 `true`,下一次
   * 停止会摸到一条早就收尾的消息(§16.24 第五节证据二)。
   *
   * 今天改成**问登记簿**:活 run 的 `assistantMessageId` 引擎自己一直记着
   * (装配层由 `currentSessionRun(sessionId)` 交进来),消息本身则从折叠产物取。
   * 于是 `isStreaming` 回到它唯一的语义 —— 由 run 开闭推导出来的**结论**,
   * 而不再兼职当寻址索引。
   *
   * 没有活 run = 没有要停的流,整段清理不跑(与"找不到 streaming 消息"同义)。
   */
  getActiveRunMessage(sessionId: string): TMessage | null | undefined
  updateMessageStep(
    sessionId: string,
    messageId: string,
    stepId: string,
    updates: Partial<TStep>
  ): MaybePromise<unknown>
  updateMessageStreaming(
    sessionId: string,
    messageId: string,
    streaming: boolean
  ): MaybePromise<unknown>
  flushSessionSave(sessionId: string): MaybePromise<unknown>
  emitEvent(sessionId: string, event: OnethingAbortCleanupEvent<TStep>): MaybePromise<unknown>
}

export interface CancelOnethingStreamingStepsForAbortResult {
  completed: boolean
  cancelledSteps: number
  messageId?: string
}

export interface AbortOnethingStreamsForIpcLogger {
  log?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

export interface AbortOnethingStreamsForIpcOptions<
  TToolCall extends OnethingAbortToolCallLike = OnethingAbortToolCallLike,
  TStep extends OnethingAbortStepLike<TToolCall> = OnethingAbortStepLike<TToolCall>,
  TMessage extends OnethingAbortMessageLike<TStep> = OnethingAbortMessageLike<TStep>,
  TSession extends OnethingAbortSessionLike<TMessage> = OnethingAbortSessionLike<TMessage>,
> extends Omit<CancelOnethingStreamingStepsForAbortOptions<TToolCall, TStep, TMessage, TSession>, 'sessionId'> {
  sessionId?: string
  /**
   * Legacy pre-engine stream ledger hooks. Optional: the ledgers they read
   * were retired (they had readers but no writers — see
   * docs/audit/architecture-review-2026-07-26.md A1); the engine hooks are
   * the real abort path.
   */
  getLegacyActiveSessionIds?(): Iterable<string>
  abortLegacyStream?(sessionId: string): boolean
  abortEngineStream(sessionId: string): boolean
  abortAllEngineStreams(): boolean
  clearPermission(sessionId: string): void
  /**
   * Stop a collab ROOM's turn (collab-team-v2 §5.1 入口①). Injected by the
   * assembly layer; absent everywhere collab is not assembled.
   *
   * A room session has hosted no stream since W18 — the turn runs in the
   * member's execution session — so `abortEngineStream` on a room id has always
   * been a no-op and the stop button pressed nothing. The callback is asked
   * FIRST and answers a narrow question: "is this id a room whose turn I just
   * stopped?" Returning false (not a room, or nothing running) leaves the
   * ordinary engine path to handle it, so a work session or private chat is
   * unaffected.
   *
   * Deliberately a callback rather than a `kind` check here: this module is
   * product-layer and must not learn what a room is, nor reach for the store.
   */
  abortCollabRoomTurn?(sessionId: string): boolean
  logger?: AbortOnethingStreamsForIpcLogger
}

export interface AbortOnethingStreamsForIpcResult {
  success: boolean
}

export interface ListOnethingActiveStreamsForIpcOptions {
  getLegacyActiveSessionIds?(): Iterable<string>
  getEngineActiveSessionIds(): Iterable<string>
}

export interface ListOnethingActiveStreamsForIpcResult {
  success: true
  sessionIds: string[]
}

export async function cancelOnethingStreamingStepsForAbort<
  TToolCall extends OnethingAbortToolCallLike,
  TStep extends OnethingAbortStepLike<TToolCall>,
  TMessage extends OnethingAbortMessageLike<TStep>,
  TSession extends OnethingAbortSessionLike<TMessage>,
>(
  options: CancelOnethingStreamingStepsForAbortOptions<TToolCall, TStep, TMessage, TSession>,
): Promise<CancelOnethingStreamingStepsForAbortResult> {
  const streamingMessage = options.getActiveRunMessage(options.sessionId)
  if (!streamingMessage?.steps) return { completed: false, cancelledSteps: 0 }

  const now = Date.now()
  let cancelledSteps = 0
  for (const step of streamingMessage.steps) {
    if (step.status !== 'awaiting-confirmation' && step.status !== 'running') continue

    // 引擎自己的收尾修复(`finalizeLingeringAgentLoopToolWork`)紧接着也会跑一遍
    // 这条消息。它按 `status ∈ {running, pending}` 且**没在等确认**筛,写的是
    // `{status:'cancelled', error:'User cancelled'}`(调用上还多一格 `endTime`)。
    //
    // 这里比它早一步(停止按钮要立刻有反馈),于是先到的那一份决定了账上留下
    // 什么 —— 从前这一支不写 `error`,同一次停止在桌面(先到)与网页(engine
    // 那一份先到)上留下**两种**记录。谁先谁后本来就是竞态,记录不该跟着变:
    // 引擎的收尾修复筛得到的那些 step,这里照它的字段写(§10.14 第 7 类)。
    // 等确认的那一支不动 —— 引擎的修复明确放过它(`requiresConfirmation` 的调用
    // 在恢复流里还要用)。
    const engineWouldRepair = step.status === 'running' && !step.toolCall?.requiresConfirmation
    const toolCall = step.toolCall
      ? {
          ...step.toolCall,
          status: 'cancelled',
          requiresConfirmation: false,
          canRespond: false,
          ...(engineWouldRepair
            ? {
                endTime: step.toolCall.endTime ?? now,
                error: step.toolCall.error || CORE_ABORTED_TOOL_ERROR,
              }
            : {}),
        } as TToolCall
      : undefined
    const updates = {
      status: 'cancelled',
      ...(engineWouldRepair ? { error: step.error || CORE_ABORTED_TOOL_ERROR } : {}),
      toolCall,
    } as Partial<TStep>

    await options.updateMessageStep(options.sessionId, streamingMessage.id, step.id, updates)
    await options.emitEvent(options.sessionId, {
      type: SESSION_EVENT_TYPES.STEP_UPDATED,
      stepId: step.id,
      updates,
    })
    cancelledSteps += 1
  }

  await options.updateMessageStreaming(options.sessionId, streamingMessage.id, false)
  await options.flushSessionSave(options.sessionId)
  await options.emitEvent(options.sessionId, {
    type: SESSION_EVENT_TYPES.MESSAGE_UPDATED,
    messageId: streamingMessage.id,
    updates: { isStreaming: false },
  })
  await options.emitEvent(options.sessionId, {
    type: SESSION_EVENT_TYPES.STREAM_COMPLETE,
    data: { aborted: true },
  })

  return {
    completed: true,
    cancelledSteps,
    messageId: streamingMessage.id,
  }
}

export async function abortOnethingStreamsForIpc<
  TToolCall extends OnethingAbortToolCallLike,
  TStep extends OnethingAbortStepLike<TToolCall>,
  TMessage extends OnethingAbortMessageLike<TStep>,
  TSession extends OnethingAbortSessionLike<TMessage>,
>(
  options: AbortOnethingStreamsForIpcOptions<TToolCall, TStep, TMessage, TSession>,
): Promise<AbortOnethingStreamsForIpcResult> {
  const sessionId = options.sessionId

  if (sessionId) {
    let aborted = false
    if (options.abortCollabRoomTurn?.(sessionId)) {
      options.logger?.log?.(`[Backend] Aborting collab room turn: ${sessionId}`)
      aborted = true
    }
    if (options.abortLegacyStream?.(sessionId)) {
      options.logger?.log?.(`[Backend] Aborting stream for session (legacy): ${sessionId}`)
      aborted = true
    }
    if (options.abortEngineStream(sessionId)) {
      options.logger?.log?.(`[Backend] Aborting stream for session (engine): ${sessionId}`)
      aborted = true
    }

    options.clearPermission(sessionId)
    await cancelOnethingStreamingStepsForAbort({
      sessionId,
      getActiveRunMessage: options.getActiveRunMessage,
      updateMessageStep: options.updateMessageStep,
      updateMessageStreaming: options.updateMessageStreaming,
      flushSessionSave: options.flushSessionSave,
      emitEvent: options.emitEvent,
    })

    return { success: aborted }
  }

  let aborted = false
  const legacySessionIds = Array.from(options.getLegacyActiveSessionIds?.() ?? [])
  if (legacySessionIds.length > 0) {
    options.logger?.log?.(`[Backend] Aborting all active streams (${legacySessionIds.length})`)
    for (const legacySessionId of legacySessionIds) {
      options.abortLegacyStream?.(legacySessionId)
      options.clearPermission(legacySessionId)
    }
    aborted = true
  }

  if (options.abortAllEngineStreams()) {
    aborted = true
  }

  return { success: aborted }
}

export function listOnethingActiveStreamsForIpc(
  options: ListOnethingActiveStreamsForIpcOptions,
): ListOnethingActiveStreamsForIpcResult {
  const legacySessionIds = Array.from(options.getLegacyActiveSessionIds?.() ?? [])
  let engineSessionIds: string[] = []

  try {
    engineSessionIds = Array.from(options.getEngineActiveSessionIds())
  } catch {
    // StreamEngine may not be initialized in legacy/bootstrap contexts.
  }

  return {
    success: true,
    sessionIds: Array.from(new Set([...legacySessionIds, ...engineSessionIds])),
  }
}
