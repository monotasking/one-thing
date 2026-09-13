/**
 * Session Command Types
 *
 * Commands are intents to mutate state, as opposed to events which
 * are facts about what already happened. Commands flow through
 * EventBus interceptors before being committed.
 *
 * Phase 3a: StreamEngine owns active stream lifecycle.
 * Phase 3b+: IPC handlers will emit commands, StreamEngine will subscribe.
 */

import type { ChatMessageMention, ChatMessageReplyTo, MessageAttachment } from '../ipc/chat.js'
import type { VoiceTranscriptMetadata } from '../ipc/voice.js'
import type { MessageOrigin } from '../ipc/channel-identity.js'
import { SESSION_COMMAND_TYPES } from '@onething/core/events'
import type { SessionCommandType } from '@onething/core/events'

// ── Type registry ───────────────────────────────

/**
 * 命令 type 字面量的**单一权威**现在在 core(`packages/core/events/session-command-types.ts`)
 * —— core 禁 import `@shared`,表留在这里就意味着引擎订阅点只能再手抄一份字面量,
 * 词汇分成两份、find-references 断在中间。表搬过去之后这里只做再导出:所有
 * `import { SESSION_COMMAND_TYPES } from '@shared/events/session-commands'` 一字不改,
 * 但它们和 `CoreStreamEngine` 的订阅表用的是同一个标识符。
 *
 * (做法与 `shared/tool-errors.ts` 从 `@onething/core/permission`、
 * `shared/ipc/interaction.ts` 从 `@onething/core/interaction` 再导出同一条。)
 *
 * 命令的**载荷形状**仍然留在本文件 —— 它们要引用 `@shared/ipc/*` 的附件 / 语音 /
 * 身份类型,core 够不着。下面那条双向穷尽断言因此仍是真闸:core 那张表多一条 /
 * 少一条,这里都编译不过。
 */
export { SESSION_COMMAND_TYPES } from '@onething/core/events'
export type { SessionCommandType } from '@onething/core/events'

// 双向穷尽:多一个 / 少一个都在这里编译不过。
const _commandTableIsExhaustive: SessionCommandType extends SessionCommand['type']
  ? SessionCommand['type'] extends SessionCommandType ? true : never
  : never = true
void _commandTableIsExhaustive

export interface SendMessageCommand {
  type: typeof SESSION_COMMAND_TYPES.SEND_MESSAGE
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  /**
   * The id this user message should be created with — **pre-minted by the
   * client**, so the sender can recognize its own message when the ledger
   * hands it back.
   *
   * Why it exists: the engine rewrites `content` before persisting it
   * (`@path` file mentions are inlined as `<file>` blocks, `/skill:x` becomes
   * the whole SKILL.md). A client that recognized its own message by comparing
   * the text it sent against the text that came back therefore never
   * recognized it at all, and left a duplicate optimistic bubble on screen
   * forever (2026-09-13 真机报障).
   *
   * Contract: the engine uses it verbatim; **absent = the engine mints one**.
   * A value that is not shaped like an id (`^[0-9a-zA-Z_-]{8,64}$`, the shape
   * `createCoreId()` produces) or that collides with a message already in this
   * session is **ignored — the engine mints one and does not error**: an id is
   * a convenience for the sender, never a way for it to overwrite history.
   *
   * Only SEND_MESSAGE takes it. `edit-and-resend` / `retry-message` address a
   * message that already exists, so there is nothing to pre-mint; a message
   * that degrades into the steering queue (busy session) gets its own id from
   * the engine, because the steering path is not this creation site.
   */
  messageId?: string
  content: string
  attachments?: MessageAttachment[]
  source?: 'text' | 'voice' | 'api' | string
  voice?: VoiceTranscriptMetadata
  origin?: MessageOrigin
  /**
   * IM quote reply (docs/design/multi-agent-collab-im.md §3.5 A). A snapshot
   * built by the sender at quote time; the engine only persists it onto the
   * user message it creates.
   */
  replyTo?: ChatMessageReplyTo
  /**
   * Identity-resolved @mentions the composer materialized from its member
   * tokens (W14a). The room ingress gate re-validates them against the roster
   * and unions the name-text fallback — the sender's ids are a hint about WHO
   * was picked, never authority over labels or membership.
   */
  mentions?: ChatMessageMention[]
  /**
   * W23: the room message this coordinator drive answers. A named passthrough
   * persisted verbatim onto the drive's user message, where it becomes a free
   * idempotence ledger — see ChatMessage.collabSourceMessageId. Only the collab
   * coordinator sets it; ordinary chat leaves it absent.
   */
  collabSourceMessageId?: string
  /**
   * Billing attribution for this turn's usage records (default 'chat').
   * Set by internal drives that spend on the user's behalf outside a plain
   * chat turn — the collab coordinator's room drives ('collab-room') and the
   * worker's task sessions ('collab-work'). Attribution ONLY: the room budget
   * gate still sums by sessionId, unchanged.
   */
  usageSource?: string
  /**
   * Provider/model the caller resolved and displayed at the moment of
   * sending (e.g. the renderer's model picker). When set, the engine uses
   * it directly instead of re-deriving from session/global settings —
   * optional so non-UI callers (gateway channels, headless clients) keep
   * today's fallback behavior unchanged.
   */
  providerId?: string
  model?: string
  /**
   * Pin the think mode for this turn, independent of the global per-model
   * toggle. Only honored alongside providerId — meant for system-internal
   * drives whose model comes from their own settings panel (e.g.
   * settings.music.radioDj), where no ThinkToggle is watching the session.
   */
  thinking?: boolean
  thinkingEffort?: string
  /**
   * System-internal drives (radio DJ wakes, …) set this so the drive prompt
   * does not become the session title — those sessions already carry a real,
   * deliberately chosen name.
   */
  suppressTitleGeneration?: boolean
}

export interface EditAndResendCommand {
  type: typeof SESSION_COMMAND_TYPES.EDIT_AND_RESEND
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  messageId: string
  newContent: string
  origin?: MessageOrigin
  /** See SendMessageCommand.providerId/model. */
  providerId?: string
  model?: string
}

export interface AbortCommand {
  type: typeof SESSION_COMMAND_TYPES.ABORT
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  reason?: string
}

export interface ResumeAfterConfirmCommand {
  type: typeof SESSION_COMMAND_TYPES.RESUME_AFTER_CONFIRM
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  messageId: string
}

export interface PermissionRespondCommand {
  type: typeof SESSION_COMMAND_TYPES.PERMISSION_RESPOND
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  /** Live request id, when the responder caught the permission:request event. */
  requestId?: string
  /**
   * Durable correlation key: the tool call this response targets. The
   * permission manager resolves it to the pending prompt, so responders
   * don't depend on having seen the ephemeral requestId.
   */
  toolCallId?: string
  /**
   * 与 `Permission.Response` 逐字同形(`packages/core/permission/index.ts`)。
   * `'always'` = 本项目里始终允许这个应用做这一类事;只有当那次 ask 的
   * `alwaysScope` 在场时它才是合法应答,否则内核结构化忽略。
   */
  decision: 'once' | 'session' | 'workdir' | 'always' | 'reject'
  /** Optional reason for rejection */
  rejectReason?: string
}

/**
 * 回答一次 agent 的提问(claude-code-integration-v2 §4,E1)。
 *
 * 与 `command:permission-respond` 并列走同一条统一命令通道 —— 于是通道亲和这件事
 * 在两条等待链上是同一套写法:ask 记下 `targetChannel`,内核校验应答方的 `channel`
 * 与之相等。跨通道冒批在提问上同样被挡住。
 */
export interface InteractionRespondCommand {
  type: typeof SESSION_COMMAND_TYPES.INTERACTION_RESPOND
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  /** 活的请求 id(应答方接到了 interaction:requested 事件时用它)。 */
  interactionId?: string
  /**
   * 持久相关键:这次提问挂在哪个工具调用上。与 permission 的 toolCallId 同一条理由——
   * requestId 只活在两端的内存里,而 toolCallId 是随消息落盘的。
   */
  toolCallId?: string
  /** 逐题答案,键是 `InteractionQuestion.id`。整体透传,内核不按题过滤。 */
  answers?: Record<string, { selected: string[]; freeText?: string }>
  /** 用户主动放弃回答 → declined,而不是空答案的 answered。 */
  decline?: boolean
  /** decline 的可读理由,进工具结果给模型看。 */
  reason?: string
}

export interface RetryMessageCommand {
  type: typeof SESSION_COMMAND_TYPES.RETRY_MESSAGE
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  messageId: string
  /** See SendMessageCommand.providerId/model — the retry path resolves them the same way. */
  providerId?: string
  model?: string
}

export interface CompactContextCommand {
  type: typeof SESSION_COMMAND_TYPES.COMPACT_CONTEXT
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  requestId?: string
  manual?: boolean
}

/** Inject a steering message mid-stream (after current turn ends) */
export interface InjectSteeringCommand {
  type: typeof SESSION_COMMAND_TYPES.INJECT_STEERING
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  content: string
  source?: string
  origin?: MessageOrigin
}

/**
 * Retract a queued steering message before the next loop turn consumes it.
 * Only works while the message is still pending in the steering queue; once
 * drained into a model request it can no longer be withdrawn.
 */
export interface RetractSteeringCommand {
  type: typeof SESSION_COMMAND_TYPES.RETRACT_STEERING
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  messageId: string
}

/** Inject a follow-up message (only after agent would stop) */
export interface InjectFollowUpCommand {
  type: typeof SESSION_COMMAND_TYPES.INJECT_FOLLOWUP
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  content: string
  source?: string
  origin?: MessageOrigin
}

export type SessionCommand =
  | SendMessageCommand
  | EditAndResendCommand
  | AbortCommand
  | ResumeAfterConfirmCommand
  | PermissionRespondCommand
  | InteractionRespondCommand
  | RetryMessageCommand
  | CompactContextCommand
  | InjectSteeringCommand
  | RetractSteeringCommand
  | InjectFollowUpCommand
