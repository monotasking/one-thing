/**
 * Session Event Types
 *
 * All events scoped to a single session. These flow through EventBus
 * and are stored in the ring buffer for replay.
 *
 * Design: each event is a self-contained fact about what happened.
 * The Session state machine reduces these events into SessionState.
 */

import type { Step, ToolCall, ToolPartialResult, ToolResult, ContentPart, ChatMessage, ChatSession, ContextVariable, SessionGoal, ThinkingEffort } from '../ipc.js'
import type {
  CollabAgentActivitySnapshot,
  CollabBoard,
  CollabCoordinatorState,
} from '../ipc/collab.js'
import type { InteractionAnswer, InteractionRequest } from '@onething/core/interaction'
import type { JsonObject } from '../json.js'
import type { SessionCommand } from './session-commands.js'

// ── Type registry ───────────────────────────────

/**
 * 事件 type 字面量的**单一权威**。命名风格沿用 `IPC_CHANNELS`:键是
 * SCREAMING_SNAKE,值与线上格式逐字相同。
 *
 * 存在的理由与 `SESSION_STREAM_TERMINAL_EVENTS` 同一条:手打的 `'stream:complete'`
 * 散在四百多处,改名时没有任何一处会编译红 —— 拼错一个字母只表现为"这条事件永远
 * 不到",而那是最难归因的一类。收进这张表之后,拼错就是一个不存在的属性名。
 *
 * 下面的 `satisfies` 保证"没有多的",`_eventTableIsExhaustive` 保证"没有少的"
 * —— 双向,判据来自 `SessionEvent` 联合本身,不是人的记性。
 *
 * 注:`packages/core` 因边界规则不能 import `@shared`,它手抄的那份形状保持字面量,
 * 由核心侧自己的焊点断言护着。
 */
export const SESSION_EVENT_TYPES = {
  STREAM_START: 'stream:start',
  STREAM_COMPLETE: 'stream:complete',
  STREAM_ERROR: 'stream:error',
  STREAM_ABORTED: 'stream:aborted',
  STREAM_USAGE: 'stream:usage',
  TOOL_CALL: 'tool:call',
  TOOL_RESULT: 'tool:result',
  TOOL_INPUT_START: 'tool:input-start',
  TOOL_INPUT_END: 'tool:input-end',
  TOOL_EXECUTION_START: 'tool:execution-start',
  TOOL_EXECUTION_UPDATE: 'tool:execution-update',
  TOOL_EXECUTION_END: 'tool:execution-end',
  STEP_ADDED: 'step:added',
  STEP_UPDATED: 'step:updated',
  CONTENT_PART: 'content:part',
  CONTENT_CONTINUATION: 'content:continuation',
  CONTEXT_SIZE_UPDATED: 'context:size-updated',
  CONTEXT_COMPACT_STARTED: 'context:compact-started',
  CONTEXT_COMPACT_PROGRESS: 'context:compact-progress',
  CONTEXT_COMPACT_COMPLETED: 'context:compact-completed',
  SESSION_VARIABLES_UPDATED: 'session:variables-updated',
  SESSION_GOAL_UPDATED: 'session:goal-updated',
  STREAM_PARAMS_RESOLVING: 'stream:params-resolving',
  REQUEST_SNAPSHOT: 'request:snapshot',
  SKILL_ACTIVATED: 'skill:activated',
  PERMISSION_REQUEST: 'permission:request',
  PERMISSION_TIMEOUT: 'permission:timeout',
  PERMISSION_QUEUED: 'permission:queued',
  PERMISSION_SETTLED: 'permission:settled',
  INTERACTION_REQUESTED: 'interaction:requested',
  INTERACTION_SETTLED: 'interaction:settled',
  TOOL_EXECUTING: 'tool:executing',
  TOOL_METADATA: 'tool:metadata',
  SESSION_RENAMED: 'session:renamed',
  SESSION_COLLAB_UPDATED: 'session:collab-updated',
  STEERING_QUEUED: 'steering:queued',
  STEERING_CONSUMED: 'steering:consumed',
  STEERING_RETRACTED: 'steering:retracted',
  SCRATCHPAD_CONSUMED: 'scratchpad:consumed',
  MESSAGE_USER_CREATED: 'message:user-created',
  MESSAGE_CREATED: 'message:created',
  MESSAGE_ASSISTANT_CREATED: 'message:assistant-created',
  MESSAGE_UPDATED: 'message:updated',
  MESSAGE_DELETED: 'message:deleted',
  MESSAGES_REPLACED: 'messages:replaced',
  COLLAB_BOARD_CHANGED: 'collab:board-changed',
  COLLAB_TYPING: 'collab:typing',
  COLLAB_TURN_ACTIVE: 'collab:turn-active',
  COLLAB_COORDINATOR_CHANGED: 'collab:coordinator-changed',
  COLLAB_AGENT_CHANGED: 'collab:agent-changed',
} as const satisfies Record<string, SessionEvent['type']>

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[keyof typeof SESSION_EVENT_TYPES]

// 双向穷尽:表少一个键(某个事件没进表)或联合少一个成员(表里有陈年死字符串)
// 都在这里编译不过。写法与下面的 `_terminalListIsExhaustive` 同款。
const _eventTableIsExhaustive: SessionEventType extends SessionEvent['type']
  ? SessionEvent['type'] extends SessionEventType ? true : never
  : never = true
void _eventTableIsExhaustive

// ── Stream lifecycle ────────────────────────────

export interface StreamCompleteUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface StreamCompleteData {
  sessionName?: string
  usage?: StreamCompleteUsage
  lastTurnUsage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
  aborted?: boolean
  error?: string
}

export interface StreamErrorData {
  error: string
  errorDetails?: string
  preserved?: boolean
}

export interface StreamStartEvent {
  type: 'stream:start'
  messageId: string
  assistantMessageId: string  // alias for messageId (backward compat)
  model?: string
}

export interface StreamCompleteEvent {
  type: 'stream:complete'
  data: StreamCompleteData
}

export interface StreamErrorEvent {
  type: 'stream:error'
  data: StreamErrorData
}

export interface StreamAbortedEvent {
  type: 'stream:aborted'
  reason?: string
}

/**
 * Per-turn usage, emitted the moment a model turn finishes (2026-08-17).
 * `stream:complete` still carries the final totals; this one exists so a
 * live "tokens so far" readout can snap from a character estimate to the real
 * count at every turn boundary of a long tool-using response.
 * `usage` is this turn's; `accumulated` is the running total for the stream.
 */
export interface StreamUsageEvent {
  type: 'stream:usage'
  messageId: string
  turnIndex?: number
  usage: StreamCompleteUsage
  accumulated: StreamCompleteUsage
}

/**
 * 流的三种终止事件 —— **单一权威**。
 *
 * 这份名单此前被手抄在五处(collab typing / voice store / stream-coalescer /
 * server runtime / plugin status sweep)。手抄的代价不是重复,是**加第四种终止
 * 事件时只有一处会被改**,而漏掉的那几处会安静地少扫一类残留。
 * 它与 `StreamCompleteEvent | StreamErrorEvent | StreamAbortedEvent` 三个接口
 * 由下面的类型断言绑死:加一个终止事件接口却忘了进名单,typecheck 就会红。
 */
export const SESSION_STREAM_TERMINAL_EVENTS = [
  SESSION_EVENT_TYPES.STREAM_COMPLETE,
  SESSION_EVENT_TYPES.STREAM_ERROR,
  SESSION_EVENT_TYPES.STREAM_ABORTED,
] as const

export type SessionStreamTerminalEventType = (typeof SESSION_STREAM_TERMINAL_EVENTS)[number]

// 名单必须与三个终止事件接口的 type 字段**完全**一致(双向):少一个或多一个
// 都在这里编译不过。这就是"补集写法"的替代品 —— 判据来自类型,不是人的记性。
type TerminalEventTypeFromInterfaces =
  | StreamCompleteEvent['type']
  | StreamErrorEvent['type']
  | StreamAbortedEvent['type']
const _terminalListIsExhaustive: SessionStreamTerminalEventType extends TerminalEventTypeFromInterfaces
  ? TerminalEventTypeFromInterfaces extends SessionStreamTerminalEventType ? true : never
  : never = true
void _terminalListIsExhaustive

export function isSessionStreamTerminalEvent(type: string): type is SessionStreamTerminalEventType {
  return (SESSION_STREAM_TERMINAL_EVENTS as readonly string[]).includes(type)
}

// ── Tool lifecycle ──────────────────────────────

/**
 * 工具与步骤事件所属的 assistant 消息号。
 *
 * 发射器一律盖号(`core/engine/event-only-emitter.ts`)。消费者**必须**优先认它,
 * 不要退回「当前活跃流是谁」去猜:那个绑定是本窗口的短暂事实,窗口中途重载、开第
 * 二个窗口、或跑起来之后才切进会话,它就不在了,而事件照发不误。可选只为兼容旧的
 * 重放数据。
 */
interface MessageScopedEvent {
  messageId?: string
}

export interface ToolCallEvent extends MessageScopedEvent {
  type: 'tool:call'
  toolCall: ToolCall
}

export interface ToolResultEvent extends MessageScopedEvent {
  type: 'tool:result'
  toolCall: ToolCall
}

export interface ToolInputStartEvent extends MessageScopedEvent {
  type: 'tool:input-start'
  toolCallId: string
  toolName: string
  toolCall: ToolCall
}

/**
 * The argument stream for a tool call is complete. This is the authoritative
 * receive-complete moment: the card's RECEIVING state must flip on this event,
 * never on a frontend guess about argument completeness.
 */
export interface ToolInputEndEvent extends MessageScopedEvent {
  type: 'tool:input-end'
  toolCallId: string
  stepId?: string
  toolCall: ToolCall
  /** Authoritative main-process Date.now() captured when args finished streaming. */
  receivedAt: number
  /** 'parse' = mid-stream JSON completion; 'provider-done' = settled by the provider's done event. */
  finalizedBy: 'parse' | 'provider-done'
}

export interface ToolExecutionStartEvent extends MessageScopedEvent {
  type: 'tool:execution-start'
  toolCallId: string
  stepId: string
  toolName: string
  args: JsonObject
  /** Authoritative main-process Date.now() captured when execution began. */
  startTime?: number
}

export interface ToolExecutionUpdateEvent extends MessageScopedEvent {
  type: 'tool:execution-update'
  toolCallId: string
  stepId: string
  partialResult: ToolPartialResult
}

export interface ToolExecutionEndEvent extends MessageScopedEvent {
  type: 'tool:execution-end'
  toolCallId: string
  stepId: string
  result?: ToolResult
  isError?: boolean
  error?: string
  /** Authoritative execution duration measured in the main process. */
  durationMs?: number
}

// ── Step events ─────────────────────────────────

export interface StepAddedEvent extends MessageScopedEvent {
  type: 'step:added'
  step: Step
}

export interface StepUpdatedEvent extends MessageScopedEvent {
  type: 'step:updated'
  stepId: string
  updates: Partial<Step>
}

// ── Content events ──────────────────────────────

export interface ContentPartEvent {
  type: 'content:part'
  part: ContentPart
}

export interface ContentContinuationEvent {
  type: 'content:continuation'
  turnIndex?: number
}

// ── Context events ──────────────────────────────

export interface ContextSizeUpdatedEvent {
  type: 'context:size-updated'
  contextSize: number
}

/**
 * P1(2026-08-14):压缩开始的**唯一**正路通知。从前 renderer 只能靠嗅探
 * 「一条内容长得像 context-compact/compacting 的消息」来猜,而专用 IPC 通道
 * 主进程从来没发过。现在手动/自动两条路统一在引擎的 runContextCompact 里发这
 * 一条,手动路径带 requestId。
 */
export interface ContextCompactStartedEvent {
  type: 'context:compact-started'
  requestId?: string
  auto?: boolean
  compactedThroughMessageId?: string
}

/**
 * C6(2026-08-14):分块摘要的进度。**只在多块时发** —— 单块压缩没有可报的进度。
 * 唯一发射点是 `compactSessionContext` 的 onChunkComplete(与刷 marker 同一处),
 * 三条调用路(手动 / 发送前自动 / 回合中 adapters)各自转发到 eventBus。
 */
export interface ContextCompactProgressEvent {
  type: 'context:compact-progress'
  chunk: number
  totalChunks: number
}

export interface ContextCompactCompletedEvent {
  type: 'context:compact-completed'
  requestId?: string
  success: boolean
  skipped?: boolean
  summary?: string
  error?: string
}

export interface SessionVariablesUpdatedEvent {
  type: 'session:variables-updated'
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  variables: ContextVariable[]
}

export interface SessionGoalUpdatedEvent {
  type: 'session:goal-updated'
  /** The goal that just changed; null after the goal is cleared. */
  goal: SessionGoal | null
  /**
   * The session's full goal history, oldest first. Sent with every update so
   * the renderer never has to derive "which one is current" itself — that rule
   * lives in exactly one place (packages/onething-runtime/src/goals/records.ts)
   * and a second copy on this side would be one more thing to keep in sync.
   */
  goals?: SessionGoal[]
}


// ── Params events ───────────────────────────────

export interface StreamParamsResolvingEvent {
  type: 'stream:params-resolving'
  messageId: string
  params: {
    providerId: string
    model: string
    temperature: number
    maxTokens: number
    topP?: number
  }
}

// ── Request inspector ───────────────────────────

export interface RequestMessageSnapshot {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  /** First N chars of the text content, escaped, for quick preview. */
  contentPreview: string
  /** Full text content for expanded inspection in the renderer. */
  content: string
  contentLength: number
  /** Assistant only: whether reasoning_content is attached to this turn. */
  hasReasoning: boolean
  reasoningLength?: number
  /** Assistant only: tool calls produced by this turn. */
  toolCalls?: Array<{ id: string; name: string; argsLength: number }>
  /** Tool only: which tool call this result belongs to. */
  toolCallId?: string
  toolName?: string
}

export interface RequestSnapshotEvent {
  type: 'request:snapshot'
  /** Pre-flight snapshot of an outbound model request, captured by the
   *  stream runtime right before provider execution. The Inspector panel
   *  keeps a small ring buffer of these per session. */
  snapshot: {
    timestamp: number
    providerId: string
    model: string
    turn: number
    messages: RequestMessageSnapshot[]
    tools: Array<{ name: string; description?: string }>
    thinking?: 'enabled' | 'disabled'
    thinkingEffort?: ThinkingEffort
    serviceTier?: string
    temperature?: number
    maxTokens?: number
  }
}

// ── Skill events ────────────────────────────────

export interface SkillActivatedEvent {
  type: 'skill:activated'
  skillName: string
}

// ── Permission events ───────────────────────────

export interface PermissionRequestEvent {
  type: 'permission:request'
  requestId: string
  /** The channel that should handle this permission request */
  targetChannel: string
  toolCallId: string
  messageId: string
  permissionType: string
  title: string
  pattern?: string | string[]
  metadata: JsonObject
  userId?: string
  workspaceId?: string
  timeoutMs?: number
}

export interface PermissionTimeoutEvent {
  type: 'permission:timeout'
  requestId: string
}

/**
 * A tool's permission ask is registered but waiting behind another prompt in
 * the session's serialized permission queue (or coalesced onto an equivalent
 * pending ask). No card should be shown yet — the UI can surface a
 * "waiting for permission" state on the tool call instead of "executing".
 */
export interface PermissionQueuedEvent {
  type: 'permission:queued'
  /** The pending request this ask is queued behind / coalesced into. */
  requestId: string
  toolCallId: string
  messageId: string
}

/**
 * A pending permission ask settled (user decision, grant auto-resolve, or
 * session cleanup). Lets every surface clear cards/waiting states for the
 * head ask and all coalesced followers — including surfaces that did not
 * originate the response (e.g. renderer when approved remotely).
 */
export interface PermissionSettledEvent {
  type: 'permission:settled'
  requestId: string
  /** Head ask's tool call plus all coalesced followers'. */
  toolCallIds: string[]
  decision: 'allowed' | 'rejected'
}

// ── Interaction events ──────────────────────────

/**
 * 一个 agent 提了一个需要人回答的问题(claude-code-integration-v2 §4,E1)。
 *
 * 与 `permission:request` **并列**而不是它的一个 case:审批的答案是「允许/拒绝」,
 * 提问的答案是「从 N 个选项里选,或者自己写一句」。
 *
 * 载**整份 request**(而不是逐字段摊平),与 `collab:board-changed` 同一条理由:
 * 它很小,而整体透传省掉了「加了一格却忘了在事件上补一格」那一整类 bug。
 * 请求里带 `deadlineAt` —— UI 画倒计时用它,但**结算不归 UI 管**:内核自己挂表,
 * 到点结成 timeout(原则 4)。
 */
export interface InteractionRequestedEvent {
  type: 'interaction:requested'
  request: InteractionRequest
}

/**
 * 一次提问结算了(用户答复 / 主动放弃 / 到点超时 / 会话清理)。
 *
 * 与 `permission:settled` 同一条纪律:让每一个面都能清掉卡片和等待态,**包括那些
 * 不是结算发起方的面**(例如超时自结算时,没有任何 UI 点过东西)。
 * `toolCallId` 是卡片的归位键。
 */
export interface InteractionSettledEvent {
  type: 'interaction:settled'
  toolCallId?: string
  answer: InteractionAnswer
}

// ── Tool lifecycle (fine-grained) ───────────────

export interface ToolExecutingEvent {
  type: 'tool:executing'
  toolCallId: string
  title: string
}

export interface ToolMetadataEvent {
  type: 'tool:metadata'
  toolCallId: string
  metadata: JsonObject
}

// ── Session events ──────────────────────────────

export interface SessionRenamedEvent {
  type: 'session:renamed'
  name: string
}

/**
 * 这间房的**配置**变了 —— 名册 / 房名 / PM / 预算 / 冻结 / 响应模式(架构收敛 C4 §3)。
 *
 * 在它之前,房间配置根本没有会话列表级的推送:每一个写入方(成员条、设置面板、
 * 建房对话框、联系人开私聊、看板面板的两个开关)各自在写完之后手动 `loadSessions()`
 * 全量重拉一遍会话表 —— 七处,散在五个文件里,新加一个写入口就漏一处,而漏掉的
 * 症状是"改完不生效,切一下会话又生效了",最难归因的那一类。
 *
 * 载**全量小快照**,与 `collab:board-changed` / `collab:coordinator-changed` 同一条
 * 理由:room 对象本来就小,而全量替换省掉了增量合并那一整类 bug。渲染层按会话 id
 * 就地合并,不动列表里的其它项。
 *
 * 房名单独带一份是因为它不在 `room` 里(它是会话自己的名字);走 `renameSession`
 * 的改名照旧由 `session:renamed` 负责,这里只在 room 写入顺带改了名时填上。
 */
export interface SessionCollabUpdatedEvent {
  type: 'session:collab-updated'
  /** 会话名(房名)。没有变化时也照发 —— 快照哲学:接收方只认最新那一份。 */
  name?: string
  /** 房间配置的全量快照。房间被降级/删除这种事不走这条通道。 */
  room: NonNullable<ChatSession['room']>
}

// ── Steering events ─────────────────────────────

/** A steering message was persisted and queued; retractable until consumed. */
export interface SteeringQueuedEvent {
  type: 'steering:queued'
  messageId: string
}

/** Queued steering messages were drained into the next model turn. */
export interface SteeringConsumedEvent {
  type: 'steering:consumed'
  messageIds: string[]
}

/** A pending steering message was retracted before being consumed. */
export interface SteeringRetractedEvent {
  type: 'steering:retracted'
  messageId: string
}

/**
 * 草稿纸的某一版真的进了模型(beforeTurn 瞬态尾块)。
 *
 * 界面的"已读水位线"只认这条事件 —— 它是引擎回推的事实,不是渲染层的猜测。
 * `version` 就是纸的文件 mtime,与渲染层握着的版本号是同一个数。
 */
export interface ScratchpadConsumedEvent {
  type: 'scratchpad:consumed'
  version: number
  turn: number
}

// ── Message events ──────────────────────────────

export interface MessageUserCreatedEvent {
  type: 'message:user-created'
  message: ChatMessage
}

export interface MessageCreatedEvent {
  type: 'message:created'
  message: ChatMessage
}

export interface MessageAssistantCreatedEvent {
  type: 'message:assistant-created'
  message: ChatMessage
}

export interface MessageUpdatedEvent {
  type: 'message:updated'
  messageId: string
  updates: Partial<ChatMessage>
}

export interface MessageDeletedEvent {
  type: 'message:deleted'
  messageId: string
}

export interface MessagesReplacedEvent {
  type: 'messages:replaced'
  messages: ChatMessage[]
}

// ── Collab (multi-agent room) ───────────────────

/** The room's board changed; carries the full (small) snapshot. */
export interface CollabBoardChangedEvent {
  type: 'collab:board-changed'
  board: CollabBoard
}

/** A member is about to speak (queued/driving) or has stopped (settled).
 *  IM semantics: true may end with no message at all — "typed and deleted". */
export interface CollabTypingEvent {
  type: 'collab:typing'
  agentId: string
  typing: boolean
}

/**
 * A room turn window opened or closed (collab-team-v2 §5.1 入口①).
 *
 * The room session never emits `stream:start` — since W18 the turn runs in the
 * member's execution session — so the renderer had no way to know a room was
 * busy and the stop button was never drawn. This is that signal, and its window
 * is exactly `runtime.activeTurn`: the same window `abortRoomTurn` shoots into,
 * so a visible stop button always has a live target.
 *
 * `agentId` names who holds the floor, for the button's tooltip.
 */
export interface CollabTurnActiveEvent {
  type: 'collab:turn-active'
  agentId: string
  active: boolean
}

/**
 * 协调器的运行时状态变了(docs/design/collab-coordinator-inspector.md)。
 *
 * 带**完整快照**,与 `collab:board-changed` 同一条理由:它很小,而全量广播省掉了
 * 增量合并那一整类 bug。发送侧按秒节流 —— 「跑了多久」这种连续量由渲染层自己走秒,
 * 后端不为计时广播。
 */
export interface CollabCoordinatorChangedEvent {
  type: 'collab:coordinator-changed'
  state: CollabCoordinatorState
}

/**
 * 一位同事的活动状态变了(D8 观测体系 §3.1)。
 *
 * 与 `collab:coordinator-changed` 是**两本互不派生的账**,这是刻意的:房间那本按房
 * 广播,而大脑、信箱、工作卡是跨房的 —— 一个人在 A 房思考这件事,B 房那本账里没有
 * 任何字段说得出来。硬要从 N 份房间快照里拼一个人的状态,拼出来的是 N 份各自过期
 * 的碎片。
 *
 * 沿用同一条快照哲学(全量小快照 + `seq` 去序)与同一档节流,但**按 agent 独立
 * 节流槽** —— 一个话痨不该拖累别人那一格的刷新。
 *
 * 挂在**哪条会话**上:发给房间会话(这位同事此刻牵涉到的那几间),渲染层按 agentId
 * 归档。私聊房与群房因此都能收到,而没开着的房自然不占带宽。
 */
export interface CollabAgentChangedEvent {
  type: 'collab:agent-changed'
  activity: CollabAgentActivitySnapshot
}

// ── Union ───────────────────────────────────────

export type SessionEvent =
  | StreamStartEvent
  | StreamCompleteEvent
  | StreamErrorEvent
  | StreamAbortedEvent
  | StreamUsageEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolInputStartEvent
  | ToolInputEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | StepAddedEvent
  | StepUpdatedEvent
  | ContentPartEvent
  | ContentContinuationEvent
  | ContextSizeUpdatedEvent
  | ContextCompactStartedEvent
  | ContextCompactProgressEvent
  | ContextCompactCompletedEvent
  | SessionVariablesUpdatedEvent
  | SessionGoalUpdatedEvent
  | StreamParamsResolvingEvent
  | RequestSnapshotEvent
  | SkillActivatedEvent
  | PermissionRequestEvent
  | PermissionTimeoutEvent
  | PermissionQueuedEvent
  | PermissionSettledEvent
  | InteractionRequestedEvent
  | InteractionSettledEvent
  | ToolExecutingEvent
  | ToolMetadataEvent
  | SessionRenamedEvent
  | SessionCollabUpdatedEvent
  | SteeringQueuedEvent
  | SteeringConsumedEvent
  | SteeringRetractedEvent
  | ScratchpadConsumedEvent
  | MessageCreatedEvent
  | MessageUserCreatedEvent
  | MessageAssistantCreatedEvent
  | MessageUpdatedEvent
  | MessageDeletedEvent
  | MessagesReplacedEvent
  | CollabBoardChangedEvent
  | CollabTypingEvent
  | CollabTurnActiveEvent
  | CollabCoordinatorChangedEvent
  | CollabAgentChangedEvent

/**
 * 总线上实际跑的东西 —— 事件**和**命令。
 *
 * 命令不是事件,但它们走的是同一条 `EventBus.emit()`:desktop 的
 * `emitCoreSessionCommandForIpc`、server 的 `POST /sessions/:id/commands`、
 * 插件的 `sendMessage`,都是往这条总线上 emit,引擎再按 `command:*` 类型订阅。
 * 于是命令和事件一样拿序号、一样进 per-session 环形缓冲、一样被 IPCBridge 的
 * `onAnySessionAny` 和 server SSE 原样转给渲染层(`?after=` 重放也照发,全链路
 * 没有任何一处按 `command:` 前缀过滤)。渲染层的 switch 只是不认识就忽略。
 *
 * 所以这里是两个名字而不是一个:`SessionEvent` 是**纯事件**,给所有对事件做
 * 穷尽 switch 的消费者;`SessionBusMessage` 是**总线载荷**,给总线本身和一切
 * 原样转发总线信封的表面。从前只有一个 `SessionEvent` 把命令混在尾部,
 * 代价是每个对事件穷尽的 switch 都被迫处理十几个它永远不该看见的命令分支。
 */
export type SessionBusMessage = SessionEvent | SessionCommand
