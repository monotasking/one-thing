import { SESSION_EVENT_TYPES } from '@shared/events/session-event-types.js'
import { SESSION_COMMAND_TYPES } from '@shared/events/session-command-types.js'
import type { SessionCommandType } from '@shared/events/session-command-types.js'
import type { Unsubscribe } from '@onething/backend/event'
import { PendingMessageQueue } from './agent-loop-message-queue.js'
import { isAgentExecutionCheckpointError } from './agent-loop-errors.js'
import type { PendingMessage } from './agent-loop-message-queue.js'
import { getCoreLogger } from '@onething/backend/logging'
import { expandFileMentions, isFileMentionTrustedChannel } from './agent-loop-file-mentions.js'
import { isClientMintedId } from './agent-loop-ids.js'
import { parsePrincipal } from '@shared/permission/principal.js'
import type {
  StreamEnginePromptAdapter,
  StreamEngineStoreAdapter,
} from './agent-loop-engine-adapters.js'
import type {
  AbortLikeCommand,
  CompactContextCommandLike,
  CoreCommandEnvelope,
  CoreContextCompactResultLike,
  CoreEventBusEmitterLike,
  CoreExecutionOptions,
  CoreProviderConfigWithKeyLike,
  CoreStreamEngineOptions,
  CoreStreamEngineRuntime,
  CoreStreamErrorInfo,
  CoreStreamMessage,
  CoreStreamPermissionModeSession,
  CoreStreamPermissionModeSettings,
  CoreStreamResultLike,
  CoreStreamSession,
  CoreStreamSettings,
  EditAndResendCommandLike,
  InjectMessageCommand,
  ResumeAfterConfirmCommandLike,
  RetractSteeringLikeCommand,
  RetryMessageCommandLike,
  SendMessageCommandLike,
} from './agent-loop-stream-engine-types.js'
import { SessionTitleGenerator } from './agent-loop-title.js'
import { ProviderResolution, isCoreProviderResolutionFailure } from './agent-loop-provider-resolution.js'
import { CompactionGate } from './agent-loop-compaction-gate.js'
import {
  extractErrorDetails,
  type CoreErrorDetails,
} from './agent-loop-error-details.js'

const log = getCoreLogger('core.engine')

export function resolveStreamPermissionMode(
  session: CoreStreamPermissionModeSession | null | undefined,
  settings: CoreStreamPermissionModeSettings | null | undefined,
  fallback = 'normal',
): string {
  return session?.permissionMode ?? settings?.tools?.permissionMode ?? fallback
}

export function normalizeCoreStreamError(
  // Error.cause is typed `unknown` by lib.es2022, so it must be excluded from
  // the intersection for plain Error values to remain assignable.
  error: Error & Partial<Omit<CoreErrorDetails, 'cause'>>,
): CoreStreamErrorInfo {
  return {
    error,
    message: error.message || 'Streaming error',
    details: extractErrorDetails({
      message: error.message,
      stack: error.stack,
      // Read via a cast: web tsconfig's lib predates ES2022's Error.cause.
      cause: (error as { cause?: unknown }).cause as CoreErrorDetails | undefined,
      responseBody: error.responseBody,
      data: error.data,
    }),
    isAbortError: error.name === 'AbortError',
  }
}

function normalizeErrorDefault(error: Error): CoreStreamErrorInfo {
  return normalizeCoreStreamError(error)
}

/**
 * CoreStreamEngine 是引擎在 core 里的**唯一一层**(2026-08-21 两层合一):
 * 命令订阅与派发表、命令目标绑定、活跃流生命周期、steering / follow-up 队列
 * (原 `HeadlessStreamEngine`,已删),加上会话/消息/工具/压缩的业务本体。
 *
 * 合并前这里是 `CoreStreamEngine extends HeadlessStreamEngine`,中间隔着 5 个
 * `handleXxxCommand` 抽象转发(每个函数体只有一行 `command as XxxCommandLike`),
 * 从派发表按 F12 要跳两次才到本体。现在派发表直接调 `handleSendMessage` 等本体,
 * 一跳到位;宿主(backend StreamEngine)照旧 override 本体。
 *
 * 平台相关的部分仍由宿主提供:命令目标由 `bindCommandTarget` 注入,
 * `onSessionAbort` / `onSessionCleared` / `onShutdown` / `log` / `logError`
 * 都是留给子类 override 的钩子。
 */
export class CoreStreamEngine<
  TEventBus extends CoreEventBusEmitterLike = CoreEventBusEmitterLike,
  TCommandTarget = unknown,
  TSettings extends CoreStreamSettings = CoreStreamSettings,
  TMessage extends CoreStreamMessage = CoreStreamMessage,
  TSession extends CoreStreamSession<TMessage> = CoreStreamSession<TMessage>,
  TProviderConfig = unknown,
  TProviderConfigWithKey extends CoreProviderConfigWithKeyLike = CoreProviderConfigWithKeyLike,
  TAuthContext = unknown,
  TSkill = unknown,
  TContentPart = unknown,
  TAttachment = unknown,
  THistoryMessage = unknown,
  TStreamResult extends CoreStreamResultLike = CoreStreamResultLike,
  TCompactResult extends CoreContextCompactResultLike = CoreContextCompactResultLike,
> {
  protected activeStreams = new Map<string, AbortController>()
  private readonly activeExecutions = new Map<string, Set<Promise<void>>>()

  /** Tracks preparation and final recorder writes, independently of controller replacement. */
  protected trackSessionExecution<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    let settled!: () => void
    const drained = new Promise<void>(resolve => { settled = resolve })
    const executions = this.activeExecutions.get(sessionId) ?? new Set<Promise<void>>()
    this.activeExecutions.set(sessionId, executions)
    executions.add(drained)
    let pending: Promise<T>
    try { pending = work() } catch (error) { pending = Promise.reject(error) }
    return pending.finally(() => {
      executions.delete(drained)
      if (executions.size === 0 && this.activeExecutions.get(sessionId) === executions) this.activeExecutions.delete(sessionId)
      settled()
    })
  }

  private async drainSessionExecutions(sessionId?: string): Promise<void> {
    for (;;) {
      const pending = sessionId === undefined
        ? [...this.activeExecutions.values()].flatMap(executions => [...executions])
        : [...(this.activeExecutions.get(sessionId) ?? [])]
      if (pending.length === 0) return
      await Promise.all(pending)
    }
  }

  /** Admission must already be closed for this session before a destructive caller invokes this. */
  async abortAndDrain(sessionId: string): Promise<void> {
    this.abort(sessionId, 'Session is closing')
    await this.drainSessionExecutions(sessionId)
  }
  protected sessionChannels = new Map<string, string>()
  protected eventBus: TEventBus | null = null
  protected commandTarget: TCommandTarget | null = null
  protected unsubs: Unsubscribe[] = []

  protected steeringQueues = new Map<string, PendingMessageQueue>()
  protected followUpQueues = new Map<string, PendingMessageQueue>()

  getChannel(sessionId: string): string {
    return this.sessionChannels.get(sessionId) || 'ipc'
  }

  getSteeringQueue(sessionId: string): PendingMessageQueue {
    let queue = this.steeringQueues.get(sessionId)
    if (!queue) {
      queue = new PendingMessageQueue('one-at-a-time')
      this.steeringQueues.set(sessionId, queue)
    }
    return queue
  }

  getFollowUpQueue(sessionId: string): PendingMessageQueue {
    let queue = this.followUpQueues.get(sessionId)
    if (!queue) {
      queue = new PendingMessageQueue('all')
      this.followUpQueues.set(sessionId, queue)
    }
    return queue
  }

  followUpMessage(sessionId: string, content: string, source = 'api', origin?: unknown): void {
    this.assertAccepting(sessionId)
    const queue = this.getFollowUpQueue(sessionId)
    queue.enqueue({
      content,
      source,
      timestamp: Date.now(),
      ...(origin !== undefined ? { origin } : {}),
    })
    this.log(`Follow-up queued for ${sessionId.slice(0, 8)}: "${content.slice(0, 60)}..."`)
  }

  setEventBus(eventBus: TEventBus): void {
    this.unsubscribeCommands()
    this.eventBus = eventBus
    this.subscribeToCommands(eventBus)
  }

  bindCommandTarget(target: TCommandTarget, onDestroyed?: (clear: () => void) => void): void {
    this.commandTarget = target
    onDestroyed?.(() => {
      if (this.commandTarget === target) {
        this.commandTarget = null
      }
    })
  }

  hasCommandTarget(isAlive?: (target: TCommandTarget) => boolean): boolean {
    if (!this.commandTarget) return false
    return isAlive ? isAlive(this.commandTarget) : true
  }

  handleAbort(sessionId: string, command: AbortLikeCommand = { type: SESSION_COMMAND_TYPES.ABORT }): boolean {
    return this.abort(sessionId, command.reason)
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.activeStreams.keys())
  }

  getController(sessionId: string): AbortController | undefined {
    return this.activeStreams.get(sessionId)
  }

  registerController(sessionId: string, controller: AbortController): void {
    this.assertAccepting(sessionId)
    const existing = this.activeStreams.get(sessionId)
    if (existing) {
      this.log(`Aborting previous stream for session: ${sessionId}`)
      existing.abort()
      this.onSessionAbort(sessionId, 'Superseded by a new stream')
    }
    this.activeStreams.set(sessionId, controller)
  }

  removeController(sessionId: string, expectedController?: AbortController): void {
    if (expectedController && this.activeStreams.get(sessionId) !== expectedController) return
    this.activeStreams.delete(sessionId)
    this.sessionChannels.delete(sessionId)
  }

  abort(sessionId: string, reason = 'User cancelled'): boolean {
    const controller = this.activeStreams.get(sessionId)
    if (controller) {
      this.log(`Aborting stream for session: ${sessionId} (${reason})`)
      controller.abort()
      this.activeStreams.delete(sessionId)
      this.onSessionAbort(sessionId, reason)
    }
    this.sessionChannels.delete(sessionId)
    this.steeringQueues.get(sessionId)?.clear()
    this.followUpQueues.get(sessionId)?.clear()
    this.onSessionCleared(sessionId)
    return Boolean(controller)
  }

  abortAll(): Promise<void> {
    if (this.activeStreams.size > 0) {
      this.log(`Aborting ${this.activeStreams.size} active stream(s)`)
      for (const [sessionId, controller] of this.activeStreams) {
        controller.abort()
        this.onSessionAbort(sessionId, 'Abort all')
        this.onSessionCleared(sessionId)
      }
      this.activeStreams.clear()
      this.sessionChannels.clear()
    }
    return this.drainSessionExecutions()
  }

  shutdown(): void {
    void this.abortAll()
    this.unsubscribeCommands()
    this.steeringQueues.clear()
    this.followUpQueues.clear()
    this.commandTarget = null
    this.onShutdown()
  }

  /**
   * 命令订阅表:键是 `SESSION_COMMAND_TYPES` 里的常量,不是再抄一遍的字面量 ——
   * 渲染层 `sessionCommands.emit({ …, command: { type: SESSION_COMMAND_TYPES.SEND_MESSAGE } })` 上按
   * F12 能直接跳到这张表的那一行,再一跳就是下面的 `handleSendMessage` 本体
   * (2026-08-21 两层合一之前,中间还隔着一层 `handleSendMessageCommand` 抽象转发)。
   *
   * 类型是 `Partial<Record<SessionCommandType, …>>` 而不是 `Record`:11 条命令里
   * 引擎只订阅 9 条,另外两条各有自己的订阅者,不在这里硬造处理者 ——
   *   - `PERMISSION_RESPOND` → `packages/backend/permission/permission-asks.ts`(Permission 自己订)
   *   - `INTERACTION_RESPOND` → `packages/backend/interaction/interaction-registry.ts`(交互注册表自己订)
   *
   * (2026-08-22 P4-F #26:`CONFIRM_TOOL` 全仓零订阅者,契约已随该批删除。)
   */
  protected buildCommandHandlers(): Partial<
    Record<SessionCommandType, (envelope: CoreCommandEnvelope) => void>
  > {
    return {
      [SESSION_COMMAND_TYPES.SEND_MESSAGE]: (envelope) => {
        const target = this.commandTarget
        if (!target) return
        this.handleSendMessage(envelope.sessionId, envelope.event as SendMessageCommandLike, target, envelope)
          .catch(err => this.logError(`${SESSION_COMMAND_TYPES.SEND_MESSAGE} error:`, err))
      },
      [SESSION_COMMAND_TYPES.EDIT_AND_RESEND]: (envelope) => {
        const target = this.commandTarget
        if (!target) return
        this.handleEditAndResend(envelope.sessionId, envelope.event as EditAndResendCommandLike, target, envelope)
          .catch(err => this.logError(`${SESSION_COMMAND_TYPES.EDIT_AND_RESEND} error:`, err))
      },
      [SESSION_COMMAND_TYPES.RETRY_MESSAGE]: (envelope) => {
        const target = this.commandTarget
        if (!target) return
        this.handleRetryMessage(envelope.sessionId, envelope.event as RetryMessageCommandLike, target, envelope)
          .catch(err => this.logError(`${SESSION_COMMAND_TYPES.RETRY_MESSAGE} error:`, err))
      },
      [SESSION_COMMAND_TYPES.COMPACT_CONTEXT]: (envelope) => {
        this.handleCompactContext(envelope.sessionId, envelope.event as CompactContextCommandLike, envelope)
          .catch(err => this.logError(`${SESSION_COMMAND_TYPES.COMPACT_CONTEXT} error:`, err))
      },
      [SESSION_COMMAND_TYPES.ABORT]: (envelope) => {
        this.handleAbort(envelope.sessionId, envelope.event as AbortLikeCommand)
      },
      [SESSION_COMMAND_TYPES.RESUME_AFTER_CONFIRM]: (envelope) => {
        const target = this.commandTarget
        if (!target) return
        this.handleResumeAfterConfirm(envelope.sessionId, envelope.event as ResumeAfterConfirmCommandLike, target, envelope)
          .catch(err => this.logError(`${SESSION_COMMAND_TYPES.RESUME_AFTER_CONFIRM} error:`, err))
      },
      [SESSION_COMMAND_TYPES.INJECT_STEERING]: (envelope) => {
        const command = envelope.event as InjectMessageCommand
        this.steerMessage(envelope.sessionId, command.content, command.source || 'eventbus', command.origin)
      },
      [SESSION_COMMAND_TYPES.RETRACT_STEERING]: (envelope) => {
        const command = envelope.event as RetractSteeringLikeCommand
        this.retractSteerMessage(envelope.sessionId, command.messageId)
      },
      [SESSION_COMMAND_TYPES.INJECT_FOLLOWUP]: (envelope) => {
        const command = envelope.event as InjectMessageCommand
        this.followUpMessage(envelope.sessionId, command.content, command.source || 'eventbus', command.origin)
      },
    }
  }

  protected subscribeToCommands(eventBus: TEventBus): void {
    for (const [commandType, handler] of Object.entries(this.buildCommandHandlers())) {
      if (!handler) continue
      this.unsubs.push(eventBus.onAnySession(commandType, envelope => {
        if (commandType !== SESSION_COMMAND_TYPES.ABORT) this.assertAccepting(envelope.sessionId)
        handler(envelope)
      }, 'StreamEngine'))
    }
  }

  protected unsubscribeCommands(): void {
    for (const unsubscribe of this.unsubs) {
      unsubscribe()
    }
    this.unsubs = []
  }

  protected onSessionAbort(_sessionId: string, _reason: string): void {}

  protected log(message: string): void {
    log.debug(message)
  }

  protected logError(message: string, error: unknown): void {
    log.error(message, undefined, error)
  }

  /**
   * 三个协作件(2026-10-04 从本类拆出,拆分批 3,D227):起标题、服务商解析、压缩闸。它们各管各的状态,
   * 向引擎要的东西写成端口;端口的每一格都在调用那一刻回本类取(`this.eventBus` 随 `setEventBus` 换,
   * `log` / `logError` / `emitStreamError` / `createMessageId` / `now` 可被子类覆写),所以行为与拆前相同。
   */
  private readonly titles = new SessionTitleGenerator<TSettings, TMessage, TSession, TProviderConfig, TAuthContext>({
    store: () => this.store,
    provider: () => this.runtime.provider,
    eventBus: () => this.eventBus,
    logError: (message, error) => this.logError(message, error),
  })

  private readonly providerResolution = new ProviderResolution<
    TSettings, TMessage, TSession, TProviderConfig, TProviderConfigWithKey, TAuthContext, THistoryMessage, TStreamResult
  >({
    store: () => this.store,
    provider: () => this.runtime.provider,
    streams: () => this.runtime.streams,
    eventBus: () => this.eventBus,
    createMessageId: () => this.createMessageId(),
    now: () => this.now(),
    emitStreamError: (sessionId, error) => this.emitStreamError(sessionId, error),
  })

  private readonly compactionGate = new CompactionGate<
    TSettings, TMessage, TSession, TProviderConfigWithKey, THistoryMessage, TCompactResult
  >({
    store: () => this.store,
    models: () => this.runtime.models,
    history: () => this.runtime.history,
    compaction: () => this.runtime.compaction,
    eventBus: () => this.eventBus,
    log: message => this.log(message),
    logError: (message, error) => this.logError(message, error),
    emitStreamError: (sessionId, error) => this.emitStreamError(sessionId, error),
    emitContextSizeUpdated: (sessionId, contextSize) => this.emitContextSizeUpdated(sessionId, contextSize),
    emitMessageCreated: (sessionId, message) => this.emitMessageCreated(sessionId, message),
    emitMessageUpdated: (sessionId, messageId, updates) => this.emitMessageUpdated(sessionId, messageId, updates),
  })

  constructor(
    protected readonly runtime: CoreStreamEngineRuntime<
      TSettings,
      TMessage,
      TSession,
      TProviderConfig,
      TProviderConfigWithKey,
      TAuthContext,
      TSkill,
      TContentPart,
      TAttachment,
      THistoryMessage,
      TStreamResult,
      TCompactResult
    >,
    private readonly options: CoreStreamEngineOptions = {},
  ) {}

  protected assertAccepting(sessionId?: string): void {
    this.options.assertAccepting?.(sessionId)
  }

  protected authorizeExecution(sessionId: string, executionContext?: unknown): void {
    this.options.authorizeExecution?.(sessionId, executionContext)
  }

  /**
   * 工单 5 §4(triage B8/D4):这里**不再授权**。
   *
   * 授权("这个主体能不能写这条会话")是**入口**的事,而这一步是五条命令共用的
   * 准备段 —— 从前它在 `prepareSession` 前后各判一次,加上产品层入口自己那一次,
   * 一次发送要跑三到四遍同一个谓词。归属在一次执行里不会变,所以重复判只是重复
   * 读:真正随 `await` 变化的是"这条会话还收不收活",那由留下来的两次
   * `assertAccepting` 判 —— 它们一个字没动。
   */
  private async prepareSessionExecution(sessionId: string): Promise<void> {
    this.assertAccepting(sessionId)
    await this.options.prepareSession?.(sessionId)
    this.assertAccepting(sessionId)
  }

  protected get store(): StreamEngineStoreAdapter<TSettings, TSession, TMessage> {
    return this.runtime.store
  }

  protected createMessageId(): string {
    return this.runtime.ids.createId()
  }

  protected now(): number {
    return this.runtime.clock.now()
  }

  steerMessage(sessionId: string, content: string, source = 'api', origin?: unknown): void {
    this.assertAccepting(sessionId)
    const queue = this.getSteeringQueue(sessionId)
    const timestamp = this.now()

    try {
      const pendingMessage = this.createPersistedSteeringMessage(sessionId, content, source, timestamp, origin)
      /**
       * 宿主可能**就地接走**这一条(2026-08-12)。默认没人接,下面两行照旧。
       *
       * 接走了就**不入队**:入了队它会在回合收尾后再进一次模型,同一句话说两遍。
       * 也**不发** `steering:queued` —— 那条事件是「还在队列里、可以撤回」的凭据,
       * 而一条已经送到模型手里的追话撤不回来;发了它,撤回按钮会点了没反应。
       *
       * 持久化与 `message:user-created` 照发(在 `createPersistedSteeringMessage`
       * 里,上一行已经做完):无论走哪一支,用户都该在流里看见自己说过这句话。
       */
      if (this.takeSteeringDelivery(sessionId, content)) {
        this.log(`Steering delivered live for ${sessionId.slice(0, 8)}: "${content.slice(0, 60)}..."`)
        return
      }
      queue.enqueue(pendingMessage)
      if (pendingMessage.id) {
        this.eventBus?.emit(sessionId, {
          type: SESSION_EVENT_TYPES.STEERING_QUEUED,
          messageId: pendingMessage.id,
        }).catch(err => this.logError('steering:queued emit error:', err))
      }
    } catch (error) {
      this.logError('Failed to persist steering message immediately:', error)
      queue.enqueue({
        content,
        source,
        timestamp,
        ...(origin !== undefined ? { origin } : {}),
      })
    }

    this.log(`Steering queued for ${sessionId.slice(0, 8)}: "${content.slice(0, 60)}..."`)
  }

  /**
   * 宿主的**就地投递**钩子(2026-08-12)。返回 true = 这条追话已经送到模型手里,
   * 引擎因此不再入队。
   *
   * core 不认识「外部 agent」这个概念,也不该认识:它只知道「有人说他能当场送到」。
   * 唯一的实现在装配层(`app/engine/stream-engine.ts` → Claude Code 连接器整轮开着
   * 的输入迭代器);别的宿主什么都不装,这里返回 false,行为与 2026-08-12 之前
   * 逐字相同。
   *
   * **必须同步**:引擎要在这一刻决定入不入队,给它一个 promise 就只能先入队,而
   * 那正是同一句话进模型两遍的做法。**必须不抛**:投递失败要降级成「没接走」,
   * 不是让用户的一次插话把整条 steering 路炸掉。
   */
  protected takeSteeringDelivery(_sessionId: string, _content: string): boolean {
    return false
  }

  /**
   * Retract a still-pending steering message: remove it from the queue and
   * delete the eagerly-persisted chat message. A message already drained
   * into a model turn stays — retraction only wins while it is pending.
   */
  retractSteerMessage(sessionId: string, messageId: string): boolean {
    const removed = this.steeringQueues.get(sessionId)?.removeById(messageId)
    if (removed) {
      this.log(`Steering retracted for ${sessionId.slice(0, 8)}: ${messageId}`)
    }
    if (!removed) return false

    if (!this.store.deleteMessage(sessionId, messageId)) {
      this.logError('Retracted steering message missing from session store:', messageId)
    }
    this.eventBus?.emit(sessionId, {
      type: SESSION_EVENT_TYPES.MESSAGE_DELETED,
      messageId,
    }).catch(err => this.logError('message:deleted emit error:', err))
    this.eventBus?.emit(sessionId, {
      type: SESSION_EVENT_TYPES.STEERING_RETRACTED,
      messageId,
    }).catch(err => this.logError('steering:retracted emit error:', err))
    return true
  }

  protected onSessionCleared(sessionId: string): void {
    this.titles.forgetSession(sessionId)
    this.runtime.permission.clearSession(sessionId)
  }

  protected onShutdown(): void {
    this.titles.clear()
  }

  /**
   * Turn-volatile context (datetime, git branch, ...) for this send.
   * Attached to the user message and persisted there so history rebuilds
   * replay identical bytes. Deduplicated: when the text equals the most
   * recently injected block in this session, nothing is attached — history
   * stays append-only and the prompt-cache prefix is never rewritten.
   */
  /**
   * Resolve every reference a user message can carry: prompt/skill tokens via
   * the runtime resolver, then `@path` file mentions inlined as <file> blocks.
   *
   * The inlining lands on the model-facing copy only. contentParts is what the
   * UI renders and what edit-and-resend reconstructs the draft from, so it must
   * keep the literal `@path` — otherwise the user's own bubble fills with the
   * file body and editing the message hands back the dump instead of what they
   * typed. When the resolver returns no parts (the common case: no prompt or
   * skill tokens) the renderer falls back to `content`, which now holds the
   * inlined bodies — so a text part has to be synthesized to pin the display.
   */
  private resolveUserReferences(
    rawContent: string,
    skills: TSkill[],
    channel: string | undefined,
  ): ReturnType<StreamEnginePromptAdapter<TSkill, TContentPart>['resolveReferences']> {
    const resolved = this.runtime.prompts.resolveReferences(rawContent, { skills })
    if (!isFileMentionTrustedChannel(channel)) return resolved

    const { content, inlinedPaths } = expandFileMentions(resolved.modelContent)
    if (inlinedPaths.length === 0) return resolved

    return {
      ...resolved,
      modelContent: content,
      contentParts: resolved.contentParts
        ?? ([{ type: 'text', content: resolved.displayContent }] as unknown as TContentPart[]),
    }
  }

  /**
   * 这条用户消息用哪个 id —— **发送方给的那个,除非它不成立**。
   *
   * 病(2026-09-13 真机报障,第二次):发送方在自己屏幕上先摆一格乐观气泡,
   * 等账本把同一条消息发回来再撤掉它。从前认领靠「正文逐字相同」,而引擎在
   * **落库之前**就把正文换掉了(`@/abs/x.lua` → 一整份 34KB 的 `<file>` 块,
   * `/skill:x` → 整份 SKILL.md),于是那一格永远认不上、永远留在屏幕上 ——
   * 用户看见的是 AI 回复之后又冒出来的第二条自己的话。
   *
   * 治法是**认领靠身份不靠正文**:发送方铸 id、随命令发过来,引擎照用。
   *
   * 两道判,不合格一律**当作没给**(不抛、不报错):
   *  ① 形 —— 它会进账本每一行、进 `data-message-id`、进事件的 `messageId`,
   *     是一个地址不是一格自由文本;
   *  ② 会话内唯一 —— 撞上已有消息就是在覆盖历史。一次重试、一次重放、一个
   *     算错了的发送方,代价都不该是账本上的一条真消息被顶掉。
   *
   * 不合格为什么不报错:id 是发送方给自己的**方便**,不是它的权力。认不认由
   * 引擎说了算,而「这句话有没有被说出去」不该因为一个 id 写歪了就变成没有。
   */
  private resolveUserMessageId(
    candidate: unknown,
    existing: readonly unknown[],
  ): string {
    if (!isClientMintedId(candidate)) return this.createMessageId()
    const taken = existing.some(message => (message as { id?: unknown } | undefined)?.id === candidate)
    return taken ? this.createMessageId() : candidate
  }

  handleSendMessage(sessionId: string, cmd: SendMessageCommandLike, sender: TCommandTarget, options: CoreExecutionOptions = {}): Promise<void> {
    this.authorizeExecution(sessionId, options.executionContext)
    return this.trackSessionExecution(sessionId, () => this.performSendMessage(sessionId, cmd, sender, options))
  }

  protected async performSendMessage(
    sessionId: string,
    cmd: SendMessageCommandLike,
    sender: TCommandTarget,
    options: CoreExecutionOptions,
  ): Promise<void> {
    this.assertAccepting(sessionId)
    /**
     * 忙时闸门(2026-08-17)。一个会话同一时刻只有一条流:这里之前对
     * `activeStreams` 不闻不问,第二条 send-message 会 `registerController` 把
     * 第一条流掐掉("Superseded")再起一条 —— 用户看到的是同一轮对话里冒出多条
     * 半截回复。这条规则以前只活在 InputBox 组件里(本地排队),草稿纸窗 /
     * deeplink / `chatStore.sendMessage` 三条直发路径全绕得过去。
     *
     * 忙时降级而不是拒绝:纯文本进 steering 队列(本轮末尾进模型,可撤回,
     * `steering:queued` 照发 —— 渲染层的 Esc 撤回对它同样生效);带附件的没有
     * 队列能装(steering / follow-up 都只带文本),如实报错,不悄悄丢文件。
     * `persistOnly`(房间 ingress、插件 handled)不开流,不受闸门管。
     */
    if (!cmd.persistOnly && this.activeStreams.has(sessionId)) {
      if (cmd.attachments && cmd.attachments.length > 0) {
        this.emitStreamError(
          sessionId,
          'A response is still running — messages with files wait until it finishes.',
        )
        return
      }
      this.steerMessage(sessionId, cmd.content, cmd.source || 'user', cmd.origin)
      return
    }

    this.sessionChannels.set(sessionId, cmd.channel || 'ipc')
    const { content: messageContent, attachments } = cmd

    try {
      // P2:持久化任何消息之前先等压缩收尾。从前用户消息**先落库**再撞
      // activeCompactions,那一轮就永远不会有回应。
      await this.waitForCompactionIdle(sessionId)
      await this.prepareSessionExecution(sessionId)

      const sessionForRefs = this.store.getSession(sessionId)
      const settingsForRefs = this.store.getSettings()
      const skillsForRefs = settingsForRefs.skills?.enableSkills === false
        ? []
        : this.runtime.skills.getForSession(sessionForRefs?.workingDirectory, sessionForRefs?.agentId)
      const resolvedPromptRefs = this.resolveUserReferences(messageContent, skillsForRefs, cmd.channel)
      const session = sessionForRefs
      // C1(P0.2):读走 store 的读门面,不再持有 session.messages。
      const messagesForRefs = this.store.listMessages(sessionId)
      const isFirstUserMessage = session && messagesForRefs.filter(m => m.role === 'user').length === 0
      const isBranchFirstMessage = session?.parentSessionId && messagesForRefs.length > 0 &&
        !messagesForRefs.some(m => m.role === 'user' && m.timestamp > session.createdAt)

      /**
       * No turn-context block is computed here any more (prompt-channels
       * 2026-08-18). The tail block is decided at **request build** time, from
       * the very context the prompt is built with (tool surface, workdir,
       * skills, projects, AGENTS.md, voice) — computing it here meant a second
       * opinion on the same facts, and it could only ever carry the variable
       * board. The persisted field on the message is unchanged; only the writer
       * moved (`SessionTurnContext` in the assembly layer).
       */
      const userMessage = {
        // 发送方预铸的那个,不成立才现铸(判词在 `resolveUserMessageId`)。
        id: this.resolveUserMessageId(cmd.messageId, messagesForRefs),
        role: 'user',
        content: resolvedPromptRefs.modelContent,
        timestamp: this.now(),
        attachments,
        contentParts: resolvedPromptRefs.contentParts,
        source: cmd.source || (cmd.channel === 'voice' ? 'voice' : 'text'),
        voice: cmd.voice,
        ...(cmd.origin !== undefined ? { origin: cmd.origin } : {}),
        ...(cmd.replyTo !== undefined ? { replyTo: cmd.replyTo } : {}),
        ...(cmd.collabSourceMessageId !== undefined
          ? { collabSourceMessageId: cmd.collabSourceMessageId }
          : {}),
      } as unknown as TMessage
      this.runtime.media.ingestMessageAttachments(
        sessionId,
        userMessage.id,
        userMessage.role,
        userMessage.attachments as TAttachment[] | undefined,
      )
      this.store.addMessage(sessionId, userMessage)

      await this.eventBus?.emit(sessionId, {
        type: SESSION_EVENT_TYPES.MESSAGE_USER_CREATED,
        message: userMessage,
      })

      // N2 `handled`: the message is on record and on screen; nothing answers it.
      // Zero model calls — that includes the title call (see persistOnly).
      if (cmd.persistOnly) return

      if ((isFirstUserMessage || isBranchFirstMessage) && !cmd.suppressTitleGeneration) {
        // 标题是**发后不管**的旁路(工单 4 A1,回 HEAD 形状):它自己是一次模型
        // 调用,`await` 它等于让新会话第一条消息在标题模型跑完之前一个字都不出。
        // 失败只记日志,不进主路的错误面。
        this.titles.generateAndApplySessionTitle(
          sessionId,
          resolvedPromptRefs.displayContent,
          session?.name || '',
        ).catch(err => this.logError('chat title generation failed:', err))
      }

      const resolved = await this.providerResolution.resolveProviderOrFailure(
        sessionId,
        cmd.providerId
          ? {
              providerId: cmd.providerId,
              model: cmd.model,
              ...(typeof cmd.thinking === 'boolean'
                ? { thinking: cmd.thinking, thinkingEffort: cmd.thinkingEffort }
                : {}),
            }
          : undefined,
      )
      if (isCoreProviderResolutionFailure(resolved)) {
        // 解不出 provider **不是**沉默的理由(见 `CoreProviderResolutionFailure`)。
        // 走与请求错误同一种形状:占位入库 → 开 run → 立刻收成 error。
        await this.providerResolution.failRunWithProviderError(sessionId, userMessage, resolved)
        return
      }
      const { configWithApiKey, providerId, settings } = resolved

      if (!await this.compactionGate.maybeCompactBeforeSend(sessionId, providerId, configWithApiKey, settings)) return

      const assistantMessageId = this.createMessageId()
      const assistantMessage = {
        id: assistantMessageId,
        role: 'assistant',
        model: configWithApiKey.model,
        provider: providerId,
        content: '',
        timestamp: this.now(),
        isStreaming: true,
        thinkingStartTime: this.now(),
        toolCalls: [],
        ...(cmd.origin !== undefined ? { origin: cmd.origin } : {}),
      } as unknown as TMessage
      // F4-a(§16.12):`addMessage` 交回**入库的那一条**。宿主可能在入库那一刻
      // 给它盖章(协作署名),而盖章是 COW 的 —— 手里这条与入库那条不是同一个
      // 对象。宿主的 run 记录要按入库那份写,所以接住它、往下递(见下面
      // `assistantMessage:` 那一格)。
      //
      // 事件那一条**故意仍发手里这份**:`message:assistant-created` 是"引擎建了
      // 这条消息"的通知,本批不改它的载荷(改了就是一次未经裁定的行为变化)。
      const storedAssistantMessage = this.store.addMessage(sessionId, assistantMessage)
      // F4-c c4-d(§16.27):**入库与开账同一同步段**。下一行起就有 `await` 了,
      // 而每一个 await 都是一扇"账本上还没有这条消息"的窗口(§16.20 实测 p50
      // 0.21ms;读侧一旦以折叠产物为准,那个窗口就是真相缺口而不是取样问题)。
      this.runtime.streams.openAssistantRun?.({
        sessionId,
        assistantMessageId,
        assistantMessage: storedAssistantMessage,
        runKind: 'send',
        triggerMessageId: userMessage.id,
        providerId,
        model: configWithApiKey.model,
      })

      await this.eventBus?.emit(sessionId, {
        type: SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED,
        message: assistantMessage,
      })

      this.log(`Starting stream: session=${sessionId}, provider=${providerId}, model=${configWithApiKey.model}`)

      const sessionForHistory = this.store.getSession(sessionId)
      const historyMessages = this.runtime.history.buildMessages(
        this.store.listMessages(sessionId) as TMessage[],
        sessionForHistory,
      )
      const sessionName = sessionForHistory?.name

      await this.runtime.streams.executeMessageStream({
        // 执行器要登记 / 摘掉这一轮的 abort 控制器、取追话与续话队列 —— 都是本引擎的事,随调用交过去。
        streamControllers: this,
        executionContext: options.executionContext,
        sender, sessionId, assistantMessageId, messageContent: resolvedPromptRefs.modelContent,
        historyMessages, configWithApiKey, providerId, settings,
        toolSettings: settings.tools, sessionName,
        // S1a(session-event-sourcing §10.2):这次执行**是哪一种**,由四个入口
        // 各自盖章。宿主拿它写 `run/start.kind`;core 自己不落盘。
        runKind: 'send',
        // F4-a(§16.12):把**入库的那条占位消息**递给宿主。宿主的 `run/start` 是
        // 这条消息在账本上的产地,产地要的时刻 / origin / 署名就在它身上 ——
        // 从前宿主写完再回读一次,那是值绕了一圈,还带着一个可以不存在的时序
        // 窗口。core 不认识 `ChatMessage`(泛型 `TMessage`),这个参数包本来就是
        // `Record<string, unknown>`,所以多一格零类型代价。
        assistantMessage: storedAssistantMessage,
        triggerMessageId: userMessage.id,
        voiceConversation: userMessage.source === 'voice',
        speakMode: userMessage.source === 'voice',
        ...(cmd.usageSource ? { usageSource: cmd.usageSource } : {}),
        ...(cmd.initialToolChoice ? { initialToolChoice: cmd.initialToolChoice } : {}),
        ...(parsePrincipal(cmd.principal) ? { principal: parsePrincipal(cmd.principal) } : {}),
      })
    } catch (error) {
      const streamError = this.normalizeStreamError(error)
      this.logError('handleSendMessage error:', streamError.error)
      this.emitStreamError(sessionId, streamError.message)
      if (isAgentExecutionCheckpointError(error)) throw error
    }
  }

  handleCompactContext(sessionId: string, cmd: CompactContextCommandLike, options: CoreExecutionOptions = {}): Promise<void> {
    // 授权在入口判一次(工单 5 §4);这两条入口产品层没有覆写,所以它归这里。
    this.authorizeExecution(sessionId, options.executionContext)
    return this.trackSessionExecution(sessionId, () => this.performCompactContext(sessionId, cmd, options))
  }

  private async performCompactContext(
    sessionId: string,
    cmd: CompactContextCommandLike,
    options: CoreExecutionOptions,
  ): Promise<void> {
    this.assertAccepting(sessionId)
    if (this.activeStreams.has(sessionId)) {
      await this.eventBus?.emit(sessionId, {
        type: SESSION_EVENT_TYPES.CONTEXT_COMPACT_COMPLETED,
        requestId: cmd.requestId,
        success: false,
        error: 'Cannot compact while a response is streaming.',
      })
      return
    }
    if (this.compactionGate.activeCompactions.has(sessionId)) {
      await this.eventBus?.emit(sessionId, {
        type: SESSION_EVENT_TYPES.CONTEXT_COMPACT_COMPLETED,
        requestId: cmd.requestId,
        success: false,
        error: 'Context compact is already running.',
      })
      return
    }

    // P2:登记必须在**第一个 await 之前**同步完成。从前 activeStreams 检查之后
    // 还有 resolveProvider 的 await 窗口,两条 /compact 能双双穿过(TOCTOU)。
    this.compactionGate.activeCompactions.add(sessionId)
    const release = this.compactionGate.openCompactionGate(sessionId)

    try {
      await this.prepareSessionExecution(sessionId)
      const resolved = await this.providerResolution.resolveProvider(sessionId)
      if (!resolved) {
        await this.eventBus?.emit(sessionId, {
          type: SESSION_EVENT_TYPES.CONTEXT_COMPACT_COMPLETED,
          requestId: cmd.requestId,
          success: false,
          error: 'Provider is not configured.',
        })
        return
      }

      const result = await this.compactionGate.runContextCompact(
        {
          sessionId,
          providerId: resolved.providerId,
          configWithApiKey: resolved.configWithApiKey,
          settings: resolved.settings,
          keepRecentTurns: resolved.settings.chat?.contextCompactKeepRecentTurns ?? 6,
          onMessageCreated: (message: TMessage) => this.emitMessageCreated(sessionId, message),
          onMessageUpdated: (messageId: string, updates: Partial<TMessage>) => this.emitMessageUpdated(sessionId, messageId, updates),
        },
        { alreadyRegistered: true, requestId: cmd.requestId },
      )

      await this.eventBus?.emit(sessionId, {
        type: SESSION_EVENT_TYPES.CONTEXT_COMPACT_COMPLETED,
        requestId: cmd.requestId,
        success: result.success,
        skipped: result.skipped,
        summary: result.summary,
        error: result.error,
      })

      if (result.success && !result.skipped) {
        this.emitContextSizeUpdated(sessionId, result.retainedContextSize ?? 0)
      }
    } finally {
      this.compactionGate.activeCompactions.delete(sessionId)
      release()
    }
  }

  handleEditAndResend(sessionId: string, cmd: EditAndResendCommandLike, sender: TCommandTarget, options: CoreExecutionOptions = {}): Promise<void> {
    this.authorizeExecution(sessionId, options.executionContext)
    return this.trackSessionExecution(sessionId, () => this.performEditAndResend(sessionId, cmd, sender, options))
  }

  protected async performEditAndResend(
    sessionId: string,
    cmd: EditAndResendCommandLike,
    sender: TCommandTarget,
    options: CoreExecutionOptions,
  ): Promise<void> {
    this.assertAccepting(sessionId)
    this.sessionChannels.set(sessionId, cmd.channel || 'ipc')
    const { messageId, newContent } = cmd

    try {
      // P2 入口闸(见 handleSendMessage):truncate 也是一次持久化。
      await this.waitForCompactionIdle(sessionId)
      await this.prepareSessionExecution(sessionId)

      const sessionForRefs = this.store.getSession(sessionId)
      const settingsForRefs = this.store.getSettings()
      const skillsForRefs = settingsForRefs.skills?.enableSkills === false
        ? []
        : this.runtime.skills.getForSession(sessionForRefs?.workingDirectory, sessionForRefs?.agentId)
      const resolvedPromptRefs = this.resolveUserReferences(newContent, skillsForRefs, cmd.channel)

      const updated = this.store.updateMessageAndTruncate(sessionId, messageId, resolvedPromptRefs.modelContent, {
        contentParts: resolvedPromptRefs.contentParts ?? null,
      })
      if (!updated) {
        this.emitStreamError(sessionId, 'Message not found')
        return
      }

      await this.eventBus?.emit(sessionId, {
        type: SESSION_EVENT_TYPES.MESSAGES_REPLACED,
        messages: this.store.listMessages(sessionId) as TMessage[],
      })

      const resolved = await this.providerResolution.resolveProvider(
        sessionId,
        cmd.providerId ? { providerId: cmd.providerId, model: cmd.model } : undefined,
      )
      if (!resolved) return
      const { configWithApiKey, providerId, settings } = resolved

      if (!await this.compactionGate.maybeCompactBeforeSend(sessionId, providerId, configWithApiKey, settings)) return

      // 现取:上面 await 过压缩,捏在手里的会话/数组都可能过期。
      const assistantOrigin = cmd.origin ?? this.store.getMessage(sessionId, messageId)?.origin
      const assistantMessageId = this.createMessageId()
      const assistantMessage = {
        id: assistantMessageId,
        role: 'assistant',
        model: configWithApiKey.model,
        provider: providerId,
        content: '',
        timestamp: this.now(),
        isStreaming: true,
        thinkingStartTime: this.now(),
        toolCalls: [],
        ...(assistantOrigin !== undefined ? { origin: assistantOrigin } : {}),
      } as unknown as TMessage
      // F4-a:入库那一条(见 `handleSendMessage` 那一处的理由)。
      const storedAssistantMessage = this.store.addMessage(sessionId, assistantMessage)
      // F4-c c4-d(§16.27):入库与开账同一同步段(见 `handleSendMessage` 的理由)。
      this.runtime.streams.openAssistantRun?.({
        sessionId,
        assistantMessageId,
        assistantMessage: storedAssistantMessage,
        runKind: 'edit-resend',
        triggerMessageId: cmd.messageId,
        providerId,
        model: configWithApiKey.model,
      })

      await this.eventBus?.emit(sessionId, {
        type: SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED,
        message: assistantMessage,
      })

      this.log(`Starting edit/resend stream: session=${sessionId}, provider=${providerId}`)

      const session = this.store.getSession(sessionId)
      const historyMessages = this.runtime.history.buildMessages(
        this.store.listMessages(sessionId) as TMessage[],
        session,
      )

      await this.runtime.streams.executeMessageStream({
        // 执行器要登记 / 摘掉这一轮的 abort 控制器、取追话与续话队列 —— 都是本引擎的事,随调用交过去。
        streamControllers: this,
        sender, sessionId, assistantMessageId,
        executionContext: options.executionContext,
        messageContent: resolvedPromptRefs.modelContent,
        historyMessages, configWithApiKey, providerId, settings,
        toolSettings: settings.tools, sessionName: session?.name,
        runKind: 'edit-resend',
        // F4-a(§16.12):入库那条占位消息前递 —— 见 `handleSendMessage` 的理由。
        assistantMessage: storedAssistantMessage,
        triggerMessageId: cmd.messageId,
      })
    } catch (error) {
      const streamError = this.normalizeStreamError(error)
      this.logError('handleEditAndResend error:', streamError.error)
      this.emitStreamError(sessionId, streamError.message)
      if (isAgentExecutionCheckpointError(error)) throw error
    }
  }

  handleRetryMessage(sessionId: string, cmd: RetryMessageCommandLike, sender: TCommandTarget, options: CoreExecutionOptions = {}): Promise<void> {
    this.authorizeExecution(sessionId, options.executionContext)
    return this.trackSessionExecution(sessionId, () => this.performRetryMessage(sessionId, cmd, sender, options))
  }

  protected async performRetryMessage(
    sessionId: string,
    cmd: RetryMessageCommandLike,
    sender: TCommandTarget,
    options: CoreExecutionOptions,
  ): Promise<void> {
    this.assertAccepting(sessionId)
    const { messageId } = cmd

    try {
      // P2 入口闸(见 handleSendMessage)。
      await this.waitForCompactionIdle(sessionId)
      await this.prepareSessionExecution(sessionId)

      const targetMessage = this.store.getMessage(sessionId, messageId)
      if (!targetMessage) {
        this.emitStreamError(sessionId, 'Message not found')
        return
      }
      if (targetMessage.role !== 'assistant') {
        this.emitStreamError(sessionId, 'Only assistant messages can be retried')
        return
      }

      const truncated = this.store.deleteMessageAndTruncate(sessionId, messageId)
      if (!truncated) {
        this.emitStreamError(sessionId, 'Message not found')
        return
      }

      await this.eventBus?.emit(sessionId, {
        type: SESSION_EVENT_TYPES.MESSAGES_REPLACED,
        messages: this.store.listMessages(sessionId) as TMessage[],
      })

      const resolved = await this.providerResolution.resolveProvider(
        sessionId,
        cmd.providerId ? { providerId: cmd.providerId, model: cmd.model } : undefined,
      )
      if (!resolved) return
      const { configWithApiKey, providerId, settings } = resolved

      if (!await this.compactionGate.maybeCompactBeforeSend(sessionId, providerId, configWithApiKey, settings)) return

      const assistantOrigin = targetMessage.origin
      const assistantMessageId = this.createMessageId()
      const assistantMessage = {
        id: assistantMessageId,
        role: 'assistant',
        model: configWithApiKey.model,
        provider: providerId,
        content: '',
        timestamp: this.now(),
        isStreaming: true,
        thinkingStartTime: this.now(),
        toolCalls: [],
        ...(assistantOrigin !== undefined ? { origin: assistantOrigin } : {}),
      } as unknown as TMessage
      // F4-c c4-d(§16.27):`run/start` 的 `triggerMessageId` 必须在**开账那一刻**
      // 就在手,而开账要与入库同一同步段 —— 所以这一问提前到追加占位之前。答案与
      // 提前之前逐字相同:追加的是一条 assistant 占位,不改变"最后一条用户消息是谁"。
      const triggerUserMessageId = this.store
        .listMessages(sessionId)
        .filter(message => message.role === 'user')
        .pop()?.id
      // F4-a:入库那一条(见 `handleSendMessage` 那一处的理由)。
      const storedAssistantMessage = this.store.addMessage(sessionId, assistantMessage)
      // F4-c c4-d(§16.27):入库与开账同一同步段(见 `handleSendMessage` 的理由)。
      this.runtime.streams.openAssistantRun?.({
        sessionId,
        assistantMessageId,
        assistantMessage: storedAssistantMessage,
        runKind: 'retry',
        ...(triggerUserMessageId ? { triggerMessageId: triggerUserMessageId } : {}),
        providerId,
        model: configWithApiKey.model,
      })

      await this.eventBus?.emit(sessionId, {
        type: SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED,
        message: assistantMessage,
      })

      this.log(`Starting retry stream: session=${sessionId}, provider=${providerId}`)

      const session = this.store.getSession(sessionId)
      const messagesForRetry = this.store.listMessages(sessionId)
      const historyMessages = this.runtime.history.buildMessages(messagesForRetry as TMessage[], session)
      const lastUserMessage = messagesForRetry.filter(m => m.role === 'user').pop()
      const messageContent = lastUserMessage?.content || ''

      await this.runtime.streams.executeMessageStream({
        // 执行器要登记 / 摘掉这一轮的 abort 控制器、取追话与续话队列 —— 都是本引擎的事,随调用交过去。
        streamControllers: this,
        sender, sessionId, assistantMessageId, messageContent,
        executionContext: options.executionContext,
        historyMessages, configWithApiKey, providerId, settings,
        toolSettings: settings.tools, sessionName: session?.name,
        runKind: 'retry',
        // F4-a(§16.12):入库那条占位消息前递 —— 见 `handleSendMessage` 的理由。
        assistantMessage: storedAssistantMessage,
        ...(lastUserMessage?.id ? { triggerMessageId: lastUserMessage.id } : {}),
      })
    } catch (error) {
      const streamError = this.normalizeStreamError(error)
      this.logError('handleRetryMessage error:', streamError.error)
      this.emitStreamError(sessionId, streamError.message)
      if (isAgentExecutionCheckpointError(error)) throw error
    }
  }

  private createPersistedSteeringMessage(
    sessionId: string,
    content: string,
    source: string,
    timestamp: number,
    origin?: unknown,
  ): PendingMessage {
    const session = this.store.getSession(sessionId)
    const settings = this.store.getSettings()
    const skills = settings.skills?.enableSkills === false
      ? []
      : this.runtime.skills.getForSession(session?.workingDirectory, session?.agentId)
    // Steering text arrives without its own channel field; the session's last
    // known channel is the sender it came from.
    const resolvedPromptRefs = this.resolveUserReferences(content, skills, this.getChannel(sessionId))
    const userMessage = {
      id: this.createMessageId(),
      role: 'user',
      content: resolvedPromptRefs.modelContent,
      timestamp,
      contentParts: resolvedPromptRefs.contentParts,
      source,
      // Persisted identity marker: the UI renders steering messages
      // distinctly (they interject into a running response).
      steered: true,
      ...(origin !== undefined ? { origin } : {}),
    } as unknown as TMessage

    this.store.addMessage(sessionId, userMessage)
    this.eventBus?.emit(sessionId, {
      type: SESSION_EVENT_TYPES.MESSAGE_USER_CREATED,
      message: userMessage,
    }).catch(err => this.logError('message:user-created emit error:', err))

    return {
      content,
      source,
      timestamp,
      id: userMessage.id,
      modelContent: resolvedPromptRefs.modelContent,
      contentParts: resolvedPromptRefs.contentParts,
      ...(origin !== undefined ? { origin } : {}),
      persisted: true,
    }
  }

  handleResumeAfterConfirm(sessionId: string, cmd: ResumeAfterConfirmCommandLike, sender: TCommandTarget, options: CoreExecutionOptions = {}): Promise<void> {
    this.authorizeExecution(sessionId, options.executionContext)
    return this.trackSessionExecution(sessionId, () => this.performResumeAfterConfirm(sessionId, cmd, sender, options))
  }

  private async performResumeAfterConfirm(
    sessionId: string,
    cmd: ResumeAfterConfirmCommandLike,
    sender: TCommandTarget,
    options: CoreExecutionOptions,
  ): Promise<void> {
    this.assertAccepting(sessionId)
    const { messageId } = cmd

    try {
      // P2 入口闸(见 handleSendMessage):恢复也要在压缩后的历史上重建。
      await this.waitForCompactionIdle(sessionId)
      await this.prepareSessionExecution(sessionId)

      const session = this.store.getSession(sessionId)
      if (!session) {
        this.emitStreamError(sessionId, 'Session not found')
        return
      }
      const assistantMessage = this.store.getMessage(sessionId, messageId)
      if (!assistantMessage) {
        this.emitStreamError(sessionId, 'Assistant message not found')
        return
      }

      // Resume with the provider/model that the paused message was already
      // created under, not whatever session/global resolves to right now —
      // the global default may have changed while the tool-permission
      // confirm dialog was pending.
      const resolved = await this.providerResolution.resolveProvider(
        sessionId,
        assistantMessage.provider ? { providerId: assistantMessage.provider, model: assistantMessage.model } : undefined,
      )
      if (!resolved) return
      const { configWithApiKey, providerId, settings } = resolved

      // 现取(await resolveProvider 之后):COW 之后手里的数组随时会过期。
      const messagesForResume = this.store.listMessages(sessionId)
      const historyMessages = this.runtime.history.buildMessages(messagesForResume as TMessage[], session)
      const historyWithoutCurrent = historyMessages.filter((_, idx) => {
        const msgCount = historyMessages.length
        const message = historyMessages[idx] as { role?: string }
        return idx !== msgCount - 1 || message.role !== 'assistant'
      })

      const voiceConversation = [...messagesForResume]
        .reverse()
        .find(message => message.role === 'user')?.source === 'voice'

      this.eventBus?.emit(sessionId, { type: SESSION_EVENT_TYPES.CONTENT_CONTINUATION, turnIndex: 1 })
        .catch(err => this.logError('continuation emit error:', err))

      const abortController = new AbortController()
      this.registerController(sessionId, abortController)

      const ctx = {
        executionContext: options.executionContext,
        sender, sessionId,
        assistantMessageId: messageId,
        abortSignal: abortController.signal,
        settings, providerConfig: configWithApiKey,
        providerId, toolSettings: settings.tools,
        steeringQueue: this.getSteeringQueue(sessionId),
        followUpQueue: this.getFollowUpQueue(sessionId),
        speakMode: voiceConversation,
      }

      try {
        this.log('Resuming agent loop after confirmation')
        const requestStartTime = this.now()
        const resumeHistoryMessages = this.runtime.history.buildResumeAfterToolConfirmation(historyWithoutCurrent, assistantMessage)

        const result = await this.runtime.streams.executeAgentLoopStreamGeneration(
          ctx,
          resumeHistoryMessages,
          session.name,
          {
            initialContent: {
              content: assistantMessage.content || '',
              reasoning: assistantMessage.reasoning || '',
            },
          },
        )

        const requestDuration = (this.now() - requestStartTime) / 1000
        this.log(`Agent loop resume completed in ${requestDuration.toFixed(2)}s`)

        if (!result.pausedForConfirmation) {
          this.removeController(sessionId, abortController)
        }
      } catch (error) {
        const streamError = this.normalizeStreamError(error)
        const isAborted = streamError.isAbortError || abortController.signal.aborted
        if (isAborted) {
          this.eventBus?.emit(sessionId, { type: SESSION_EVENT_TYPES.STREAM_ABORTED, reason: 'User cancelled' })
            .catch(err => this.logError('stream:aborted emit error:', err))
        } else {
          this.logError('Resume streaming error:', streamError.error)
          this.store.deleteMessage(sessionId, messageId)
          const errorMessage = {
            id: `error-${this.now()}`,
            role: 'error',
            content: streamError.message,
            timestamp: this.now(),
            errorDetails: streamError.details,
          } as unknown as TMessage
          this.store.addMessage(sessionId, errorMessage)
          this.eventBus?.emit(sessionId, {
            type: SESSION_EVENT_TYPES.STREAM_ERROR,
            data: { error: streamError.message, errorDetails: streamError.details },
          }).catch(err => this.logError('stream:error emit error:', err))
        }
        this.removeController(sessionId, abortController)
        if (isAgentExecutionCheckpointError(error)) throw error
      }
    } catch (error) {
      const streamError = this.normalizeStreamError(error)
      this.logError('handleResumeAfterConfirm error:', streamError.error)
      this.emitStreamError(sessionId, streamError.message || 'Resume error')
      if (isAgentExecutionCheckpointError(error)) throw error
    }
  }

  /**
   * P2 入口闸:等这条会话的压缩收尾(本体在压缩闸 `agent-loop-compaction-gate.ts`)。留成本类的受保护方法,
   * 是为了子类合同一格不动。
   */
  protected waitForCompactionIdle(sessionId: string): Promise<void> {
    return this.compactionGate.waitForCompactionIdle(sessionId)
  }

  protected emitStreamError(sessionId: string, error: string): void {
    if (this.eventBus) {
      this.eventBus.emit(sessionId, {
        type: SESSION_EVENT_TYPES.STREAM_ERROR,
        data: { error },
      }).catch(err => this.logError('stream:error emit failed:', err))
    }
  }

  private async emitMessageCreated(sessionId: string, message: TMessage): Promise<void> {
    await this.eventBus?.emit(sessionId, {
      type: SESSION_EVENT_TYPES.MESSAGE_CREATED,
      message,
    })
  }

  private async emitMessageUpdated(
    sessionId: string,
    messageId: string,
    updates: Partial<TMessage>,
  ): Promise<void> {
    await this.eventBus?.emit(sessionId, {
      type: SESSION_EVENT_TYPES.MESSAGE_UPDATED,
      messageId,
      updates,
    })
  }

  private emitContextSizeUpdated(sessionId: string, contextSize: number): void {
    this.eventBus?.emit(sessionId, {
      type: SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED,
      contextSize,
    }).catch(err => this.logError('context:size-updated emit failed:', err))
  }

  private normalizeStreamError(error: unknown): CoreStreamErrorInfo {
    const normalized = error instanceof Error ? error : new Error(String(error))
    return this.options.normalizeStreamError?.(normalized) ?? normalizeErrorDefault(normalized)
  }
}
