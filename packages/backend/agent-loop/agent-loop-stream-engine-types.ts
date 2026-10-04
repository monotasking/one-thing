// `CoreStreamEngine`(`agent-loop-stream-engine.ts`)的形状:命令信封、会话 / 消息 / 设置的最小形状、宿主给引擎的
// 运行时端口表与选项,以及五条命令各自的载荷。2026-10-04 从引擎文件原样外移(拆分批 3,D227),一个字段没改。
import type { Unsubscribe } from '@onething/backend/event'
import type { CoreInitialToolChoice } from './agent-loop-stream-executor.js'
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
} from './agent-loop-engine-adapters.js'

export interface CoreCommandEnvelope<TCommand = unknown> {
  sessionId: string
  event: TCommand
  readonly executionContext?: unknown
}

export interface CoreExecutionOptions {
  readonly executionContext?: unknown
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

export interface CoreEventBusEmitterLike {
  onAnySession(
    eventType: string,
    handler: (envelope: CoreCommandEnvelope) => void,
    label?: string
  ): Unsubscribe
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
  authorizeExecution?: (sessionId: string, executionContext: unknown) => void
  normalizeStreamError?: (error: Error) => CoreStreamErrorInfo
  assertAccepting?: (sessionId?: string) => void
  prepareSession?: (sessionId: string) => Promise<void>
}

export interface SendMessageCommandLike {
  type?: string
  /**
   * 客户端预铸的用户消息 id(契约上的说明在
   * `@shared/events/session-commands.ts` 的 `SendMessageCommand.messageId`)。
   *
   * 它**不是**一格透传:引擎会读它,而且是这条命令里唯一一格由发送方决定的
   * 「事实地址」。所以它两道判 —— 形(`isClientMintedId`)与会话内唯一 ——
   * 由 `resolveUserMessageId` 一处做完,不合格就当作没给。
   */
  messageId?: string
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
   * A forwarded command CAN spell this field — apps/backend-server forwards commands
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

export interface EditAndResendCommandLike {
  type?: string
  messageId: string
  newContent: string
  channel?: string
  origin?: unknown
  providerId?: string
  model?: string
}

export interface RetryMessageCommandLike {
  type?: string
  messageId: string
  providerId?: string
  model?: string
}

export interface ResumeAfterConfirmCommandLike {
  type?: string
  messageId: string
}

export interface CompactContextCommandLike {
  type?: string
  requestId?: string
}
