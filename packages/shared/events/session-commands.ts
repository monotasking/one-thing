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

// ── Type registry ───────────────────────────────

/**
 * 命令 type 字面量的**单一权威** —— 与 `SESSION_EVENT_TYPES` 同一条理由、同一套
 * 双向断言,只是分两张表:事件和命令是两个联合(批 4 之后 `SessionEvent` 已不含
 * 命令),合成一张表就等于把它们又搅回一起。
 *
 * 键上不再重复 `COMMAND_` —— 表名已经说了它是命令。值与线上格式逐字相同。
 */
export const SESSION_COMMAND_TYPES = {
  SEND_MESSAGE: 'command:send-message',
  EDIT_AND_RESEND: 'command:edit-and-resend',
  ABORT: 'command:abort',
  CONFIRM_TOOL: 'command:confirm-tool',
  RESUME_AFTER_CONFIRM: 'command:resume-after-confirm',
  PERMISSION_RESPOND: 'command:permission-respond',
  INTERACTION_RESPOND: 'command:interaction-respond',
  RETRY_MESSAGE: 'command:retry-message',
  COMPACT_CONTEXT: 'command:compact-context',
  INJECT_STEERING: 'command:inject-steering',
  RETRACT_STEERING: 'command:retract-steering',
  INJECT_FOLLOWUP: 'command:inject-followup',
} as const satisfies Record<string, SessionCommand['type']>

export type SessionCommandType = (typeof SESSION_COMMAND_TYPES)[keyof typeof SESSION_COMMAND_TYPES]

// 双向穷尽:多一个 / 少一个都在这里编译不过。
const _commandTableIsExhaustive: SessionCommandType extends SessionCommand['type']
  ? SessionCommand['type'] extends SessionCommandType ? true : never
  : never = true
void _commandTableIsExhaustive

export interface SendMessageCommand {
  type: 'command:send-message'
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
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
  type: 'command:edit-and-resend'
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
  type: 'command:abort'
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  reason?: string
}

export interface ConfirmToolCommand {
  type: 'command:confirm-tool'
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  toolCallId: string
  approved: boolean
}

export interface ResumeAfterConfirmCommand {
  type: 'command:resume-after-confirm'
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  messageId: string
}

export interface PermissionRespondCommand {
  type: 'command:permission-respond'
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
  decision: 'once' | 'session' | 'workdir' | 'reject'
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
  type: 'command:interaction-respond'
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
  type: 'command:retry-message'
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  messageId: string
  /** See SendMessageCommand.providerId/model — the retry path resolves them the same way. */
  providerId?: string
  model?: string
}

export interface CompactContextCommand {
  type: 'command:compact-context'
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  requestId?: string
  manual?: boolean
}

/** Inject a steering message mid-stream (after current turn ends) */
export interface InjectSteeringCommand {
  type: 'command:inject-steering'
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
  type: 'command:retract-steering'
  /** Originating channel ('ipc' | 'telegram' | 'cli' | 'api' | ...) */
  channel?: string
  messageId: string
}

/** Inject a follow-up message (only after agent would stop) */
export interface InjectFollowUpCommand {
  type: 'command:inject-followup'
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
  | ConfirmToolCommand
  | ResumeAfterConfirmCommand
  | PermissionRespondCommand
  | InteractionRespondCommand
  | RetryMessageCommand
  | CompactContextCommand
  | InjectSteeringCommand
  | RetractSteeringCommand
  | InjectFollowUpCommand
