/**
 * AgentActor 的**纯规则**(docs/design/collab-actor-v3.md §1.2)——账的转换、
 * 举手评估、drive 组装。
 *
 * 与 `room-rules.ts` 同一条分工:带 IO 的那一半(mailbox、笔记落盘、回合执行)
 * 在 `@onething/backend` 的 `collab/actors/`,这里只有同步纯函数。理由也一样 ——
 * **金重放与真机必须走同一行代码**,而重放没有磁盘、没有引擎、没有时钟。
 *
 * ## 账里为什么有两个游标
 *
 * 一间房两个水位,不是冗余:
 *
 *  - `deliveredMessageId` —— **投递水位**:这封信我收到并处理过了。只前进。它是
 *    幂等的落点:mailbox 是 at-least-once,崩在一批中间重启后那一批原样重投,
 *    水位不倒退、信封不重复靠的就是它。
 *  - `readMessageId` —— **已读水位**:模型真的读到哪一条了。它在**回合收尾**才
 *    前进,而且前进到 drive 组装**之前**捕获的那一条(`projectedThroughId`)。
 *
 * 合并成一个的代价在 v2 已经付过一次:投递即已读的话,一条消息进了信箱就算读过,
 * 而下一轮 drive 的未读窗口按已读水位算 —— 于是模型永远读到「零未读」,房间里
 * 说了什么它一个字都看不见。反过来(回合收尾才推投递水位)则是重投会重复折叠。
 * 两个水位各答各的问题,没有一个能替另一个。
 */
import type { CollabActivationReason } from '../activation.js'
import { isCollabRoomFact } from '../classify.js'
import { resolveCollabMentionIds } from '../mentions.js'
import type { CollabAgentLike, CollabMessageLike } from '../types.js'
import type { CollabFoldEntry } from './envelope-fold.js'
import type {
  CollabActorRef,
  CollabHandUrgency,
  CollabRoomPostedVerb,
  CollabWorkerOutcome,
} from './protocol.js'
import {
  adoptCollabWorkerOrphans,
  normalizeCollabAgentWorkerRecords,
  settleCollabWorkerRecord,
  upsertCollabWorkerRecord,
  type CollabAgentWorkerRecord,
  type CollabWorkerStatus,
} from './worker-rules.js'

export const COLLAB_AGENT_ACCOUNT_VERSION = 1

/**
 * 折叠缓冲的容量。
 *
 * 上限存在的理由与渲染上限不同:渲染管的是「一次 drive 里放几行」,这里管的是
 * 「一个下线三天的 agent 的账会长到多大」。溢出丢**最旧**的并计数 —— 计数会跟着
 * 进 `<more count>`,截断因此不是静默的。
 */
export const COLLAB_AGENT_FOLD_BUFFER_MAX = 200

/** 折叠幂等窗口。盖住「重投可能发生的距离」即可(与 core 的 seen 窗口同一套论证)。 */
export const COLLAB_AGENT_FOLD_SEEN_MAX = 128

/** 一间房在这个 agent 账里的两个水位 + 上一轮的时刻。 */
export interface CollabAgentRoomAccount {
  /** 投递水位:处理过的最后一条房间消息。 */
  deliveredMessageId?: string
  deliveredAt?: number
  /** 已读水位:模型真的读到的最后一条。回合收尾才前进。 */
  readMessageId?: string
  readAt?: number
  /** 上一次在这间房跑完回合的时刻(排障与「首轮铺底」判据的备份)。 */
  lastTurnAt?: number
  /** 在这间房跑过几个回合。零 = 首轮铺底。 */
  turns: number
}

/** 手里的一张牌(账上只留能重建现场的那几格)。 */
export interface CollabAgentLeaseRecord {
  roomId: string
  leaseId: string
  epoch: number
  issuedAt: number
}

/**
 * AgentActor 的账(`agents-v3/<agentId>/state.json`)。
 *
 * **同步原子写、先于任何一步动作**(§3 三面纪律)。转录那一面不在这里 ——
 * 蓝图修正:经历流就是既有的 per-(agent×房) 执行会话(`agent-exec-…`),
 * AgentActor 接管它的所有权而不是另起一份。引擎(流式/工具/权限/UI 履历页)
 * 全部按 ChatSession 工作,保留它 = 引擎零改造 + 经历零迁移。
 */
export interface CollabAgentAccount {
  version: typeof COLLAB_AGENT_ACCOUNT_VERSION
  agentId: string
  rooms: Record<string, CollabAgentRoomAccount>
  /** 待折叠的事件(信封素材),按序。取走即清。 */
  fold: CollabFoldEntry[]
  /** 因为容量上限被丢掉的素材条数。渲染时并进 `<more count>`。 */
  foldDropped: number
  /** 已折叠过的事件身份(有界窗口)——重投折不出第二条。 */
  foldSeen: string[]
  /** 上一次折叠的位点(ms)。信封块的 `since` 读它。 */
  foldedAt?: number
  /** 举手中的房。 */
  hands: string[]
  /** 手里的牌,按房。 */
  leases: CollabAgentLeaseRecord[]
  /** 收到过几份子 actor 结果(观测口径,只增不减)。 */
  workerResults: number
  /**
   * 子清单:我派出去的那些手(D4,§1.6)。
   *
   * 它在账里而不在内存里,只为了一件事:**崩溃之后父能发现孤儿**。一条
   * `running` 的记录能活到下一次进程启动,只可能是上一条命没来得及给它收尾 ——
   * 重启对账因此有据可查(见 `adoptCollabAgentWorkerOrphans`)。并发闸也读它:
   * per-agent 的在跑数就是这张表上 `running` 的条数,没有第二本账。
   */
  workers: CollabAgentWorkerRecord[]
  /** 单调序号。每一次账的变化 +1 —— 与房间账同一条纪律。 */
  seq: number
}

export function createCollabAgentAccount(agentId: string): CollabAgentAccount {
  return {
    version: COLLAB_AGENT_ACCOUNT_VERSION,
    agentId,
    rooms: {},
    fold: [],
    foldDropped: 0,
    foldSeen: [],
    hands: [],
    leases: [],
    workerResults: 0,
    workers: [],
    seq: 0,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * 从盘上认一份账。认不出的形状退回新账(与房间账同一个决定):半份账会在第一次
 * 折叠或第一次发牌时炸在离成因很远的地方。
 */
export function normalizeCollabAgentAccount(value: unknown, agentId: string): CollabAgentAccount {
  const raw = asRecord(value)
  if (!raw || raw.agentId !== agentId) return createCollabAgentAccount(agentId)

  const rooms: Record<string, CollabAgentRoomAccount> = {}
  for (const [roomId, entry] of Object.entries(asRecord(raw.rooms) ?? {})) {
    const room = asRecord(entry)
    if (!room) continue
    rooms[roomId] = {
      ...(typeof room.deliveredMessageId === 'string' ? { deliveredMessageId: room.deliveredMessageId } : {}),
      ...(typeof room.deliveredAt === 'number' ? { deliveredAt: room.deliveredAt } : {}),
      ...(typeof room.readMessageId === 'string' ? { readMessageId: room.readMessageId } : {}),
      ...(typeof room.readAt === 'number' ? { readAt: room.readAt } : {}),
      ...(typeof room.lastTurnAt === 'number' ? { lastTurnAt: room.lastTurnAt } : {}),
      turns: asNumber(room.turns),
    }
  }

  const leases: CollabAgentLeaseRecord[] = (Array.isArray(raw.leases) ? raw.leases : [])
    .map(entry => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .filter(entry => typeof entry.roomId === 'string' && typeof entry.leaseId === 'string')
    .map(entry => ({
      roomId: entry.roomId as string,
      leaseId: entry.leaseId as string,
      epoch: asNumber(entry.epoch, 1),
      issuedAt: asNumber(entry.issuedAt),
    }))

  return {
    version: COLLAB_AGENT_ACCOUNT_VERSION,
    agentId,
    rooms,
    fold: Array.isArray(raw.fold) ? (raw.fold as CollabFoldEntry[]) : [],
    foldDropped: asNumber(raw.foldDropped),
    foldSeen: asStringArray(raw.foldSeen),
    ...(typeof raw.foldedAt === 'number' ? { foldedAt: raw.foldedAt } : {}),
    hands: asStringArray(raw.hands),
    leases,
    workerResults: asNumber(raw.workerResults),
    workers: normalizeCollabAgentWorkerRecords(raw.workers),
    seq: asNumber(raw.seq),
  }
}

export function collabAgentRoomAccount(
  account: CollabAgentAccount,
  roomId: string,
): CollabAgentRoomAccount {
  return account.rooms[roomId] ?? { turns: 0 }
}

function withRoom(
  account: CollabAgentAccount,
  roomId: string,
  patch: CollabAgentRoomAccount,
): CollabAgentAccount {
  return {
    ...account,
    rooms: { ...account.rooms, [roomId]: patch },
    seq: account.seq + 1,
  }
}

/**
 * 推投递水位。**只前进**。
 *
 * 判据是时刻而不是「见过没见过」:mailbox 保序,所以一条时刻不晚于水位的消息
 * 只可能是重投或迟到,两种都不该让水位动。同刻同 id 也当已处理 —— 崩溃重投的
 * 恰恰是同一条。
 */
export function advanceCollabAgentDelivered(
  account: CollabAgentAccount,
  roomId: string,
  messageId: string | undefined,
  at: number,
): CollabAgentAccount {
  const room = collabAgentRoomAccount(account, roomId)
  if (room.deliveredAt !== undefined && at < room.deliveredAt) return account
  if (room.deliveredAt === at && room.deliveredMessageId === messageId) return account
  return withRoom(account, roomId, {
    ...room,
    ...(messageId ? { deliveredMessageId: messageId } : {}),
    deliveredAt: at,
  })
}

/**
 * 推已读水位。同样只前进,而且**只在回合真的跑过之后**调 —— 一个 abort/超时的
 * 回合可能一个字都没读到,虚假前进的游标会把那批消息永久变成「已读」。
 */
export function advanceCollabAgentRead(
  account: CollabAgentAccount,
  roomId: string,
  messageId: string | undefined,
  at: number,
): CollabAgentAccount {
  if (!messageId) return account
  const room = collabAgentRoomAccount(account, roomId)
  if (room.readAt !== undefined && at < room.readAt) return account
  return withRoom(account, roomId, { ...room, readMessageId: messageId, readAt: at })
}

/** 记一个回合跑完了(首轮铺底判据读 `turns`)。 */
export function recordCollabAgentTurn(
  account: CollabAgentAccount,
  roomId: string,
  at: number,
): CollabAgentAccount {
  const room = collabAgentRoomAccount(account, roomId)
  return withRoom(account, roomId, { ...room, lastTurnAt: at, turns: room.turns + 1 })
}

/**
 * 把一条素材压进折叠缓冲。
 *
 * 三件事一起做:按身份去重(重投)、按容量淘汰最旧的(并计数)、维护有界的
 * 幂等窗口。三件事分开写的话,第二件很容易被写成「丢掉但不计数」——那正是
 * 「截断要说出来」这条纪律最常见的漏法。
 */
export function pushCollabAgentFold(
  account: CollabAgentAccount,
  entry: CollabFoldEntry,
  options: { max?: number; seenMax?: number } = {},
): CollabAgentAccount {
  if (account.foldSeen.includes(entry.key)) return account

  const max = Math.max(1, Math.floor(options.max ?? COLLAB_AGENT_FOLD_BUFFER_MAX))
  const seenMax = Math.max(1, Math.floor(options.seenMax ?? COLLAB_AGENT_FOLD_SEEN_MAX))

  const fold = [...account.fold, entry]
  const overflow = Math.max(0, fold.length - max)
  return {
    ...account,
    fold: overflow ? fold.slice(overflow) : fold,
    foldDropped: account.foldDropped + overflow,
    foldSeen: [...account.foldSeen, entry.key].slice(-seenMax),
    seq: account.seq + 1,
  }
}

export interface CollabAgentFoldTake {
  account: CollabAgentAccount
  entries: CollabFoldEntry[]
  dropped: number
  /** 上一次折叠位点 —— 信封块的 `since`。 */
  since?: number
}

/**
 * 取走缓冲并推进折叠位点。
 *
 * 取走即清是「只能是事件,不能是状态」那条纪律的落点:一个事件只在它真的发生的
 * 那一刻被写进一条 drive。v2 初版把它写成滚动快照,实测同一个事件被写进 drive
 * 最多 23 次。
 *
 * `foldSeen` **不清** —— 它挡的是重投,而重投恰恰发生在取走之后。
 */
export function takeCollabAgentFold(account: CollabAgentAccount, at: number): CollabAgentFoldTake {
  return {
    account: {
      ...account,
      fold: [],
      foldDropped: 0,
      foldedAt: at,
      seq: account.seq + 1,
    },
    entries: account.fold,
    dropped: account.foldDropped,
    ...(account.foldedAt === undefined ? {} : { since: account.foldedAt }),
  }
}

export function raiseCollabAgentHand(account: CollabAgentAccount, roomId: string): CollabAgentAccount {
  if (account.hands.includes(roomId)) return account
  return { ...account, hands: [...account.hands, roomId], seq: account.seq + 1 }
}

export function clearCollabAgentHand(account: CollabAgentAccount, roomId: string): CollabAgentAccount {
  if (!account.hands.includes(roomId)) return account
  return { ...account, hands: account.hands.filter(entry => entry !== roomId), seq: account.seq + 1 }
}

/** 收下一张牌。同房重复发牌以**新的**为准(换代之后房间会重发)。 */
export function recordCollabAgentLease(
  account: CollabAgentAccount,
  lease: CollabAgentLeaseRecord,
): CollabAgentAccount {
  const leases = account.leases.filter(entry => entry.roomId !== lease.roomId)
  return {
    ...account,
    leases: [...leases, lease],
    hands: account.hands.filter(entry => entry !== lease.roomId),
    seq: account.seq + 1,
  }
}

export function dropCollabAgentLease(account: CollabAgentAccount, leaseId: string): CollabAgentAccount {
  if (!account.leases.some(entry => entry.leaseId === leaseId)) return account
  return {
    ...account,
    leases: account.leases.filter(entry => entry.leaseId !== leaseId),
    seq: account.seq + 1,
  }
}

export function collabAgentLeaseOf(
  account: CollabAgentAccount,
  roomId: string,
): CollabAgentLeaseRecord | undefined {
  return account.leases.find(entry => entry.roomId === roomId)
}

/**
 * 子 actor 结果记账(观测口径)。
 *
 * 只数,不判成败 —— 成败在子清单的那条记录上(`settleCollabAgentWorker`)。两处
 * 各答各的问题:这里答「回投这条路走通过几次」,那里答「那张卡到底怎么了」。
 */
export function recordCollabAgentWorkerResult(account: CollabAgentAccount): CollabAgentAccount {
  return { ...account, workerResults: account.workerResults + 1, seq: account.seq + 1 }
}

/* ── 子清单(D4 §1.6):账的那一面 ────────────────────────────────────────── */

/** 派出去一只手。账先落再动手 —— 崩在这两步之间,重启对账认得出这个孤儿。 */
export function startCollabAgentWorker(
  account: CollabAgentAccount,
  record: CollabAgentWorkerRecord,
): CollabAgentAccount {
  return { ...account, workers: upsertCollabWorkerRecord(account.workers, record), seq: account.seq + 1 }
}

/** 收尾一只手。认不出的 workerId 是空操作(一封迟到的回投不该凭空造记录)。 */
export function settleCollabAgentWorker(
  account: CollabAgentAccount,
  input: {
    workerId: string
    outcome: CollabWorkerOutcome
    at: number
    status?: CollabWorkerStatus
    workSessionId?: string
  },
): CollabAgentAccount {
  const workers = settleCollabWorkerRecord(account.workers, input)
  return { ...account, workers, seq: account.seq + 1 }
}

/**
 * 重启对账:`running` 的记录认成孤儿并标 `interrupted`,把它们交出来。
 *
 * 怎么处置(重派 or 就此打住)不在这里 —— 那是策略,归 AgentActor 的
 * `recoverWorkers`。这一层只回答「上一条命留下了什么」。
 */
export function adoptCollabAgentWorkerOrphans(
  account: CollabAgentAccount,
  at: number,
): { account: CollabAgentAccount; orphans: CollabAgentWorkerRecord[] } {
  const adoption = adoptCollabWorkerOrphans(account.workers, at)
  if (adoption.orphans.length === 0) return { account, orphans: [] }
  return {
    account: { ...account, workers: adoption.workers, seq: account.seq + 1 },
    orphans: adoption.orphans,
  }
}

/* ── 举手评估 ─────────────────────────────────────────────────────────────── */

export interface CollabHandEvaluationInput {
  agentId: string
  roomId: string
  message: CollabMessageLike
  author: CollabActorRef
  /** 在职成员 —— 裸 `@名字` 的解析要它。 */
  members: readonly CollabAgentLike[]
  /** 这间房是不是私聊(单成员托管私聊 / 成对私聊)。 */
  dm?: boolean
}

export interface CollabHandEvaluation {
  raise: boolean
  reason: CollabActivationReason
  why?: string
  urgency?: CollabHandUrgency
}

/**
 * 「这条消息值得我举手吗」。
 *
 * 做成接口而不是一个函数,是因为 D3 的真身**要花钱**:真实意愿判定是一次模型
 * 调用,而批量裁决(qm P0-2 的 O(N)→O(1))更是一次**房间级**的调用,属于
 * referee 那一侧。接口在这里留好,`free` 档永远是那条不花钱的降级路径
 * (§7 风险 3 要的「对照与降级」)。
 */
export interface CollabHandEvaluator {
  readonly name: string
  evaluate(input: CollabHandEvaluationInput): CollabHandEvaluation | Promise<CollabHandEvaluation>
}

export const COLLAB_HAND_NOT_RAISED: CollabHandEvaluation = { raise: false, reason: 'self-elected' }

/**
 * D2 的默认启发式:**被 @ 就举手;私聊里人类说话就举手**。
 *
 * 两条都不是猜的 —— 它们是 v2 路由表里唯二不经意愿判定的直通分支。其余一律不
 * 举手:D2 没有意愿判定,而「不确定就说话」在真机上的形态是群里刷屏。
 *
 * 被 @ 时房间其实已经直通发牌了(`grantFloor` 的 mentioned 分支),所以这只手
 * 多半会被 `applyCollabRoomRaiseHand` 的持牌判断当成空操作吃掉 —— 这是有意的
 * 冗余:agent 不该为了省一次往返而去猜房间当前用的是哪一档发言策略(D3 会换掉
 * 它),而房间那侧的去重是**结构性**的。
 */
export function createCollabHeuristicHandEvaluator(): CollabHandEvaluator {
  return {
    name: 'heuristic',
    evaluate(input: CollabHandEvaluationInput): CollabHandEvaluation {
      // 自己说的话不构成举手理由。
      if (input.author.kind === 'agent' && input.author.id === input.agentId) return COLLAB_HAND_NOT_RAISED
      // 运营行、drive、thinking 不是发言时机 —— 判据走 C1 的单一分类器,不比字符串。
      if (!isCollabRoomFact(input.message)) return COLLAB_HAND_NOT_RAISED

      if (resolveCollabMentionIds(input.message, input.members).includes(input.agentId)) {
        return { raise: true, reason: 'mention', why: '被点名', urgency: 'high' }
      }
      if (input.dm && input.author.kind === 'user') {
        return { raise: true, reason: 'self-elected', why: '私聊里的人类消息' }
      }
      return COLLAB_HAND_NOT_RAISED
    },
  }
}

/* ── drive 组装 ───────────────────────────────────────────────────────────── */

export interface BuildCollabMindDriveOptions {
  /** 当前房增量投影(首轮铺底/增量的语义沿用 v2 `buildCollabDriveRoomContext`)。 */
  roomContext: string
  /** mailbox 折叠信封 —— 别处发生的事,只有信封没有正文。 */
  envelope?: string
  /** 跨房私人笔记的尾部窗口。 */
  notebook?: string
  /** 三块全空时的兜底(空 drive 就是一条什么都没有的 user 消息)。 */
  fallback?: string
}

/**
 * 一条 drive 的正文 = 房间内容 + 别处发生的事 + 笔记,句号。
 *
 * 次序有理由:房间内容在最前(它是这一轮真正要答的东西),信封与笔记是背景,
 * 排在其后。这里**没有**尾注块 —— v2 那个 `<turn agent=… reason=…>` 于
 * 2026-08-02 整块删除(措辞劝导被真机证明有偏,而它占着 recency 最强的位置)。
 * persona 与机制说明归 system prompt 那一面,这里一个字都不重复。
 */
export function buildCollabMindDrive(options: BuildCollabMindDriveOptions): string {
  const body = [options.roomContext, options.envelope ?? '', options.notebook ?? '']
    .map(block => block.trim())
    .filter(Boolean)
    .join('\n\n')
  return body || (options.fallback ?? '')
}

/**
 * 这条 posted 的「谁说的」——折叠条目与举手评估共用一份判据。
 *
 * 房间广播的 `author` 是权威(它是投递那一跳记下的事实);消息自己的 `agentId`
 * 只是兜底 —— 迁移期的旧转录有 agentId 而没有 author。
 */
export function collabPostedSpeakerId(verb: CollabRoomPostedVerb): string | undefined {
  if (verb.author.kind === 'agent') return verb.author.id
  if (verb.author.kind === 'user') return undefined
  return verb.message.agentId
}
