/**
 * Collab board wire types — docs/design/multi-agent-collab.md D6/P1.
 * The board is room-scoped; mutations flow through the board tool / main
 * process store, the renderer reads snapshots + subscribes to
 * 'collab:board-changed' session events on the room session.
 */

import { defineRouter } from './router.js'
import type { ChatMessageReaction, ChatMessageReactionActor } from './chat.js'
import type { PermissionMode } from './tools.js'

export type CollabTaskStatus = 'backlog' | 'todo' | 'doing' | 'review' | 'done' | 'blocked'

/**
 * Structural execution trace (W9b.4): toolName → completed-call count, counted
 * by CODE from the work session's persisted messages. A model cannot write it,
 * which is exactly why the panel renders it verbatim (empty = 无执行记录).
 */
export interface CollabTaskEvidence {
  toolCounts: Record<string, number>
  /**
   * 交付物 (W17): write/edit targets of the work session, de-duplicated and
   * relativised to the room's workingDirectory. Code-collected like
   * toolCounts. Absent on pre-W17 cards.
   */
  files?: string[]
}

export interface CollabTask {
  id: string
  rev: number
  title: string
  description?: string
  status: CollabTaskStatus
  assigneeAgentId?: string
  createdBy: { type: 'user' | 'agent'; agentId?: string }
  workSessionIds: string[]
  rejections: number
  /** Times this card was halted (W9b.2). Absent on pre-W9b cards = 0. */
  haltedCount?: number
  /** Why it is/was blocked (W9b.3). Absent on pre-W9b cards. */
  blockReason?: string
  report?: { summary: string; messageId?: string; evidence?: CollabTaskEvidence }
  createdAt: number
  updatedAt: number
}

export interface CollabBoard {
  version: 1
  tasks: CollabTask[]
  /**
   * Monotonic commit counter stamped by the main-process board store (P2-18).
   * The renderer drops any snapshot whose seq is lower than the one on screen —
   * broadcast, write reply and GET race, and arrival order proves nothing.
   * Absent on boards written before this field; readers treat that as 0.
   */
  seq?: number
}

export interface CollabBoardGetRequest {
  roomSessionId: string
}

export interface CollabBoardGetResponse {
  success: boolean
  board?: CollabBoard
  error?: string
}

/**
 * Board mutation vocabulary (W16). Structurally identical to the runtime's
 * `CollabBoardAction` on purpose: the request carries the action ACROSS
 * unchanged and the pure reducer — the single source of truth for what is
 * legal — decides. Adding a case here without adding it there just yields the
 * reducer's own error text on the wire, which is the intended failure mode.
 */
export type CollabBoardAction =
  | {
      action: 'create'
      title: string
      description?: string
      assigneeAgentId?: string
      status?: 'backlog' | 'todo'
    }
  | { action: 'assign'; taskId: string; assigneeAgentId: string; expectedRev?: number }
  | { action: 'move'; taskId: string; status: CollabTaskStatus; expectedRev?: number; reason?: string }
  | { action: 'update'; taskId: string; title?: string; description?: string; expectedRev?: number }
  | { action: 'comment'; taskId: string; comment: string }
  | { action: 'complete'; taskId: string; summary: string; expectedRev?: number }
  | { action: 'block'; taskId: string; reason?: string; expectedRev?: number }
  | { action: 'list' }

/**
 * User-driven board mutation (W16). The actor is pinned to the human on the
 * main-process side — a renderer must never be able to act AS an agent, and
 * W9b's halt cap / 打回 accounting deliberately exempt the user.
 */
export interface CollabBoardActRequest {
  roomSessionId: string
  action: CollabBoardAction
}

export interface CollabBoardActResponse {
  success: boolean
  error?: string
  /**
   * The board AFTER the attempt — present on success and on a rev conflict
   * alike, so the panel can repaint from truth instead of re-fetching. The
   * broadcast still arrives (30ms coalesced); this only removes the wait.
   */
  board?: CollabBoard
}

/**
 * 停止一张卡正在跑的执行(collab-team-v2 §5.1 入口②)。
 *
 * 与「标受阻」分开的通道,因为它们是两件事:受阻宣告「这事儿卡住了、要人
 * 裁决」并烧掉一次自动处置预算,停止只是把手从方向盘上拿开——卡回到待办,
 * 现场留着,谁都可以 board start 续做。
 */
export interface CollabTaskStopRequest {
  roomSessionId: string
  taskId: string
}

export interface CollabTaskStopResponse {
  success: boolean
  /** false = 这张卡此刻没有在跑的执行(菜单项本不该出现在那儿)。 */
  stopped?: boolean
  error?: string
}

export interface CollabRoomFrozenRequest {
  roomSessionId: string
  frozen: boolean
}

export interface CollabRoomFrozenResponse {
  success: boolean
  error?: string
}

// ── 协调器状态条(docs/design/collab-coordinator-inspector.md)─────────────
//
// 房间里最贵、最不可见的一步是**调度**:谁被问了、谁答了不说、谁排在队里、卡在
// 哪道闸上,全发生在用户看不见的地方。这一族类型就是把它画出来所需的全部。
//
// 形态逐字照抄看板那条已经跑通的链路:一次 GET 冷启动 + `collab:coordinator-changed`
// 带**完整快照**的会话事件。快照很小,而全量广播省掉了增量合并那一整类 bug。

/** 一条正在跑的回合。 */
export interface CollabCoordinatorTurn {
  agentId: string
  /** 'mention' | 'self-elected' | 'task-event' | 'schedule' | 'relay' */
  reason: string
  startedAt: number
  /** 停它要打的那条执行会话 —— 「停」按钮的靶子,也是下钻的靶子。 */
  agentSessionId: string
  /**
   * 这张牌此刻**真在生成**吗(D8 观测体系 §1「词汇表修正」)。
   *
   * v3 特有的第三种状态:持牌 ≠ 在说话。牌发出去之后要先躺进那个 agent 的信箱,
   * 等它的心智循环取到这一批才起跑 —— 而那颗大脑此刻可能正在**别的房**里思考。
   * 「持牌等大脑」在 v2 的词汇表里根本没有对应词,于是状态条把它画成「发言中」,
   * 用户看见的是一个在说话、实则一个字都还没写的人。
   *
   * 判据是 turn-context 登记簿(engine-mind-port 登记的在飞回合),不是租约表 ——
   * 租约只证明「轮到它了」。
   */
  executing: boolean
}

/**
 * 一只举着的手卡在哪道闸上(D8 §3.2)。
 *
 * 「排队中」在 v2 是一个笼统词,而它底下是六件成因完全不同的事:等裁决(正常,
 * 几秒后自解)、等座位(并发满,自解)、链闸(要人说句话才解)、相位挂起(要换相)、
 * 冻结(要用户解冻)、预算(要等明天或改配额)。前两个不用管,后四个必须有人动手,
 * 而在这一格之前它们在界面上长得一模一样。
 *
 * 这是**快照组装时现算的判据,不落账** —— 它是解释不是状态。
 */
export type CollabCoordinatorBlockedBy =
  | 'judging'
  | 'seats'
  | 'chain'
  | 'phase'
  | 'frozen'
  | 'budget'

/** 一条排队等发言的激活。 */
export interface CollabCoordinatorQueued {
  id: string
  agentId: string
  reason: string
  /** 卡在哪道闸上(见 `CollabCoordinatorBlockedBy`)。 */
  blockedBy: CollabCoordinatorBlockedBy
}

/**
 * 裁决窗的四态(D8 §3.2)。
 *
 * 判别联合而不是几个平行布尔:`degraded` 必须带 `reason`、`inflight` 必须带候选,
 * 而平行布尔允许「降级了但没有理由」这种组装不出来的状态存在于类型里。
 *
 * `debouncing` 今天在 v3 里没有产生点(房间是事件驱动开窗,没有防抖窗口),
 * 留在联合里是因为它是**状态条要画的一格**(蓝图 §4.1 的虚点倒计时):裁决改算法
 * 时加防抖不该再动一次 wire 契约。读者按「还没开始问」处理。
 */
export type CollabCoordinatorJudgment =
  | { state: 'idle' }
  | { state: 'debouncing'; opensAt: number }
  | { state: 'inflight'; candidates: string[]; since: number }
  /** 降级要**亮牌**:回落 FIFO 是一次失败,不是一个答案(referee-rules 的同一条教训)。 */
  | { state: 'degraded'; reason: string; at: number }

/** 相位(`phase` 策略)。没有相位的房间这一格缺席。 */
export interface CollabCoordinatorPhase {
  name: string
  /** 这一相里能发牌的房。 */
  activeRooms?: string[]
  /** 因为不在活跃相而挂起的手数 —— 「没人理我」的第四种成因。 */
  suspendedHands: number
}

/** 一道闸的读数。`max` 为 0 表示这道闸关着(不限)。 */
export interface CollabCoordinatorGate {
  value: number
  max: number
}

/**
 * 一条调度事件(「刚才」那一段)。
 *
 * 只活在内存的环形缓冲里,**不落盘** —— 它说的是"刚才",而重启之后没有刚才。
 * 落盘账本是另一件事(qm-collab-learnings P2-8),目的也不同。
 */
export interface CollabCoordinatorLogEntry {
  at: number
  kind:
    | 'received'      // 收到用户消息
    | 'judging'       // 开始判定 N 人
    | 'judged'        // 判定 N 人 → count 人接话
    | 'relay-pass'    // 发言里 @ 到的人被插进编排的下一批
    | 'planned'       // 协调器给出一份编排(count = 几批, detail = 一句话理由)
    | 'wave'          // 发出一批(count = 这批几个人)
    | 'plan-failed'   // 编排要不到(detail = timeout/unparsable/unresolved/…),已降级
    | 'spoke'         // 谁说了 count 句
    | 'silent'        // 谁没说话(读完确实没自己的事)
    | 'unsent'        // 写了大段正文却没调 say,且收养投递也没送出去(写而未发)
    | 'adopted'       // 写而未发被收养:收尾正文由框架代为投进群(2026-08-02 翻案)
    | 'blocked'       // 撞闸(detail 说明是哪一道)
    | 'stopped'       // 用户喊停清场
  agentId?: string
  /** 'judged' = 几人接话;'spoke' = 说了几句;'judging' = 问了几人。 */
  count?: number
  /** 'judged' 的分母(问了几人)—— 「判定 4 人 → 1 人接话」要两个数才说得完整。 */
  total?: number
  /**
   * 'judged' 的成因分布,键是 `CollabWillingnessOutcomeKind`
   * ('yes' | 'no' | 'unparsable' | 'timeout' | 'unresolved' | 'aborted' | 'error')。
   *
   * 「都没接话」有五种完全不同的成因,而在这一格之前它们长得一模一样:满屋子 `no`
   * 是这群人真的没话说(不用管),满屋子 `timeout`/`unresolved` 是判定这条链断了
   * (必须修)。状态条存在的理由就是分开这两件事。
   */
  outcomes?: Record<string, number>
  /** 'chain' | 'budget' | 'loops' | 'frozen' —— 仅 'blocked' 用;'planned'/'plan-failed' 放理由。 */
  detail?: string
  /**
   * 'planned' 专用:编排的完整批次(agentId 的有序批)。
   *
   * 编排跑完就被丢掉(`state.plan` 是执行态,不是历史),而「刚才」是唯一活得比它
   * 久的地方 —— 不带上批次,用户回头只能看见「编排 2 批」这个数,说不出谁在哪批。
   */
  waves?: string[][]
}

export interface CollabCoordinatorState {
  roomSessionId: string
  mode: 'auto' | 'parallel' | 'serial'
  frozen: boolean
  turns: CollabCoordinatorTurn[]
  queue: CollabCoordinatorQueued[]
  /**
   * 「谁在说话」—— 此刻占着这间房发言权的 agent(架构收敛 C4 §1)。
   *
   * 取的是 `roomOccupancy`(inFlight ∪ activeTurns),也就是 C1 那份**占用视图**,
   * 所以它是 `turns` 的超集:一条刚出队、还卡在闸上或 agent 锁上的激活同样属于
   * "这间房有东西在跑",而喊停(`stopRoomFloor` 换世代号)对它同样有效 ——
   * 停止按钮的可见性因此与"停得掉的东西"完全同宽。
   *
   * 这个字段存在的理由是**口径统一**:停止按钮从前读 `collab:turn-active` 的
   * 事件账,状态面读这份快照,「在忙」又从看板 doing 卡现算,三本账各自漂移,
   * 而事件账在窗口重载后直接归零(没有任何补水)。现在只有这一本。
   */
  speaking: string[]
  /**
   * 此刻正在打字的 agent(IM typing,multi-agent-collab-im §2.4)。
   *
   * 与 `speaking` 同存一份快照,但**不是**同一件事:typing 在一轮里明灭数次
   * (每次 `say` 的参数流),speaking 一轮只翻两次。停止按钮读后者,打字行读前者。
   */
  typing: string[]
  /** 快照生成时刻(ms)。typing 的 60s 陈旧兜底挂在它上面 —— 丢了一条 false 的房间
   *  会忘掉那盏灯,而不是永远亮着。 */
  at: number
  /**
   * 单调序号,每广播一次 +1(与 `CollabBoard.seq` 同一条纪律,P2-18)。
   *
   * 广播、冷启动 GET 两条路会赛跑,而到达顺序什么都证明不了:渲染层据此丢弃
   * **比屏幕上更旧**的快照。GET 带的是"上一次广播的号",所以一发比它新的广播
   * 总能顶掉一条迟到的 GET 回包。缺这个字段的旧数据读作 0。
   */
  seq: number
  /** 在飞的意愿判定轮数(并行模式);0 = 此刻没有判定在跑。 */
  judging: number
  /** 这一轮判定在问谁 —— 常驻条那句「4 人在判断要不要接话」的名字来源。 */
  judgingAgentIds: string[]
  gates: {
    chain: CollabCoordinatorGate
    concurrency: CollabCoordinatorGate
    /** 单位是美元;`value` 取协调器自己的 60s 缓存(与预算闸读的是同一个数)。 */
    budget: CollabCoordinatorGate
  }
  /**
   * 此刻在跑的**编排**(collab-coordinator-plan.md);没有编排在飞时为 null。
   *
   * 接力时代这里是「环 + 持棒者」。编排之后环是 waves 的一个特例
   * (`[[a],[b],[c]]`),所以视图直接给 waves —— 它同时画得出
   * 「阿般 → 小李 → Iris」(单人批)和「阿般 · 小李 / Iris」(多人批),
   * 而环那个形状画不出后者。
   */
  plan: {
    /** 有序批次;批内并行、批间串行。 */
    waves: string[][]
    /** 正在跑(或即将发)的那一批。 */
    waveIndex: number
    /** 这一趟已经执行了几批。 */
    waveCount: number
    /** 走完之后要不要从头再来。 */
    cycle: boolean
    /** 协调器给的一句话理由 —— 用户第一次能看到它**为什么**这么排。 */
    why: string
    /** 0 = 不限圈。 */
    loops: number
  } | null
  /** 最近的调度事件,**旧在前**。 */
  log: CollabCoordinatorLogEntry[]
  /**
   * 裁决窗此刻的状态(D8 §3.2)。
   *
   * 与上面 `judging` / `judgingAgentIds` 两格并存而不是替换它们:那两格是 C4 立下的
   * 形状,状态条今天读的就是它们。这一格说的是**同一件事的四态**,多出来的是
   * 「降级」——一次回落 FIFO 在旧两格里表现为 `judging: 0`,与「没有裁决在跑」
   * 一模一样,而它恰恰是必须修的那一类。
   */
  judgment: CollabCoordinatorJudgment
  /** 相位(`phase` 策略);其余三档没有相位。 */
  phase?: CollabCoordinatorPhase
  /**
   * 这间房的 actor 处理事件失败了几次(只增计数;详情走调度时间轴)。
   *
   * 死信在 D8 之前是一个**没有消费者**的内存环:一封信炸了,循环继续跑,而系统
   * 静默地变哑 —— 「它没回应」与「它试过但炸了」在界面上完全无法区分。这个数字
   * 是那两者之间的第一条分界线。
   */
  deadLetterCount: number
  /**
   * 这间房此刻的发言权代数(E5 人级停止)。
   *
   * 撤牌那颗按钮拿它当**乐观并发的前置条件**——与看板的 `expectedRev` 同一个
   * 形状。牌号本身已经是唯一的,代数管的是另一件事:界面上这一屏描述的是哪一轮。
   * 代数变过就说明这一屏说的已经是上一轮的事,此时撤牌撤到的很可能是无辜的人。
   *
   * 可选:v2 那侧的协调器快照没有代数这个概念,缺席读作「不做前置校验」。
   */
  floorEpoch?: number
}

export interface CollabCoordinatorGetRequest {
  roomSessionId: string
}

/**
 * 人级停止(E5):点名把某一张在外的牌收回来。
 *
 * 三级停止的第三级。房级是 `stopRoomFloor`(换代,全场清空)、卡级是
 * `taskStop`(停一张卡上的那只手),而「停下 TA」在此之前**不可达** ——
 * 界面上只能拿房级喊停冒充,而那会把同房其他人一起打断。
 */
export interface CollabRoomRevokeLeaseRequest {
  roomSessionId: string
  /** 要收的那张牌。v3 快照里它就是 `CollabCoordinatorTurn.agentSessionId`。 */
  leaseId: string
  /** 界面看见这张牌时房间的代数。与运行时对不上就拒绝(见 `floorEpoch`)。 */
  expectedEpoch: number
}

/** 撤牌为什么没做成 —— 每一条都是**可操作的**,不留 null 漏到界面。 */
export type CollabRoomRevokeLeaseFailure =
  /** 代数对不上:界面上那一屏说的已经是上一轮的事,刷新再看。 */
  | 'epoch-stale'
  /** 账上没这张在外的牌:它已经让位/过期/被换代作废了,这一停无事可做。 */
  | 'not-found'
  /** 这不是一间(跑着 v3 运行时的)房。 */
  | 'not-a-room'

export interface CollabRoomRevokeLeaseResult {
  ok: boolean
  revoked?: true
  reason?: CollabRoomRevokeLeaseFailure
  /**
   * 运行时此刻的代数。`epoch-stale` 时**必带** —— 界面据它自愈(重取快照),
   * 而不是让用户对着一颗永远失败的按钮猜为什么。
   */
  epoch?: number
  /** 被收牌的那位。成功时带上,供界面给出「已让 X 停下」这类确证文案。 */
  agentId?: string
}

export interface CollabRoomRevokeLeaseResponse {
  success: boolean
  error?: string
  result?: CollabRoomRevokeLeaseResult
}

export interface CollabCoordinatorGetResponse {
  success: boolean
  error?: string
  state?: CollabCoordinatorState
}

// ── Agent 视角(D8 观测体系 §3.1)────────────────────────────────────────────
//
// 房间视角回答「这间房怎么了」,而 v3 把世界改成了 **agent 中心**:一个大脑、跨房
// 的租约、一条持久信箱、一把工作卡。「这个人现在在干嘛」在房间那本账里根本问不出来
// —— 它只看得见自己这间房里的那一格。这一族类型就是另一本账。
//
// 形态逐字照抄协调器那条已经跑通的链路(C4):一次 GET 冷启动 + 带**完整小快照**的
// 会话事件(`collab:agent-changed`)。快照很小,而全量广播省掉了增量合并那一整类 bug。

/** 一张在手的牌。 */
export interface CollabAgentHeldLease {
  roomSessionId: string
  leaseId: string
  since: number
  /**
   * 真在生成吗 —— 与 `CollabCoordinatorTurn.executing` 同一个判据、同一个理由。
   * 一个人可以同时持三张牌而只在其中一间房里真的动着笔。
   */
  executing: boolean
}

/** 手上的一张工作卡(D4 子 actor)。 */
export interface CollabAgentWorkerCard {
  cardId: string
  roomSessionId: string
  status: 'running' | 'done' | 'interrupted'
  since: number
}

/**
 * 大脑此刻在哪。
 *
 * 「一个大脑」这条宪法的可观测形态:同一时刻至多在**一间**房里思考,所以这是一个
 * 判别联合而不是一张房间表 —— 类型本身就说得出那条约束。
 */
export type CollabAgentMind =
  | { state: 'idle' }
  | { state: 'thinking'; roomSessionId: string; since: number }

/**
 * 一位同事此刻的活动快照。
 *
 * **永不携带消息正文**(保密纪律,蓝图 §7):信箱只给深度与最旧时刻,工作卡只给
 * 卡号与状态。正文只在房间转录里,按成员表的可见性走。
 */
export interface CollabAgentActivitySnapshot {
  agentId: string
  /** 每 agent 单调,发射时 +1(C4 纪律:渲染层据此丢弃比屏幕更旧的包)。 */
  seq: number
  /** 快照生成时刻(ms)。陈旧兜底挂在它上面。 */
  at: number
  mind: CollabAgentMind
  heldLeases: CollabAgentHeldLease[]
  /** 信箱积压。深度用游标差现算(O(1)),不数文件行。 */
  inbox: { depth: number; oldestAt?: number }
  workers: CollabAgentWorkerCard[]
  lastSpokeAt?: number
  /** 只增计数;详情走调度时间轴(与房间快照同一条纪律)。 */
  deadLetterCount: number
  /**
   * **它在等人**(E6,claude-code-integration-v2 §6)。
   *
   * `mind.state === 'thinking'` 答的是「大脑在转」,而一次挂在提问或审批上的等待
   * 在那一格里与「正在写一段很长的回答」长得一模一样 —— F3 里 Iris 挂了 2 分 11 秒,
   * 界面自始至终只说「生成中」。这一格把两者分开:有它 = 球在**人**这边。
   *
   * 两条并列的等待链共用这一格(`interaction` 提问 / `permission` 审批),读的是
   * 两个内核现成的 pending 表(`Interaction.getPending` / `Permission.getPendingPrompts`),
   * **不新开一本账**。两条都挂着时取更早的那一条 —— 「等了多久」问的是这个人被卡住
   * 有多久,不是某一张卡开了多久。
   */
  waitingOn?: { kind: 'interaction' | 'permission'; since: number }
}

/**
 * 冷启动补水:问几位同事此刻的活动快照(D8 §3.1 的 GET 口)。
 *
 * `agentIds` 缺席 = 全要(此刻开着心智循环的那些)。带上则**逐个都有回答** ——
 * 一位没在跑循环的同事回一份空闲快照而不是被悄悄跳过:「读不到」与「空闲」在
 * 界面上必须是同一个样子,否则冷启动会闪一下空白(C4 那条老纪律)。
 */
export interface CollabAgentActivityGetRequest {
  agentIds?: string[]
}

export interface CollabAgentActivityGetResponse {
  success: boolean
  error?: string
  /** 顺序与请求一致;不带 `agentIds` 时是运行时枚举序。 */
  activities?: CollabAgentActivitySnapshot[]
}

// ── 调度时间轴(D8 观测体系 §3.3)──────────────────────────────────────────
//
// 两本快照回答的都是**此刻**。这一扇门回答另一个问题:「**刚才**为什么是那样?」
// —— 谁举了手、裁判怎么排的、为什么这么排、牌发给了谁、谁被哪道闸拦了、有没有
// 一封信炸了。那些事在 D8 之前只活在 inspector 的内存环里(≤32 条,重启即失忆),
// 而抓瞎最惨的时刻恰恰是进程不对劲的时刻。
//
// **只读,没有写口**:账由记账的那几个 actor 单点写(谁转换状态谁记账)。

/**
 * 时间轴上的一行,**整体透传**。
 *
 * 完整判别联合的属主是纯层的 `CollabSchedulerLogRow`(14 类,带因果 `triggeredBy`
 * 与「正文永不入账」的类型级门)。契约层不重抄一份:抄一份就要在每次加一类行时
 * 记得改两处,漏掉哪一处都不报错 —— 只是那一类行在界面上静默地长成一个空白。
 * 所以这里只钉住**每一行都有的两格**,判别由读的那一侧按 `type` 收窄。
 */
export type CollabSchedulerLogEntry = {
  at: number
  type: string
} & Record<string, unknown>

export interface CollabSchedulerLogTailRequest {
  roomSessionId: string
  /** 尾读几条。缺席 = 主进程的默认尾长。 */
  limit?: number
  /** 只要这几类(`CollabSchedulerLogRow['type']` 的字面量)。缺席 = 全要。 */
  types?: string[]
}

export interface CollabSchedulerLogTailResponse {
  success: boolean
  error?: string
  /** **新在前** —— 回查从最近一步往回看,不是从开天辟地往下翻。 */
  rows?: CollabSchedulerLogEntry[]
}

/** Update room budgets. Only provided fields change; 0 disables that gate. */
export interface CollabRoomBudgetsRequest {
  roomSessionId: string
  dailyCostUSD?: number
  maxChain?: number
  /** 回合断路器上限 (W22); 0 = 关闭该闸。 */
  maxTurnToolCalls?: number
  maxTurnSayCalls?: number
  /** 同时最多几个人说话(房间回合并行化)。缺省 = 内置默认;0 = 不限。 */
  maxConcurrentTurns?: number
}

/** What a budgets write may change — the request minus its address. Named
 *  because four layers (preload, renderer platform type, daemon, app) each
 *  carried their own copy of this shape and the last two fields showed how
 *  quickly the copies drift. */
export type CollabRoomBudgetsPatch = Omit<CollabRoomBudgetsRequest, 'roomSessionId'>

export interface CollabRoomBudgetsResponse {
  success: boolean
  error?: string
}

/**
 * Read-only spend view for the room settings panel (W13.5). Same ledger
 * aggregation the coordinator's budget gate uses (room session + its work
 * sessions, today), read once when the panel opens — no live refresh.
 */
export interface CollabRoomSpendRequest {
  roomSessionId: string
}

export interface CollabRoomSpendResponse {
  success: boolean
  error?: string
  /** Today's total cost in USD across the room and its work sessions. */
  spentTodayUSD?: number
  /** The room's configured daily cap; 0 means no cap. */
  dailyCostUSD?: number
}

/**
 * Team settings update (W6). Only provided fields change:
 *  - `memberAgentIds` replaces the roster (每个 id 必须是存在的 agent,至少 1 人)
 *  - `pmAgentId` must be one of the resulting members; `null` clears it
 *  - `permissionMode` writes the ROOM session's mode; work sessions inherit it
 *  - `responseMode` / `speakOrder` / `relayLoops` 是响应模式三件套
 *    (docs/design/collab-speaking-order.md);`speakOrder: []` = 清空,退回名册序
 */
export interface CollabRoomUpdateRequest {
  roomSessionId: string
  name?: string
  memberAgentIds?: string[]
  pmAgentId?: string | null
  permissionMode?: PermissionMode
  responseMode?: 'auto' | 'parallel' | 'serial'
  speakOrder?: string[]
  relayLoops?: number
}

/**
 * What a room-settings write may change — the request minus its address.
 *
 * 与 `CollabRoomBudgetsPatch` 同一条纪律,而且是被同一种事故逼出来的:这个形状
 * 此前在 preload 与 renderer 的类型表里各手抄了一份,加一个字段要记得改三处,
 * 漏掉哪一处都不报错,只是那个字段静默到不了主进程(隔壁 budgets 的
 * `maxConcurrentTurns` 就这么丢了几个月)。现在只有一份。
 */
export type CollabRoomUpdatePatch = Omit<CollabRoomUpdateRequest, 'roomSessionId'>

export interface CollabRoomUpdateResponse {
  success: boolean
  error?: string
}

/**
 * 清空一间房的对话记忆
 * (docs/design/collab-room-clear-and-mention-all.md B)。
 *
 * **不可恢复**,且不止是这间房的转录:每位成员(含曾在册的)在这间房的执行会话
 * 一并清空、已读游标归零 —— 否则旧记忆继续躺在成员那侧,每轮都被读进上下文。
 * 看板卡片、房间设置、成员本体、今日已花额度都不动。
 *
 * 删之前房间转录会原样留档一份(`messages.cleared-<ts>.jsonl`,不进任何读取
 * 路径);执行会话是派生记忆,不留档。
 */
export interface CollabRoomClearHistoryRequest {
  roomSessionId: string
  /**
   * 连带清空成员两两之间的私聊房(及其执行会话)。
   *
   * 缺省 false:pair 私聊房是**跨群共享**的(Iris⇄Bram 只有一间,别的群也用它),
   * 连带清空是用户的显式选择,不是"清空这间房"的默认语义。
   */
  includeMemberDms?: boolean
}

export interface CollabRoomClearHistoryResponse {
  success: boolean
  /** 清掉的房间消息条数。 */
  clearedMessageCount?: number
  /** 连带清空的成员间私聊房数(仅当 includeMemberDms)。 */
  clearedDmRoomCount?: number
  /** 一并清空的成员执行会话数。 */
  clearedSessionCount?: number
  /** 一并清掉的看板卡片数(含连带清空的私聊房)。 */
  clearedTaskCount?: number
  error?: string
}

/**
 * 打开(必要时惰性创建)用户 ↔ 某个 agent 的托管私聊房
 * (docs/design/agent-im-dm.md D1)。
 *
 * 幂等:房间 id 从 agentId 派生,同一个 agent 永远是同一间房,所以这个请求既是
 * "创建"也是"打开",调用方不需要先查再建。
 *
 * 失败(`success: false`)的含义只有一种:**这个 agent 不该有私聊房** ——
 * 查无此人、service agent(不是同事)、已退休。desktop-only:rooms 需要主进程的
 * RoomCoordinator,web 端返回明确的不支持错误。
 */
export interface CollabDmRoomEnsureRequest {
  agentId: string
}

export interface CollabDmRoomEnsureResponse {
  success: boolean
  /** 私聊房的会话 id(= `userDmRoomId(agentId)`)。 */
  roomSessionId?: string
  error?: string
}

/**
 * 群 folder 的只读列目录(docs/design/agent-im-chat-ui.md §3.2「文件」块)。
 *
 * 为什么不是 `file:list-directory`:folder 的位置是主进程的推导
 * (`collabRoomFolder` = workingDirectory ?? `<store>/rooms/<id>`),渲染进程只
 * 拿得到房间会话上那个**可能还没写下来**的 workingDirectory,拿它去猜等于把
 * 一条回退规则抄第二份。所以通道按房间 id 问,由主进程回答"在哪儿 + 有什么"。
 *
 * 只读:没有建/删/写。desktop-only(rooms 本就是,web 端给不支持错误)。
 */
export interface CollabRoomFolderListRequest {
  roomSessionId: string
}

/** folder 里的一个文件。目录本身不成行 —— 这是个文件列表,不是文件树控件。 */
export interface CollabRoomFolderEntry {
  /** 相对 folder 的路径,永远用 `/` 分隔 —— 行上显示的就是它。 */
  relativePath: string
  /** 绝对路径,点开走既有 openFile 链路。 */
  path: string
  size: number
  mtimeMs: number
}

export interface CollabRoomFolderListResponse {
  success: boolean
  /** folder 的绝对路径;非房间会话时缺席。 */
  folder?: string
  entries?: CollabRoomFolderEntry[]
  /** 目录还没建过(这个房间从没往里放过东西)—— 不是错误,是空。 */
  missing?: boolean
  /** 条目超过上限,列表被截断。 */
  truncated?: boolean
  error?: string
}

/**
 * Toggle one emoji on one room message (W8, §3.5 B). Same actor + same emoji
 * again takes it back; `emoji` must be one of the six-emoji palette
 * (COLLAB_REACTION_EMOJIS) or the write is refused.
 */
export interface CollabMessageReactRequest {
  roomSessionId: string
  messageId: string
  emoji: string
  /**
   * @deprecated Ignored on the main-process side, which pins the actor to the
   * human user — exactly like CollabBoardActRequest. A reaction is attribution
   * (a silent member's emoji IS its answer), so a renderer must never be able
   * to file one under an agent's name. Kept on the type for wire compatibility;
   * agent reactions are written in-process by the willingness round.
   */
  actor?: ChatMessageReactionActor
}

export interface CollabMessageReactResponse {
  success: boolean
  error?: string
  /** The message's reactions after the write (aggregated per emoji). */
  reactions?: ChatMessageReaction[]
}

/**
 * collab(多 agent 协作房:看板 / 房间设置 / 协调器 / 观测)域 —— 结构债 P4a
 * 的第三个域(前两个是 spaces、practice)。
 *
 * 十五个方法全是**纯数据面**:看板的读/写、卡级与人级停止、房间配置(改名 /
 * 名册 / PM / 权限档 / 预算 / 冻结)、协调器与 agent 活动快照的冷启动补水、
 * 调度时间轴尾读、清空转录、托管私聊房的 get-or-create、群 folder 列目录、
 * 表情回应。旧线是主进程里那十五条裸 handle —— 零 electron 原生、零 sender、
 * 零 fs,所以整只搬得进 `app/rpc/domains/collab.ts`,旧文件随之整只删掉。
 *
 * **一条纪律必须随着搬过去**:`messageReact` 的 `actor` **被刻意忽略**,处理者
 * 把它钉死成 `{ type: 'user' }`。表情回应是**归属**(§3.5 B:一位沉默成员的
 * emoji 就是它的回答),渲染层能指定 actor 就等于能替别人表态。router 的
 * dispatch context 里没有「我是谁」,所以这颗钉子留在 handler 里,和从前一样;
 * `actor?` 只为线上兼容留在类型上 —— 我们自己的调用点不再填它。
 *
 * **没有无入参的方法**:十五条每一条都至少带一个地址(房间 id / agent id)。
 * `agentActivityGet` 是唯一一个所有键都可选的(`agentIds` 缺席 = app 层决定
 * 「全要」),信封仍然要给,写 `{}`。
 *
 * 不在这条路上的:表情写完之后的回灌走既有的 `message:updated` 会话事件,
 * 看板 / 协调器 / agent 的实时更新走 `collab:*-changed` 会话事件 —— 都是**推送
 * 面**,而 router 今天只有请求/响应面。所以这十五条**一条推送都不带**,手写 IPC
 * 那一侧迁完什么也不剩(与 spaces / practice 各留一条广播不同)。
 *
 * (本文件从此不再是「纯类型模块」—— 多了 `collabRouter` 这一个 const。
 * `import type` 的引用点仍然被完全擦除,只有真正要动词表的地方才会带上它。)
 */
export type CollabRoutes = {
  boardGet: { input: CollabBoardGetRequest; output: CollabBoardGetResponse }
  boardAct: { input: CollabBoardActRequest; output: CollabBoardActResponse }
  taskStop: { input: CollabTaskStopRequest; output: CollabTaskStopResponse }
  roomRevokeLease: { input: CollabRoomRevokeLeaseRequest; output: CollabRoomRevokeLeaseResponse }
  coordinatorGet: { input: CollabCoordinatorGetRequest; output: CollabCoordinatorGetResponse }
  agentActivityGet: { input: CollabAgentActivityGetRequest; output: CollabAgentActivityGetResponse }
  schedulerLogTail: { input: CollabSchedulerLogTailRequest; output: CollabSchedulerLogTailResponse }
  roomSetFrozen: { input: CollabRoomFrozenRequest; output: CollabRoomFrozenResponse }
  roomSetBudgets: { input: CollabRoomBudgetsRequest; output: CollabRoomBudgetsResponse }
  roomSpendGet: { input: CollabRoomSpendRequest; output: CollabRoomSpendResponse }
  roomUpdate: { input: CollabRoomUpdateRequest; output: CollabRoomUpdateResponse }
  roomClearHistory: { input: CollabRoomClearHistoryRequest; output: CollabRoomClearHistoryResponse }
  dmRoomEnsure: { input: CollabDmRoomEnsureRequest; output: CollabDmRoomEnsureResponse }
  roomFolderList: { input: CollabRoomFolderListRequest; output: CollabRoomFolderListResponse }
  messageReact: { input: CollabMessageReactRequest; output: CollabMessageReactResponse }
}

export const collabRouter = defineRouter<CollabRoutes>('collab', [
  'boardGet',
  'boardAct',
  'taskStop',
  'roomRevokeLease',
  'coordinatorGet',
  'agentActivityGet',
  'schedulerLogTail',
  'roomSetFrozen',
  'roomSetBudgets',
  'roomSpendGet',
  'roomUpdate',
  'roomClearHistory',
  'dmRoomEnsure',
  'roomFolderList',
  'messageReact',
])
