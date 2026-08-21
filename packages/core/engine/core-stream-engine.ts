import { SESSION_COMMAND_TYPES } from '../events/session-command-types.js'
import type { SessionCommandType } from '../events/session-command-types.js'
import type { Unsubscribe } from '../events/types.js'
import { PendingMessageQueue } from './message-queue.js'
import type { PendingMessage } from './message-queue.js'
import { getCoreLogger } from '../logging/index.js'
import type { CoreInitialToolChoice } from './stream-executor.js'
import { coreProviderOwnsItsContextWindow } from './external-agent-providers.js'
import { expandFileMentions, isFileMentionTrustedChannel } from './file-mentions.js'
import { parsePrincipal } from '../permission/principal.js'
import type {
  StreamEngineCompactionAdapter,
  StreamEngineClockAdapter,
  StreamEngineHistoryAdapter,
  StreamEngineIdAdapter,
  StreamEngineMediaAdapter,
  StreamEngineModelRegistryAdapter,
  StreamEnginePermissionAdapter,
  StreamEnginePromptAdapter,
  StreamEngineProviderAdapter,
  StreamEngineSkillsAdapter,
  StreamEngineStoreAdapter,
  StreamEngineStreamsAdapter,
} from './stream-runtime.js'
import {
  canApplyGeneratedSessionTitle,
  generateTitleFromMessage,
  normalizeSessionTitle,
  resolveToolCallModel,
  type StreamEngineSettingsWithProviders,
} from './title.js'
import {
  extractErrorDetails,
  type CoreErrorDetails,
} from './error-details.js'
import {
  buildContextUsageSnapshot,
} from './context-usage.js'
import { resolveContextCompactTotalBudgetMs } from './context-compact.js'

const log = getCoreLogger('core.engine')

export interface CoreCommandEnvelope<TCommand = unknown> {
  sessionId: string
  event: TCommand
}

export interface CoreEventBusLike {
  onAnySession(
    eventType: string,
    handler: (envelope: CoreCommandEnvelope) => void,
    label?: string
  ): Unsubscribe
}

export interface AbortLikeCommand {
  type?: string
  reason?: string
}

export interface InjectMessageCommand {
  type?: string
  content: string
  source?: string
  origin?: unknown
}

export interface RetractSteeringLikeCommand {
  type?: string
  messageId: string
}

export interface CoreEventBusEmitterLike extends CoreEventBusLike {
  emit(sessionId: string, event: any): Promise<unknown>
}

export interface CoreStreamMessage {
  id: string
  role: string
  content?: string
  timestamp: number
  attachments?: unknown[]
  contentParts?: unknown[]
  source?: string
  voice?: unknown
  model?: string
  provider?: string
  isStreaming?: boolean
  thinkingStartTime?: number
  toolCalls?: unknown[]
  reasoning?: string
  errorDetails?: string
  [key: string]: unknown
}

export interface CoreStreamSession<TMessage extends CoreStreamMessage = CoreStreamMessage> {
  messages: TMessage[]
  name?: string
  workingDirectory?: string
  agentId?: string
  parentSessionId?: string
  createdAt: number
  contextSize?: number
  lastInputTokens?: number
  permissionMode?: string
  [key: string]: unknown
}

export interface CoreStreamSettings {
  tools?: {
    permissionMode?: string
    toolCallModel?: {
      thinking?: boolean
      thinkingEffort?: unknown
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  skills?: {
    enableSkills?: boolean
    [key: string]: unknown
  }
  chat?: {
    contextCompactKeepRecentTurns?: number
    contextCompactChunkTimeoutSeconds?: number
    contextCompactEnabled?: boolean
    maxTokens?: number
    contextCompactThreshold?: number
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface CoreStreamPermissionModeSession {
  permissionMode?: string
}

export interface CoreStreamPermissionModeSettings {
  tools?: {
    permissionMode?: string
  }
}

export function resolveStreamPermissionMode(
  session: CoreStreamPermissionModeSession | null | undefined,
  settings: CoreStreamPermissionModeSettings | null | undefined,
  fallback = 'normal',
): string {
  return session?.permissionMode ?? settings?.tools?.permissionMode ?? fallback
}

export interface CoreProviderConfigWithKeyLike {
  model: string
  selectedModels?: string[]
  apiKey: string
  authContext?: unknown
  oauthToken?: unknown
  baseUrl?: unknown
  maxOutputByModel?: Record<string, number | undefined>
  [key: string]: unknown
}

export interface CoreStreamResultLike {
  pausedForConfirmation?: boolean
  [key: string]: unknown
}

export interface CoreContextCompactResultLike {
  success: boolean
  skipped?: boolean
  summary?: string
  error?: string
  retainedContextSize?: number
  [key: string]: unknown
}

export interface CoreStreamEngineRuntime<
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
  store: StreamEngineStoreAdapter<TSettings, TSession, TMessage>
  ids: StreamEngineIdAdapter
  clock: StreamEngineClockAdapter
  permission: StreamEnginePermissionAdapter
  skills: StreamEngineSkillsAdapter<TSkill>
  prompts: StreamEnginePromptAdapter<TSkill, TContentPart>
  media: StreamEngineMediaAdapter<TAttachment>
  provider: StreamEngineProviderAdapter<TSettings, TProviderConfig, TAuthContext>
  models: StreamEngineModelRegistryAdapter
  history: StreamEngineHistoryAdapter<TSession, TMessage, THistoryMessage>
  streams: StreamEngineStreamsAdapter<THistoryMessage, TStreamResult>
  compaction: StreamEngineCompactionAdapter<unknown, TCompactResult>
}

export interface CoreStreamErrorInfo {
  error: Error
  message: string
  details?: string
  isAbortError: boolean
}

export interface CoreStreamEngineOptions {
  normalizeStreamError?: (error: Error) => CoreStreamErrorInfo
}

interface SendMessageCommandLike {
  type?: string
  content: string
  attachments?: unknown[]
  channel?: string
  source?: string
  voice?: unknown
  origin?: unknown
  /**
   * Who is behind this turn. NOT a passthrough the engine trusts: hosts mint
   * it at their boundary (app/engine/stream-engine.ts) after proving the
   * sender may name an actor, and overwrite anything that arrived on the wire.
   * The engine only carries it down to the tool executor.
   *
   * A forwarded command CAN spell this field — apps/server forwards commands
   * whole — which is exactly why the mint site, not the engine, is the
   * authority. Same lesson as collabDriveToken (app/collab/drive-guard.ts).
   */
  principal?: unknown
  /**
   * IM quote-reply snapshot ({messageId, authorLabel, excerpt}). Persisted
   * verbatim onto the user message — the engine never reads inside it. This is
   * a NAMED passthrough, not a generic one: nothing else on the command may
   * ride into storage without its own line here.
   */
  replyTo?: unknown
  /**
   * The room message a collab coordinator drive answers. Another NAMED
   * passthrough persisted verbatim onto the user message — the engine never
   * reads it. It exists so the durable transcript itself records which room
   * message was already consumed, which is what makes a restart idempotent
   * without consulting the coordinator's own state file (W23).
   */
  collabSourceMessageId?: string
  /**
   * Billing attribution label for this turn's usage records ('chat' when
   * absent). A plain passthrough: the engine never reads it, it only rides
   * down to whoever writes the usage ledger, so a collab room turn shows up
   * as room spend instead of anonymous chat spend.
   */
  usageSource?: string
  /**
   * Force the FIRST model call of this turn into a tool call. Another named
   * passthrough — the engine never reads it, it only rides down to the agent
   * loop, which applies it to iteration 1 and nothing else.
   *
   * Set by system-internal drives whose entire output space is the tool surface
   * (the collab room drive forces `say` by name). Ordinary chat never sets it.
   */
  initialToolChoice?: CoreInitialToolChoice
  providerId?: string
  model?: string
  /**
   * Pin the think mode for this turn (system-internal drives with their own
   * configured model, e.g. the radio DJ). Only honored alongside providerId.
   */
  thinking?: boolean
  thinkingEffort?: string
  /** System-internal drives set this: their prompt text is not a title. */
  suppressTitleGeneration?: boolean
  /**
   * Persist and display the user message, then STOP — no provider resolution,
   * no compaction check, no assistant message, no stream (N2 `handled`).
   *
   * The engine had no word for "the user said this, and nothing is going to
   * answer it". `steerMessage` is the closest existing shape but it is a
   * QUEUE: the text also gets consumed by whatever turn runs next, which is
   * wrong here — a plugin that answered `=1+2` locally must not have `=1+2`
   * re-injected into the next real turn as steering.
   *
   * The early return sits AFTER `message:user-created` so every consumer
   * (renderer, coordinator, session store) sees an ordinary user message. It
   * is deliberately BEFORE title generation: a message nothing answered is
   * not what a session should be named after, and the whole point of the
   * `handled` branch is that this send costs zero model calls.
   */
  persistOnly?: boolean
}

interface EditAndResendCommandLike {
  type?: string
  messageId: string
  newContent: string
  channel?: string
  origin?: unknown
  providerId?: string
  model?: string
}

interface RetryMessageCommandLike {
  type?: string
  messageId: string
  providerId?: string
  model?: string
}

interface ResumeAfterConfirmCommandLike {
  type?: string
  messageId: string
}

interface CompactContextCommandLike {
  type?: string
  requestId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function authKind(authContext: unknown): string | undefined {
  const record = asRecord(authContext)
  return typeof record.kind === 'string' ? record.kind : undefined
}

function authApiKey(authContext: unknown): string {
  const record = asRecord(authContext)
  return typeof record.apiKey === 'string' ? record.apiKey : ''
}

function authToken(authContext: unknown): unknown {
  return asRecord(authContext).token
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
 * 一跳到位;宿主(OnethingStreamEngine → backend StreamEngine)照旧 override 本体。
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
    const existing = this.activeStreams.get(sessionId)
    if (existing) {
      this.log(`Aborting previous stream for session: ${sessionId}`)
      existing.abort()
      this.onSessionAbort(sessionId, 'Superseded by a new stream')
    }
    this.activeStreams.set(sessionId, controller)
  }

  removeController(sessionId: string): void {
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

  abortAll(): void {
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
  }

  shutdown(): void {
    this.abortAll()
    this.unsubscribeCommands()
    this.steeringQueues.clear()
    this.followUpQueues.clear()
    this.commandTarget = null
    this.onShutdown()
  }

  /**
   * 命令订阅表:键是 `SESSION_COMMAND_TYPES` 里的常量,不是再抄一遍的字面量 ——
   * 渲染层 `emitCommand(…, { type: SESSION_COMMAND_TYPES.SEND_MESSAGE })` 上按
   * F12 能直接跳到这张表的那一行,再一跳就是下面的 `handleSendMessage` 本体
   * (2026-08-21 两层合一之前,中间还隔着一层 `handleSendMessageCommand` 抽象转发)。
   *
   * 类型是 `Partial<Record<SessionCommandType, …>>` 而不是 `Record`:12 条命令里
   * 引擎只订阅 9 条,另外三条各有自己的订阅者,不在这里硬造处理者 ——
   *   - `PERMISSION_RESPOND` → `packages/core/permission/index.ts`(Permission 自己订)
   *   - `INTERACTION_RESPOND` → `packages/core/interaction/registry.ts`(交互注册表自己订)
   *   - `CONFIRM_TOOL` → **全仓无订阅者**(只剩契约形状,没有任何 `onAnySession`
   *     消费它;发它等于丢进空气)。
   */
  protected buildCommandHandlers(): Partial<
    Record<SessionCommandType, (envelope: CoreCommandEnvelope) => void>
  > {
    return {
      [SESSION_COMMAND_TYPES.SEND_MESSAGE]: (envelope) => {
        const target = this.commandTarget
        if (!target) return
        this.handleSendMessage(envelope.sessionId, envelope.event as SendMessageCommandLike, target)
          .catch(err => this.logError(`${SESSION_COMMAND_TYPES.SEND_MESSAGE} error:`, err))
      },
      [SESSION_COMMAND_TYPES.EDIT_AND_RESEND]: (envelope) => {
        const target = this.commandTarget
        if (!target) return
        this.handleEditAndResend(envelope.sessionId, envelope.event as EditAndResendCommandLike, target)
          .catch(err => this.logError(`${SESSION_COMMAND_TYPES.EDIT_AND_RESEND} error:`, err))
      },
      [SESSION_COMMAND_TYPES.RETRY_MESSAGE]: (envelope) => {
        const target = this.commandTarget
        if (!target) return
        this.handleRetryMessage(envelope.sessionId, envelope.event as RetryMessageCommandLike, target)
          .catch(err => this.logError(`${SESSION_COMMAND_TYPES.RETRY_MESSAGE} error:`, err))
      },
      [SESSION_COMMAND_TYPES.COMPACT_CONTEXT]: (envelope) => {
        this.handleCompactContext(envelope.sessionId, envelope.event as CompactContextCommandLike)
          .catch(err => this.logError(`${SESSION_COMMAND_TYPES.COMPACT_CONTEXT} error:`, err))
      },
      [SESSION_COMMAND_TYPES.ABORT]: (envelope) => {
        this.handleAbort(envelope.sessionId, envelope.event as AbortLikeCommand)
      },
      [SESSION_COMMAND_TYPES.RESUME_AFTER_CONFIRM]: (envelope) => {
        const target = this.commandTarget
        if (!target) return
        this.handleResumeAfterConfirm(envelope.sessionId, envelope.event as ResumeAfterConfirmCommandLike, target)
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
      this.unsubs.push(eventBus.onAnySession(commandType, handler, 'StreamEngine'))
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

  private activeCompactions = new Set<string>()
  /**
   * P2(2026-08-14):per-session 压缩闸。压缩开跑时放进一个 promise,收尾时
   * **无条件** resolve 并清除。四个命令入口在持久化任何消息之前 await 它 ——
   * 语义是**等待而不是拒绝**:压缩通常几十秒,用户消息不该丢、也不该要求手动
   * 重试。这是本方案唯一新增的阻塞点,所以 finally 的 resolve 不能有条件。
   */
  private compactionGates = new Map<string, { promise: Promise<void>; release: () => void }>()
  private sessionTitleGenerations = new Map<string, number>()
  private titleGenerationSeq = 0

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
          type: 'steering:queued',
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
      type: 'message:deleted',
      messageId,
    }).catch(err => this.logError('message:deleted emit error:', err))
    this.eventBus?.emit(sessionId, {
      type: 'steering:retracted',
      messageId,
    }).catch(err => this.logError('steering:retracted emit error:', err))
    return true
  }

  protected onSessionCleared(sessionId: string): void {
    this.sessionTitleGenerations.delete(sessionId)
    this.runtime.permission.clearSession(sessionId)
  }

  protected onShutdown(): void {
    this.sessionTitleGenerations.clear()
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

  async handleSendMessage(
    sessionId: string,
    cmd: SendMessageCommandLike,
    sender: TCommandTarget,
  ): Promise<void> {
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
        id: this.createMessageId(),
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
        type: 'message:user-created',
        message: userMessage,
      })

      // N2 `handled`: the message is on record and on screen; nothing answers it.
      // Zero model calls — that includes the title call (see persistOnly).
      if (cmd.persistOnly) return

      if ((isFirstUserMessage || isBranchFirstMessage) && !cmd.suppressTitleGeneration) {
        this.generateAndApplySessionTitle(
          sessionId,
          resolvedPromptRefs.displayContent,
          session?.name || '',
        ).catch(err => this.logError('chat title generation failed:', err))
      }

      const resolved = await this.resolveProvider(
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
      if (!resolved) return
      const { configWithApiKey, providerId, settings } = resolved

      if (!await this.maybeCompactBeforeSend(sessionId, providerId, configWithApiKey, settings)) return

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
      this.store.addMessage(sessionId, assistantMessage)

      await this.eventBus?.emit(sessionId, {
        type: 'message:assistant-created',
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
        sender, sessionId, assistantMessageId, messageContent: resolvedPromptRefs.modelContent,
        historyMessages, configWithApiKey, providerId, settings,
        toolSettings: settings.tools, sessionName,
        // S1a(session-event-sourcing §10.2):这次执行**是哪一种**,由四个入口
        // 各自盖章。宿主拿它写 `run/start.kind`;core 自己不落盘。
        runKind: 'send',
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
    }
  }

  async handleCompactContext(
    sessionId: string,
    cmd: CompactContextCommandLike,
  ): Promise<void> {
    if (this.activeStreams.has(sessionId)) {
      await this.eventBus?.emit(sessionId, {
        type: 'context:compact-completed',
        requestId: cmd.requestId,
        success: false,
        error: 'Cannot compact while a response is streaming.',
      })
      return
    }
    if (this.activeCompactions.has(sessionId)) {
      await this.eventBus?.emit(sessionId, {
        type: 'context:compact-completed',
        requestId: cmd.requestId,
        success: false,
        error: 'Context compact is already running.',
      })
      return
    }

    // P2:登记必须在**第一个 await 之前**同步完成。从前 activeStreams 检查之后
    // 还有 resolveProvider 的 await 窗口,两条 /compact 能双双穿过(TOCTOU)。
    this.activeCompactions.add(sessionId)
    const release = this.openCompactionGate(sessionId)

    try {
      const resolved = await this.resolveProvider(sessionId)
      if (!resolved) {
        await this.eventBus?.emit(sessionId, {
          type: 'context:compact-completed',
          requestId: cmd.requestId,
          success: false,
          error: 'Provider is not configured.',
        })
        return
      }

      const result = await this.runContextCompact(
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
        type: 'context:compact-completed',
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
      this.activeCompactions.delete(sessionId)
      release()
    }
  }

  async handleEditAndResend(
    sessionId: string,
    cmd: EditAndResendCommandLike,
    sender: TCommandTarget,
  ): Promise<void> {
    this.sessionChannels.set(sessionId, cmd.channel || 'ipc')
    const { messageId, newContent } = cmd

    try {
      // P2 入口闸(见 handleSendMessage):truncate 也是一次持久化。
      await this.waitForCompactionIdle(sessionId)

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
        type: 'messages:replaced',
        messages: this.store.listMessages(sessionId) as TMessage[],
      })

      const resolved = await this.resolveProvider(
        sessionId,
        cmd.providerId ? { providerId: cmd.providerId, model: cmd.model } : undefined,
      )
      if (!resolved) return
      const { configWithApiKey, providerId, settings } = resolved

      if (!await this.maybeCompactBeforeSend(sessionId, providerId, configWithApiKey, settings)) return

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
      this.store.addMessage(sessionId, assistantMessage)

      await this.eventBus?.emit(sessionId, {
        type: 'message:assistant-created',
        message: assistantMessage,
      })

      this.log(`Starting edit/resend stream: session=${sessionId}, provider=${providerId}`)

      const session = this.store.getSession(sessionId)
      const historyMessages = this.runtime.history.buildMessages(
        this.store.listMessages(sessionId) as TMessage[],
        session,
      )

      await this.runtime.streams.executeMessageStream({
        sender, sessionId, assistantMessageId,
        messageContent: resolvedPromptRefs.modelContent,
        historyMessages, configWithApiKey, providerId, settings,
        toolSettings: settings.tools, sessionName: session?.name,
        runKind: 'edit-resend',
        triggerMessageId: cmd.messageId,
      })
    } catch (error) {
      const streamError = this.normalizeStreamError(error)
      this.logError('handleEditAndResend error:', streamError.error)
      this.emitStreamError(sessionId, streamError.message)
    }
  }

  async handleRetryMessage(
    sessionId: string,
    cmd: RetryMessageCommandLike,
    sender: TCommandTarget,
  ): Promise<void> {
    const { messageId } = cmd

    try {
      // P2 入口闸(见 handleSendMessage)。
      await this.waitForCompactionIdle(sessionId)

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
        type: 'messages:replaced',
        messages: this.store.listMessages(sessionId) as TMessage[],
      })

      const resolved = await this.resolveProvider(
        sessionId,
        cmd.providerId ? { providerId: cmd.providerId, model: cmd.model } : undefined,
      )
      if (!resolved) return
      const { configWithApiKey, providerId, settings } = resolved

      if (!await this.maybeCompactBeforeSend(sessionId, providerId, configWithApiKey, settings)) return

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
      this.store.addMessage(sessionId, assistantMessage)

      await this.eventBus?.emit(sessionId, {
        type: 'message:assistant-created',
        message: assistantMessage,
      })

      this.log(`Starting retry stream: session=${sessionId}, provider=${providerId}`)

      const session = this.store.getSession(sessionId)
      const messagesForRetry = this.store.listMessages(sessionId)
      const historyMessages = this.runtime.history.buildMessages(messagesForRetry as TMessage[], session)
      const lastUserMessage = messagesForRetry.filter(m => m.role === 'user').pop()
      const messageContent = lastUserMessage?.content || ''

      await this.runtime.streams.executeMessageStream({
        sender, sessionId, assistantMessageId, messageContent,
        historyMessages, configWithApiKey, providerId, settings,
        toolSettings: settings.tools, sessionName: session?.name,
        runKind: 'retry',
        ...(lastUserMessage?.id ? { triggerMessageId: lastUserMessage.id } : {}),
      })
    } catch (error) {
      const streamError = this.normalizeStreamError(error)
      this.logError('handleRetryMessage error:', streamError.error)
      this.emitStreamError(sessionId, streamError.message)
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
      type: 'message:user-created',
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

  async handleResumeAfterConfirm(
    sessionId: string,
    cmd: ResumeAfterConfirmCommandLike,
    sender: TCommandTarget,
  ): Promise<void> {
    const { messageId } = cmd

    try {
      // P2 入口闸(见 handleSendMessage):恢复也要在压缩后的历史上重建。
      await this.waitForCompactionIdle(sessionId)

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
      const resolved = await this.resolveProvider(
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

      this.eventBus?.emit(sessionId, { type: 'content:continuation', turnIndex: 1 })
        .catch(err => this.logError('continuation emit error:', err))

      const abortController = new AbortController()
      this.registerController(sessionId, abortController)

      const ctx = {
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
          this.removeController(sessionId)
        }
      } catch (error) {
        const streamError = this.normalizeStreamError(error)
        const isAborted = streamError.isAbortError || abortController.signal.aborted
        if (isAborted) {
          this.eventBus?.emit(sessionId, { type: 'stream:aborted', reason: 'User cancelled' })
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
            type: 'stream:error',
            data: { error: streamError.message, errorDetails: streamError.details },
          }).catch(err => this.logError('stream:error emit error:', err))
        }
        this.removeController(sessionId)
      }
    } catch (error) {
      const streamError = this.normalizeStreamError(error)
      this.logError('handleResumeAfterConfirm error:', streamError.error)
      this.emitStreamError(sessionId, streamError.message || 'Resume error')
    }
  }

  private async generateAndApplySessionTitle(
    sessionId: string,
    displayContent: string,
    expectedSessionName: string,
  ): Promise<void> {
    const requestId = ++this.titleGenerationSeq
    this.sessionTitleGenerations.set(sessionId, requestId)

    try {
      const generatedTitle = await this.generateSessionTitle(sessionId, displayContent)
      const title = normalizeSessionTitle(generatedTitle) || generateTitleFromMessage(displayContent)
      if (!title) return

      if (this.sessionTitleGenerations.get(sessionId) !== requestId) return

      const session = this.store.getSession(sessionId)
      if (!session) return
      if (!canApplyGeneratedSessionTitle(session.name, expectedSessionName)) {
        return
      }
      if (session.name === title) return

      this.store.renameSession(sessionId, title)
      await this.eventBus?.emit(sessionId, {
        type: 'session:renamed',
        name: title,
      })
    } catch (error) {
      const fallbackTitle = generateTitleFromMessage(displayContent)
      const session = this.store.getSession(sessionId)
      if (
        session &&
        fallbackTitle &&
        this.sessionTitleGenerations.get(sessionId) === requestId &&
        canApplyGeneratedSessionTitle(session.name, expectedSessionName)
      ) {
        this.store.renameSession(sessionId, fallbackTitle)
        await this.eventBus?.emit(sessionId, {
          type: 'session:renamed',
          name: fallbackTitle,
        })
      }
      this.logError('Falling back to local chat title:', error)
    } finally {
      if (this.sessionTitleGenerations.get(sessionId) === requestId) {
        this.sessionTitleGenerations.delete(sessionId)
      }
    }
  }

  private async generateSessionTitle(sessionId: string, displayContent: string): Promise<string> {
    // Title generation resolves off settings directly, so it needs the same
    // session-scoped view the send path gets — otherwise a session in another
    // workspace titles itself with a model that workspace never selected.
    const settings = this.store.getSettingsForSession?.(sessionId) ?? this.store.getSettings()
    const { providerId, providerConfig: rawProviderConfig, model } = resolveToolCallModel(
      settings as unknown as StreamEngineSettingsWithProviders<{ model?: string; selectedModels?: string[] }>,
    )
    if (!providerId || !rawProviderConfig || !model) {
      return generateTitleFromMessage(displayContent)
    }

    if (!this.runtime.provider.isSupported(providerId)) {
      return generateTitleFromMessage(displayContent)
    }

    // Title generation resolves its provider straight off settings rather than
    // through getEffectiveConfig, so the host's per-session credential scoping
    // has to be applied here too — otherwise a session whose workspace has its
    // own keys would still bill its title to the global ones.
    const providerConfig = this.runtime.provider.applySpaceCredentials?.(
      sessionId,
      providerId,
      rawProviderConfig as TProviderConfig,
    ) ?? (rawProviderConfig as TProviderConfig)

    const authContext = await this.runtime.provider.resolveAuth(providerId, providerConfig)
    if (!authContext) {
      return generateTitleFromMessage(displayContent)
    }

    const apiType = this.runtime.provider.getApiType(settings, providerId)
    const providerConfigRecord = asRecord(providerConfig)
    return this.runtime.provider.generateTitle(
      providerId,
      {
        ...providerConfigRecord,
        apiKey: authKind(authContext) === 'api-key' ? authApiKey(authContext) : '',
        authContext,
        oauthToken: authKind(authContext) === 'oauth' ? authToken(authContext) : providerConfigRecord.oauthToken,
        baseUrl: providerConfigRecord.baseUrl,
        model,
        apiType,
      },
      displayContent,
      {
        thinking: settings.tools?.toolCallModel?.thinking === true,
        thinkingEffort: settings.tools?.toolCallModel?.thinkingEffort,
        debugSessionId: sessionId,
      },
    )
  }

  private async resolveProvider(
    sessionId: string,
    override?: { providerId?: string; model?: string; thinking?: boolean; thinkingEffort?: string } | null,
  ): Promise<{
    configWithApiKey: TProviderConfigWithKey
    providerId: string
    settings: TSettings
  } | null> {
    const settings = this.store.getSettings()
    const { providerId, providerConfig, model: effectiveModel } = this.runtime.provider.getEffectiveConfig(settings, sessionId, override)

    const authContext = await this.runtime.provider.resolveAuth(providerId, providerConfig)
    if (!authContext) {
      // The host may know a more specific reason than "no key" — e.g. this
      // session's workspace has its own credential pool and this provider is
      // not in it. Falling back keeps the message identical when it doesn't.
      const described = this.runtime.provider.describeMissingCredentials?.(
        providerId,
        providerConfig,
        sessionId,
      )
      const isOAuth = this.runtime.provider.requiresOAuth(providerId)
      this.emitStreamError(sessionId, described || (isOAuth
        ? `Not logged in to ${providerId}. Please login in settings.`
        : 'API Key not configured. Please configure your AI settings.'))
      return null
    }

    if (!this.runtime.provider.isSupported(providerId)) {
      this.emitStreamError(sessionId, `Unsupported provider: ${providerId}`)
      return null
    }

    const providerConfigRecord = asRecord(providerConfig)
    const selectedModels = Array.isArray(providerConfigRecord.selectedModels)
      ? providerConfigRecord.selectedModels.filter((model): model is string => typeof model === 'string')
      : [effectiveModel]

    const configWithApiKey = {
      ...providerConfigRecord,
      model: effectiveModel,
      selectedModels,
      apiKey: authKind(authContext) === 'api-key' ? authApiKey(authContext) : '',
      authContext,
      oauthToken: authKind(authContext) === 'oauth' ? authToken(authContext) : providerConfigRecord.oauthToken,
    } as TProviderConfigWithKey

    return { configWithApiKey, providerId, settings }
  }

  private async maybeCompactBeforeSend(
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
      this.emitStreamError(sessionId, 'Context compact is already running. Please wait for it to finish before sending another message.')
      return false
    }

    let modelContextLength = 128000
    let reservedOutputTokens = settings.chat?.maxTokens || 4096
    try {
      modelContextLength = await this.runtime.models.getModelContextLength(configWithApiKey.model, providerId)
      const modelMaxOutputTokens = await this.runtime.models.getModelMaxOutputTokens(configWithApiKey.model, providerId)
      const perModelOverride = configWithApiKey.maxOutputByModel?.[configWithApiKey.model]
      const halfDefault = modelMaxOutputTokens > 0 ? Math.max(1, Math.floor(modelMaxOutputTokens / 2)) : 0
      const requested = perModelOverride ?? (halfDefault > 0 ? halfDefault : reservedOutputTokens)
      reservedOutputTokens = modelMaxOutputTokens > 0 ? Math.min(requested, modelMaxOutputTokens) : requested
    } catch (error) {
      this.logError('Failed to resolve model context length for compact:', error)
    }

    const configuredKeepTurns = compactSettings?.contextCompactKeepRecentTurns ?? 6
    let keepRecentTurns = configuredKeepTurns

    for (let pass = 1; pass <= configuredKeepTurns; pass++) {
      const latestSession = this.store.getSession(sessionId)
      if (!latestSession) return true
      const historyMessages = this.runtime.history.buildMessages(
        this.store.listMessages(sessionId) as TMessage[],
        latestSession,
      )
      const usage = buildContextUsageSnapshot({
        session: latestSession,
        historyMessages: historyMessages as unknown[],
        modelContextLength,
        thresholdPercent: compactSettings?.contextCompactThreshold ?? 85,
        reservedOutputTokens,
        providerId,
        model: configWithApiKey.model,
      })
      if (
        latestSession.contextSize !== usage.visibleInputTokens ||
        latestSession.lastInputTokens !== usage.visibleInputTokens
      ) {
        this.emitContextSizeUpdated(sessionId, usage.visibleInputTokens)
      }

      if (this.runtime.compaction.shouldSkipAutoCompactForProviderUsageMismatch({
        providerId,
        session: latestSession,
        modelContextLength,
        inputTokens: usage.visibleInputTokens,
      })) {
        this.logError('Skipping auto compact because provider usage exceeds registered model context length:', {
          sessionId,
          providerId,
          model: configWithApiKey.model,
          contextSize: usage.visibleInputTokens,
          modelContextLength,
          source: usage.source,
        })
        return true
      }

      const reason = this.runtime.compaction.getContextCompactReason({
        session: latestSession,
        modelContextLength,
        thresholdPercent: compactSettings?.contextCompactThreshold ?? 85,
        reservedOutputTokens,
        inputTokens: usage.visibleInputTokens,
      })
      if (!reason) return true

      this.log(`[ContextUsage] decision ${JSON.stringify({
        sessionId,
        providerId,
        model: configWithApiKey.model,
        visibleInputTokens: usage.visibleInputTokens,
        effectiveInputTokens: usage.effectiveInputTokens,
        providerInputTokens: usage.providerInputTokens,
        requestEstimatedInputTokens: usage.requestEstimatedInputTokens,
        modelContextLength: usage.modelContextLength,
        reservedOutputTokens: usage.reservedOutputTokens,
        thresholdPercent: usage.thresholdPercent,
        reason,
        source: usage.source,
        historyMessageCount: usage.details.historyMessageCount,
        summaryUsed: usage.details.summaryUsed,
      })}`)
      this.log(`Auto compact triggered before send session=${sessionId} model=${configWithApiKey.model} reason=${reason}`)

      const result = await this.runContextCompact(
        {
          sessionId,
          providerId,
          configWithApiKey,
          settings,
          keepRecentTurns,
          onMessageCreated: (message: TMessage) => this.emitMessageCreated(sessionId, message),
          onMessageUpdated: (messageId: string, updates: Partial<TMessage>) => this.emitMessageUpdated(sessionId, messageId, updates),
        },
        { auto: true },
      )

      await this.eventBus?.emit(sessionId, {
        type: 'context:compact-completed',
        success: result.success,
        skipped: result.skipped,
        summary: result.summary,
        error: result.error,
      })

      if (result.success && !result.skipped) {
        this.emitContextSizeUpdated(sessionId, result.retainedContextSize ?? 0)
      }

      if (!result.success) {
        if (result.error === 'Context compact is already running.') {
          this.emitStreamError(sessionId, 'Context compact is already running. Please wait for it to finish before sending another message.')
          return false
        }
        this.logError('Auto compact failed; continuing send:', result.error)
        return true
      }

      if (result.skipped) {
        keepRecentTurns--
        if (keepRecentTurns <= 0) break
      } else if (reason === 'hard-limit') {
        keepRecentTurns--
        if (keepRecentTurns <= 0) break
      } else {
        return true
      }
    }

    const latestSession = this.store.getSession(sessionId)
    if (!latestSession) return true
    const finalHistoryMessages = this.runtime.history.buildMessages(
      this.store.listMessages(sessionId) as TMessage[],
      latestSession,
    )
    const finalUsage = buildContextUsageSnapshot({
      session: latestSession,
      historyMessages: finalHistoryMessages as unknown[],
      modelContextLength,
      thresholdPercent: compactSettings?.contextCompactThreshold ?? 85,
      reservedOutputTokens,
      providerId,
      model: configWithApiKey.model,
    })
    if (
      latestSession.contextSize !== finalUsage.visibleInputTokens ||
      latestSession.lastInputTokens !== finalUsage.visibleInputTokens
    ) {
      this.emitContextSizeUpdated(sessionId, finalUsage.visibleInputTokens)
    }
    const finalReason = this.runtime.compaction.getContextCompactReason({
      session: latestSession,
      modelContextLength,
      thresholdPercent: compactSettings?.contextCompactThreshold ?? 85,
      reservedOutputTokens,
      inputTokens: finalUsage.visibleInputTokens,
    })
    if (finalReason === 'hard-limit') {
      const lastKnownInputTokens = finalUsage.visibleInputTokens
      const message = [
        'Context is still too large after compacting down to the latest turn.',
        `Last known provider input ${lastKnownInputTokens.toLocaleString()} + reserved output ${reservedOutputTokens.toLocaleString()} exceeds model context ${modelContextLength.toLocaleString()}.`,
        'Reduce the latest message/tool context or lower max output tokens before retrying.',
      ].join(' ')
      this.emitStreamError(sessionId, message)
      return false
    }

    return true
  }

  /**
   * P2:同步开闸。**必须**在调用点的第一个 await 之前调用 —— 闸是在 await
   * 窗口里挡住并发发送的东西,晚一步就等于没有。返回的 release 必须在 finally
   * 里无条件调用。
   */
  private openCompactionGate(sessionId: string): () => void {
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
  protected async waitForCompactionIdle(sessionId: string): Promise<void> {
    const gate = this.compactionGates.get(sessionId)
    if (!gate) return

    // 预算随设置里的单块超时走(默认 300s × 5);设置读不到就用默认。
    let budgetMs = resolveContextCompactTotalBudgetMs(undefined)
    try {
      budgetMs = resolveContextCompactTotalBudgetMs(
        this.store.getSettings()?.chat?.contextCompactChunkTimeoutSeconds,
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
        this.logError('waitForCompactionIdle exceeded the compaction budget; proceeding anyway:', { sessionId })
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async runContextCompact(
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
      await this.eventBus?.emit(sessionId, {
        type: 'context:compact-started',
        ...(registration.requestId !== undefined ? { requestId: registration.requestId } : {}),
        ...(registration.auto ? { auto: true } : {}),
      }).catch(err => this.logError('context:compact-started emit error:', err))

      // C6:分块进度。手动路(handleCompactContext)与发送前自动路
      // (maybeCompactBeforeSend)都经过这里,所以接线只此一处 —— 回合中那条
      // (agent-loop 的 adapters)不走本函数,在 app 层各自接。
      return await this.runtime.compaction.compactSessionContext({
        ...asRecord(options),
        onProgress: (progress: { chunk: number; totalChunks: number }) =>
          this.eventBus?.emit(sessionId, {
            type: 'context:compact-progress',
            chunk: progress.chunk,
            totalChunks: progress.totalChunks,
          }).catch(err => this.logError('context:compact-progress emit error:', err)),
      })
    } finally {
      if (!registration.alreadyRegistered) {
        this.activeCompactions.delete(sessionId)
      }
      release()
    }
  }

  protected emitStreamError(sessionId: string, error: string): void {
    if (this.eventBus) {
      this.eventBus.emit(sessionId, {
        type: 'stream:error',
        data: { error },
      }).catch(err => this.logError('stream:error emit failed:', err))
    }
  }

  private async emitMessageCreated(sessionId: string, message: TMessage): Promise<void> {
    await this.eventBus?.emit(sessionId, {
      type: 'message:created',
      message,
    })
  }

  private async emitMessageUpdated(
    sessionId: string,
    messageId: string,
    updates: Partial<TMessage>,
  ): Promise<void> {
    await this.eventBus?.emit(sessionId, {
      type: 'message:updated',
      messageId,
      updates,
    })
  }

  private emitContextSizeUpdated(sessionId: string, contextSize: number): void {
    this.eventBus?.emit(sessionId, {
      type: 'context:size-updated',
      contextSize,
    }).catch(err => this.logError('context:size-updated emit failed:', err))
  }

  private normalizeStreamError(error: unknown): CoreStreamErrorInfo {
    const normalized = error instanceof Error ? error : new Error(String(error))
    return this.options.normalizeStreamError?.(normalized) ?? normalizeErrorDefault(normalized)
  }
}
