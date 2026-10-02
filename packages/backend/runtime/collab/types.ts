/**
 * Collab (multi-agent room) pure logic — docs/design/multi-agent-collab.md.
 *
 * Product-layer module (electron-free, wire-contract-free). Structural types
 * mirror the shared chat wire shapes; the app layer is where the two meet.
 */
import type { CollabReactionLike } from './reactions.js'

/** 'agent' = an agent's own execution session (W18): where its room turns run. */
export type CollabSessionKind = 'chat' | 'room' | 'work' | 'agent'

export interface CollabRoomBudgets {
  maxChain?: number
  maxConcurrentWork?: number
  dailyCostUSD?: number
  /** 回合断路器上限 (W22, see collab/circuit-breaker.ts). Absent = the built-in
   *  default; **0 = 关闭该闸**, the same convention as dailyCostUSD/maxChain. */
  maxTurnToolCalls?: number
  maxTurnSayCalls?: number
  /**
   * 同时最多几个人说话(房间回合并行化 2026-08-01)。缺省 = 内置默认
   * `COLLAB_MAX_CONCURRENT_TURNS`;**0 = 不限**,与本族其它闸同一套约定。
   */
  maxConcurrentTurns?: number
}

/**
 * In-flight card statuses an agent can be told about (W9.3).
 *
 * 提示词那一段 `<your_cards>` 已经退役(agent-self-state-variables.md §4.4):
 * 内容改由 `my_cards` 变量承载,而看板 → 变量那条链仍然要一个形状,就是这两个类型。
 */
export type CollabSelfTaskStatus = 'doing' | 'blocked'

/** One in-flight card assigned to a given agent. */
export interface CollabSelfTaskFact {
  id: string
  title: string
  status: CollabSelfTaskStatus
}

/** Structural view of an agent, as rosters/projection/mentions need it. */
export interface CollabAgentLike {
  id: string
  name: string
  title?: string
  description?: string
  avatar?: string
  /**
   * Media-library file name of the picture avatar (see AgentDefinition). Carried
   * so a projection of the roster is complete, NOT so text can render it: every
   * line this module builds (群公告, roster prompts) is plain text and keeps
   * using the emoji `avatar` as the identity mark.
   */
  avatarImage?: string
}

/** An IM quote-reply snapshot as the projection reads it (shared ChatMessage
 *  carries the wire-level twin). */
export interface CollabReplyToLike {
  messageId?: string
  authorLabel?: string
  excerpt?: string
}

/**
 * One @mention, resolved to an identity (W14a). `agentId` is the truth —
 * fixed when the message was authored, so renames and 重名 cannot move it.
 * `label` is the display name at that moment, kept as the fallback for an
 * agent that is no longer in the roster. The shared ChatMessage carries the
 * wire-level twin (ChatMessageMention).
 */
export interface CollabMentionLike {
  agentId: string
  label: string
  /**
   * 缺省 `'agent'`(每一条老转录都是)。`'user'` = 这一处点的是用户本人 ——
   * TA 没有 agent id,所以那一条的 `agentId` 是**空串**,而所有消费方本来就有
   * 空值门,于是它天然不进激活、不进成员校验(collab-handle-codec.md §2.3)。
   */
  kind?: 'agent' | 'user'
  /**
   * 用户的句柄(仅 `kind:'user'`)。**不塞进 `agentId`**:那个字段的语义是
   * agent 花名册 id,混进一个不是 agent 的值,迟早有人拿它去 `findAgent`。
   *
   * 为什么不能省:曾经的理由是「用户只有一个,kind 就够指认」—— 那是拿**当下
   * 只有一个人**当永久前提。网关(微信/飞书等渠道)进来的是**多个真人**,那一刻
   * 「是用户」不再是一个身份,而句柄是。真实存在的标识符不该在落库时被丢掉。
   */
  userHandle?: string
}

/** Structural view of a persisted chat message, as the projection needs it. */
export interface CollabMessageLike {
  /** 房间消息 id。视野窗口(history-window.ts)按它定位每位同事的已读游标。 */
  id?: string
  role: string
  content: string
  agentId?: string
  /** 落库时刻(ms)。进 `<message time>` —— 聊天记录里「什么时候说的」是信息。 */
  timestamp?: number
  source?: string
  origin?: { source?: string }
  toolCalls?: Array<{ name?: string; arguments?: unknown; result?: unknown }>
  replyTo?: CollabReplyToLike
  reactions?: CollabReactionLike[]
  /** Identity-resolved @mentions (W14a). Absent on pre-W14a transcripts. */
  mentions?: CollabMentionLike[]
  /**
   * W23: on a DRIVE, the room message that caused the activation. Absent on
   * pre-W23 drives and on everything that is not a drive.
   */
  collabSourceMessageId?: string
  /**
   * 这条消息是**外部注入**,落库即把这间房的链长清零(A2)。跨房 dm 与 wake
   * poke 打这个标,判定收在 `classify.ts`。缺席 = 普通消息。
   */
  collabChainReset?: boolean
}

/** Default chain cap: consecutive agent CHAT messages without human input.
 *  Task-event activations (delivery reports, reviews) are exempt — the work
 *  pipeline is bounded by its own gates (per-task rejections, concurrency),
 *  and freezing it mid-delivery stalls real work (真机实测).
 *
 *  房间可用 `budgets.maxChain` 覆盖,**0 = 关闭该闸**(与 dailyCostUSD 和两个
 *  回合断路器上限同一套约定);解析见 `maxChainFor()`。 */
export const COLLAB_DEFAULT_MAX_CHAIN = 32

/**
 * 房间日预算的默认值(美元)。房间可用 `budgets.dailyCostUSD` 覆盖,0 = 不限额。
 *
 * 放在纯层而不是 `app/collab/budget.ts`,是因为它有**第二个**读者了(协调器
 * 状态条要画那道闸的分母),而 budget.ts 的静态图上挂着用量账本 → 设置仓库 →
 * 存储路径 —— 为一个数字把整条链拖进来,代价是 15 个测试文件在收集阶段就炸。
 * 闸的**逻辑**照旧留在 budget.ts;这里只有那个数,与 `COLLAB_DEFAULT_MAX_CHAIN`
 * 同一格。
 */
export const COLLAB_DEFAULT_DAILY_COST_USD = 5

/**
 * 双成员 dm 房(agent ↔ agent 私聊)没配 `budgets.maxChain` 时的默认链长闸
 * (agent-im-dm.md §3.3)。
 *
 * 比群房的 32 收紧一个数量级,因为这里的失控形态与群里不同:群里"连着聊 32 条"
 * 至少还有 N 个人各说各的,而一对一的最大风险是**客套乒乓**——「收到」「辛苦了」
 * 「不客气」互相激活,每一条都合法、每一条都没有新信息(W14d 重复发言的变体)。
 * 免判激活(D6)把这条链上唯一那道判定也省了,所以机械止损必须补回来。
 *
 * 6 = 双方各说三轮。真要长谈,房间设置里的「连续发言上限」照常生效并原样尊重
 * ——显式配置永远压过这个默认值,这是 `maxChainFor()` 的既有约定。
 */
export const COLLAB_DM_PAIR_MAX_CHAIN = 6

/**
 * The drive and harvest markers, and the predicates over them, moved to
 * `classify.ts` (R3): every marker is now read in exactly one place, because
 * each of them can arrive on `source` OR on `origin.source` and doing that read
 * six times is what produced the 事故. Re-exported here so every existing
 * import site keeps working unchanged.
 */
export {
  COLLAB_HARVEST_SOURCE,
  COLLAB_MESSAGE_SOURCE,
  isCollabDriveMessage,
  isCollabHarvestMessage,
} from './classify.js'

/**
 * Usage-ledger attribution labels (W13.3). Purely a reporting axis: the room
 * budget gate still sums the ledger by sessionId (room + its work sessions),
 * which already works and is deliberately NOT re-keyed onto these strings.
 * Everything not stamped here keeps recording as 'chat'.
 */
export const COLLAB_USAGE_SOURCE_ROOM = 'collab-room'
export const COLLAB_USAGE_SOURCE_WORK = 'collab-work'

