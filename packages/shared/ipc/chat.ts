/**
 * Chat Module
 * Chat and message-related type definitions for IPC communication
 */

import type {
  PermissionMode,
  ToolCall,
  ToolExecutionMode,
  ToolParameter,
  ToolPartialResult,
  ToolRenderKind,
} from './tools.js'
import type { PromptReferenceSnapshot } from './prompts.js'
import type { SkillConditions, SkillReferenceSnapshot, SkillSource } from './skills.js'
import type { VoiceTranscriptMetadata } from './voice.js'
import type { MessageOrigin } from './channel-identity.js'
import type { SessionGoal } from './goal.js'
import { defineRouter } from './router.js'

/**
 * @deprecated Kept as a type alias for one version so old persisted
 * session data with a `level` field still parses. New code does not
 * read or write this field.
 */
export type VariableLevel = 'system' | 'session'

export type VariableScope = 'global' | 'session' | 'agent' | 'project'

/** Value type of a custom variable; `value` holds the canonical string form. */
export type VariableType = 'string' | 'number' | 'bool' | 'list' | 'map' | 'set'

export interface ContextVariable {
  name: string
  value: string
  values?: string[]
  type?: VariableType
  scope?: VariableScope
  description?: string
  readonly?: boolean
  // true: the model needs to know this at all times — delivered in full in
  // every <context-update> block. Otherwise it never enters the request and is
  // read through the `variable` tool.
  state?: boolean
  updatedAt?: number
}

// Content part types for sequential display
export type ContentPart =
  | { type: 'text'; content: string; turnIndex?: number }
  | ({ type: 'prompt-ref'; turnIndex?: number } & PromptReferenceSnapshot)
  | ({ type: 'skill-ref'; turnIndex?: number } & SkillReferenceSnapshot)
  | { type: 'reasoning'; content: string; turnIndex?: number }
  | { type: 'tool-call'; toolCalls: ToolCall[] }
  | { type: 'waiting'; turnIndex?: number }      // Waiting for AI continuation after tool call
  | { type: 'image-loading'; turnIndex?: number; label?: string } // Image generation skeleton
  | { type: 'data-steps'; turnIndex: number }    // Placeholder for steps panel (rendered inline)
  | { type: 'provider-data'; provider: string; encryptedReasoning?: string; turnIndex?: number } // Hidden provider context
  /**
   * 插件流状态(R6)。**一个泛化成员,不是每插件一个类型。**
   *
   * 按插件加类型的话,每来一个插件就要改一次本文件 —— 那正是 soul-memory 让宿主
   * 改了 16,989 行的那种形状。R6 的验收口径:此后新增插件状态**零改动本文件**
   * (本期加这一个成员本身是对它的一次性修改)。
   *
   * 寻址是 `(pluginId, id)` 的格子,不是追加:同一个 id 再来一次是改 label。
   * `cleared` 表示撤下 —— ContentPart 数组没有"删除某一项"的事件,而状态天然
   * 需要撤下;让同一个成员携带这一位,好过为 R6 新开一条投递轨。
   *
   * ## 计时(2026-08-11,SDK 外部会话的后台任务可见性)
   *
   * `startedAt` 是起始**墙钟**,不是耗时:渲染侧拿它自算 `now - startedAt`,
   * 所以一条状态在屏幕上走秒,过线的事件却只有起、变、落三条。反过来做
   * (宿主每秒发一次带 elapsed 的事件)会按秒冲 EventBus 的环形缓冲,而那个
   * 缓冲正是 SSE 断线重连的 `?after=` 重放依据 —— 与 R6 压 label 抖动同一条理由。
   *
   * `durationMs` present ⇒ **这条状态已经结算**:渲染侧停止走秒并定格这个总数。
   * 两个字段合起来是一个三态,不需要第三个布尔:无 startedAt = 不计时的老式状态,
   * 有 startedAt 无 durationMs = 在跑,有 durationMs = 已收场。
   */
  | {
      type: 'plugin-status'
      pluginId: string
      id: string
      label: string
      cleared?: boolean
      turnIndex?: number
      startedAt?: number
      durationMs?: number
    }

/**
 * **占位型** transient:真内容一到就让位。
 *
 * 它们表达的是"还没有内容",所以内容到达即失效 —— 归约器每次追加正文前会把
 * 末尾的这类 part 弹掉。
 */
export function isPlaceholderTransientPart(part: ContentPart): boolean {
  return part.type === 'waiting' || part.type === 'image-loading'
}

/**
 * **流内型** transient:活到流结束,不被正文顶掉。
 *
 * plugin-status 属于这一类。把它混进占位型是个真 bug:模型吐出第一个 token
 * 状态就消失,而插件还在干活;插件下一次 show 同 id 又把它推回来,于是它按
 * delta 的频率闪烁。更糟的是弹掉之后宿主账本仍持有记录,后续 clear 在渲染侧
 * 成了 no-op。
 *
 * **已结算的那条不算 transient**(`durationMs` 已定格)。它说的不再是"某人正在
 * 忙",而是"这件事跑了多久" —— 一个和工具卡上那个冻结时长同类的既成事实。
 * 把它一起扫掉的话,"完成后定格总耗时"在屏幕上只存在到回合收尾那一瞬,用户
 * 恰恰是在回合结束之后才回头问"它到底跑了多久"。插件走不到这一支:`api.status`
 * 只收 `{id, label}`,`durationMs` 没有插件侧的入口。
 */
export function isStreamScopedTransientPart(part: ContentPart): boolean {
  return part.type === 'plugin-status' && part.durationMs === undefined
}

/**
 * 流结束时要一并清掉的全部 transient。
 *
 * 注意这只是**呈现侧**的兜底 —— 真正的生命周期保证在宿主(core 的
 * CorePluginStatusRegistry 在终止事件**之前**强制清扫并投递撤下事件),
 * 否则 web 端与桌面端会对"还挂着什么"给出不同答案。
 */
export function isTransientPart(part: ContentPart): boolean {
  return isPlaceholderTransientPart(part) || isStreamScopedTransientPart(part)
}

// Step types for showing AI reasoning process
export type StepType = 'skill-read' | 'tool-call' | 'thinking' | 'file-read' | 'file-write' | 'command'

export interface Step {
  id: string
  type: StepType
  title: string                    // Short title (e.g., "查看agent-plan技能文档")
  description?: string             // Longer description shown when expanded
  status: 'pending' | 'running' | 'completed' | 'failed' | 'awaiting-confirmation' | 'cancelled'
  timestamp: number
  turnIndex?: number               // Which turn this step belongs to (for interleaving with text)
  toolCallId?: string              // Link to associated tool call if any
  // Tool call details for inline display
  toolCall?: ToolCall              // Full tool call object for displaying details
  thinking?: string                // AI's reasoning before this step (why it's doing this)
  result?: string                  // Tool execution result
  partialResult?: ToolPartialResult // Structured partial tool result while execution is running
  partialResultIsPartial?: boolean // True when partialResult is a live/incomplete result
  summary?: string                 // AI's analysis after getting the result
  error?: string                   // Error message if failed
  rejected?: boolean               // True when the user rejected permission for this step
  rejectionReason?: string         // Optional user-provided rejection reason
  // Token usage for this turn (shared by all steps in the same turn)
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
}

// Message attachment types for file/image uploads
export type AttachmentMediaType = 'image' | 'document' | 'audio' | 'video' | 'file'

export interface MessageAttachment {
  id: string
  fileName: string
  // Absolute on-disk path of a real file holding these bytes. Dropped/picked
  // files carry the user's own path from the start; pasted files have none
  // until the engine ingests them, where the media library's stored copy is
  // backfilled (MediaLibraryService.ingestMessageAttachments). Either way the
  // model is told the path (buildMessageContent) so read/bash can reach it.
  filePath?: string
  mimeType: string           // e.g., 'image/jpeg', 'application/pdf'
  size: number               // File size in bytes
  mediaType: AttachmentMediaType
  base64Data?: string        // Base64 encoded file data (for sending to AI)
  url?: string               // Local file URL (for display, optional)
  width?: number             // Image width (for images)
  height?: number            // Image height (for images)
  mediaAssetId?: string      // Linked Media Library asset, when indexed
  // Web-element attachments (picked from the embedded browser): the screenshot
  // rides in base64Data/image; these carry its provenance + text so a non-vision
  // model still receives the excerpt. See docs/design/browser-v2.md §P2.
  sourceUrl?: string         // Source page URL the element was picked from
  sourceTitle?: string       // Source page title
  excerpt?: string           // Text excerpt of the picked element (≤2k chars)
}

// ============================================================================
// Collab (multi-agent room) Types — docs/design/multi-agent-collab.md
// ============================================================================

/**
 * Session kind. Absent = 'chat' (ordinary session, zero-regression path).
 * 'room' = multi-agent group chat (streams only started by the RoomCoordinator);
 * 'work' = an agent's task-execution session, child of a room.
 */
/**
 * 'agent' = an agent's own execution session (W18, multi-agent-collab-im §4.6):
 * one durable hidden session per agent where its room turns run — drives,
 * thinking and tool calls live there, and only `say` reaches a room.
 */
export type SessionKind = 'chat' | 'room' | 'work' | 'agent'

/**
 * 派工(`task` 工具)开出来的后台工作会话戳
 * (`docs/audit/self-hosting-gap-audit-2026-08-11.md` P0-3)。
 *
 * **刻意不是一个新的 `SessionKind`**:一条派工会话在产品上就是一条普通会话 ——
 * 它出现在会话列表里、人点得进去、能接管、提示词与工具面与普通对话同一份。
 * 给它一个新 kind 会让 collab 的场子门、房面工具、渲染分支全部要多认一格,
 * 而那些分支答的都不是「谁派它来的」这个问题。这里只回答那一个问题。
 *
 * 两个消费者:完成回流投给谁(`parentSessionId`),以及这条会话的回合看不看得见
 * `task` 工具(带戳 = 看不见,禁止套娃)。
 */
export interface TaskSessionRef {
  /** 派工的那条会话。 */
  parentSessionId: string
  createdAt: number
  /** 建卡时给的短标签(会话列表与回投抬头共用)。 */
  description?: string
}

/** Room configuration, present only on kind='room' sessions. */
export interface RoomConfig {
  memberAgentIds: string[]
  /**
   * 曾经在场、后来被移出的成员(docs/design/collab-history-search.md §3)。
   *
   * 历史检索的授权判据用它回答「我能看到这间房到什么时候」:当前成员看得到全部,
   * 被移出的只看得到 `removedAt` 之前的。**只追加不删除**;同一个 agentId 可能有
   * 多条(移出→拉回→再移出),读时取最后一次。
   *
   * 为什么不去解析转录里那条 `collab-membership` 系统行:那行只有名字没有 id
   * (`buildCollabMemberRemovedLine`),而按名字反查是被禁止的 —— W14a 把 @ 全部
   * id 化正是因为名字会改,改完旧行里那个名字就对不上了。
   */
  formerMembers?: Array<{ agentId: string; removedAt: number }>
  /** 负责人: review/disposition activation target, and a "你是本群的负责人"
   *  fact in the willingness judgement. Optional — NOT a default responder
   *  (that mechanism was removed in the IM rework, W1). */
  pmAgentId?: string
  budgets?: {
    maxChain?: number
    maxConcurrentWork?: number
    dailyCostUSD?: number
    /** 回合断路器上限 (W22); 0 = 关闭该闸。 */
    maxTurnToolCalls?: number
    maxTurnSayCalls?: number
    /** 同时最多几个人说话(房间回合并行化)。缺省 = 内置默认;0 = 不限。 */
    maxConcurrentTurns?: number
  }
  /**
   * 每位同事看这间房时的**视野**配置(collab/history-window.ts)。
   *
   * 与 budgets 分开:那一格是花钱的闸(超了就拒),这一格是"给模型看多少",
   * 两者撞不到一起,而混在一个对象里迟早有人把「省钱」和「省上下文」当成同一件事。
   * 全部缺省 = 内置默认;各项 0 的含义见 history-window.ts 的常量注释。
   */
  context?: {
    /** 历史保留几天(含今天)。0 = 不折叠,全量。 */
    historyDays?: number
    /** 折叠线之前额外保留的条数(日界悬崖补丁)。 */
    historyTailCount?: number
    /** 尾部未读逐字上限;超出的退回历史并记 elided。 */
    unreadMax?: number
    /**
     * 折叠段的每日摘要(collab-agent-view.md P2)。缺省开启。
     *
     * 这是一条**后台模型调用** —— 一间房一天一次,在回合收尾之后发出。所有后台
     * 触发都要能关掉,这就是那个开关;关掉之后 `<Folded>` 行仍在,只是不再说
     * 被折掉的那些天里发生了什么。
     */
    dailyDigest?: boolean
  }
  /**
   * 响应模式(docs/design/collab-speaking-order.md)。缺省 = 'parallel'(现状零回归)。
   *
   * 'serial' = **接力**:不买意愿判定,棒子沿 `speakOrder` 的环依次传,轮到谁谁说。
   * 私聊房不适用(那里本来就是依次)。
   */
  responseMode?: 'auto' | 'parallel' | 'serial'
  /**
   * 接力次序(agent id)。只在 `responseMode === 'serial'` 时读。
   *
   * 不是准入名单:没列进来的成员按名册序接在末尾,列表里已离房/退休的 id 读时
   * 忽略。空/未配 = 直接用名册序,所以顺序模式开箱可用。
   */
  speakOrder?: string[]
  /**
   * 一趟接力最多跑几圈(1 圈 = 环长次发言机会)。缺省 **0 = 不限**,靠"走满一圈
   * 没人开口"与链长闸收尾。
   *
   * 内部按**棒数**计(上限 = relayLoops × 环长):@ 抢棒会让环绕回,按"圈"数
   * 边界会失准。
   */
  relayLoops?: number
  /** Room-wide pause switch: freezes all activations. */
  frozen?: boolean
  /**
   * 私聊标记(docs/design/agent-im-dm.md D1/D3)。人数即形态,标记只说"这间房是
   * 私聊而不是群":
   *  - **单成员** = 用户 ↔ agent 的托管式私聊(id 约定 `userDmRoomId(agentId)`)。
   *    用户说话免意愿判定直接激活唯一那位成员(D6),常驻会话工具面走 union(D7)。
   *  - **双成员** = agent ↔ agent 私聊(D3,IM P3 才实现;本期只落单成员语义)。
   *
   * 可选且只写 `true`:旧房没有这个字段,读作"普通群聊",零迁移。
   */
  dm?: true
}

/**
 * Link from a collab session back to the room it serves.
 *
 * kind='work': room + the task being executed (both always present).
 * kind='agent' (W18): only the room, and it is the room whose drive the
 * execution session is currently answering — a `say` with no explicit `room`
 * lands there. `taskId` is therefore optional: an execution session serves the
 * room's chat, not one card.
 */
export interface CollabWorkRef {
  roomSessionId: string
  taskId?: string
  /**
   * 卡标题的**快照**(kind='work',架构收敛 C3-5)。
   *
   * 存在的理由是压缩:工作会话的任务框架此前只寄在 briefing 那一条 user 消息里,
   * 而那条消息会随历史一起被摘要化 —— 干到第三个小时的 agent 于是不再知道自己
   * 在做哪张卡。写进 meta 之后它进 system prompt,每一轮整份重发,压不掉。
   *
   * 是快照不是指针:板上改标题不会追改这里,但 `spawnWork` 每次开工/续做都会重
   * 盖一遍,所以它最旧也只旧到"这一段执行开始的那一刻"。真要现值,`board` list
   * 就在手边(通用规则里那条「卡状态现查」说的正是这件事)。
   */
  taskTitle?: string
  /**
   * 已读游标(kind='agent'):这位同事在这间房**读到哪一条**房间消息为止。
   *
   * 语义严格是「它的某个回合把这条投影给了模型」,不是「它在这条之后说过话」——
   * 后者会漏:一条回合启动**之后**才到达的 @,作者根本没看见,却会因为它随后
   * 开口而被判成已答复。
   *
   * 写入时机同样是这条语义的一部分:回合**跑完(harvest)**才落盘,值取投影
   * 构建那一刻的房间末条。中途 abort/超时的回合不推进 —— 它可能一个字都没读到,
   * 而虚假前进的游标会把那批消息永久变成"已读",这是本机制唯一的不可逆伤害。
   */
  seenMessageId?: string
  /** 游标落盘时刻,诊断与 UI 用;判定一律以 `seenMessageId` 为准。 */
  seenAt?: number
  /**
   * 待回流的**收养回声**(kind='agent',架构审查 A6):上一回合写下却没发送的
   * 收尾正文,已由框架代发进群,这是那条消息的 id。
   *
   * 存在的理由是一条视野盲区:被收养的消息署作者本人的名,而"自己的消息永不
   * 进未读"(collab/history-window.ts)+「增量 drive 只带未读」= 作者永远读不到
   * 它,于是它以为那段话还压在手里。下一次 drive 组装时读走这个字段、渲染一行
   * 事实回声,然后**清掉** —— 说一次就够,回声本身落进 drive 消息成为历史。
   */
  adoptedEchoMessageId?: string
  /** 代发那一刻(回声里的时间)。与 `adoptedEchoMessageId` 同生共死。 */
  adoptedEchoAt?: number
}

/**
 * Quote-reply snapshot (docs/design/multi-agent-collab-im.md §3.5 A).
 *
 * Deliberately a SNAPSHOT, not a pointer: `authorLabel` is the signature at
 * quote time and `excerpt` is the quoted text at quote time, so the block stays
 * whole after the original is edited or dropped from a paged window.
 * `messageId` is only ever used to scroll back — if it is gone, nothing jumps.
 */
export interface ChatMessageReplyTo {
  messageId: string
  authorLabel: string
  /** ≤120 chars, whitespace collapsed to one line. */
  excerpt: string
}

/**
 * One resolved @mention (docs/design/multi-agent-collab-im.md §4.5 身份 id 化).
 *
 * `agentId` is the identity — generated when the agent is created and stable
 * across renames, so activation is exact even when two members share a name.
 * `label` is the display name AT MENTION TIME: a snapshot kept only so the
 * words still read sensibly after the agent is deleted; while the agent lives,
 * every surface repaints `@label` from the current roster.
 */
export interface ChatMessageMention {
  agentId: string
  label: string
  /**
   * 缺省 `'agent'` —— 每一条老转录都是,所以这个键不写。
   *
   * `'user'` = 这一处点的是**用户本人**(docs/design/collab-handle-codec.md §2.3)。
   * TA 没有 agent id,那一条的 `agentId` 因此是**空串**:这是诚实的(合成一个
   * 假 id 迟早会被谁当真拿去 `findAgent`),也是安全的 —— 消费方本来就有空值门
   * (`if (!agentId) continue`),于是它天然不进激活、不进成员校验。
   *
   * 它存在的理由:渲染层此前认「@我」只能按名字比对两个常量,而名字匹配正是
   * W14a 为 agent 废弃掉的东西(改名即失效)。用户不该退回那条老路。
   */
  kind?: 'agent' | 'user'
  /**
   * 用户的句柄(仅 `kind:'user'`)。**不塞进 `agentId`** —— 那个字段的语义是
   * agent 花名册 id,混进一个不是 agent 的值,迟早有人拿它去 `findAgent`。
   *
   * 为什么不能省:「用户只有一个,kind 就够指认」是拿**当下只有一个人**当永久
   * 前提。网关(微信/飞书等渠道)进来的是**多个真人**,那一刻「是用户」不再是
   * 一个身份,而句柄是。
   */
  userHandle?: string
}

/**
 * Who put an emoji on a message (docs/design/multi-agent-collab-im.md §3.5 B).
 * The human is a single identity (`{type:'user'}`); an agent is identified by
 * its roster id, so the display name can be re-read after a rename.
 */
export interface ChatMessageReactionActor {
  type: 'user' | 'agent'
  agentId?: string
}

/**
 * One emoji and everyone who put it there — reactions are stored aggregated,
 * so the projection's `(👍×2)` and the chip's count read the same array.
 * Metadata only: a reaction never triggers a willingness round.
 */
export interface ChatMessageReaction {
  emoji: string
  by: ChatMessageReactionActor[]
}

// Type definitions for IPC messages
export interface ChatMessage {
  id: string
  seq?: number  // 1-based sequence in the session timeline when loaded via paged history
  sessionId?: string  // Session ID this message belongs to (for context isolation)
  role: 'user' | 'assistant' | 'error' | 'system'  // 'error' and 'system' are display-only, not saved to backend
  content: string
  timestamp: number
  isStreaming?: boolean
  isThinking?: boolean
  errorDetails?: string  // Additional error details for error messages
  reasoning?: string  // Thinking/reasoning process for reasoning models (e.g., deepseek-reasoner)
  toolCalls?: ToolCall[]  // Tool calls made by the assistant
  contentParts?: ContentPart[]  // Sequential content parts for inline tool call display
  model?: string  // AI model used for assistant messages
  provider?: string  // AI provider used for assistant messages
  thinkingTime?: number  // Final thinking time in seconds (persisted for display after session switch)
  thinkingStartTime?: number  // Timestamp when thinking started (for calculating elapsed time on session switch)
  skillUsed?: string  // Name of the skill used by the assistant (e.g., "agent-plan")
  steps?: Step[]  // Steps showing AI reasoning process
  attachments?: MessageAttachment[]  // File/image attachments
  source?: 'text' | 'voice' | 'api' | string
  /**
   * Assistant persona attribution in collab (room/work) sessions: the agent that
   * spoke this message. Stamped at the app-layer store choke point from the
   * session's agentId at creation time; absent on ordinary chat sessions.
   */
  agentId?: string
  /**
   * 产生这条消息的那一次**执行**(S1a,`docs/design/session-event-sourcing-2026-08.md`
   * §10.2)。引擎入口 `randomUUID()` 一次,贯穿 agent-loop、recorder、权限与压缩;
   * 事件账本里的 `run/start` / `run/end` 用的是同一个 id。
   *
   * 影子期靠它按 run 切片比对(投影出的那一条 vs 消息里的那一条)。
   */
  runId?: string
  /** True for steering messages injected mid-stream (persisted marker for UI) */
  steered?: boolean
  /** IM quote reply: what this message is answering (snapshot, see the type). */
  replyTo?: ChatMessageReplyTo
  /**
   * Identity-resolved @mentions (W14a, rooms only). Absent on every message
   * written before W14a — consumers fall back to name-text parsing, which is
   * exactly what makes old transcripts keep working.
   */
  mentions?: ChatMessageMention[]
  /**
   * W23 restart idempotence: on a coordinator DRIVE (source 'collab'), the room
   * message that caused the activation. The execution-session transcript is
   * durable and uncapped, so a persisted drive IS the idempotence ledger — boot
   * reconciliation can tell "already consumed" from "never driven" without the
   * state file. Absent on every pre-W23 drive (those replay once and self-heal)
   * and on every non-drive message; the renderer never reads it.
   */
  collabSourceMessageId?: string
  /**
   * 这条房间消息是**外部注入**,落库即把该房的链长计数清零(架构审查 A2)。
   *
   * 跨房私聊注入(`send_message` 带 `to`)与 wake poke 打这个标:它们的由头来自
   * 另一间房的一个回合,对这间房而言是新的外部输入 —— 与人类插话同语义。live
   * 侧本来就就地清零,这个标记是它**可重放**的那一半:boot 重算(collab/chain.ts)
   * 认它作清零边界,否则没有人类在场的 agent ⇄ agent 房重启后必然顶格冻死。
   * 缺席 = 普通消息(旧转录零迁移)。
   */
  collabChainReset?: boolean
  /** IM emoji reactions on this message (rooms only, see the type). */
  reactions?: ChatMessageReaction[]
  voice?: VoiceTranscriptMetadata
  origin?: MessageOrigin
  // Legacy whole-block turn context (pre-2026-08-18 sessions): the variable
  // board captured at send time. Still read and replayed verbatim — the bytes
  // of an old session must not move — but nothing writes it any more.
  contextUpdate?: string
  /**
   * Turn context delivered with this user message (prompt-channels 2026-08-18):
   * the named sections it (re)sent and the ones it retired. Written once per
   * turn at request-build time and replayed verbatim on every history rebuild,
   * so repeated calls inside one turn produce identical request bytes.
   * Not displayed as message content.
   */
  turnContext?: {
    set?: Record<string, string>
    removed?: string[]
  }
  // Token usage for this message (for assistant messages)
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
}

// ============================================================================
// Session Metadata Types (for optimized loading)
// ============================================================================

/**
 * Lightweight session metadata for list display
 * Does not include messages array for fast loading
 */
export interface SessionMeta {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  agentId?: string
  kind?: SessionKind
  room?: RoomConfig
  collab?: CollabWorkRef
  /** 派工开出来的后台工作会话;缺席 = 不是派工来的。 */
  task?: TaskSessionRef
  parentSessionId?: string
  branchFromMessageId?: string
  lastModel?: string
  lastProvider?: string
  /**
   * The user picked lastProvider/lastModel by hand. Without this flag those two
   * are indistinguishable from the auto-stamp every assistant message performs,
   * so an agent's model binding could not tell "the user chose otherwise" from
   * "the last turn happened to run on that model".
   */
  modelPinned?: boolean
  permissionMode?: PermissionMode
  isPinned?: boolean
  isArchived?: boolean
  archivedAt?: number
  originIdentityKey?: string
  memoryProfileId?: string
  lastConnector?: string
  lastSentAt?: number
  // Additional metadata for display (computed on save)
  messageCount?: number      // Number of messages in session
  previewText?: string       // First user message preview (truncated)
  // Active project directory, surfaced into the list so the sidebar can group
  // by project. Persisted per-session (meta.json); the fast index backfills it.
  workingDirectory?: string
  /**
   * 归属的 space(workspace)。**缺席 = default space** —— 旧会话零迁移,
   * 所有读取端自己缺省(`docs/design/workspace-spaces-2026-08.md` 批 B)。
   */
  workspaceId?: string
}

/**
 * Session details without messages array
 * Used for session activation (before loading messages)
 */
export interface SessionDetails extends SessionMeta {
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  variables?: ContextVariable[]
  goal?: SessionGoal
  goals?: SessionGoal[]
  summary?: string
  summaryUpToMessageId?: string
  summaryCreatedAt?: number
  promptContext?: PromptContextState | null
  totalInputTokens?: number
  totalOutputTokens?: number
  totalTokens?: number
  maxTokens?: number
  lastInputTokens?: number
  contextSize?: number
  originIdentityKey?: string
  memoryProfileId?: string
  lastConnector?: string
  lastSentAt?: number
}

// ============================================================================
// Full Session Type (with messages)
// ============================================================================

export interface ChatSession {
  id: string
  name: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  agentId?: string
  kind?: SessionKind
  room?: RoomConfig
  collab?: CollabWorkRef
  /** 派工开出来的后台工作会话;缺席 = 不是派工来的。 */
  task?: TaskSessionRef
  parentSessionId?: string
  branchFromMessageId?: string
  lastModel?: string
  lastProvider?: string
  /**
   * The user picked lastProvider/lastModel by hand. Without this flag those two
   * are indistinguishable from the auto-stamp every assistant message performs,
   * so an agent's model binding could not tell "the user chose otherwise" from
   * "the last turn happened to run on that model".
   */
  modelPinned?: boolean
  permissionMode?: PermissionMode
  isPinned?: boolean
  isArchived?: boolean  // Archived (soft-deleted) session
  archivedAt?: number   // Timestamp when session was archived
  // Sandbox boundary - tools restrict file access to this directory
  workingDirectory?: string  // Active project directory for this session
  workingDirectoryRoots?: string[] // Additional sandbox roots for this session
  /** 归属的 space;缺席 = default space(读取端缺省,零迁移)。 */
  workspaceId?: string
  variables?: ContextVariable[] // Session-scoped context variables
  goal?: SessionGoal // Current goal; mirrors goals' newest unfinished record
  goals?: SessionGoal[] // Goal history, oldest first (docs/design/goal-system-v3.md)
  // Context compacting fields
  summary?: string              // Conversation summary for context window management
  summaryUpToMessageId?: string // ID of the last message included in the summary
  summaryCreatedAt?: number     // Timestamp when summary was created
  promptContext?: PromptContextState | null // Internal model-visible prompt context baseline/transcript
  // Token usage tracking
  totalInputTokens?: number     // Accumulated input tokens for this session
  totalOutputTokens?: number    // Accumulated output tokens for this session
  totalTokens?: number          // Accumulated total tokens for this session
  maxTokens?: number            // Session context/token budget limit
  lastInputTokens?: number      // Last request's input tokens
  contextSize?: number          // Current context window size (last turn's input tokens)
  originIdentityKey?: string    // Stable identity-session routing key for channel/API sessions
  memoryProfileId?: string      // User/profile whose memory workspace should be used
  lastConnector?: string        // Last IM/API connector that routed into this session
  lastSentAt?: number           // Last inbound user message timestamp for profile/channel auditing
}

// ============================================================================
// Prompt Context Types
// ============================================================================

export type PromptContextRole = 'developer' | 'user'

export interface BaseInstructions {
  source: string
  content: string
  hash: string
}

export interface PromptContextMarker {
  name: string
  start: string
  end: string
}

export interface PromptContextFragment {
  role: PromptContextRole
  source: string
  marker: PromptContextMarker
  content: string
  rendered: string
  hash: string
  reason?: 'initial' | 'changed' | 'removed'
}

export interface TurnContextSnapshot {
  createdAt: number
  agentId?: string
  hasTools: boolean
  osType: 'macos' | 'windows' | 'linux'
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  contextVariablesHash?: string
  activeProjectHash?: string
  knownProjectsHash?: string
  skillsHash?: string
  toolNamesHash?: string
  mcpToolNamesHash?: string
  agentsMdHash?: string
  fragmentHashes: Record<string, string>
}

export interface PromptContextState {
  version: 1
  baseInstructions?: BaseInstructions
  referenceSnapshot?: TurnContextSnapshot
  items: PromptContextFragment[]
  updatedAt: number
}

// IPC Request/Response types
export interface SendMessageRequest {
  sessionId: string
  message: string
  attachments?: MessageAttachment[]  // File/image attachments
}

export interface SendMessageResponse {
  success: boolean
  userMessage?: ChatMessage
  assistantMessage?: ChatMessage
  sessionName?: string  // Updated session name if auto-renamed
  error?: string
  errorDetails?: string
}

export interface EditAndResendRequest {
  sessionId: string
  messageId: string
  newContent: string
}

export interface EditAndResendResponse {
  success: boolean
  assistantMessage?: ChatMessage
  error?: string
  errorDetails?: string
}

export interface GetChatHistoryRequest {
  sessionId: string
}

export interface GetChatHistoryResponse {
  success: boolean
  messages?: ChatMessage[]
  error?: string
}

export interface GetSessionsResponse {
  success: boolean
  sessions?: ChatSession[]
  error?: string
}

export interface CreateSessionRequest {
  name: string
  /** Session kind; absent = ordinary chat. 'room' requires `room` config. */
  kind?: SessionKind
  /** Room configuration when kind='room'. */
  room?: RoomConfig
}

/**
 * `sessionsApi.create({ name, ...options })` 的可选项 —— **唯一一份**
 * (P4c 第五批之前它是 `platformApi.createSession(name, options)` 的第二个参数)。
 *
 * 2026-08-05 (U5) 收敛:此前它在三处各手抄一遍(`renderer/types/index.ts`、
 * `preload/bridge.ts`、`platform/web.ts`),而且已经抄岔了 —— 只有 renderer 那份
 * 带 `room.dm`,另两处漏了。三份手抄的类型迟早会再岔一次,所以只留这一份。
 */
export interface CreateSessionOptions {
  /** 调用方指定 id(建房走派生 id:一个人只有一间私聊房)。 */
  sessionId?: string
  /**
   * 新会话落在哪个 space。缺省 = default —— 后端不认识「当前空间」
   * (那是 window 级状态,住在渲染层),所以每次创建都得显式带上。
   */
  workspaceId?: string
  /** 桌面端只放行 'room';服务端对任何 kind 一律拒绝(它不跑协调器)。 */
  kind?: Extract<SessionKind, "room">
  room?: {
    memberAgentIds: string[]
    pmAgentId?: string
    budgets?: { dailyCostUSD?: number; maxChain?: number }
    /** 私聊标记(agent-im-dm.md D1/D3);人数即形态。 */
    dm?: true
  }
}

export interface CreateSessionResponse {
  success: boolean
  session?: ChatSession
  error?: string
}

export interface SwitchSessionRequest {
  sessionId: string
}

export interface SwitchSessionResponse {
  success: boolean
  session?: ChatSession
  error?: string
}

export interface DeleteSessionRequest {
  sessionId: string
}

export interface DeleteSessionResponse {
  success: boolean
  error?: string
  parentSessionId?: string  // Parent session ID if deleted session was a branch
  deletedCount?: number     // Total count of deleted sessions (including cascaded children)
}

export interface RenameSessionRequest {
  sessionId: string
  newName: string
}

export interface RenameSessionResponse {
  success: boolean
  error?: string
}

export interface CreateBranchRequest {
  parentSessionId: string
  branchFromMessageId: string
}

export interface CreateBranchResponse {
  success: boolean
  session?: ChatSession
  error?: string
}

export interface UpdateSessionPinRequest {
  sessionId: string
  isPinned: boolean
}

export interface UpdateSessionPinResponse {
  success: boolean
  error?: string
}

export interface GenerateTitleRequest {
  message: string
}

export interface GenerateTitleResponse {
  success: boolean
  title?: string
  error?: string
}

export interface SystemPromptToolSnapshot {
  id: string
  name: string
  description?: string
  category?: string
  modelFacingName?: string
  source?: 'builtin' | 'plugin' | 'mcp' | 'codex-native'
  serverId?: string
  serverName?: string
  enabled?: boolean
  autoExecute?: boolean
  /**
   * @deprecated R4b —— 概念已退役。权限只认 `Intent.effects`(见
   * `packages/core/toolkit/effects.ts` 的策略表);这个字段活着只是因为契约与
   * 渲染层还在读它,它的值由 `app/toolkit/guard-projection.ts` 从 `spec.effects`
   * **派生**。没有任何工具作者再写它,也没有任何判定读它做决定。
   */
  permissionGuard?: 'safe' | 'sandboxed' | 'internal-check' | 'permission-gated' | 'external'
  executionMode?: ToolExecutionMode
  renderKind?: ToolRenderKind
  parameters?: ToolParameter[]
}

export interface SystemPromptSkillFileSnapshot {
  name: string
  path?: string
  type: 'markdown' | 'script' | 'template' | 'other'
}

export interface SystemPromptSkillSnapshot {
  id: string
  name: string
  description?: string
  source?: SkillSource
  category?: string
  tags?: string[]
  enabled?: boolean
  allowedTools?: string[]
  relatedSkills?: string[]
  platforms?: string[]
  conditions?: SkillConditions
  path?: string
  directoryPath?: string
  rootPath?: string
  relativePath?: string
  runtimeContext?: string
  files?: SystemPromptSkillFileSnapshot[]
}

export interface SystemPromptSnapshot {
  sessionId: string
  generatedAt: number
  providerId: string
  model: string
  providerSupported: boolean
  credentialsReady: boolean
  workingDirectory?: string
  agentId?: string
  agentName?: string
  systemPrompt: string
  systemPromptChars: number
  tools: {
    enableToolCalls: boolean
    modelSupportsTools: boolean
    hasTools: boolean
    configuredCount: number
    modelFacingCount: number
    builtin: SystemPromptToolSnapshot[]
    mcp: SystemPromptToolSnapshot[]
    codexNative: SystemPromptToolSnapshot[]
  }
  agentLoopStream: {
    enabled: boolean
    enabledBy: 'env' | 'settings' | 'default'
    providerSupported: boolean
    active: boolean
    supportedProviderIds: string[]
  }
  skills: {
    enabled: boolean
    includedInPrompt: boolean
    count: number
    items: SystemPromptSkillSnapshot[]
  }
}

export interface GetSystemPromptSnapshotRequest {
  sessionId: string
}

export interface GetSystemPromptSnapshotResponse {
  success: boolean
  snapshot?: SystemPromptSnapshot
  error?: string
}

// ============================================================================
// Optimized Session IPC Types
// ============================================================================

/**
 * Response for GET_SESSIONS_LIST - returns metadata only (no messages)
 */
export interface GetSessionsListResponse {
  success: boolean
  sessions?: SessionMeta[]
  error?: string
}

/**
 * Response for ACTIVATE_SESSION - returns session details (no messages)
 */
export interface ActivateSessionResponse {
  success: boolean
  session?: SessionDetails
  messageCount?: number  // Number of messages in session
  error?: string
}

/**
 * Response for GET_SESSION_MESSAGES - returns messages array
 */
export interface GetSessionMessagesResponse {
  success: boolean
  messages?: ChatMessage[]
  error?: string
}

export type SessionMessagesPageDirection = 'older' | 'newer'

export interface SessionMessagesPageAnchor {
  messageId?: string
  seq?: number
  before?: number
  after?: number
}

export interface GetSessionMessagesPageRequest {
  sessionId: string
  cursor?: string | null
  limit?: number
  direction?: SessionMessagesPageDirection
  anchor?: 'tail' | SessionMessagesPageAnchor
}

export interface SessionMessagePageCursor {
  sessionId: string
  seq: number
  includeAnchor: boolean
}

export interface GetSessionMessagesPageResponse {
  success: boolean
  messages?: ChatMessage[]
  nextCursor?: string | null
  backwardsCursor?: string | null
  hasMoreBefore?: boolean
  hasMoreAfter?: boolean
  totalCount?: number
  error?: string
}

export interface UserMessageMarker {
  id: string
  seq: number
  timestamp: number
  preview: string
}

export interface GetSessionUserMarkersResponse {
  success: boolean
  markers?: UserMessageMarker[]
  error?: string
}

// ============================================================================
// chat 域的 router —— 结构债 P4c 第五批
// ============================================================================

/**
 * chat(聊天面)域 —— **六条**方法从手写 IPC 通道搬到通用 `rpc:invoke` /
 * `POST /api/rpc`:`GET_CHAT_HISTORY` / `GENERATE_TITLE` /
 * `GET_SYSTEM_PROMPT_SNAPSHOT` / `UPDATE_MESSAGE_THINKING_TIME` /
 * `ABORT_STREAM` / `GET_ACTIVE_STREAMS`。
 *
 * 第七条「工具审批后恢复流」于 2026-08-22(#21)连同它的 invoke 通道整条
 * 删除:渲染层零调用者,且引擎侧 `result.requiresConfirmation === true` 早已
 * 无生产者(toolkit 重建后审批在工具内阻塞,runner 的 pause 抛不出来)。引擎的
 * `command:resume-after-confirm` 与 `handleResumeAfterConfirm` 仍在命令总线上。
 * 两只手写工厂(`apps/electron/src/ipc/chat.ts` / `@main/ipc/chat.ts`)随之整只删掉。
 *
 * **不在本域的聊天面**:会话的读/写是 `sessions` 域(第五批同期),命令总线的
 * 入口是 `session-command` 域(第四批);`session:stream` / `session:event` 是
 * **推送**,router 没有推送面。
 *
 * 位置参数一律折成信封(与 sessions / media / skills 同一判例):
 * `getHistory({ sessionId })`、`generateTitle({ message })`;无参的
 * `getActiveStreams` 按本仓惯例递 `{}`。
 */
export type ChatRoutes = {
  getHistory: { input: { sessionId: string }; output: GetChatHistoryResponse }
  generateTitle: { input: { message: string }; output: GenerateTitleResponse }
  getSystemPromptSnapshot: {
    input: { sessionId: string }
    output: GetSystemPromptSnapshotResponse
  }
  updateMessageThinkingTime: {
    input: { sessionId: string; messageId: string; thinkingTime: number }
    output: { success: boolean; error?: string }
  }
  /**
   * 不带 `sessionId` = 全停(旧线上 `abortStream()` 的零参调用)。`success` 的
   * 含义是**真的停下了什么**(`abortOnethingStreamsForIpc` 的语义),不是「请求
   * 收到了」—— 渲染层的 `stopGeneration` 靠它决定要不要就地收尾那几条消息。
   */
  abortStream: { input: { sessionId?: string }; output: { success: boolean } }
  /**
   * 字段名是 `sessionIds`(桌面那条实现的形状)。被删掉的
   * `GET /api/streams/active` 回的是 `streams` —— 两个宿主对同一件事用了不同
   * 的字段名,搬完之后只剩一个。
   */
  getActiveStreams: {
    input: Record<string, never>
    output: { success: boolean; sessionIds: string[] }
  }
}

export const chatRouter = defineRouter<ChatRoutes>('chat', [
  'getHistory',
  'generateTitle',
  'getSystemPromptSnapshot',
  'updateMessageThinkingTime',
  'abortStream',
  'getActiveStreams',
])
