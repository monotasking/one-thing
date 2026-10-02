/**
 * RoomActor 的**账与规则**(docs/design/collab-actor-v3.md §1.4 / §3)。
 *
 * 房间在 v3 里只剩三件事:**转录**(消息落在哪)、**发言权**(谁能开口)、
 * **三道闸**(冻结 / 预算 / 链)。这个文件是后两件的全部规则,写成一组
 * **纯函数**:输入一份账 + 一个动词 + 一组闸读数,输出一份新账 + 一串效果。
 *
 * 为什么规则与 actor 分家:
 *
 * 1. **单账无双实现**(§1.4 的硬要求)。v2 的链计数有两套 —— live 那侧
 *    `noteAgentSpoke` 逐条 ++,重启那侧 `computeCollabChainCount` 扫转录重算,
 *    两套公式漂过不止一次(harvest 该不该计、thinking 该不该计、外部注入清不清
 *    零,每一条都是补出来的)。v3 只留一条:**链数 = 上一个清零事件以来发出的
 *    租约数**。live 是这个 reducer 跑一遍,重放是同一个 reducer 再跑一遍 ——
 *    不是"两份实现对得上",是**同一份实现跑两次**。
 *
 * 2. **金重放要的是同步决策**。重放架的管线接缝是同步的(`onPosted` 直接返回
 *    动词),而 actor 的循环是异步的。把决策抽成纯函数之后,真机与重放走的是
 *    同一行代码,快照才有资格当行为对照。
 *
 * 三面纪律(§3)在这里的落点:这一层只产出**账**(返回值)与**转录**(effects
 * 里的 messages),谁把它们落盘是 `app/collab/actors/` 的事;流(在飞租约的
 * 内存态)不存在于这里 —— 租约本身就是账的一部分,重启后照样验得出真伪。
 */
import type { FloorLease, FloorLeaseLedger } from '@onething/backend/core/actors'
import {
  activeFloorLeases,
  bumpFloorEpoch,
  canIssueFloorLease,
  createFloorLeaseLedger,
  isFloorLeaseExpired,
  issueFloorLease,
  pruneFloorLeases,
  revokeFloorLease,
  validateFloorLeaseId,
} from '@onething/backend/core/actors'

import { collabChainGateAllows, type CollabActivationReason } from '../activation.js'
import { collabMessageResetsChain } from '../chain.js'
import { COLLAB_SAY_SOURCE, isCollabRoomFact } from '../classify.js'
import { stripCollabAgentHandles, type CollabAddressable } from '../handles.js'
import { resolveCollabMentionIds } from '../mentions.js'
import {
  COLLAB_SAY_REFUSED_BUDGET,
  COLLAB_SAY_REFUSED_EMPTY,
  COLLAB_SAY_REFUSED_FROZEN,
  COLLAB_SAY_REFUSED_NOT_MEMBER,
  normalizeCollabSayContent,
  resolveCollabSayMentions,
} from '../say.js'
import { buildCollabChainHoldLine } from '../system-lines.js'
import type { CollabAgentLike, CollabMentionLike } from '../types.js'
import {
  createCollabFreeFloorPolicy,
  resolveCollabFloorPolicy,
  type CollabFloorPolicyState,
  type CollabRaisedHand,
} from './floor-policy.js'
import {
  collabJudgmentToken,
  isCollabRoomJudgmentShape,
  type CollabRoomJudgment,
  type CollabRoomJudgmentRequest,
} from './referee-rules.js'
import {
  collabActorRef,
  collabRoomFloorGranted,
  collabRoomFloorRevoked,
  collabRoomPhaseChanged,
  collabRoomPosted,
  type CollabActorVerb,
  type CollabAgentRaiseHandVerb,
  type CollabAgentSpeakVerb,
  type CollabAgentYieldVerb,
  type CollabFloorPolicyName,
  type CollabFloorPolicyParams,
  type CollabFloorRevokeReason,
  type CollabRefereeSetFloorPolicyVerb,
  type CollabRoomPostedVerb,
} from './protocol.js'

/**
 * v3 房间账的版本号。
 *
 * **不是** v2 `state.json` 的 `version: 1` 的续号 —— 两份账是两个文件、两套
 * 字段、两条生命周期(v2 那份归 coordinator,D6 才删)。共用一个版本号会让
 * 「读到 1 该按哪套解析」变成一个真问题。
 */
export const COLLAB_ROOM_ACCOUNT_VERSION = 1

/** 一次广播的在飞记录 —— 崩溃点续播的账(§1.4「成员 mailbox 逐一投递」)。 */
export interface CollabRoomPendingBroadcast {
  /** 事件身份。确定性派生,重投不变 —— 消费端的去重窗按它认。 */
  eventId: string
  /** 还没投到的成员,按序。投一个删一个,空了整条记录移除。 */
  pending: string[]
  /** 事件本体。续播时不重新决策 —— 决策已经发生过了,再决策一次就是两个事实。 */
  verb: CollabActorVerb
  at: number
}

/**
 * 房间账。**同步原子写、先于转录**(§3)。
 *
 * `floor` 直接嵌 core 的租约账:代数、在外的牌、撤销过的牌号,一份不拆。拆开
 * 存(比如只存 leaseId 列表)等于在这里重实现一遍 core 已经测过的验票规则。
 */
export interface CollabRoomAccount {
  version: typeof COLLAB_ROOM_ACCOUNT_VERSION
  roomId: string
  /** 在飞租约表 + 代数 + 撤销史(core `FloorLeaseLedger`)。 */
  floor: FloorLeaseLedger
  /**
   * 链计数 = **上一个清零事件以来发出的租约数**。
   *
   * 计在发牌那一刻,而不是说话那一刻 —— 这一条同时解掉了 v2 的两个病:
   *  - 并行超发:v2 的 `chainCount` 要等回合收尾才 +=,同批起跑的 N 条读到同一个
   *    旧计数各自过闸,于是要靠一张 `floorHolds` 预占表把闸补回来(A1)。发牌即
   *    计数之后,预占这个概念直接不存在;
   *  - live/重放双实现:数"说了几句"要认 harvest / thinking / pass 三种标记,
   *    数"发了几张牌"只要数 `room:floor-granted`。
   */
  chainCount: number
  /** 最近一次清零是哪条消息干的(排障与对账)。 */
  chainResetMessageId?: string
  /** 已消费到哪条消息。只前进,不后退(v2 `advanceWatermark` 的同一条纪律)。 */
  watermark: { messageId?: string; at?: number }
  /** 当前相位(`phase` 策略)。 */
  phase?: string
  /** 当前发言策略。裁判缺席 = `free`。 */
  policy: { name: CollabFloorPolicyName; params?: CollabFloorPolicyParams }
  /**
   * 策略自己的游标(`ring` 的环位、`waves` 的批位)。
   *
   * 住在账里而不是策略对象里:策略是每次决策现 `resolve` 出来的,而且崩溃后要重建
   * ——一个活在闭包里的游标,重启之后环就从头开始了。换策略时整袋清空。
   */
  policyState?: CollabFloorPolicyState
  /**
   * 裁决窗(D3,`free` + 挂了裁判)。**同一间房只有一扇**。
   *
   * 它就是 qm P0-2 的 O(N)→O(1) 的落点:窗按**触发事件**开,窗开着的时候再来十只
   * 手也还是那一次调用。窗的生死全在这一格上,没有第二份状态可漂。
   */
  judgment?: CollabRoomJudgment
  /** 开过几扇裁决窗。窗的 token 由它派生 —— 随机 id 会让金重放每次都变。 */
  judgmentSeq: number
  /**
   * 最近一次**裁决降级**(D8 观测体系 O2:黄牌要有地方站)。
   *
   * 为什么必须多这一格:降级发生在 `applyCollabRoomSetPolicy` 的 token 分支里,而
   * 那一步紧接着就调 `grantFloor` —— 后者把「不是 pending 的窗」一律关掉(那是对的,
   * 一份答完的裁决留着只会让下一次决策拿陈旧的结果发牌)。于是 `judgment: 'degraded'`
   * 这个态**在同一个同步步里生灭**,任何一份快照都读不到它,黄牌永远亮不起来。
   *
   * 所以降级的"留痕"与裁决窗的"生死"必须是两格:窗照旧当场关掉,痕留到**下一次
   * 开窗**才清 —— 而不是下一条消息、不是一个墙钟超时。判据是「这间房又去买了一次
   * 裁决」:那一刻上一次降级才真正翻篇,在此之前它一直是这间房现在这个样子的解释。
   *
   * 与 `judgment` 同为账里的一格而不是现算:成因(超时/读不懂/端口炸)只有裁判那侧
   * 知道,而它经由 `verdictDegraded` 那一步之后就消失了 —— 现算无从算起。完整成因
   * 在时间轴的 `judge-degraded` 行上,这里只留一句话与一个时刻。
   */
  lastDegraded?: { reason: string; at: number }
  /** 举手队列。 */
  hands: CollabRaisedHand[]
  /** 发牌用的确定性牌号计数器。随机牌号会让金重放每次都变。 */
  leaseSeq: number
  /**
   * 每张在外的牌是**因为什么**发的。
   *
   * 不塞进 `FloorLease`(那是 core 的骨架类型,不认识 collab 的激活理由),也不
   * 从举手队列现查 —— 发牌那一刻手就从队里摘掉了,查不回来。快照的「谁在说、
   * 为什么」读它,D3 的批量裁决同样要它当输入。牌作废时一起清。
   */
  leaseReasons: Record<string, CollabActivationReason>
  /** 落库消息的确定性种子计数器(重放用;真机的 id 由宿主给)。 */
  messageSeq: number
  /**
   * 「同一次只说一遍」的闩锁(v2 `chainNoticePosted` / `frozenNoticePosted` 的
   * 泛化)。撞闸每次都贴一行,房间会被自己的运营噪声淹掉。
   */
  notices: { frozen: boolean; budget: boolean; chain: boolean }
  /** 在飞广播,按发生序。 */
  broadcasts: CollabRoomPendingBroadcast[]
  /**
   * 单调序号。每一次**对外可见的状态变化** +1,C4 的快照协议按它丢弃迟到的包。
   * 与 `CollabBoard.seq` / `CollabCoordinatorState.seq` 同一条纪律。
   */
  seq: number
}

/** 三道闸这一刻的读数 + 房间的形态。由宿主现取(它才知道设置与账本)。 */
export interface CollabRoomGates {
  /** 总闸:房间被暂停了。 */
  frozen: boolean
  /** 费用闸:今天的预算已经用完。 */
  overBudget: boolean
  /** 链闸上限。`Infinity` = 不限。 */
  maxChain: number
  /** 并发上限。0 或负数 = 不限。 */
  maxConcurrent: number
  /** 在职成员(授权面)。 */
  members: readonly CollabAgentLike[]
  /** 识别面:哪串字符算一个真身份(用户、退休成员)。缺省退回 `members`。 */
  directory?: readonly CollabAddressable[]
  /** agent ⇄ agent 的双成员私聊房 —— 链闸文案分支(那里没有人类可召唤)。 */
  pairDm?: boolean
  /**
   * 发出去的牌的墙钟上限(ms)。**缺省 = 不自动过期**,只能被让位、撤销或换代
   * 作废(core `FloorLease.ttlMs` 的同一套约定)。
   *
   * 为什么默认没有 ttl:一个回合合法地跑十分钟是常态(工具链路长),给它一个
   * 猜出来的墙钟只会在真机上表现为"说到一半被收了牌"。要收就由宿主显式配。
   */
  leaseTtlMs?: number
  now: number
  /** 预算行要的两个数(拿不到就退化成不带数字的那句)。 */
  budgetSpentUSD?: number
  budgetLimitUSD?: number
  /**
   * 这间房挂了裁判吗(D3)—— 挂了,`free` 的举手先进裁决窗。
   *
   * 与 `policy.params.referee` **求或**:裁判可以自己下发 `set-floor-policy` 把这一格
   * 打开(它接管这间房),宿主也可以按房间设置直接打开(用户在设置里挂的那个)。
   * 两条路都是同一件事,所以判据只有一条:任一为真即为真。
   */
  referee?: boolean
}

/**
 * RoomActor 落进房间转录的一条消息。
 *
 * **字段与 v2 的 `ChatMessage` 逐字段同形** —— 「转录零迁移」这条承诺就落在这个
 * 类型上:v3 写下的消息必须能被 v2 的分类器(`classifyCollabRoomMessage`)、
 * 投影(`isCollabRoomFact`)、渲染层一字不改地读懂。app 层有一条测试钉住它。
 */
export interface CollabRoomTranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  agentId?: string
  source?: string
  mentions?: CollabMentionLike[]
  collabChainReset?: boolean
}

/** 一次转换的产物。账是返回值,这些是副作用清单 —— 由 actor 去执行。 */
export interface CollabRoomEffects {
  /** 广播给成员 mailbox 的动词,按序。 */
  broadcast: CollabActorVerb[]
  /** 追加进房间转录的消息(账落盘之后才写:账先于转录)。 */
  messages: CollabRoomTranscriptMessage[]
  /** 这一步真正发出去的牌 —— 调用方要把它交到 agent 手上。 */
  granted: FloorLease[]
  /** 动词被拒时给调用方的可操作文案(措辞是 C1/C2 资产,一个字不动)。 */
  refusal?: string
  /**
   * 这一步开出来的**裁决窗** —— 调用方(RefereeActor)拿它去买那一次模型调用。
   *
   * 是一张待办而不是一次调用:决策必须是同步的(金重放与真机走同一行代码),而
   * 模型调用不可能同步。房间开完窗就把手挂起,答案什么时候回来是裁判那一侧的事。
   */
  judgment?: CollabRoomJudgmentRequest
}

export interface CollabRoomStep {
  account: CollabRoomAccount
  effects: CollabRoomEffects
}

/** 落库消息的 id 来源。重放传确定性派生,真机传 `randomUUID`。 */
export interface CollabRoomIdSource {
  newMessageId(seed: string): string
}

/* ── 拒绝与系统行文案 ──────────────────────────────────────────────────────
 *
 * 冻结/预算这两句与 v2 `queue.ts` / `budget.ts` 里的字面量**逐字相同**。这里
 * 复制而不是抽公共导出,是因为那两个文件属于 v2 调度链,D6 会整层删掉 ——
 * 为一段活不过这个月的代码去改它,换来的只是一次多余的回归面。删掉那一侧时
 * 这里就是唯一的一份。
 */

/** 房间被暂停,@ 落了空。群房那句(v2 queue.ts 的同一串字)。 */
export const COLLAB_ROOM_FROZEN_LINE = '房间已暂停,@ 暂时无人应答——恢复后再说一声'
/** 同上,双成员私聊版 —— 那里说"无人应答"读着别扭(没有别人)。 */
export const COLLAB_ROOM_FROZEN_LINE_DM = '这间私聊已暂停,TA 暂时不会回复——恢复后再说一声'

/** 预算闸的房间行(v2 budget.ts 的同一串字)。 */
export function buildCollabRoomBudgetHoldLine(options: {
  spentUSD?: number
  limitUSD?: number
}): string {
  if (typeof options.spentUSD !== 'number' || typeof options.limitUSD !== 'number') {
    return '今天这个房间的预算已经用完——明天自动恢复,或调整房间预算'
  }
  return `今天这个房间已花费 $${options.spentUSD.toFixed(2)},达到日预算 $${options.limitUSD}`
    + '——明天自动恢复,或调整房间预算'
}

/**
 * 没牌就开口。
 *
 * 这是 v3 才有的失败态 —— v2 里"能不能说"是调度决定的,agent 手上没有可以
 * 拿错的东西。措辞沿用 §4.5 的送达态口径:说清没送达,并说清下一步。
 */
export const COLLAB_SPEAK_REFUSED_NO_LEASE =
  '消息未送达:你现在没有这间群聊的发言权。先举手(raise-hand),拿到发言权再说。'
/** 手里的牌是上一代的 —— 换相/重启/用户喊停之后。 */
export const COLLAB_SPEAK_REFUSED_STALE_LEASE =
  '消息未送达:你手里的发言权已经作废了(这间群聊换过一轮)。重新举手再说。'
/** 牌过期了(墙钟)。 */
export const COLLAB_SPEAK_REFUSED_EXPIRED_LEASE =
  '消息未送达:你的发言权已经超时收回了。重新举手再说。'
/** 拿着别人的牌说话。 */
export const COLLAB_SPEAK_REFUSED_LEASE_OWNER =
  '消息未送达:这张发言权不是发给你的。'

/* ── 账的构造与形状校验 ──────────────────────────────────────────────────── */

export function createCollabRoomAccount(
  roomId: string,
  options: { epoch?: number; policy?: CollabFloorPolicyName } = {},
): CollabRoomAccount {
  return {
    version: COLLAB_ROOM_ACCOUNT_VERSION,
    roomId,
    floor: createFloorLeaseLedger(roomId, options.epoch),
    chainCount: 0,
    watermark: {},
    policy: { name: options.policy ?? 'free' },
    judgmentSeq: 0,
    hands: [],
    leaseSeq: 0,
    leaseReasons: {},
    messageSeq: 0,
    notices: { frozen: false, budget: false, chain: false },
    broadcasts: [],
    seq: 0,
  }
}

/**
 * 读回来的账做一次形状归一。
 *
 * 半份账比没有账更糟:一个 `floor.active` 读成 undefined 的房间会在第一次发牌时
 * 炸在 `[...undefined]` 上,而那一刻离"文件是什么时候写坏的"已经很远了。认不出
 * 形状就当新账 —— 代价是一次链计数归零(下一条人类消息本来也会归零)。
 */
export function normalizeCollabRoomAccount(value: unknown, roomId: string): CollabRoomAccount {
  const fresh = createCollabRoomAccount(roomId)
  if (!value || typeof value !== 'object') return fresh
  const raw = value as Partial<CollabRoomAccount>
  if (raw.version !== COLLAB_ROOM_ACCOUNT_VERSION) return fresh

  const floor = raw.floor
  const ledger: FloorLeaseLedger = floor && typeof floor === 'object' && Array.isArray(floor.active)
    ? {
        roomId,
        epoch: typeof floor.epoch === 'number' ? floor.epoch : fresh.floor.epoch,
        active: floor.active.filter(isFloorLeaseShape),
        revoked: Array.isArray(floor.revoked) ? floor.revoked.filter(id => typeof id === 'string') : [],
      }
    : fresh.floor

  return {
    version: COLLAB_ROOM_ACCOUNT_VERSION,
    roomId,
    floor: ledger,
    chainCount: typeof raw.chainCount === 'number' && raw.chainCount >= 0 ? raw.chainCount : 0,
    ...(typeof raw.chainResetMessageId === 'string' ? { chainResetMessageId: raw.chainResetMessageId } : {}),
    watermark: raw.watermark && typeof raw.watermark === 'object' ? { ...raw.watermark } : {},
    ...(typeof raw.phase === 'string' ? { phase: raw.phase } : {}),
    policy: raw.policy && typeof raw.policy.name === 'string' ? { ...raw.policy } : { name: 'free' },
    ...(raw.policyState && typeof raw.policyState === 'object'
      ? { policyState: { ...raw.policyState } }
      : {}),
    // 认不出形状的裁决窗当**没开过**:一扇半份的窗会让房间永远挂着手等一个不会来
    // 的答案(比丢一次裁决贵得多 —— 丢一次裁决只是这轮回落 FIFO)。
    ...(isCollabRoomJudgmentShape(raw.judgment) ? { judgment: { ...raw.judgment } } : {}),
    judgmentSeq: typeof raw.judgmentSeq === 'number' ? raw.judgmentSeq : 0,
    // 认不出形状就当没降级过 —— 一句读不出来的解释不如没有解释(黄牌宁可不亮,
    // 也不要亮成一句空话)。
    ...(isLastDegradedShape(raw.lastDegraded) ? { lastDegraded: { ...raw.lastDegraded } } : {}),
    hands: Array.isArray(raw.hands) ? raw.hands.filter(isRaisedHandShape) : [],
    leaseSeq: typeof raw.leaseSeq === 'number' ? raw.leaseSeq : 0,
    leaseReasons: raw.leaseReasons && typeof raw.leaseReasons === 'object' ? { ...raw.leaseReasons } : {},
    messageSeq: typeof raw.messageSeq === 'number' ? raw.messageSeq : 0,
    notices: {
      frozen: raw.notices?.frozen === true,
      budget: raw.notices?.budget === true,
      chain: raw.notices?.chain === true,
    },
    broadcasts: Array.isArray(raw.broadcasts) ? raw.broadcasts.filter(isPendingBroadcastShape) : [],
    seq: typeof raw.seq === 'number' ? raw.seq : 0,
  }
}

function isFloorLeaseShape(value: unknown): value is FloorLease {
  if (!value || typeof value !== 'object') return false
  const lease = value as Partial<FloorLease>
  return typeof lease.leaseId === 'string'
    && typeof lease.epoch === 'number'
    && typeof lease.agentId === 'string'
    && typeof lease.issuedAt === 'number'
}

function isLastDegradedShape(value: unknown): value is { reason: string; at: number } {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<{ reason: string; at: number }>
  return typeof record.reason === 'string' && typeof record.at === 'number'
}

function isRaisedHandShape(value: unknown): value is CollabRaisedHand {
  if (!value || typeof value !== 'object') return false
  const hand = value as Partial<CollabRaisedHand>
  return typeof hand.agentId === 'string' && typeof hand.at === 'number'
    && (hand.origin === 'mention' || hand.origin === 'hand')
}

function isPendingBroadcastShape(value: unknown): value is CollabRoomPendingBroadcast {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<CollabRoomPendingBroadcast>
  return typeof record.eventId === 'string'
    && Array.isArray(record.pending)
    && !!record.verb
    && typeof (record.verb as { type?: unknown }).type === 'string'
}

/* ── 读口 ──────────────────────────────────────────────────────────────── */

/** 此刻手里有有效牌的人。发牌的「同 agent 不双持」与快照的 `speaking` 同读它。 */
export function collabRoomHolders(account: CollabRoomAccount, now: number): Set<string> {
  return new Set(activeFloorLeases(account.floor, now).map(lease => lease.agentId))
}

/** 此刻在外的有效牌。 */
export function collabRoomActiveLeases(account: CollabRoomAccount, now: number): FloorLease[] {
  return activeFloorLeases(account.floor, now)
}

/**
 * 一只举着的手卡在哪道闸上(D8 观测体系 §1「词汇表修正」)。
 *
 * 「排队中」在 v2 是一个笼统词,而它底下是六件成因完全不同的事 —— 前两个几秒后自解
 * (等裁决、等座位),后四个**必须有人动手**(链闸要人说句话、相位要换相、冻结要
 * 解冻、预算要改配额)。在这个函数之前它们在界面上长得一模一样,于是「怎么没人理我」
 * 这个问题只能靠猜。
 *
 * **现算,不落账** —— 它是解释不是状态:账里已经有全部素材(手、牌、闸、窗、相),
 * 再存一份就是第二本会漂的账。
 *
 * 次序照 `grantFloor` 里那几道闸的真实先后:冻结 → 预算 → 裁决窗 → 相位 → 座位 →
 * 链。读错次序的症状是"显示卡在链闸,实际是房间冻着",而那两句话要用户做的事完全
 * 不同。
 *
 * 与 wire 侧的 `CollabCoordinatorBlockedBy` 是同一套六个值,两份而不是一份:纯层
 * 不许引 shared 的 IPC 契约(边界检查器钉着),而这个判据的家在房账这边。装配层
 * 把它抄进快照时两边逐值对齐,app 层有测试钉住。
 */
export type CollabRoomHandBlock =
  | 'frozen'
  | 'budget'
  | 'judging'
  | 'phase'
  | 'seats'
  | 'chain'

export function resolveCollabRoomHandBlock(
  account: CollabRoomAccount,
  gates: CollabRoomGates,
): CollabRoomHandBlock {
  if (gates.frozen) return 'frozen'
  if (gates.overBudget) return 'budget'
  // 窗开着 = 手全部挂起等一个答案(那正是 O(1) 的定义)。
  if (account.judgment?.state === 'pending') return 'judging'
  if (account.policy.name === 'phase') {
    const activeRooms = account.policy.params?.activeRooms
    // `activeRooms` 缺席 = 这一相没划活跃房(全房都活跃),不算挂起。
    if (activeRooms && activeRooms.length > 0 && !activeRooms.includes(account.roomId)) return 'phase'
  }
  const seats = gates.maxConcurrent
  if (seats > 0 && collabRoomActiveLeases(account, gates.now).length >= seats) return 'seats'
  if (Number.isFinite(gates.maxChain) && account.chainCount >= gates.maxChain) return 'chain'
  // 闸全开着还举着手,在挂了裁判的自由发言房里意思是**等下一扇窗**(刚举的手赶不上
  // 这一扇,或者上一扇刚关)。归到「等座位」会当着一排空座位说"等人让位",而那正是
  // 真机走查抓到的那句假话。「裁决中」在这里是实话:它等的就是一次裁决。
  //
  // 判据与 `grantFloor` 里那一处求或同源:裁判可以自己接管这间房(params),
  // 宿主也可以按房间设置挂(gates)。
  if (account.policy.name === 'free' && (gates.referee === true || account.policy.params?.referee === true)) {
    return 'judging'
  }
  // 其余档(接力/编排/相位):这一批刚判完、牌马上就到。归到「等座位」是最不误导的
  // 一格:它说的是"轮到你了,再等一下",而不是"有人拦着你"。
  return 'seats'
}

/* ── 链账:唯一的一条公式 ────────────────────────────────────────────────── */

/** 链账认得的两种事件。其余动词与链无关。 */
export type CollabRoomChainEntry = { kind: 'reset' } | { kind: 'lease' }

/**
 * 一个动词对链账意味着什么。
 *
 * 只有两种:发出一张牌(+1)、一个清零事件(归零)。清零判据**直接复用 C1 的
 * `collabMessageResetsChain`** —— 人类 posted 与带 `collabChainReset` 标记的
 * 外部注入,一个字都不重写。
 */
export function collabRoomChainEntryOf(verb: CollabActorVerb): CollabRoomChainEntry | null {
  if (verb.type === 'room:floor-granted') return { kind: 'lease' }
  if (verb.type === 'room:posted' && collabMessageResetsChain(verb.message)) return { kind: 'reset' }
  return null
}

/**
 * 从一串动词重算链数。**重放对账用的就是它**。
 *
 * live 侧走的是 `applyCollabRoom*` 里的 `chainCount ± `,而两者必须逐条相等 ——
 * app 层有一条测试把同一份剧本的 live 值与这个 fold 值比死。
 */
export function foldCollabRoomChain(verbs: readonly CollabActorVerb[]): number {
  let count = 0
  for (const verb of verbs) {
    const entry = collabRoomChainEntryOf(verb)
    if (!entry) continue
    if (entry.kind === 'reset') count = 0
    else count += 1
  }
  return count
}

/* ── 内部:发牌 ────────────────────────────────────────────────────────── */

interface GrantOutcome {
  account: CollabRoomAccount
  broadcast: CollabActorVerb[]
  messages: CollabRoomTranscriptMessage[]
  granted: FloorLease[]
  judgment?: CollabRoomJudgmentRequest
}

function emptyEffects(): CollabRoomEffects {
  return { broadcast: [], messages: [], granted: [] }
}

/**
 * 一条运营系统行。
 *
 * 不打 source 标记 —— `classifyCollabRoomMessage` 因此读作 `operational-line`:
 * 只给人看,永不进模型投影(W9.1「机器的账不是房间的事实」)。序号由调用方传进来
 * 并接住返回值,一次转换里贴两行也不会撞 id。
 */
function systemLine(
  roomId: string,
  ids: CollabRoomIdSource,
  content: string,
  now: number,
  messageSeq: number,
): { message: CollabRoomTranscriptMessage; messageSeq: number } {
  const next = messageSeq + 1
  return {
    message: {
      id: ids.newMessageId(`${roomId}:sys:${next}`),
      role: 'system',
      content,
      timestamp: now,
    },
    messageSeq: next,
  }
}

/**
 * 发牌 —— 三道闸的**单点**。
 *
 * 次序是契约:先策略排队,再冻结,再预算,最后逐张过链闸。为什么链闸放最后 ——
 * 它是唯一**逐张**判定的闸(前两道是全房性质,撞上就整批停发),而逐张判定必须
 * 建立在"这一张真的要发"之上,否则一批被冻结吃掉的候选会白白把链数推高。
 *
 * D3 在"策略排队"那一步之后多了一件事:策略可能回答**「先别发,等裁决」**
 * (`decision.openJudgment`)。开窗写在闸的**里面**而不是外面 —— 一间冻住的、
 * 或者预算烧光的房不该去买一次裁决调用,而那正好是这两道闸站着的位置。
 */
function grantFloor(
  account: CollabRoomAccount,
  gates: CollabRoomGates,
  ids: CollabRoomIdSource,
  input: { mentioned?: readonly string[]; sourceMessageId?: string },
): GrantOutcome {
  const policy = resolveCollabFloorPolicy(account.policy.name)
  const holders = collabRoomHolders(account, gates.now)
  const memberIds = gates.members.map(member => member.id)
  const mentioned = (input.mentioned ?? []).filter(agentId => memberIds.includes(agentId))
  // 「挂了裁判」两条路求或:裁判自己下发的(params)、宿主按房间设置给的(gates)。
  const params: CollabFloorPolicyParams | undefined = gates.referee
    ? { ...account.policy.params, referee: true }
    : account.policy.params

  const decision = policy.decide({
    mentioned,
    hands: account.hands,
    holders,
    activeLeases: holders.size,
    maxConcurrent: gates.maxConcurrent,
    members: memberIds,
    roster: gates.members,
    roomId: account.roomId,
    ...(account.phase ? { phase: account.phase } : {}),
    ...(account.policyState ? { state: account.policyState } : {}),
    ...(account.judgment ? { judgment: account.judgment } : {}),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(gates.pairDm ? { pairDm: true } : {}),
    ...(params ? { params } : {}),
  })

  const broadcast: CollabActorVerb[] = []
  const messages: CollabRoomTranscriptMessage[] = []
  const granted: FloorLease[] = []

  let ledger = account.floor
  let chainCount = account.chainCount
  let leaseSeq = account.leaseSeq
  let messageSeq = account.messageSeq
  let judgmentSeq = account.judgmentSeq
  // 答完的窗当场关掉(不管这一轮有没有真发出牌):它已经是一个答案了,留着只会
  // 让下一次决策拿一份陈旧的裁决去发牌。还在 `pending` 的原样留着等答案。
  let judgment: CollabRoomJudgment | undefined =
    account.judgment?.state === 'pending' ? account.judgment : undefined
  let judgmentRequest: CollabRoomJudgmentRequest | undefined
  // 降级的痕活到**下一次开窗**(见 `CollabRoomAccount.lastDegraded`)。窗一开,
  // 这间房又去买裁决了,上一次降级才算翻篇。
  let lastDegraded = account.lastDegraded
  const notices = { ...account.notices }
  const leaseReasons = { ...account.leaseReasons }
  const issuedAgentIds = new Set<string>()

  /** 这一刻真的有人想说话吗 —— 没人想说,任何一道闸都没有开口的理由。 */
  const wanted = decision.grants.length > 0 || mentioned.length > 0 || decision.openJudgment === true

  // 闩锁由**它自己那道闸**放开,不由别的事件放开(v2:`frozenNoticePosted` 在
  // 解冻时清、`chainNoticePosted` 在清零时清)。共用一个清点会让"人类说了一句话"
  // 把冻结通知也一起放开,于是同一次暂停被反复播报。
  if (!gates.frozen) notices.frozen = false
  if (!gates.overBudget) notices.budget = false

  if (gates.frozen) {
    // 冻结吃掉一个 @ 必须说出来(P2-17):在一间自己一小时前暂停掉的房里写
    // 「@小李 看一下」而**什么都没发生**,读起来是房间坏了,不是房间停了。
    if (wanted && !notices.frozen) {
      notices.frozen = true
      const line = systemLine(
        account.roomId,
        ids,
        gates.pairDm ? COLLAB_ROOM_FROZEN_LINE_DM : COLLAB_ROOM_FROZEN_LINE,
        gates.now,
        messageSeq,
      )
      messages.push(line.message)
      messageSeq = line.messageSeq
    }
  } else if (gates.overBudget) {
    if (wanted && !notices.budget) {
      notices.budget = true
      const line = systemLine(
        account.roomId,
        ids,
        buildCollabRoomBudgetHoldLine({
          ...(gates.budgetSpentUSD === undefined ? {} : { spentUSD: gates.budgetSpentUSD }),
          ...(gates.budgetLimitUSD === undefined ? {} : { limitUSD: gates.budgetLimitUSD }),
        }),
        gates.now,
        messageSeq,
      )
      messages.push(line.message)
      messageSeq = line.messageSeq
    }
  } else {
    // 开裁决窗。**在闸里面**:冻住/烧光的房不该去买一次裁决调用。
    if (decision.openJudgment) {
      judgmentSeq += 1
      lastDegraded = undefined
      judgment = {
        token: collabJudgmentToken(account.roomId, judgmentSeq),
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        openedAt: gates.now,
        state: 'pending',
        // 这一批候选是谁 —— 答案回来时「谁该放手」按它分(见 `CollabRoomJudgment.candidates`)。
        candidates: account.hands.map(hand => hand.agentId),
      }
      judgmentRequest = {
        roomId: account.roomId,
        token: judgment.token,
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        openedAt: gates.now,
        // 开窗那一刻的手。裁判读它当**下限** —— 举手是异步到的,真正的候选它自己
        // 去房间现取(`CollabRefereeActorHost.candidates`)。
        candidates: account.hands.map(hand => ({ ...hand })),
      }
    }
    for (const candidate of decision.grants) {
      // 并发上限:策略已经按座位排过一遍,这里是账自己的复核 —— 策略是可替换的,
      // 闸不是。
      if (!canIssueFloorLease(ledger, gates.now, gates.maxConcurrent)) break

      if (!collabChainGateAllows({ reason: candidate.reason, chainCount, maxChain: gates.maxChain })) {
        // 顶格。队里的手不清 —— 它们在等下一个清零事件,而不是被丢掉。
        if (!notices.chain) {
          notices.chain = true
          const line = systemLine(
            account.roomId,
            ids,
            buildCollabChainHoldLine({
              maxChain: gates.maxChain,
              ...(gates.pairDm ? { pairDm: true } : {}),
            }),
            gates.now,
            messageSeq,
          )
          messages.push(line.message)
          messageSeq = line.messageSeq
        }
        break
      }

      leaseSeq += 1
      const issued = issueFloorLease(ledger, {
        agentId: candidate.agentId,
        now: gates.now,
        // 确定性牌号。随机牌号会让金重放的快照每次都变(D0 已为这条立过测试)。
        leaseId: `${account.roomId}#L${leaseSeq}`,
        ...(gates.leaseTtlMs === undefined ? {} : { ttlMs: gates.leaseTtlMs }),
      })
      ledger = issued.ledger
      // 发牌即计链(见 `CollabRoomAccount.chainCount` 的注释):v2 的预占账在
      // 这一行之后就没有存在的理由了。
      chainCount += 1
      leaseReasons[issued.lease.leaseId] = candidate.reason
      granted.push(issued.lease)
      issuedAgentIds.add(candidate.agentId)
      broadcast.push(collabRoomFloorGranted({
        roomId: account.roomId,
        agentId: candidate.agentId,
        lease: issued.lease,
      }))
    }
  }

  // 队列结算:发出去的手摘掉;被点名但没拿到牌的,**留在队首**等下一次机会 ——
  // @ 是直通授牌,座位满不该把它降级成一次普通举手。
  let hands = account.hands.filter(hand => !issuedAgentIds.has(hand.agentId))

  if (account.judgment?.state === 'resolved') {
    // 裁决是对**这一批候选**的终审:被裁过、没被点名的手**当场放下**(空裁决 =
    // 全放下)。
    //
    // 这里曾经是反过来的("留着等下一次触发"),前提是「一只手代表一个还没兑现的
    // 意愿」。D6-a 之后那个前提没了:举手判据变成"每条房间事实人人机械举手",下
    // 一条消息全员都会重新举一次,留旧手防不住任何东西 —— 它只造出两样坏东西,
    // 一是 UI 上永不清零的「N 人排队中」(座位全空却显示等座位),二是旧话题的手
    // 混进新话题的裁决窗。手随消息走,这一轮的沉默是合法答案。
    //
    // 三类手在这一步各走各的路:
    //  1. 被点名了 —— 留(下面那段的**渐进兑现**要它);
    //  2. 被裁过、没点名 —— 放下;
    //  3. **不在候选集里** —— 留。窗在飞的时候才举的手一次都没被裁过,连坐放下
    //     等于替裁判否掉一个它没看过的人。它们进下一扇窗。
    const named = new Set(account.judgment.grants ?? [])
    // 形状不对(读坏的账)与缺席同义 —— 落到"全放下",而不是让一次结算炸掉。
    const judged = Array.isArray(account.judgment.candidates) ? account.judgment.candidates : undefined
    hands = hands.filter(hand => named.has(hand.agentId)
      // 旧账没有候选集:按"这一批就是全部"处理 —— 存量僵尸手本来就该放。
      || (judged !== undefined && !judged.includes(hand.agentId)))

    // 裁决**分批兑现**:一份「bo 然后 ana」的裁决在只有一个座位时先发 bo,剩下的
    // 那半份留在窗里 —— 等 bo 让位,ana 直接按这份裁决上场。
    //
    // 不留的话,每一次让位都会重开一扇窗、再买一次调用,而那正是 O(1) 要消灭的东西
    // (「一个触发事件一次调用」会退化成「一次发言一次调用」)。裁决排的是这一轮的
    // 次序,一轮里有几次让位不该改变它的价钱。
    const remaining = (account.judgment.grants ?? []).filter(
      agentId => !issuedAgentIds.has(agentId) && hands.some(hand => hand.agentId === agentId),
    )
    // 残余那半份**不再管放手**:候选集清空(`[]` = 这扇窗管不着任何人)。放手是
    // 一次性的,上面那一步已经落定;留着旧候选集的话,同一个人为**下一条消息**重新
    // 举的手会被这份旧答案再放一次 —— 一只刚举起来的手凭空消失,比幽灵排队更难查。
    if (remaining.length > 0) judgment = { ...account.judgment, grants: remaining, candidates: [] }
  }
  for (const agentId of mentioned) {
    if (issuedAgentIds.has(agentId)) continue
    if (holders.has(agentId)) continue
    hands = enqueueCollabHand(hands, {
      agentId,
      at: gates.now,
      origin: 'mention',
      reason: 'mention',
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    })
  }

  return {
    account: {
      ...account,
      floor: ledger,
      chainCount,
      hands,
      leaseSeq,
      leaseReasons,
      messageSeq,
      notices,
      judgmentSeq,
      // 策略没动游标就保留原值 —— `undefined` 在这里是"没意见",不是"清空"。
      ...(decision.state ? { policyState: decision.state } : {}),
      ...(judgment ? { judgment } : { judgment: undefined }),
      ...(lastDegraded ? { lastDegraded } : { lastDegraded: undefined }),
    },
    broadcast,
    messages,
    granted,
    ...(judgmentRequest ? { judgment: judgmentRequest } : {}),
  }
}

/** 牌作废时把它的理由一起清掉 —— 账不留死条目。 */
function forgetLeaseReasons(
  reasons: Record<string, CollabActivationReason>,
  leaseIds: readonly string[],
): Record<string, CollabActivationReason> {
  if (leaseIds.length === 0) return reasons
  const next = { ...reasons }
  for (const leaseId of leaseIds) delete next[leaseId]
  return next
}

/**
 * 举手入队。同一个人重复举手**不叠加**:一只手就是一只手,叠加只会让一个
 * 反复举手的 agent 把队列刷满并连拿数张牌。
 *
 * 升级是允许的:一只普通手被 @ 到之后升为 `mention` 起源(直通),时刻保留原值
 * —— 它排在前面靠的是起源,不是把等待时间抹掉。
 */
export function enqueueCollabHand(
  hands: readonly CollabRaisedHand[],
  hand: CollabRaisedHand,
): CollabRaisedHand[] {
  const existing = hands.findIndex(entry => entry.agentId === hand.agentId)
  if (existing < 0) return [...hands, hand]
  const previous = hands[existing]
  const merged: CollabRaisedHand = {
    ...previous,
    origin: previous.origin === 'mention' || hand.origin === 'mention' ? 'mention' : 'hand',
    reason: hand.origin === 'mention' ? hand.reason : previous.reason,
    ...(hand.urgency ? { urgency: hand.urgency } : {}),
    ...(hand.why ? { why: hand.why } : {}),
    ...(hand.sourceMessageId ? { sourceMessageId: hand.sourceMessageId } : {}),
  }
  const next = [...hands]
  next[existing] = merged
  return next
}

/* ── 转换 ──────────────────────────────────────────────────────────────── */

/**
 * 房间收到一条消息(用户投递、或某个 agent 的发言落地之后的回声)。
 *
 * 四件事,按序:广播 → 推水位 → 清链 → 发牌。清链必须在发牌**之前** ——
 * 反过来的话人类那句话先被旧链数挡住,再清零,于是「你说一句话讨论就继续」
 * 这句承诺要等到下一条消息才兑现。
 */
export function applyCollabRoomPosted(
  account: CollabRoomAccount,
  verb: CollabRoomPostedVerb,
  gates: CollabRoomGates,
  ids: CollabRoomIdSource,
  options: {
    /** 这条 posted 自己就是这次转换写下的消息(speak 的回流口)。 */
    extraMessages?: readonly CollabRoomTranscriptMessage[]
  } = {},
): CollabRoomStep {
  const message = verb.message
  let next: CollabRoomAccount = { ...account }
  const effects = emptyEffects()
  effects.messages.push(...(options.extraMessages ?? []))

  // 房间把每一条消息播给全体成员 —— 可见性边界就是成员表(§0.1)。
  effects.broadcast.push(verb)

  // 水位只前进(v2 `advanceWatermark`:两条消息并发处理时,后到先完的那条
  // 会被先到后完的那条用更旧的位置盖回去)。
  const at = message.timestamp
  if (at === undefined || next.watermark.at === undefined || at >= next.watermark.at) {
    next.watermark = {
      ...(message.id ? { messageId: message.id } : {}),
      ...(at === undefined ? {} : { at }),
    }
  }

  if (collabMessageResetsChain(message)) {
    next.chainCount = 0
    if (message.id) next.chainResetMessageId = message.id
    // 只放开**链**那一把闩:下一次顶格该重新说一遍。冻结/预算两把由它们自己那道
    // 闸放开(见 `grantFloor`)—— 一条人类消息不解冻房间,也不补预算。
    next.notices = { ...next.notices, chain: false }
    // **人类消息重置环**(D3)。清链与重置环是同一件事的两面:讨论重新开始了,
    // 接力该从起棒人重新数,编排该从第一批重新走 —— 沿用旧游标等于让人类那句话
    // 落进上一轮的第三批里,而那一轮已经不存在了。
    next.policyState = undefined
    // 还没答的裁决窗一起作废:它判的是上一条消息该谁说,而那条消息刚被顶掉。
    // 排队而不是作废的话,新消息要等一个已经过时的答案回来才轮得上。
    if (next.judgment?.state === 'pending') next.judgment = undefined
  }

  // 运营行、drive、thinking 不是发牌时机 —— 判据走 C1 的单一分类器,不比字符串。
  if (isCollabRoomFact(message)) {
    const authorAgentId = verb.author.kind === 'agent' ? verb.author.id : undefined
    const mentioned = resolveCollabMentionIds(message, gates.members)
      .filter(agentId => agentId && agentId !== authorAgentId)
    const outcome = grantFloor(next, gates, ids, {
      mentioned,
      ...(message.id ? { sourceMessageId: message.id } : {}),
    })
    next = outcome.account
    effects.broadcast.push(...outcome.broadcast)
    effects.messages.push(...outcome.messages)
    effects.granted.push(...outcome.granted)
    if (outcome.judgment) effects.judgment = outcome.judgment
  }

  next.seq = account.seq + 1
  return { account: next, effects }
}

/** 举手。已经有牌的人举手是空操作 —— 它已经站在台上了。 */
export function applyCollabRoomRaiseHand(
  account: CollabRoomAccount,
  verb: CollabAgentRaiseHandVerb,
  gates: CollabRoomGates,
  ids: CollabRoomIdSource,
  options: { reason?: CollabActivationReason } = {},
): CollabRoomStep {
  const effects = emptyEffects()
  if (collabRoomHolders(account, gates.now).has(verb.agentId)) {
    return { account, effects }
  }

  let next: CollabRoomAccount = {
    ...account,
    hands: enqueueCollabHand(account.hands, {
      agentId: verb.agentId,
      at: gates.now,
      origin: 'hand',
      reason: options.reason ?? 'self-elected',
      ...(verb.urgency ? { urgency: verb.urgency } : {}),
      ...(verb.why ? { why: verb.why } : {}),
      ...(verb.sourceMessageId ? { sourceMessageId: verb.sourceMessageId } : {}),
    }),
  }

  const outcome = grantFloor(next, gates, ids, {
    ...(verb.sourceMessageId ? { sourceMessageId: verb.sourceMessageId } : {}),
  })
  next = outcome.account
  effects.broadcast.push(...outcome.broadcast)
  effects.messages.push(...outcome.messages)
  effects.granted.push(...outcome.granted)
  if (outcome.judgment) effects.judgment = outcome.judgment

  next.seq = account.seq + 1
  return { account: next, effects }
}

/**
 * 说话 —— 唯一发送面(§2「speak 的工具面形态」)。
 *
 * 验票在最前面:**没牌不许开口**,这是「说话即行动」的结构保证。其后的三道门
 * (冻结 / 成员 / 预算)与拒绝文案原样沿用 v2 的 `speakIntoCollabRoom`,因为
 * 那些措辞本身是资产 —— agent 拿到的是一句能照做的话,不是一个 error。
 *
 * **说话不计链**:链数是发出的牌数,牌在发的时候就计过了。一个回合说三句话在
 * v2 里计三格,在 v3 里计一格 —— 这是有意的口径变化,因为闸要挡的是"轮流讲了
 * 多少轮",不是"打了多少字"。
 */
export function applyCollabRoomSpeak(
  account: CollabRoomAccount,
  verb: CollabAgentSpeakVerb,
  gates: CollabRoomGates,
  ids: CollabRoomIdSource,
): CollabRoomStep {
  const check = validateFloorLeaseId(account.floor, verb.leaseId, gates.now)
  if (!check.valid) {
    return { account, effects: { ...emptyEffects(), refusal: refusalForLease(check.reason) } }
  }
  if (check.lease.agentId !== verb.agentId) {
    return { account, effects: { ...emptyEffects(), refusal: COLLAB_SPEAK_REFUSED_LEASE_OWNER } }
  }

  if (gates.frozen) {
    return { account, effects: { ...emptyEffects(), refusal: COLLAB_SAY_REFUSED_FROZEN } }
  }
  if (!gates.members.some(member => member.id === verb.agentId)) {
    // 回合中途被移出群(W6):名册是现读的,刚被请出去的人不能把话说完。
    return { account, effects: { ...emptyEffects(), refusal: COLLAB_SAY_REFUSED_NOT_MEMBER } }
  }
  if (gates.overBudget) {
    return { account, effects: { ...emptyEffects(), refusal: COLLAB_SAY_REFUSED_BUDGET } }
  }

  const content = normalizeCollabSayContent(verb.content)
  if (!content) {
    return { account, effects: { ...emptyEffects(), refusal: COLLAB_SAY_REFUSED_EMPTY } }
  }

  const directory = gates.directory ?? gates.members
  const mentions = resolveCollabSayMentions({
    content,
    ...(verb.mentions ? { mentionAgentIds: verb.mentions.map(mention => mention.agentId) } : {}),
    members: gates.members,
    directory,
  })
  // 句柄出栈(collab-agent-handle.md §2.4):`@小李#3f9c1e2a` 还原成 `@小李`,
  // 身份已经进了 mentions[]。
  const spoken = stripCollabAgentHandles(content, directory)

  const messageSeq = account.messageSeq + 1
  const message: CollabRoomTranscriptMessage = {
    id: ids.newMessageId(`${account.roomId}:say:${messageSeq}`),
    role: 'assistant',
    agentId: verb.agentId,
    content: spoken,
    timestamp: gates.now,
    source: COLLAB_SAY_SOURCE,
    // 空 mentions 数组是一个真答案("谁都没点"),所以缺席而不是存空 —— 那正是
    // 老转录的名字扫描兜底还能用的原因(W14a)。
    ...(mentions.length > 0 ? { mentions } : {}),
  }

  const posted = collabRoomPosted({
    roomId: account.roomId,
    author: collabActorRef('agent', verb.agentId),
    message,
  })

  // 说出口的话立刻**回到房间的入口** —— 它和一条人类消息一样是一次 posted:
  // 广播给全体成员、推水位、里面的 @ 直通授牌。不走这一条的话,agent 之间就永远
  // @ 不动对方(只有人类的 @ 算数),而「@ = 直通授牌」这条决策没有说只对人类成立。
  //
  // 复用同一个转换而不是抄一遍发牌:抄一遍就是第二本账,而这正是 v3 要消灭的东西。
  return applyCollabRoomPosted({ ...account, messageSeq }, posted, gates, ids, {
    extraMessages: [message],
  })
}

function refusalForLease(reason: string): string {
  if (reason === 'stale-epoch') return COLLAB_SPEAK_REFUSED_STALE_LEASE
  if (reason === 'expired') return COLLAB_SPEAK_REFUSED_EXPIRED_LEASE
  return COLLAB_SPEAK_REFUSED_NO_LEASE
}

/** 让位:交牌,空出来的座位立刻给队里下一个。 */
export function applyCollabRoomYield(
  account: CollabRoomAccount,
  verb: CollabAgentYieldVerb,
  gates: CollabRoomGates,
  ids: CollabRoomIdSource,
): CollabRoomStep {
  const effects = emptyEffects()
  const held = account.floor.active.some(lease => lease.leaseId === verb.leaseId)
  if (!held) {
    // 交一张不存在的牌:无害,不报错(重投/迟到的 yield 就长这样)。
    return { account, effects }
  }

  let next: CollabRoomAccount = {
    ...account,
    floor: revokeFloorLease(account.floor, verb.leaseId),
    leaseReasons: forgetLeaseReasons(account.leaseReasons, [verb.leaseId]),
  }
  effects.broadcast.push(collabRoomFloorRevoked({
    roomId: account.roomId,
    agentId: verb.agentId,
    leaseId: verb.leaseId,
    reason: 'yield',
  }))

  const outcome = grantFloor(next, gates, ids, {})
  next = outcome.account
  effects.broadcast.push(...outcome.broadcast)
  effects.messages.push(...outcome.messages)
  effects.granted.push(...outcome.granted)
  if (outcome.judgment) effects.judgment = outcome.judgment

  next.seq = account.seq + 1
  return { account: next, effects }
}

/**
 * 换代:代数 +1,在外的牌**全部作废**。
 *
 * 用在换相、用户喊停、房间被冻住这三处。不逐一通知任何人 —— agent 重启后手里
 * 攥着的那张旧牌,自己验一次就知道过期了(§1.4 代数存在的全部理由)。
 */
export function bumpCollabRoomEpoch(
  account: CollabRoomAccount,
  reason: CollabFloorRevokeReason,
  now: number,
): CollabRoomStep {
  const effects = emptyEffects()
  const revoked: string[] = []
  for (const lease of activeFloorLeases(account.floor, now)) {
    revoked.push(lease.leaseId)
    effects.broadcast.push(collabRoomFloorRevoked({
      roomId: account.roomId,
      agentId: lease.agentId,
      leaseId: lease.leaseId,
      reason,
    }))
  }
  const bumped = bumpFloorEpoch(account.floor)
  return {
    account: {
      ...account,
      floor: pruneFloorLeases(bumped, now),
      leaseReasons: forgetLeaseReasons(account.leaseReasons, revoked),
      seq: account.seq + 1,
    },
    effects,
  }
}

/**
 * 换相(§1.5 `phase` 策略的动词面)。换相即换代 —— 上一相的牌一律作废。
 *
 * **举手挂起不丢**(D3):`phase` 这一档下队列**跨相位存活**。夜里举了手的村民
 * 天亮就该说得上话,而不是得再被戳一次 —— 相位切换是"这间房此刻活不活",不是
 * 一次重启。其余策略沿用 D1:换相清队(那里的换相多半是用户喊停的同义词)。
 *
 * 传了 `gates`/`ids` 就**当场重新发牌**:刚被激活的那一相里,挂着的手应该立刻
 * 兑现。不传就只换相不发牌(D1 的三参调用点与测试沿用这条)。
 */
export function applyCollabRoomPhaseChange(
  account: CollabRoomAccount,
  phase: string,
  now: number,
  gates?: CollabRoomGates,
  ids?: CollabRoomIdSource,
): CollabRoomStep {
  const previousPhase = account.phase
  const keepHands = account.policy.name === 'phase'
  const stepped = bumpCollabRoomEpoch(account, 'epoch-bumped', now)
  let next: CollabRoomAccount = {
    ...stepped.account,
    phase,
    ...(keepHands ? {} : { hands: [] }),
    // 换相作废在飞的裁决:它判的是上一相该谁说。
    judgment: undefined,
    policyState: undefined,
  }
  const effects = stepped.effects
  effects.broadcast.push(collabRoomPhaseChanged({
    roomId: account.roomId,
    phase,
    ...(previousPhase ? { previousPhase } : {}),
    epoch: next.floor.epoch,
  }))

  if (gates && ids) {
    const outcome = grantFloor(next, { ...gates, now }, ids, {})
    next = outcome.account
    effects.broadcast.push(...outcome.broadcast)
    effects.messages.push(...outcome.messages)
    effects.granted.push(...outcome.granted)
    if (outcome.judgment) effects.judgment = outcome.judgment
  }

  return { account: next, effects }
}

/**
 * 裁判 → 房间的唯一动词,两件事共用(D3)。
 *
 * 1. **裁决投递**(带 `verdictToken`)—— 一次批量裁决的答案回来了。这不是换策略:
 *    `policy` 那一格原样落回去,变的只有裁决窗。为什么裁决走这个动词而不是新开
 *    一个,见 `CollabFloorPolicyParams.verdict` 的注释;
 * 2. **换策略**(不带 token)—— 换档。整袋游标与在飞裁决一起清:半份旧游标比没有
 *    游标更糟(`ring` 的环位拿去喂 `waves` 的批位是一个查不出来的错)。切到 `phase`
 *    且相位真的变了,顺手走一次换相(换相即换代,上一档的牌一律作废)。
 *
 * 迟到的裁决(token 对不上当前的窗)**直接丢弃**:它判的是上一条消息该谁说,而
 * 那条消息已经被顶掉了。拿它去发牌等于让房间回答一个没人再问的问题。
 */
export function applyCollabRoomSetPolicy(
  account: CollabRoomAccount,
  verb: CollabRefereeSetFloorPolicyVerb,
  gates: CollabRoomGates,
  ids: CollabRoomIdSource,
): CollabRoomStep {
  const token = verb.params?.verdictToken
  if (token !== undefined) {
    if (account.judgment?.token !== token || account.judgment.state !== 'pending') {
      // 迟到 / 重投 / 认不领 —— 无害,不报错(至多多等一次触发)。
      return { account, effects: emptyEffects() }
    }
    const degraded = verb.params?.verdictDegraded === true
    const resolved: CollabRoomAccount = {
      ...account,
      judgment: {
        ...account.judgment,
        state: degraded ? 'degraded' : 'resolved',
        ...(degraded
          ? {}
          : {
              grants: [...(verb.params?.verdict ?? [])],
              // 裁判现取的候选集**压过**开窗那一刻的快照:窗是第一只手开的,其余的
              // 手随后异步到,真正被判过的是裁判读到的那一份。带不带这一格的差别
              // 就是「4 只手放下 1 只」与「4 只手全放下」(见 `candidates` 的注释)。
              ...(verb.params?.verdictCandidates
                ? { candidates: [...verb.params.verdictCandidates] }
                : {}),
            }),
        ...(verb.params?.why ? { why: verb.params.why } : {}),
      },
      // 降级要**留痕**:下面那一步 `grantFloor` 会把这扇答完的窗当场关掉,于是
      // `judgment: 'degraded'` 在同一个同步步里就没了 —— 黄牌没有它站的地方
      // (见 `CollabRoomAccount.lastDegraded`)。痕活到下一次开窗。
      ...(degraded
        ? { lastDegraded: { reason: verb.params?.why || 'unspecified', at: gates.now } }
        : {}),
    }
    const effects = emptyEffects()
    const outcome = grantFloor(resolved, gates, ids, {
      ...(account.judgment.sourceMessageId ? { sourceMessageId: account.judgment.sourceMessageId } : {}),
    })
    effects.broadcast.push(...outcome.broadcast)
    effects.messages.push(...outcome.messages)
    effects.granted.push(...outcome.granted)
    if (outcome.judgment) effects.judgment = outcome.judgment
    return { account: { ...outcome.account, seq: account.seq + 1 }, effects }
  }

  const next: CollabRoomAccount = {
    ...account,
    policy: { name: verb.policy, ...(verb.params ? { params: verb.params } : {}) },
    policyState: undefined,
    judgment: undefined,
    seq: account.seq + 1,
  }
  const nextPhase = verb.params?.phase
  if (nextPhase && nextPhase !== account.phase) {
    // 换相走完整那条路(换代 + 广播 + 重新发牌),而不是只把 `phase` 那一格改掉:
    // 上一相手里的牌必须作废,否则狼在天亮之后还能拿夜里那张牌开口。
    const stepped = applyCollabRoomPhaseChange(next, nextPhase, gates.now, gates, ids)
    return { account: { ...stepped.account, seq: account.seq + 1 }, effects: stepped.effects }
  }
  if (nextPhase) next.phase = nextPhase
  // 换档之后立刻按新策略排一次:`ring` 换上来时棒子该当场传出去,而不是等下一条
  // 消息。不重排的话「切成接力」在用户眼里是一个没有反应的开关。
  const effects = emptyEffects()
  const outcome = grantFloor(next, gates, ids, {})
  effects.broadcast.push(...outcome.broadcast)
  effects.messages.push(...outcome.messages)
  effects.granted.push(...outcome.granted)
  if (outcome.judgment) effects.judgment = outcome.judgment
  return { account: { ...outcome.account, seq: account.seq + 1 }, effects }
}

/**
 * 点名收一张牌(E5 人级停止的账面动作)。
 *
 * 与换代(`bumpCollabRoomEpoch`)的分别是**范围**:那一条把在外的牌一起作废,
 * 这一条只动被点名的那张,同房其他人手里的牌一个都不碰。人级停止要的正是后者
 * —— 用房级喊停冒充「停下 TA」,是 O2 当初宁可把撤牌做成只读也不肯犯的错。
 *
 * 与让位(`applyCollabRoomYield`)在**账上是同一个事实**(牌没了),差别只在理由:
 * 那边写 `yield`(它自己交的),这边写 `revoked`(被收的)。所以这里不复用那条
 * 路 —— 复用就得把 reason 掰成参数,而一个「让位」函数带一个「被强收」的理由,
 * 读的人两边都要猜。
 *
 * 收完立刻重新发牌:空出来的座位就是给队里下一个人的(与过期回收同一条)。
 * 账上没这张在外的牌 = 原样返回,**不报错**:UI 那一侧的乐观并发前置在调用方,
 * 纯层这里重投一次是无害的。
 */
export function revokeCollabRoomLease(
  account: CollabRoomAccount,
  leaseId: string,
  gates: CollabRoomGates,
  ids: CollabRoomIdSource,
): CollabRoomStep {
  const lease = account.floor.active.find(entry => entry.leaseId === leaseId)
  if (!lease) return { account, effects: emptyEffects() }

  const effects = emptyEffects()
  effects.broadcast.push(collabRoomFloorRevoked({
    roomId: account.roomId,
    agentId: lease.agentId,
    leaseId: lease.leaseId,
    reason: 'revoked',
  }))

  const outcome = grantFloor(
    {
      ...account,
      floor: revokeFloorLease(account.floor, lease.leaseId),
      leaseReasons: forgetLeaseReasons(account.leaseReasons, [lease.leaseId]),
    },
    gates,
    ids,
    {},
  )
  effects.broadcast.push(...outcome.broadcast)
  effects.messages.push(...outcome.messages)
  effects.granted.push(...outcome.granted)
  if (outcome.judgment) effects.judgment = outcome.judgment

  return { account: { ...outcome.account, seq: account.seq + 1 }, effects }
}

/**
 * 过期回收。牌带 ttl 时由宿主定期调 —— 一个跑飞的回合不该永远占着座位。
 *
 * 回收之后立刻重新发牌:空出来的座位就是给队里下一个人的。
 */
export function pruneCollabRoomFloor(
  account: CollabRoomAccount,
  gates: CollabRoomGates,
  ids: CollabRoomIdSource,
): CollabRoomStep {
  const expired = account.floor.active.filter(lease => isFloorLeaseExpired(lease, gates.now))
  if (expired.length === 0) return { account, effects: emptyEffects() }

  const effects = emptyEffects()
  let ledger = account.floor
  for (const lease of expired) {
    ledger = revokeFloorLease(ledger, lease.leaseId)
    effects.broadcast.push(collabRoomFloorRevoked({
      roomId: account.roomId,
      agentId: lease.agentId,
      leaseId: lease.leaseId,
      reason: 'expired',
    }))
  }

  const outcome = grantFloor(
    {
      ...account,
      floor: ledger,
      leaseReasons: forgetLeaseReasons(account.leaseReasons, expired.map(lease => lease.leaseId)),
    },
    gates,
    ids,
    {},
  )
  effects.broadcast.push(...outcome.broadcast)
  effects.messages.push(...outcome.messages)
  effects.granted.push(...outcome.granted)
  if (outcome.judgment) effects.judgment = outcome.judgment

  return { account: { ...outcome.account, seq: account.seq + 1 }, effects }
}

/**
 * 只落账 + 透传的动词(dm-open / wake / card-event / membership-changed)。
 *
 * D1 的边界就在这里:这些动词的**语义**分别属于 D2(私聊房生命周期)与
 * D3/D4(相位、看板)。房间此刻能诚实做到的只有两件事 —— 把它记进序号、把它
 * 原样播出去。假装实现一半的语义,比留一个明确的透传口更贵。
 */
export function applyCollabRoomPassthrough(
  account: CollabRoomAccount,
  verb: CollabActorVerb,
): CollabRoomStep {
  return {
    account: { ...account, seq: account.seq + 1 },
    effects: { ...emptyEffects(), broadcast: [verb] },
  }
}

/* ── 广播账 ────────────────────────────────────────────────────────────── */

/**
 * 事件 id 的确定性派生(复用重放架 `roomId:messageId` 的思路)。
 *
 * 同一封信重投多少次 id 都不变 —— 这是消费端去重窗唯一认得的东西。所以派生的
 * 材料必须是**事件的身份**(哪间房、哪条消息/哪张牌),不能掺进投递时刻或重试
 * 次数,那些是"这一次投递"的属性。
 */
export function collabRoomEventId(roomId: string, verb: CollabActorVerb, ordinal: number): string {
  switch (verb.type) {
    case 'room:posted':
      return `evt:${roomId}:${verb.message.id ?? `n${ordinal}`}`
    case 'room:floor-granted':
      return `evt:${roomId}:${verb.lease.leaseId}`
    case 'room:floor-revoked':
      return `evt:${roomId}:${verb.leaseId}:${verb.reason}`
    case 'room:phase-changed':
      return `evt:${roomId}:phase:${verb.epoch}`
    default:
      return `evt:${roomId}:${verb.type}:${ordinal}`
  }
}

/** 登记一次在飞广播。投递之前先落账 —— 崩在中途才有东西可续。 */
export function openCollabRoomBroadcast(
  account: CollabRoomAccount,
  record: CollabRoomPendingBroadcast,
): CollabRoomAccount {
  return { ...account, broadcasts: [...account.broadcasts, record] }
}

/** 一个成员投完了。投一个销一个,空了整条记录移除。 */
export function settleCollabRoomBroadcast(
  account: CollabRoomAccount,
  eventId: string,
  agentId: string,
): CollabRoomAccount {
  const broadcasts: CollabRoomPendingBroadcast[] = []
  for (const record of account.broadcasts) {
    if (record.eventId !== eventId) {
      broadcasts.push(record)
      continue
    }
    const pending = record.pending.filter(id => id !== agentId)
    if (pending.length > 0) broadcasts.push({ ...record, pending })
  }
  return { ...account, broadcasts }
}

/** D1 只内置 `free` —— 导出一个现成的,省得每个调用点各造一个。 */
export const COLLAB_ROOM_DEFAULT_FLOOR_POLICY = createCollabFreeFloorPolicy()
