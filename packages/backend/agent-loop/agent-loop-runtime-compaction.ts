// 带适配器的上下文压缩驱动(从 `agent-loop-runtime.ts` 拆出,拆分批 1,D226):什么时候该压、一轮压缩怎么计划、
// 压完的结果怎么落回状态、发哪些事件。它是压缩的三个面之一 —— 压缩**算法**(怎么切块、怎么摘要)住在
// `agent-loop-context-compact.ts`,「同一会话不并发压缩、发送前等闸」的调度状态是引擎里的压缩闸;这里只做驱动。
import { SESSION_EVENT_TYPES } from '@shared/events/session-event-types.js'
import { getContextCompactReason, type CoreCompactSession } from './agent-loop-context-compact.js'
import {
  buildContextUsageSnapshot,
} from './agent-loop-context-usage.js'
import { coreProviderOwnsItsContextWindow } from './agent-loop-external-agent-providers.js'
import { toLogger, type CompatLogger } from '@onething/backend/logging'
import type { CoreAgentLoopContextBudget } from './agent-loop-runtime-budget.js'
import { configWithApiKey } from './agent-loop-runtime-preparation.js'

export type CoreAgentLoopCompactReason = 'threshold'

export interface CoreAgentLoopCompactState {
  configuredKeepTurns: number
  keepRecentTurns: number
  pass: number
  compacted: boolean
}

export type CoreAgentLoopCompactPassPlan =
  | { kind: 'stop'; state: CoreAgentLoopCompactState }
  | { kind: 'skip-provider-usage-mismatch'; state: CoreAgentLoopCompactState }
  | {
      kind: 'compact'
      state: CoreAgentLoopCompactState
      reason: CoreAgentLoopCompactReason
      keepRecentTurns: number
      pass: number
    }

export type CoreAgentLoopCompactResultPlan =
  | { kind: 'retry'; state: CoreAgentLoopCompactState }
  | { kind: 'stop'; state: CoreAgentLoopCompactState }

export type CoreAgentLoopCompactFinalPlan =
  | { kind: 'none' }
  | { kind: 'rebuild' }

export interface CoreAgentLoopCompactResultLike {
  success: boolean
  skipped?: boolean
  summary?: string
  error?: string
  retainedContextSize?: number
}

export type CoreAgentLoopCompactEventPlan =
  | {
      type: typeof SESSION_EVENT_TYPES.CONTEXT_COMPACT_COMPLETED
      success: boolean
      skipped?: boolean
      summary?: string
      error?: string
    }
  | {
      type: typeof SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED
      contextSize: number
    }

export interface CoreAgentLoopCompactSessionLike extends CoreCompactSession {
  contextSize?: number
  lastInputTokens?: number
}

export interface CoreAgentLoopCompactionContext<TSettings, TProviderConfig extends object> {
  sessionId: string
  providerId: string
  providerConfig: TProviderConfig
  settings: TSettings
}

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CoreAgentLoopCompactLogger = CompatLogger

export interface CoreAgentLoopCompactionAdapters<
  TSettings,
  TProviderConfig extends object,
  TSession extends CoreAgentLoopCompactSessionLike,
  TMessage,
  TCompactResult extends CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
> {
  getSession(sessionId: string): TSession | null | undefined
  compactSessionContext(input: {
    sessionId: string
    providerId: string
    configWithApiKey: TProviderConfig & { apiKey: string }
    settings: TSettings
    keepRecentTurns: number
    onMessageCreated: (message: unknown) => Promise<void>
    onMessageUpdated: (messageId: string, updates: unknown) => Promise<void>
  }): Promise<TCompactResult>
  emitEvent(sessionId: string, event: CoreAgentLoopCompactEventPlan | { type: typeof SESSION_EVENT_TYPES.MESSAGE_CREATED; message: unknown } | { type: typeof SESSION_EVENT_TYPES.MESSAGE_UPDATED; messageId: string; updates: unknown }): Promise<void>
  rebuildMessages(): Promise<TMessage[]>
  shouldSkipProviderUsageMismatch?: (input: {
    providerId: string
    /** 这一发的 config(宿主据它判「这一发真正发给谁」,core 只转交)。 */
    providerConfig?: unknown
    session: TSession
    modelContextLength: number
    inputTokens?: number
  }) => boolean
  logger?: CoreAgentLoopCompactLogger
}

export interface MaybeCompactAgentLoopContextOptions<
  TSettings,
  TProviderConfig extends object,
  TSession extends CoreAgentLoopCompactSessionLike,
  TMessage,
  TCompactResult extends CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
> {
  ctx: CoreAgentLoopCompactionContext<TSettings, TProviderConfig>
  turn: number
  messages: TMessage[]
  budget: CoreAgentLoopContextBudget
  compactEnabled: boolean
  keepRecentTurns: number
  adapters: CoreAgentLoopCompactionAdapters<TSettings, TProviderConfig, TSession, TMessage, TCompactResult>
}

export type CoreAgentLoopTurnCompactionAdapters<
  TSettings,
  TProviderConfig extends object,
  TSession extends CoreAgentLoopCompactSessionLike,
  TMessage,
  TCompactResult extends CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
> = Omit<CoreAgentLoopCompactionAdapters<TSettings, TProviderConfig, TSession, TMessage, TCompactResult>, 'rebuildMessages'>

export function shouldStartAgentLoopContextCompact(options: {
  turn: number
  providerId: string
  compactEnabled: boolean
}): boolean {
  if (options.turn <= 1) return false
  // 能力查询而非身份判定:上下文归执行体自己管时,我们不压缩(E0)。
  if (coreProviderOwnsItsContextWindow(options.providerId)) return false
  if (!options.compactEnabled) return false
  return true
}

export function createAgentLoopCompactState(configuredKeepTurns: number): CoreAgentLoopCompactState {
  const normalizedKeepTurns = Math.max(0, Math.floor(configuredKeepTurns || 0))
  return {
    configuredKeepTurns: normalizedKeepTurns,
    keepRecentTurns: normalizedKeepTurns,
    pass: 1,
    compacted: false,
  }
}

export function planAgentLoopContextCompactPass(options: {
  state: CoreAgentLoopCompactState
  session?: CoreCompactSession
  providerId: string
  budget: CoreAgentLoopContextBudget
  providerUsageMismatch?: boolean
  inputTokens?: number
}): CoreAgentLoopCompactPassPlan {
  if (options.state.configuredKeepTurns <= 0) {
    return { kind: 'stop', state: options.state }
  }
  if (options.state.pass > options.state.configuredKeepTurns) {
    return { kind: 'stop', state: options.state }
  }
  if (!options.session) {
    return { kind: 'stop', state: options.state }
  }
  if (options.providerUsageMismatch) {
    return { kind: 'skip-provider-usage-mismatch', state: options.state }
  }

  const reason = getContextCompactReason({
    session: options.session,
    modelContextLength: options.budget.modelContextLength,
    thresholdPercent: options.budget.thresholdPercent,
    inputTokens: options.inputTokens,
  })
  if (!reason) {
    return { kind: 'stop', state: options.state }
  }

  return {
    kind: 'compact',
    state: options.state,
    reason,
    keepRecentTurns: options.state.keepRecentTurns,
    pass: options.state.pass,
  }
}

function nextAgentLoopCompactState(
  state: CoreAgentLoopCompactState,
  patch: Partial<CoreAgentLoopCompactState> = {},
): CoreAgentLoopCompactState {
  return {
    ...state,
    ...patch,
  }
}

export function applyAgentLoopContextCompactResult(options: {
  state: CoreAgentLoopCompactState
  reason: CoreAgentLoopCompactReason
  success: boolean
  skipped?: boolean
}): CoreAgentLoopCompactResultPlan {
  if (!options.success) {
    return { kind: 'stop', state: options.state }
  }

  if (options.skipped) {
    const state = nextAgentLoopCompactState(options.state, {
      keepRecentTurns: options.state.keepRecentTurns - 1,
      pass: options.state.pass + 1,
    })
    return state.keepRecentTurns <= 0 || state.pass > state.configuredKeepTurns
      ? { kind: 'stop', state }
      : { kind: 'retry', state }
  }

  return { kind: 'stop', state: nextAgentLoopCompactState(options.state, { compacted: true }) }
}

/**
 * 2026-08-23:hard-limit 触发删除之后,压缩收尾只剩"压过就重建历史"一条路 ——
 * 压缩轮次跑完仍然超阈值,循环就带着现有历史继续走(与既有 'stop' 路径同款),
 * 不再抛错早退。
 */
export function planAgentLoopContextCompactFinal(options: {
  state: CoreAgentLoopCompactState
}): CoreAgentLoopCompactFinalPlan {
  return options.state.compacted ? { kind: 'rebuild' } : { kind: 'none' }
}

export function buildAgentLoopContextCompactEventPlan(
  result: CoreAgentLoopCompactResultLike,
): CoreAgentLoopCompactEventPlan[] {
  const events: CoreAgentLoopCompactEventPlan[] = [{
    type: SESSION_EVENT_TYPES.CONTEXT_COMPACT_COMPLETED,
    success: result.success,
    skipped: result.skipped,
    summary: result.summary,
    error: result.error,
  }]
  if (result.success && !result.skipped) {
    events.push({
      type: SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED,
      contextSize: result.retainedContextSize ?? 0,
    })
  }
  return events
}

export async function maybeCompactAgentLoopContextWithAdapters<
  TSettings,
  TProviderConfig extends object,
  TSession extends CoreAgentLoopCompactSessionLike,
  TMessage,
  TCompactResult extends CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
>(
  options: MaybeCompactAgentLoopContextOptions<TSettings, TProviderConfig, TSession, TMessage, TCompactResult>,
): Promise<TMessage[] | undefined> {
  const { ctx, adapters } = options
  const logger = toLogger(adapters.logger)

  if (!shouldStartAgentLoopContextCompact({
    turn: options.turn,
    providerId: ctx.providerId,
    compactEnabled: options.compactEnabled,
  })) return undefined

  let compactState = createAgentLoopCompactState(options.keepRecentTurns)

  while (true) {
    const session = adapters.getSession(ctx.sessionId)
    const usage = session
      ? buildContextUsageSnapshot({
          session,
          historyMessages: !compactState.compacted && options.messages.length > 0
            ? options.messages as unknown[]
            : undefined,
          modelContextLength: options.budget.modelContextLength,
          thresholdPercent: options.budget.thresholdPercent,
          providerId: ctx.providerId,
          model: (ctx.providerConfig as { model?: string }).model,
        })
      : undefined
    if (
      session &&
      usage &&
      (session.contextSize !== usage.visibleInputTokens ||
        session.lastInputTokens !== usage.visibleInputTokens)
    ) {
      await adapters.emitEvent(ctx.sessionId, {
        type: SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED,
        contextSize: usage.visibleInputTokens,
      })
    }
    const providerUsageMismatch = session
      ? adapters.shouldSkipProviderUsageMismatch?.({
          providerId: ctx.providerId,
          providerConfig: ctx.providerConfig,
          session,
          modelContextLength: options.budget.modelContextLength,
          inputTokens: usage?.visibleInputTokens,
        }) ?? false
      : false
    const passPlan = planAgentLoopContextCompactPass({
      state: compactState,
      session: session ?? undefined,
      providerId: ctx.providerId,
      budget: options.budget,
      providerUsageMismatch,
      inputTokens: usage?.visibleInputTokens,
    })

    if (passPlan.kind === 'stop') break

    if (passPlan.kind === 'skip-provider-usage-mismatch') {
      logger.warn('[AgentLoopRuntime] Skipping context compact because provider usage exceeds registered model context length:', {
        sessionId: ctx.sessionId,
        providerId: ctx.providerId,
        model: (ctx.providerConfig as { model?: unknown }).model,
        contextSize: usage?.visibleInputTokens ?? session?.contextSize ?? session?.lastInputTokens ?? 0,
        modelContextLength: options.budget.modelContextLength,
        source: usage?.source,
      })
      return undefined
    }

    logger.debug('[ContextUsage] decision', {
      sessionId: ctx.sessionId,
      providerId: ctx.providerId,
      model: (ctx.providerConfig as { model?: unknown }).model,
      visibleInputTokens: usage?.visibleInputTokens,
      effectiveInputTokens: usage?.effectiveInputTokens,
      providerInputTokens: usage?.providerInputTokens,
      requestEstimatedInputTokens: usage?.requestEstimatedInputTokens,
      modelContextLength: usage?.modelContextLength ?? options.budget.modelContextLength,
      reservedOutputTokens: options.budget.reservedOutputTokens,
      thresholdPercent: usage?.thresholdPercent ?? options.budget.thresholdPercent,
      reason: passPlan.reason,
      source: usage?.source,
      historyMessageCount: usage?.details.historyMessageCount,
      summaryUsed: usage?.details.summaryUsed,
      turn: options.turn,
    })
    logger.debug('[AgentLoopRuntime] Context compact triggered before agent turn', {
      sessionId: ctx.sessionId,
      model: (ctx.providerConfig as { model?: unknown }).model,
      turn: options.turn,
      modelContextLength: options.budget.modelContextLength,
      reservedOutputTokens: options.budget.reservedOutputTokens,
      keepRecentTurns: passPlan.keepRecentTurns,
      pass: passPlan.pass,
      reason: passPlan.reason,
    })

    const result = await adapters.compactSessionContext({
      sessionId: ctx.sessionId,
      providerId: ctx.providerId,
      configWithApiKey: configWithApiKey(ctx.providerConfig),
      settings: ctx.settings,
      keepRecentTurns: passPlan.keepRecentTurns,
      onMessageCreated: message => adapters.emitEvent(ctx.sessionId, {
        type: SESSION_EVENT_TYPES.MESSAGE_CREATED,
        message,
      }),
      onMessageUpdated: (messageId, updates) => adapters.emitEvent(ctx.sessionId, {
        type: SESSION_EVENT_TYPES.MESSAGE_UPDATED,
        messageId,
        updates,
      }),
    })

    try {
      for (const event of buildAgentLoopContextCompactEventPlan(result)) {
        await adapters.emitEvent(ctx.sessionId, event)
      }
    } catch (error) {
      logger.error('[AgentLoopRuntime] context compact event emit error:', undefined, error)
    }

    const resultPlan = applyAgentLoopContextCompactResult({
      state: compactState,
      reason: passPlan.reason,
      success: result.success,
      skipped: result.skipped,
    })
    compactState = resultPlan.state

    if (!result.success) return undefined

    if (resultPlan.kind === 'retry') continue
    break
  }

  const finalPlan = planAgentLoopContextCompactFinal({ state: compactState })

  return finalPlan.kind === 'rebuild' ? adapters.rebuildMessages() : undefined
}
