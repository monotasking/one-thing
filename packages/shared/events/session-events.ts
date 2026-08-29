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
import { SESSION_EVENT_TYPES } from '@onething/core/events'
import type { SessionLogEventRecord } from '@onething/core/session/events'
import type { SessionEventType } from '@onething/core/events'

// ── Type registry ───────────────────────────────

/**
 * 事件 type 字面量的**单一权威**现在在 core(`packages/core/events/session-event-types.ts`)
 * —— core 禁 import `@shared`,表留在这里就意味着引擎发射点 / 会话状态机 / 权限 / 交互
 * 只能把同一批字符串再手抄一遍,词汇分成两份、find-references 断在中间。表搬过去之后
 * 这里只做再导出:所有 `import { SESSION_EVENT_TYPES } from '@shared/events/session-events'`
 * 一字不改,但它们和 `CoreStreamEngine` 的发射点用的是同一个标识符。
 *
 * (做法与 `session-commands.ts` 从 `@onething/core/events`、`shared/tool-errors.ts` 从
 * `@onething/core/permission` 再导出同一条。)
 *
 * 事件的**载荷形状**仍然留在本文件 —— 它们要引用 `@shared/ipc/*` 的消息 / 权限 / 协作
 * 类型,core 够不着。下面那条双向穷尽断言因此仍是真闸:core 那张表多一条 / 少一条,
 * 这里都编译不过(每个接口的 `type:` 都写成 `typeof SESSION_EVENT_TYPES.X`,拼错就是
 * 一个不存在的属性名)。
 */
export { SESSION_EVENT_TYPES } from '@onething/core/events'
export type { SessionEventType } from '@onething/core/events'

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
  type: typeof SESSION_EVENT_TYPES.STREAM_START
  messageId: string
  assistantMessageId: string  // alias for messageId (backward compat)
  model?: string
}

export interface StreamCompleteEvent {
  type: typeof SESSION_EVENT_TYPES.STREAM_COMPLETE
  data: StreamCompleteData
}

export interface StreamErrorEvent {
  type: typeof SESSION_EVENT_TYPES.STREAM_ERROR
  data: StreamErrorData
}

export interface StreamAbortedEvent {
  type: typeof SESSION_EVENT_TYPES.STREAM_ABORTED
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
  type: typeof SESSION_EVENT_TYPES.STREAM_USAGE
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
  type: typeof SESSION_EVENT_TYPES.TOOL_CALL
  toolCall: ToolCall
}

export interface ToolResultEvent extends MessageScopedEvent {
  type: typeof SESSION_EVENT_TYPES.TOOL_RESULT
  toolCall: ToolCall
}

export interface ToolInputStartEvent extends MessageScopedEvent {
  type: typeof SESSION_EVENT_TYPES.TOOL_INPUT_START
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
  type: typeof SESSION_EVENT_TYPES.TOOL_INPUT_END
  toolCallId: string
  stepId?: string
  toolCall: ToolCall
  /** Authoritative main-process Date.now() captured when args finished streaming. */
  receivedAt: number
  /** 'parse' = mid-stream JSON completion; 'provider-done' = settled by the provider's done event. */
  finalizedBy: 'parse' | 'provider-done'
}

export interface ToolExecutionStartEvent extends MessageScopedEvent {
  type: typeof SESSION_EVENT_TYPES.TOOL_EXECUTION_START
  toolCallId: string
  stepId: string
  toolName: string
  args: JsonObject
  /** Authoritative main-process Date.now() captured when execution began. */
  startTime?: number
}

export interface ToolExecutionUpdateEvent extends MessageScopedEvent {
  type: typeof SESSION_EVENT_TYPES.TOOL_EXECUTION_UPDATE
  toolCallId: string
  stepId: string
  partialResult: ToolPartialResult
}

export interface ToolExecutionEndEvent extends MessageScopedEvent {
  type: typeof SESSION_EVENT_TYPES.TOOL_EXECUTION_END
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
  type: typeof SESSION_EVENT_TYPES.STEP_ADDED
  step: Step
}

export interface StepUpdatedEvent extends MessageScopedEvent {
  type: typeof SESSION_EVENT_TYPES.STEP_UPDATED
  stepId: string
  updates: Partial<Step>
}

// ── Content events ──────────────────────────────

export interface ContentPartEvent {
  type: typeof SESSION_EVENT_TYPES.CONTENT_PART
  part: ContentPart
}

export interface ContentContinuationEvent {
  type: typeof SESSION_EVENT_TYPES.CONTENT_CONTINUATION
  turnIndex?: number
}

// ── Context events ──────────────────────────────

export interface ContextSizeUpdatedEvent {
  type: typeof SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED
  contextSize: number
}

/**
 * P1(2026-08-14):压缩开始的**唯一**正路通知。从前 renderer 只能靠嗅探
 * 「一条内容长得像 context-compact/compacting 的消息」来猜,而专用 IPC 通道
 * 主进程从来没发过。现在手动/自动两条路统一在引擎的 runContextCompact 里发这
 * 一条,手动路径带 requestId。
 */
export interface ContextCompactStartedEvent {
  type: typeof SESSION_EVENT_TYPES.CONTEXT_COMPACT_STARTED
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
  type: typeof SESSION_EVENT_TYPES.CONTEXT_COMPACT_PROGRESS
  chunk: number
  totalChunks: number
}

export interface ContextCompactCompletedEvent {
  type: typeof SESSION_EVENT_TYPES.CONTEXT_COMPACT_COMPLETED
  requestId?: string
  success: boolean
  skipped?: boolean
  summary?: string
  error?: string
}

export interface SessionVariablesUpdatedEvent {
  type: typeof SESSION_EVENT_TYPES.SESSION_VARIABLES_UPDATED
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  variables: ContextVariable[]
}

export interface SessionGoalUpdatedEvent {
  type: typeof SESSION_EVENT_TYPES.SESSION_GOAL_UPDATED
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
  type: typeof SESSION_EVENT_TYPES.STREAM_PARAMS_RESOLVING
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
  type: typeof SESSION_EVENT_TYPES.REQUEST_SNAPSHOT
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
  type: typeof SESSION_EVENT_TYPES.SKILL_ACTIVATED
  skillName: string
}

// ── Permission events ───────────────────────────

export interface PermissionRequestEvent {
  type: typeof SESSION_EVENT_TYPES.PERMISSION_REQUEST
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
  type: typeof SESSION_EVENT_TYPES.PERMISSION_TIMEOUT
  requestId: string
}

/**
 * A tool's permission ask is registered but waiting behind another prompt in
 * the session's serialized permission queue (or coalesced onto an equivalent
 * pending ask). No card should be shown yet — the UI can surface a
 * "waiting for permission" state on the tool call instead of "executing".
 */
export interface PermissionQueuedEvent {
  type: typeof SESSION_EVENT_TYPES.PERMISSION_QUEUED
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
  type: typeof SESSION_EVENT_TYPES.PERMISSION_SETTLED
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
  type: typeof SESSION_EVENT_TYPES.INTERACTION_REQUESTED
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
  type: typeof SESSION_EVENT_TYPES.INTERACTION_SETTLED
  toolCallId?: string
  answer: InteractionAnswer
}

// ── Tool lifecycle (fine-grained) ───────────────

export interface ToolExecutingEvent {
  type: typeof SESSION_EVENT_TYPES.TOOL_EXECUTING
  toolCallId: string
  title: string
}

export interface ToolMetadataEvent {
  type: typeof SESSION_EVENT_TYPES.TOOL_METADATA
  toolCallId: string
  metadata: JsonObject
}

// ── Session events ──────────────────────────────

export interface SessionRenamedEvent {
  type: typeof SESSION_EVENT_TYPES.SESSION_RENAMED
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
  type: typeof SESSION_EVENT_TYPES.SESSION_COLLAB_UPDATED
  /** 会话名(房名)。没有变化时也照发 —— 快照哲学:接收方只认最新那一份。 */
  name?: string
  /** 房间配置的全量快照。房间被降级/删除这种事不走这条通道。 */
  room: NonNullable<ChatSession['room']>
}

// ── 事件账本(B 期,§17.8)─────────────────────────────

/**
 * **账本原词汇下发**:`events.jsonl` 里逐字同一条记录,原样推到渲染层。
 *
 * 为什么骑 `session:event` 这条既有推送面而不是新开通道:桌面 IPCBridge 与 web SSE
 * 都是**观察总线**的,一条总线事件自动两边都有;新开通道意味着 preload / 四壳 /
 * `transport:gate` 数字棘轮一起动,而这条事件没有任何"通道级"的特殊需求。
 *
 * 载荷不是 UI 词汇的投影,而是**事实那一条**(定律一)。打包行(`assistant/chunks`)
 * 原样下发,消费侧过 `decode` 展开 —— 打包是存储编码,不是语义(定律二),所以
 * 这里不需要第二套节流。
 *
 * 消费者(本批唯一一个):渲染层的影子 fold。旧的 `session:event` / `session:stream`
 * 双发**一字不动**,退役是 U2 之后单独一刀。
 */
export interface SessionLedgerEvent {
  type: typeof SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT
  /** 账本记录本体(自带 `seq`,消费侧靠它查缺号)。 */
  record: SessionLogEventRecord
}

/**
 * 这条会话被删了(E 批)。级联删子会话时**每个 id 各发一条**,各发在自己的
 * `sessionId` 上 —— 通配订阅的归属判据是逐条问的,合成一条会让子会话失去自己的
 * 那次判定。
 *
 * **它与 `global-events.ts` 的 `SessionDeletedEvent` 说的是同一件事,但不是同一
 * 条车道**:那一只在全局总线上(`emitGlobal` / `onGlobal`),只有进程内的插件
 * 订阅得到,既不进 IPCBridge 也不进 SSE。两张词汇表的**值必须不相交**(理由见
 * `SESSION_EVENT_TYPES.SESSION_REMOVED` 的注释),所以这一条叫 `removed`。
 */
export interface SessionRemovedEvent {
  type: typeof SESSION_EVENT_TYPES.SESSION_REMOVED
  /** 冗余一份,便于消费侧不看信封也能用。与 envelope.sessionId 恒等。 */
  sessionId: string
  /** 这次删除动作里一起没掉的全部会话(含自己)。 */
  cascadedSessionIds: readonly string[]
}

// ── Steering events ─────────────────────────────

/** A steering message was persisted and queued; retractable until consumed. */
export interface SteeringQueuedEvent {
  type: typeof SESSION_EVENT_TYPES.STEERING_QUEUED
  messageId: string
}

/** Queued steering messages were drained into the next model turn. */
export interface SteeringConsumedEvent {
  type: typeof SESSION_EVENT_TYPES.STEERING_CONSUMED
  messageIds: string[]
}

/** A pending steering message was retracted before being consumed. */
export interface SteeringRetractedEvent {
  type: typeof SESSION_EVENT_TYPES.STEERING_RETRACTED
  messageId: string
}

/**
 * 草稿纸的某一版真的进了模型(beforeTurn 瞬态尾块)。
 *
 * 界面的"已读水位线"只认这条事件 —— 它是引擎回推的事实,不是渲染层的猜测。
 * `version` 就是纸的文件 mtime,与渲染层握着的版本号是同一个数。
 */
export interface ScratchpadConsumedEvent {
  type: typeof SESSION_EVENT_TYPES.SCRATCHPAD_CONSUMED
  version: number
  turn: number
}

// ── Message events ──────────────────────────────

export interface MessageUserCreatedEvent {
  type: typeof SESSION_EVENT_TYPES.MESSAGE_USER_CREATED
  message: ChatMessage
}

export interface MessageCreatedEvent {
  type: typeof SESSION_EVENT_TYPES.MESSAGE_CREATED
  message: ChatMessage
}

export interface MessageAssistantCreatedEvent {
  type: typeof SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED
  message: ChatMessage
}

export interface MessageUpdatedEvent {
  type: typeof SESSION_EVENT_TYPES.MESSAGE_UPDATED
  messageId: string
  updates: Partial<ChatMessage>
}

export interface MessageDeletedEvent {
  type: typeof SESSION_EVENT_TYPES.MESSAGE_DELETED
  messageId: string
}

export interface MessagesReplacedEvent {
  type: typeof SESSION_EVENT_TYPES.MESSAGES_REPLACED
  messages: ChatMessage[]
}

// ── Collab (multi-agent room) ───────────────────

/** The room's board changed; carries the full (small) snapshot. */
export interface CollabBoardChangedEvent {
  type: typeof SESSION_EVENT_TYPES.COLLAB_BOARD_CHANGED
  board: CollabBoard
}

/** A member is about to speak (queued/driving) or has stopped (settled).
 *  IM semantics: true may end with no message at all — "typed and deleted". */
export interface CollabTypingEvent {
  type: typeof SESSION_EVENT_TYPES.COLLAB_TYPING
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
  type: typeof SESSION_EVENT_TYPES.COLLAB_TURN_ACTIVE
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
  type: typeof SESSION_EVENT_TYPES.COLLAB_COORDINATOR_CHANGED
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
  type: typeof SESSION_EVENT_TYPES.COLLAB_AGENT_CHANGED
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
  | SessionLedgerEvent
  | SessionRemovedEvent
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
