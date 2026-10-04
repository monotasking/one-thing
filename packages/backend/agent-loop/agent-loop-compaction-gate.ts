// 压缩闸:同一会话不并发压缩、发送前先等压缩收尾、发送前要不要自动压。它是压缩的第三个面 —— 压缩**算法**
// (选段 / 定块 / 摘要 / 文件清单)住在 `agent-loop-context-compact{,-sizing,-summary,-file-tags}.ts`,带适配器的
// 回合中压缩**驱动**住在 `agent-loop-runtime-compaction.ts`;这里是引擎命令入口那一侧的**调度状态**。
// 2026-10-04 从 `CoreStreamEngine` 拆出的协作件(拆分批 3,D227):方法正文原样,从前读引擎字段的地方改读
// `CompactionGatePort`(每一格在调用那一刻回引擎取,子类覆写的 `log` / `logError` / `emitStreamError` 照旧生效)。
import { SESSION_EVENT_TYPES } from '@shared/events/session-event-types.js'
import { coreProviderOwnsItsContextWindow } from './agent-loop-external-agent-providers.js'
import { buildContextUsageSnapshot } from './agent-loop-context-usage.js'
import { resolveContextCompactTotalBudgetMs } from './agent-loop-context-compact-summary.js'
import { asRecord } from './agent-loop-provider-resolution.js'
import type {
  StreamEngineCompactionAdapter,
  StreamEngineHistoryAdapter,
  StreamEngineModelRegistryAdapter,
  StreamEngineStoreAdapter,
} from './agent-loop-engine-adapters.js'
import type {
  CoreContextCompactResultLike,
  CoreEventBusEmitterLike,
  CoreProviderConfigWithKeyLike,
  CoreStreamMessage,
  CoreStreamSession,
  CoreStreamSettings,
} from './agent-loop-stream-engine-types.js'

/** 压缩闸向引擎要的东西:每一格都在调用那一刻回引擎取。 */
export interface CompactionGatePort<
  TSettings extends CoreStreamSettings,
  TMessage extends CoreStreamMessage,
  TSession extends CoreStreamSession<TMessage>,
  THistoryMessage,
  TCompactResult extends CoreContextCompactResultLike,
> {
  store(): StreamEngineStoreAdapter<TSettings, TSession, TMessage>
  models(): StreamEngineModelRegistryAdapter
  history(): StreamEngineHistoryAdapter<TSession, TMessage, THistoryMessage>
  compaction(): StreamEngineCompactionAdapter<unknown, TCompactResult>
  eventBus(): CoreEventBusEmitterLike | null
  log(message: string): void
  logError(message: string, error: unknown): void
  emitStreamError(sessionId: string, error: string): void
  emitContextSizeUpdated(sessionId: string, contextSize: number): void
  emitMessageCreated(sessionId: string, message: TMessage): Promise<void>
  emitMessageUpdated(sessionId: string, messageId: string, updates: Partial<TMessage>): Promise<void>
}

export class CompactionGate<
  TSettings extends CoreStreamSettings,
  TMessage extends CoreStreamMessage,
  TSession extends CoreStreamSession<TMessage>,
  TProviderConfigWithKey extends CoreProviderConfigWithKeyLike,
  THistoryMessage,
  TCompactResult extends CoreContextCompactResultLike,
> {
  constructor(
    private readonly port: CompactionGatePort<TSettings, TMessage, TSession, THistoryMessage, TCompactResult>,
  ) {}

  readonly activeCompactions = new Set<string>()

  /**
   * P2(2026-08-14):per-session 压缩闸。压缩开跑时放进一个 promise,收尾时
   * **无条件** resolve 并清除。四个命令入口在持久化任何消息之前 await 它 ——
   * 语义是**等待而不是拒绝**:压缩通常几十秒,用户消息不该丢、也不该要求手动
   * 重试。这是本方案唯一新增的阻塞点,所以 finally 的 resolve 不能有条件。
   */
  private compactionGates = new Map<string, { promise: Promise<void>; release: () => void }>()

  async maybeCompactBeforeSend(
    sessionId: string,
    providerId: string,
    configWithApiKey: TProviderConfigWithKey,
    settings: TSettings,
  ): Promise<boolean> {
    // 发送前压缩同理走能力查询(E0):别人的窗口,别人自己管。
    if (coreProviderOwnsItsContextWindow(providerId)) return true

    const compactSettings = settings.chat
    if (compactSettings?.contextCompactEnabled === false) return true
    // P2 兜底断言:理论上到不了 —— 命令入口的 waitForCompactionIdle 已经把
    // 「压缩进行中」等成了「压缩已结束」。留着是因为 core 不该假设每个宿主的
    // 每条路都过了那道闸(例如未来新增的命令入口忘了 await)。
    if (this.activeCompactions.has(sessionId)) {
      this.port.emitStreamError(sessionId, 'Context compact is already running. Please wait for it to finish before sending another message.')
      return false
    }

    // 2026-08-23:预留输出量不再参与触发判定(hard-limit 已删),这里只需要窗口长度。
    let modelContextLength = 128000
    try {
      modelContextLength = await this.port.models().getModelContextLength(configWithApiKey.model, providerId)
    } catch (error) {
      this.port.logError('Failed to resolve model context length for compact:', error)
    }

    const configuredKeepTurns = compactSettings?.contextCompactKeepRecentTurns ?? 6
    let keepRecentTurns = configuredKeepTurns

    for (let pass = 1; pass <= configuredKeepTurns; pass++) {
      const latestSession = this.port.store().getSession(sessionId)
      if (!latestSession) return true
      const historyMessages = this.port.history().buildMessages(
        this.port.store().listMessages(sessionId) as TMessage[],
        latestSession,
      )
      const usage = buildContextUsageSnapshot({
        session: latestSession,
        historyMessages: historyMessages as unknown[],
        modelContextLength,
        thresholdPercent: compactSettings?.contextCompactThreshold ?? 85,
        providerId,
        model: configWithApiKey.model,
      })
      if (
        latestSession.contextSize !== usage.visibleInputTokens ||
        latestSession.lastInputTokens !== usage.visibleInputTokens
      ) {
        this.port.emitContextSizeUpdated(sessionId, usage.visibleInputTokens)
      }

      if (this.port.compaction().shouldSkipAutoCompactForProviderUsageMismatch({
        providerId,
        // 宿主据这份 config 判「这一发真正发给谁」(core 只转交,不读)。
        providerConfig: configWithApiKey,
        session: latestSession,
        modelContextLength,
        inputTokens: usage.visibleInputTokens,
      })) {
        this.port.logError('Skipping auto compact because provider usage exceeds registered model context length:', {
          sessionId,
          providerId,
          model: configWithApiKey.model,
          contextSize: usage.visibleInputTokens,
          modelContextLength,
          source: usage.source,
        })
        return true
      }

      const reason = this.port.compaction().getContextCompactReason({
        session: latestSession,
        modelContextLength,
        thresholdPercent: compactSettings?.contextCompactThreshold ?? 85,
        inputTokens: usage.visibleInputTokens,
      })
      if (!reason) return true

      this.port.log(`[ContextUsage] decision ${JSON.stringify({
        sessionId,
        providerId,
        model: configWithApiKey.model,
        visibleInputTokens: usage.visibleInputTokens,
        effectiveInputTokens: usage.effectiveInputTokens,
        providerInputTokens: usage.providerInputTokens,
        requestEstimatedInputTokens: usage.requestEstimatedInputTokens,
        modelContextLength: usage.modelContextLength,
        thresholdPercent: usage.thresholdPercent,
        reason,
        source: usage.source,
        historyMessageCount: usage.details.historyMessageCount,
        summaryUsed: usage.details.summaryUsed,
      })}`)
      this.port.log(`Auto compact triggered before send session=${sessionId} model=${configWithApiKey.model} reason=${reason}`)

      const result = await this.runContextCompact(
        {
          sessionId,
          providerId,
          configWithApiKey,
          settings,
          keepRecentTurns,
          onMessageCreated: (message: TMessage) => this.port.emitMessageCreated(sessionId, message),
          onMessageUpdated: (messageId: string, updates: Partial<TMessage>) => this.port.emitMessageUpdated(sessionId, messageId, updates),
        },
        { auto: true },
      )

      await this.port.eventBus()?.emit(sessionId, {
        type: SESSION_EVENT_TYPES.CONTEXT_COMPACT_COMPLETED,
        success: result.success,
        skipped: result.skipped,
        summary: result.summary,
        error: result.error,
      })

      if (result.success && !result.skipped) {
        this.port.emitContextSizeUpdated(sessionId, result.retainedContextSize ?? 0)
      }

      if (!result.success) {
        if (result.error === 'Context compact is already running.') {
          this.port.emitStreamError(sessionId, 'Context compact is already running. Please wait for it to finish before sending another message.')
          return false
        }
        this.port.logError('Auto compact failed; continuing send:', result.error)
        return true
      }

      if (result.skipped) {
        keepRecentTurns--
        if (keepRecentTurns <= 0) break
      } else {
        return true
      }
    }

    // 压缩轮次跑完就放行:2026-08-23 起唯一的触发器是用户设的百分比,压不下去
    // 也不再拦截发送 —— provider 若真的超窗,报它自己的原始错误。
    const latestSession = this.port.store().getSession(sessionId)
    if (!latestSession) return true
    const finalHistoryMessages = this.port.history().buildMessages(
      this.port.store().listMessages(sessionId) as TMessage[],
      latestSession,
    )
    const finalUsage = buildContextUsageSnapshot({
      session: latestSession,
      historyMessages: finalHistoryMessages as unknown[],
      modelContextLength,
      thresholdPercent: compactSettings?.contextCompactThreshold ?? 85,
      providerId,
      model: configWithApiKey.model,
    })
    if (
      latestSession.contextSize !== finalUsage.visibleInputTokens ||
      latestSession.lastInputTokens !== finalUsage.visibleInputTokens
    ) {
      this.port.emitContextSizeUpdated(sessionId, finalUsage.visibleInputTokens)
    }

    return true
  }

  /**
   * P2:同步开闸。**必须**在调用点的第一个 await 之前调用 —— 闸是在 await
   * 窗口里挡住并发发送的东西,晚一步就等于没有。返回的 release 必须在 finally
   * 里无条件调用。
   */
  openCompactionGate(sessionId: string): () => void {
    let release: () => void = () => {}
    const promise = new Promise<void>(resolve => {
      release = resolve
    })
    const gate = { promise, release }
    this.compactionGates.set(sessionId, gate)
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.compactionGates.get(sessionId) === gate) {
        this.compactionGates.delete(sessionId)
      }
      gate.release()
    }
  }

  /**
   * P2 入口闸。**无条件执行** —— 不看 `contextCompactEnabled`、不看
   * `coreProviderOwnsItsContextWindow`:那些开关只管「要不要自动压」,不管
   * 「压缩进行中能不能并发改会话」。
   *
   * 上限用压缩总预算兜底并**放行**(而不是拒绝):传输/宿主意外死掉时,一次
   * 忘记 resolve 的闸不该让整个会话永久卡死。
   */
  async waitForCompactionIdle(sessionId: string): Promise<void> {
    const gate = this.compactionGates.get(sessionId)
    if (!gate) return

    // 预算随设置里的单块超时走(默认 300s × 5);设置读不到就用默认。
    let budgetMs = resolveContextCompactTotalBudgetMs(undefined)
    try {
      budgetMs = resolveContextCompactTotalBudgetMs(
        this.port.store().getSettings()?.chat?.contextCompactChunkTimeoutSeconds,
      )
    } catch {
      /* settings unavailable — keep the default budget */
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), budgetMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })

    try {
      const outcome = await Promise.race([
        gate.promise.then(() => 'idle' as const),
        timedOut,
      ])
      if (outcome === 'timeout') {
        this.port.logError('waitForCompactionIdle exceeded the compaction budget; proceeding anyway:', { sessionId })
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async runContextCompact(
    options: unknown,
    registration: { alreadyRegistered?: boolean; requestId?: string; auto?: boolean } = {},
  ): Promise<TCompactResult> {
    const sessionId = asRecord(options).sessionId
    if (typeof sessionId !== 'string') {
      return {
        success: false,
        error: 'Session id is required.',
      } as TCompactResult
    }

    // 手动路径已经在 handleCompactContext 的入口同步登记过(消除
    // resolveProvider await 窗口的 TOCTOU),这里不再重复登记。
    let release: () => void = () => {}
    if (!registration.alreadyRegistered) {
      if (this.activeCompactions.has(sessionId)) {
        return {
          success: false,
          error: 'Context compact is already running.',
        } as TCompactResult
      }
      this.activeCompactions.add(sessionId)
      release = this.openCompactionGate(sessionId)
    }

    try {
      // P1:压缩开始的唯一 emit 点 —— 手动与自动都从这里出去。
      await this.port.eventBus()?.emit(sessionId, {
        type: SESSION_EVENT_TYPES.CONTEXT_COMPACT_STARTED,
        ...(registration.requestId !== undefined ? { requestId: registration.requestId } : {}),
        ...(registration.auto ? { auto: true } : {}),
      }).catch(err => this.port.logError('context:compact-started emit error:', err))

      // C6:分块进度。手动路(handleCompactContext)与发送前自动路
      // (maybeCompactBeforeSend)都经过这里,所以接线只此一处 —— 回合中那条
      // (agent-loop 的 adapters)不走本函数,在 app 层各自接。
      return await this.port.compaction().compactSessionContext({
        ...asRecord(options),
        onProgress: (progress: { chunk: number; totalChunks: number }) =>
          this.port.eventBus()?.emit(sessionId, {
            type: SESSION_EVENT_TYPES.CONTEXT_COMPACT_PROGRESS,
            chunk: progress.chunk,
            totalChunks: progress.totalChunks,
          }).catch(err => this.port.logError('context:compact-progress emit error:', err)),
      })
    } finally {
      if (!registration.alreadyRegistered) {
        this.activeCompactions.delete(sessionId)
      }
      release()
    }
  }
}
