/**
 * Collab v3 协议动词表(docs/design/collab-actor-v3.md §2)。
 *
 * v2 的编排是**代码路径**:coordinator 调 planner 调 willingness-runner,谁能说话
 * 藏在四个文件的控制流里。v3 把它翻成**动词**:举手、发牌、说话、让位、换相 ——
 * 每一个都是一封持久事件,谁发的、发给谁、什么时候发的,全都落在信封上。
 * 好处不是「更优雅」,是**可重放**:一间房昨天为什么是那个人说话,重放同一串动词
 * 就能重现;藏在控制流里的判断重放不出来。
 *
 * 纪律(C3 沿用):动词是联合类型,`collabActorVerbDirection()` 用 `never` 穷尽 ——
 * **新增一个动词却漏了处理,typecheck 当场红**。协议演进不能靠记性。
 *
 * 这一层是纯类型 + 纯构造函数:不碰 fs、不碰事件总线、不认识 StreamEngine。
 * 谁把这些动词投进 mailbox 是 D1/D2 的事。
 */
import type { FloorLease } from '@onething/backend/runtime/collab/kernel'

import type { CollabMentionLike, CollabMessageLike } from '../types.js'

/** 协议里有身份的五种角色(docs/design/collab-actor-v3.md §1.1)。 */
export type CollabActorKind = 'room' | 'agent' | 'user' | 'referee' | 'worker'

/** core 的 `ActorRef` 在 collab 语境里的收窄形态。 */
export interface CollabActorRef {
  kind: CollabActorKind
  id: string
}

export function collabActorRef(kind: CollabActorKind, id: string): CollabActorRef {
  return { kind, id }
}

// ─────────────────────────────────────────────────────────────────────────────
// Room → Agent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 房间广播一条消息。
 *
 * 人类发言也走这一条:UserProxyActor 把它投进房间,房间再广播 —— 所以 `author`
 * 的 kind 可能是 `user`。不给用户单开一个动词,是因为「谁说的」是**身份**问题,
 * 不是**协议**问题;开两个动词的话每个消费方都要写两遍分支。
 */
export interface CollabRoomPostedVerb {
  type: 'room:posted'
  roomId: string
  author: CollabActorRef
  message: CollabMessageLike
}

/** 发牌:拿到租约才能 speak(§1.4)。 */
export interface CollabRoomFloorGrantedVerb {
  type: 'room:floor-granted'
  roomId: string
  agentId: string
  lease: FloorLease
}

export type CollabFloorRevokeReason =
  /** agent 自己让位。 */
  | 'yield'
  /** 墙钟到点。 */
  | 'expired'
  /** 换代作废(换相/重启/人类插话)。 */
  | 'epoch-bumped'
  /** 房间被冻住(闸)。 */
  | 'frozen'
  /** 裁判换了发言策略。 */
  | 'policy-changed'
  /**
   * 用户点名把这一张牌收回来(E5 人级停止)。
   *
   * 与 `epoch-bumped` 的分别是**范围**,不是力度:换代把在外的牌一起作废(「停下
   * 这间房」),这一条只动被点名的那一张,同房其他人一个字都不受影响。时间轴上
   * 两者必须分得开 —— 一行写着「换代」的记录会让人以为整间房停过。
   */
  | 'revoked'

export interface CollabRoomFloorRevokedVerb {
  type: 'room:floor-revoked'
  roomId: string
  agentId: string
  leaseId: string
  reason: CollabFloorRevokeReason
}

/**
 * 换相。狼人杀这类回合制的裁判第一次有了一等表达:夜晚只激活狼房、白天只激活群房。
 * `epoch` 跟着涨 —— 换相即作废在外的全部租约,不需要逐一通知。
 */
export interface CollabRoomPhaseChangedVerb {
  type: 'room:phase-changed'
  roomId: string
  phase: string
  previousPhase?: string
  epoch: number
}

export interface CollabRoomMembershipChangedVerb {
  type: 'room:membership-changed'
  roomId: string
  joined: string[]
  left: string[]
}

export type CollabCardEventKind = 'created' | 'assigned' | 'started' | 'delivered' | 'blocked' | 'closed'

/** 看板动静。board.json 零迁移,这里只是把它的变化搬上协议面。 */
export interface CollabRoomCardEventVerb {
  type: 'room:card-event'
  roomId: string
  cardId: string
  event: CollabCardEventKind
  assigneeId?: string
  title?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent → Room
// ─────────────────────────────────────────────────────────────────────────────

export type CollabHandUrgency = 'low' | 'normal' | 'high'

/** 举手。`free` 策略下房间一次裁决一批举手(qm P0-2:O(N) → O(1))。 */
export interface CollabAgentRaiseHandVerb {
  type: 'agent:raise-hand'
  roomId: string
  agentId: string
  why?: string
  urgency?: CollabHandUrgency
  /** 触发这次举手的房间消息(链闸清零判定要它)。 */
  sourceMessageId?: string
}

/**
 * 说话 —— **唯一发送面**(send_message 的协议形态,C1/C2 资产原样沿用)。
 * 必须带租约:没牌的 speak 由房间拒收,这是「说话即行动」的结构保证。
 */
export interface CollabAgentSpeakVerb {
  type: 'agent:speak'
  roomId: string
  agentId: string
  leaseId: string
  content: string
  mentions?: CollabMentionLike[]
  replyToMessageId?: string
}

export type CollabYieldReason = 'done' | 'pass' | 'nothing-to-add' | 'budget'

/** 让位:主动交牌。与房间强制收回在账上是同一个事实,理由留在这里。 */
export interface CollabAgentYieldVerb {
  type: 'agent:yield'
  roomId: string
  agentId: string
  leaseId: string
  reason?: CollabYieldReason
}

/** 开一间私聊房(dm)。peer 可能是人,也可能是另一个 agent。 */
export interface CollabAgentDmOpenVerb {
  type: 'agent:dm-open'
  agentId: string
  peerId: string
  peerKind: 'agent' | 'user'
}

/** 跨房唤醒:把另一间房里的人叫过来。带清零标记(A2)。 */
export interface CollabAgentWakeVerb {
  type: 'agent:wake'
  agentId: string
  roomId: string
  peerId: string
  note?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Referee → Room
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 发言策略(§1.5)。v2 的 planner/plan-runner/speaking-order/willingness-runner
 * 四条代码路径,在 v3 是这一个枚举的四个取值。
 */
export type CollabFloorPolicyName =
  /** 自由发言 + 批量举手裁决(默认;裁判缺席时房间内置这一档)。 */
  | 'free'
  /** 免判定的确定性接力环。 */
  | 'ring'
  /** 批内并行、批间串行。 */
  | 'waves'
  /** 相位控制:只有当前相位的成员被激活。 */
  | 'phase'

export interface CollabFloorPolicyParams {
  /** 同时在外的租约上限。0 / 缺省 = 不限(与其它闸同一套约定)。 */
  maxConcurrent?: number
  /** `ring`:接力次序。 */
  order?: string[]
  /** `waves`:批次划分。 */
  waves?: string[][]
  /** `phase`:切到哪个相位。 */
  phase?: string
  /** `phase`:该相位里允许说话的成员。 */
  activeMembers?: string[]
  /**
   * `phase`:**当前相位只有这些房能发牌**(D3)。
   *
   * 相位是跨房的:狼人杀的夜相里狼房活、群房死,而"活"这件事只有房间自己判得了
   * ——所以裁判把整张活跃表下发给每一间房,每间房拿自己的 id 去对。给一张表而不是
   * 给一个布尔,是因为布尔要求裁判知道自己此刻在跟谁说话,而下发是广播式的。
   *
   * 缺省(未配)= 所有房都活跃 —— 一间没配相位表的房不该因为别人换了相位就哑掉。
   */
  activeRooms?: string[]
  /**
   * `ring` / `waves`:一趟最多跑几圈(批)。**0 / 缺省 = 不限**。
   *
   * 「接力收棒权在配置(relayLoops)不在模型」这条已拍板决策的落点(§8)。名字沿用
   * v2 的 `relayLoops` —— 它在设置面板里已经是这个意思,换个名字只会让同一个旋钮
   * 在两代之间对不上号。
   */
  relayLoops?: number
  /** `waves`:走完全部批次之后要不要从头再来(v2 `CollabPlan.cycle` 的同一格)。 */
  cycle?: boolean
  /**
   * `free`:这间房挂了裁判 —— 举手先进**裁决窗**,等一次批量裁决,而不是直接 FIFO。
   *
   * 挂在 params 而不是另开一个动词:裁判在不在,本来就是"这间房用哪一档发言策略"
   * 的一部分。
   */
  referee?: boolean
  /**
   * **裁决结果**:这一次触发的授牌次序(qm P0-2,O(N)→O(1))。
   *
   * 为什么裁决走 `set-floor-policy` 而不是新开一个 `referee:verdict` 动词:蓝图 §2
   * 的动词表里 referee→room 只有这一个动词,而一次裁决答的正是「这一轮的发言策略
   * 是什么次序」。新增一个只在一种策略下有意义的动词,换来的是每个消费端的穷尽
   * switch 都要多一个分支,而它们对这件事无话可说。
   */
  verdict?: string[]
  /** 裁决认领的窗口 id。对不上的裁决(上一次触发的)房间直接丢弃。 */
  verdictToken?: string
  /**
   * 这一次裁决**管得着的人** —— 裁判现取的那批候选(不是开窗那一刻的快照)。
   *
   * 房间拿它分「判过、没点名 → 放手」与「窗在飞的时候才举的 → 留着进下一扇窗」。
   * 判据必须由**裁判**报回来:窗是第一只手开的,其余的手是随后异步到的,裁判读的
   * 是它现取的那一份 —— 房间那侧的开窗快照只是下限,拿它当分母会把后到的手全部
   * 误留,而那正是「幽灵排队」的形状。
   */
  verdictCandidates?: string[]
  /** 裁决没答上来(超时 / 读不懂)—— 房间回落 D1 的举手 FIFO。 */
  verdictDegraded?: boolean
  /** 一句话理由。进房间账的 notices 与状态条,不进模型。 */
  why?: string
}

export interface CollabRefereeSetFloorPolicyVerb {
  type: 'referee:set-floor-policy'
  roomId: string
  refereeId: string
  policy: CollabFloorPolicyName
  params?: CollabFloorPolicyParams
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent → self
// ─────────────────────────────────────────────────────────────────────────────

/** 私人笔记增量。跨房可见,注入有预算上限 —— 它是唯一显式的跨房知识通道。 */
export interface CollabAgentNoteVerb {
  type: 'agent:note'
  agentId: string
  note: string
  /** 这条笔记记于哪间房(可空:不是每条笔记都有房间语境)。 */
  roomId?: string
}

/** 派生工作子 actor:一张卡一双手。「一个大脑」只约束对话性回合(§1.6)。 */
export interface CollabAgentSpawnWorkerVerb {
  type: 'agent:spawn-worker'
  agentId: string
  workerId: string
  cardId: string
  roomId: string
  title?: string
  /** 卡的详情 —— 进任务书。标题装不下的那一半在这里。 */
  description?: string
  /**
   * 续做:接着这条工作会话往下做(collab-team-v2 §5.3 的 v3 形态)。
   *
   * 缺席 = 新开一条。重开一条新会话等于把现场扔掉,让模型从零开始猜自己上次
   * 做到哪儿了;重驱**同一条**则什么都不用做 —— 它自己的转录就是现场。
   */
  workSessionId?: string
}

/**
 * 一份工作的终局。
 *
 * 前五个与端口的终端事件一一对应,另外两个是这一层自己的判断:
 *  - `blocked` —— 它在看板上如实标了受阻。**与 `error` 必须分得开**:受阻是一个
 *    结论(做不下去了,原因在卡上),error 是这一轮压根没跑成。
 *  - `interrupted` —— 它没能自己收尾(进程死了),由父的重启对账认领。
 */
export type CollabWorkerOutcome =
  | 'complete'
  | 'blocked'
  | 'error'
  | 'aborted'
  | 'timeout'
  | 'skipped'
  | 'interrupted'

/**
 * evidence 的一条引用。**只有引用,没有全文**(与折叠信封同一条保密纪律)。
 *
 * `kind: 'file'` 是它写过的一个路径,`kind: 'tool'` 是它调过的一个工具与次数。
 * 两者都是**代码采集**的 —— 模型写不了这一格,那正是它存在的理由(v2 W9b.4)。
 */
export interface CollabWorkerEvidenceRef {
  kind: 'file' | 'tool'
  ref: string
  count?: number
}

/** 子 actor 的结果回投父 mailbox:父在下一个对话回合自然「知道自己的活干完了」。 */
export interface CollabAgentWorkerResultVerb {
  type: 'agent:worker-result'
  agentId: string
  workerId: string
  cardId: string
  roomId: string
  outcome: CollabWorkerOutcome
  /** 交回父的一句话(已截断、已转义)。 */
  summary?: string
  /** 代码采集的执行痕迹。只带引用 —— 正文留在工作会话里。 */
  evidence?: CollabWorkerEvidenceRef[]
  /** 这一段跑在哪条工作会话里(续做与排障读它)。 */
  workSessionId?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 联合、方向、穷尽守卫
// ─────────────────────────────────────────────────────────────────────────────

export type CollabActorVerb =
  | CollabRoomPostedVerb
  | CollabRoomFloorGrantedVerb
  | CollabRoomFloorRevokedVerb
  | CollabRoomPhaseChangedVerb
  | CollabRoomMembershipChangedVerb
  | CollabRoomCardEventVerb
  | CollabAgentRaiseHandVerb
  | CollabAgentSpeakVerb
  | CollabAgentYieldVerb
  | CollabAgentDmOpenVerb
  | CollabAgentWakeVerb
  | CollabRefereeSetFloorPolicyVerb
  | CollabAgentNoteVerb
  | CollabAgentSpawnWorkerVerb
  | CollabAgentWorkerResultVerb

export type CollabActorVerbType = CollabActorVerb['type']

export type CollabActorVerbDirection = 'room->agent' | 'agent->room' | 'referee->room' | 'agent->self'

/** 动词全表,按方向分组。运行时校验与文档都读它。 */
export const COLLAB_ACTOR_VERB_TYPES = [
  'room:posted',
  'room:floor-granted',
  'room:floor-revoked',
  'room:phase-changed',
  'room:membership-changed',
  'room:card-event',
  'agent:raise-hand',
  'agent:speak',
  'agent:yield',
  'agent:dm-open',
  'agent:wake',
  'referee:set-floor-policy',
  'agent:note',
  'agent:spawn-worker',
  'agent:worker-result',
] as const satisfies readonly CollabActorVerbType[]

/**
 * 双向穷尽守卫:联合里有而表里没有 → 红;表里有而联合里没有 → 也红。
 * 只查一个方向的话,删掉一个动词的类型定义可以悄悄溜过去。
 */
type VerbTableMissing = Exclude<CollabActorVerbType, (typeof COLLAB_ACTOR_VERB_TYPES)[number]>
type VerbTableStray = Exclude<(typeof COLLAB_ACTOR_VERB_TYPES)[number], CollabActorVerbType>
export const COLLAB_ACTOR_VERB_TABLE_IS_EXHAUSTIVE: [VerbTableMissing] extends [never]
  ? [VerbTableStray] extends [never]
    ? true
    : never
  : never = true

/**
 * 动词方向。这个 switch 就是 C3 纪律的落点 —— `default` 分支把 `verb` 收窄成
 * `never`,新增动词没在这里处理的话,`assertNeverVerb` 的参数类型当场红。
 */
export function collabActorVerbDirection(verb: CollabActorVerb): CollabActorVerbDirection {
  switch (verb.type) {
    case 'room:posted':
    case 'room:floor-granted':
    case 'room:floor-revoked':
    case 'room:phase-changed':
    case 'room:membership-changed':
    case 'room:card-event':
      return 'room->agent'
    case 'agent:raise-hand':
    case 'agent:speak':
    case 'agent:yield':
    case 'agent:dm-open':
    case 'agent:wake':
      return 'agent->room'
    case 'referee:set-floor-policy':
      return 'referee->room'
    case 'agent:note':
    case 'agent:spawn-worker':
    case 'agent:worker-result':
      return 'agent->self'
    default:
      return assertNeverVerb(verb)
  }
}

function assertNeverVerb(verb: never): never {
  throw new Error(`[collab-actor] unhandled verb: ${JSON.stringify(verb)}`)
}

export function isCollabActorVerbType(value: string): value is CollabActorVerbType {
  return (COLLAB_ACTOR_VERB_TYPES as readonly string[]).includes(value)
}

/** 动词的发起方地址 —— 投递时当信封的 `from`。 */
export function collabActorVerbSender(verb: CollabActorVerb): CollabActorRef {
  switch (collabActorVerbDirection(verb)) {
    case 'room->agent':
      return collabActorRef('room', (verb as CollabRoomPostedVerb).roomId)
    case 'referee->room':
      return collabActorRef('referee', (verb as CollabRefereeSetFloorPolicyVerb).refereeId)
    case 'agent->room':
    case 'agent->self':
      return collabActorRef('agent', (verb as CollabAgentSpeakVerb).agentId)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 构造函数。手搓字面量会把 `type` 打错而 TS 只在赋值处才发现,
// 走构造函数则错在调用点当场暴露。
// ─────────────────────────────────────────────────────────────────────────────

export function collabRoomPosted(input: Omit<CollabRoomPostedVerb, 'type'>): CollabRoomPostedVerb {
  return { type: 'room:posted', ...input }
}

export function collabRoomFloorGranted(
  input: Omit<CollabRoomFloorGrantedVerb, 'type'>,
): CollabRoomFloorGrantedVerb {
  return { type: 'room:floor-granted', ...input }
}

export function collabRoomFloorRevoked(
  input: Omit<CollabRoomFloorRevokedVerb, 'type'>,
): CollabRoomFloorRevokedVerb {
  return { type: 'room:floor-revoked', ...input }
}

export function collabRoomPhaseChanged(
  input: Omit<CollabRoomPhaseChangedVerb, 'type'>,
): CollabRoomPhaseChangedVerb {
  return { type: 'room:phase-changed', ...input }
}

export function collabRoomMembershipChanged(
  input: Omit<CollabRoomMembershipChangedVerb, 'type'>,
): CollabRoomMembershipChangedVerb {
  return { type: 'room:membership-changed', ...input }
}

export function collabRoomCardEvent(input: Omit<CollabRoomCardEventVerb, 'type'>): CollabRoomCardEventVerb {
  return { type: 'room:card-event', ...input }
}

export function collabAgentRaiseHand(
  input: Omit<CollabAgentRaiseHandVerb, 'type'>,
): CollabAgentRaiseHandVerb {
  return { type: 'agent:raise-hand', ...input }
}

export function collabAgentSpeak(input: Omit<CollabAgentSpeakVerb, 'type'>): CollabAgentSpeakVerb {
  return { type: 'agent:speak', ...input }
}

export function collabAgentYield(input: Omit<CollabAgentYieldVerb, 'type'>): CollabAgentYieldVerb {
  return { type: 'agent:yield', ...input }
}

export function collabAgentDmOpen(input: Omit<CollabAgentDmOpenVerb, 'type'>): CollabAgentDmOpenVerb {
  return { type: 'agent:dm-open', ...input }
}

export function collabAgentWake(input: Omit<CollabAgentWakeVerb, 'type'>): CollabAgentWakeVerb {
  return { type: 'agent:wake', ...input }
}

export function collabRefereeSetFloorPolicy(
  input: Omit<CollabRefereeSetFloorPolicyVerb, 'type'>,
): CollabRefereeSetFloorPolicyVerb {
  return { type: 'referee:set-floor-policy', ...input }
}

export function collabAgentNote(input: Omit<CollabAgentNoteVerb, 'type'>): CollabAgentNoteVerb {
  return { type: 'agent:note', ...input }
}

export function collabAgentSpawnWorker(
  input: Omit<CollabAgentSpawnWorkerVerb, 'type'>,
): CollabAgentSpawnWorkerVerb {
  return { type: 'agent:spawn-worker', ...input }
}

export function collabAgentWorkerResult(
  input: Omit<CollabAgentWorkerResultVerb, 'type'>,
): CollabAgentWorkerResultVerb {
  return { type: 'agent:worker-result', ...input }
}
