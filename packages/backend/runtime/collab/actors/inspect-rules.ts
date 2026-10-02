/**
 * 诊断 CLI 的**纯规则**(docs/design/collab-v3-observability.md §5,D8 O3)。
 *
 * `scripts/collab-v3-inspect.mjs` 只做两件事:**读文件**、**打印**。中间那一段
 * ——「一份房账 + 一份房间配置 + 一段时间轴,合起来说明这间房此刻怎么了」——
 * 全在这里,理由与 `migrate-rules.ts` 逐条相同:
 *
 *  1. **CLI 不能是唯一实现**。判据(`blockedBy`、座位数、链闸读数)在 UI 那侧
 *     已经有一份;CLI 若自己现搓一套,两处早晚会说不一样的话,而「界面说排队、
 *     命令行说没排队」比两边都不说更糟。所以这里**复用** `room-rules.ts` 的
 *     `resolveCollabRoomHandBlock` 与 `collabRoomActiveLeases` —— 一模一样的
 *     那个函数,不是照着抄的第二个。
 *  2. **纯段要能被测**。一个 `.mjs` 脚本只能靠子进程验,而行格式化、过滤、
 *     名字解析这些恰恰是最容易错一格的地方(错一格没人看得出来,因为输出本来
 *     就长得像那样)。搬进来之后它们跟别的纯规则一起跑在 vitest 里。
 *
 * ## 进程外读不到的两样,一律**如实说**,不猜
 *
 *  - **「生成中」**:判据是 turn-context 登记簿,那是内存态。盘上只有租约,而
 *    租约只证明「轮到它了」,证明不了「它此刻真在生成」(D8 §1 的词汇表修正说的
 *    就是这一对)。所以 CLI 一律只报**持牌**,并把「执行态要进程内看」写在同一行。
 *  - **预算闸**:`overBudget` 由宿主现算(用量账本 + 房间上限),不在房账里。
 *    `collabInspectGates` 因此把它填 `false` 并**记一条 caveat** —— 一只手真被
 *    预算闸拦着的时候,重算出来的 `blockedBy` 会落到下游某道闸上。时间轴里那条
 *    `gate-block` 行才是进程内的原话,所以详情页两个都给:重算的判据 + 账上最近
 *    一次记下的闸。
 *
 * 保密纪律沿用蓝图 §7:这个文件**不认识消息正文**。它拿到的输入是账、时间轴行
 * 与配置,三样里都没有正文;它也不会去读转录。
 */
import type { CollabActivationReason } from '../activation.js'
import type { CollabRaisedHand } from './floor-policy.js'
import type { CollabAgentAccount } from './mind-rules.js'
import type { CollabWorkerStatus } from './worker-rules.js'
import {
  collabRoomActiveLeases,
  resolveCollabRoomHandBlock,
  type CollabRoomAccount,
  type CollabRoomGates,
  type CollabRoomHandBlock,
} from './room-rules.js'
import type {
  CollabSchedulerLogRow,
  CollabSchedulerLogType,
} from './scheduler-log-rules.js'

/* ── 输入:CLI 从盘上读到的东西 ─────────────────────────────────────────── */

/**
 * 房间配置里 CLI 用得上的那几格 —— **最小结构类型**(产品层不碰 shared 的 IPC
 * 契约,与 `CollabDmRoomLike` 同一条纪律)。全部可缺席:一间房的 meta 可能读不到
 * (会话被删了、格式变了),那时闸按缺省算,而不是整条命令炸掉。
 */
export interface CollabInspectRoomConfigLike {
  dm?: boolean
  memberAgentIds?: readonly string[]
  responseMode?: string
  frozen?: boolean
  budgets?: {
    maxChain?: number
    maxConcurrentTurns?: number
  }
}

/** 一条信箱的积压读数。`unreadable` = 文件在但读不动(损坏 / 权限)。 */
export interface CollabInspectMailbox {
  depth: number
  oldestAt?: number
  unreadable?: string
}

/** 一间房喂进来的原始事实。 */
export interface CollabInspectRoomInput {
  roomId: string
  /** 会话名(`sessions/<id>/meta.json` 的 `name`)。读不到就没有。 */
  name?: string
  account: CollabRoomAccount
  room?: CollabInspectRoomConfigLike | null
  /** 时间轴尾读,**新在前**(`readTail` 的既定次序)。缺席 = 没读。 */
  tail?: readonly CollabSchedulerLogRow[]
  /** 房间自己的信箱(`collab/<id>/actors/inbox.jsonl`)。 */
  mailbox?: CollabInspectMailbox
  now: number
}

/** 一位同事喂进来的原始事实。 */
export interface CollabInspectAgentInput {
  agentId: string
  /** `agents.json` 里的名字。退休 / 被删 = 没有。 */
  name?: string
  account: CollabAgentAccount
  inbox?: CollabInspectMailbox
  /** 各房账 —— **租约的唯一权威**(与 `agent-activity.ts` 同一条纪律)。 */
  rooms: ReadonlyArray<{ roomSessionId: string; name?: string; account: CollabRoomAccount }>
  /** 时间轴上署名 `agent:<id>` 的死信条数。盘上数得出来,不是内存环。 */
  deadLetters?: number
  now: number
}

/* ── 闸 ───────────────────────────────────────────────────────────────────── */

/** 与 `room-runtime.ts` 的 `COLLAB_MAX_CONCURRENT_TURNS` 同值。见下面的注释。 */
export const COLLAB_INSPECT_DEFAULT_MAX_CONCURRENT = 6
/** 与 `collab/types.ts` 的 `COLLAB_DEFAULT_MAX_CHAIN` 同值。 */
export const COLLAB_INSPECT_DEFAULT_MAX_CHAIN = 32
/** 与 `collab/types.ts` 的 `COLLAB_DM_PAIR_MAX_CHAIN` 同值。 */
export const COLLAB_INSPECT_DM_PAIR_MAX_CHAIN = 6

/**
 * 进程外重算不出来的那几道闸。详情页把它原样印出来 —— 一个读者看见「重算判据」
 * 时必须同时看见「这次重算少了哪一格」,否则他会把它当成全部真相。
 */
export type CollabInspectCaveat = 'budget-gate' | 'executing' | 'no-room-config'

/**
 * 这间房此刻的闸读数,**只用盘上有的东西算**。
 *
 * 三格取自房间配置(`sessions/<id>/meta.json` 的 `room`),口径与
 * `app/collab/room-runtime.ts` 的 `maxChainFor` / `maxConcurrentTurnsFor` 逐条对齐:
 * 缺省 = 内置默认(双成员 dm 房的链闸另有一档);**0 = 不限**;负数按「没配」。
 * 那两个函数住在装配层(它们要 `store.getSession`),CLI 进不去,所以口径在这里
 * 重述一遍 —— 这是本文件唯一一处"抄"，因此常量在上面显式对齐并注明出处。
 */
export function collabInspectGates(
  account: CollabRoomAccount,
  room: CollabInspectRoomConfigLike | null | undefined,
  now: number,
): { gates: CollabRoomGates; caveats: CollabInspectCaveat[] } {
  // 成员表这里只当**授权面**用(闸判定读它的长度与 id),名字与头像那几格 CLI 用不上
  // ——`name` 回填 id 是为了满足 `CollabAgentLike` 的形状,不是在冒充名册。
  const members = (room?.memberAgentIds ?? []).map(id => ({ id, name: id }))
  const pairDm = room?.dm === true && members.length === 2
  const caveats: CollabInspectCaveat[] = ['budget-gate']
  if (!room) caveats.push('no-room-config')
  return {
    gates: {
      frozen: room?.frozen === true,
      // 用量账本不在房账里,进程外算不出。填 false 并记 caveat —— 见文件头。
      overBudget: false,
      maxChain: collabInspectMaxChain(room, pairDm),
      maxConcurrent: collabInspectMaxConcurrent(room),
      members,
      ...(pairDm ? { pairDm: true } : {}),
      // 群房(≥2 人、非私聊)挂裁判 —— 与 `roomHasReferee` 同一条判据。
      ...(!room?.dm && members.length >= 2 ? { referee: true } : {}),
      now,
    },
    caveats,
  }
}

function collabInspectMaxChain(
  room: CollabInspectRoomConfigLike | null | undefined,
  pairDm: boolean,
): number {
  const configured = room?.budgets?.maxChain
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 0) {
    return pairDm ? COLLAB_INSPECT_DM_PAIR_MAX_CHAIN : COLLAB_INSPECT_DEFAULT_MAX_CHAIN
  }
  return configured === 0 ? Number.POSITIVE_INFINITY : Math.floor(configured)
}

function collabInspectMaxConcurrent(room: CollabInspectRoomConfigLike | null | undefined): number {
  // 用户把模式钉死成顺序 = 一次一个,与 `maxConcurrentTurnsFor` 的第一条分支同款。
  if (room?.responseMode === 'serial' && room?.dm !== true) return 1
  const configured = room?.budgets?.maxConcurrentTurns
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 0) {
    return COLLAB_INSPECT_DEFAULT_MAX_CONCURRENT
  }
  return configured === 0 ? Number.POSITIVE_INFINITY : Math.floor(configured)
}

/* ── 房间摘要 ─────────────────────────────────────────────────────────────── */

export interface CollabInspectLeaseRow {
  agentId: string
  leaseId: string
  since: number
  heldMs: number
  /**
   * 发牌时的房间代数。
   *
   * 这里**只列在外的牌**(`collabRoomActiveLeases` 已经把换代作废与过期的滤掉了),
   * 所以这一格恒等于房间当前代数 —— 印它是为了让「重启换过代没有」在详情页与
   * 房头那一格能对上,不是为了标记作废。
   */
  epoch: number
  reason?: CollabActivationReason
}

export interface CollabInspectHandRow {
  agentId: string
  at: number
  waitedMs: number
  origin: CollabRaisedHand['origin']
  reason: CollabActivationReason
  /** 重算的判据(缺预算闸那一格,见 caveats)。 */
  blockedBy: CollabRoomHandBlock
  /** 时间轴上这只手最近一次被记下的闸 —— **进程内的原话**。 */
  loggedGate?: CollabRoomHandBlock
}

export interface CollabInspectVerdictReplay {
  at: number
  token: string
  order: string[]
  why?: string
  elapsedMs: number
  model?: string
}

export interface CollabInspectJudgmentView {
  state: 'idle' | 'pending' | 'resolved' | 'degraded'
  token?: string
  openedAt?: number
  ageMs?: number
  grants?: string[]
  why?: string
  /** 时间轴尾部最近一次完整裁决回放(候选/排序/理由/耗时/模型)。 */
  lastVerdict?: CollabInspectVerdictReplay
  lastDegraded?: { at: number; token: string; reason: string }
}

export interface CollabInspectRoomSummary {
  roomId: string
  name?: string
  frozen: boolean
  policy: string
  phase?: string
  epoch: number
  leases: CollabInspectLeaseRow[]
  hands: CollabInspectHandRow[]
  /** `max: null` = 不限(`Infinity` 过不了 JSON)。 */
  seats: { used: number; max: number | null }
  chain: { value: number; max: number | null; resetMessageId?: string }
  judgment: CollabInspectJudgmentView
  watermark?: { messageId?: string; at?: number }
  /** 时间轴上这间房的死信条数。 */
  deadLetters: number
  mailbox?: CollabInspectMailbox
  /** 时间轴最新一行的时刻 —— 「这间房上一次动是什么时候」。 */
  lastEventAt?: number
  seq: number
  caveats: CollabInspectCaveat[]
}

/** `Infinity` → `null`(JSON 里 `Infinity` 会变成 `null`,不如自己先说清楚)。 */
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

/**
 * 一间房此刻的样子。**纯**:一个字段都不写,输入不被改。
 *
 * 时间轴是可选输入:没读时 `deadLetters` = 0、`loggedGate` 缺席、裁决回放缺席
 * ——那三样本来就只有账本才有,而「读不到」与「没有」在这里必须是同一个样子,
 * 不能让一次没带 `--tail` 的调用看起来像「这间房没出过事」。所以详情页在时间轴
 * 缺席时印的是「(未读时间轴)」而不是 0。
 */
export function summarizeCollabInspectRoom(input: CollabInspectRoomInput): CollabInspectRoomSummary {
  const { account, now } = input
  const { gates, caveats } = collabInspectGates(account, input.room, now)
  const active = collabRoomActiveLeases(account, now)
  const tail = input.tail ?? []

  const leases: CollabInspectLeaseRow[] = active.map(lease => {
    const reason = account.leaseReasons[lease.leaseId]
    return {
      agentId: lease.agentId,
      leaseId: lease.leaseId,
      since: lease.issuedAt,
      heldMs: Math.max(0, now - lease.issuedAt),
      epoch: lease.epoch,
      ...(reason ? { reason } : {}),
    }
  })

  // 重算的判据是**房级**的(六道闸里没有一道是按人开的),所以每只手拿到同一个
  // 答案;差别在 `loggedGate` —— 那一格是进程内当时按人记下的。
  const blockedBy = resolveCollabRoomHandBlock(account, gates)
  const loggedGates = collabInspectLoggedGates(tail)
  const hands: CollabInspectHandRow[] = account.hands.map(hand => {
    const logged = loggedGates.get(hand.agentId)
    return {
      agentId: hand.agentId,
      at: hand.at,
      waitedMs: Math.max(0, now - hand.at),
      origin: hand.origin,
      reason: hand.reason,
      blockedBy,
      ...(logged ? { loggedGate: logged } : {}),
    }
  })

  return {
    roomId: input.roomId,
    ...(input.name ? { name: input.name } : {}),
    frozen: gates.frozen,
    policy: account.policy.name,
    ...(account.phase ? { phase: account.phase } : {}),
    epoch: account.floor.epoch,
    leases,
    hands,
    seats: { used: active.length, max: finiteOrNull(gates.maxConcurrent) },
    chain: {
      value: account.chainCount,
      max: finiteOrNull(gates.maxChain),
      ...(account.chainResetMessageId ? { resetMessageId: account.chainResetMessageId } : {}),
    },
    judgment: collabInspectJudgment(account, tail, now),
    ...(account.watermark.messageId || account.watermark.at
      ? { watermark: account.watermark }
      : {}),
    deadLetters: tail.filter(row => row.type === 'dead-letter').length,
    ...(input.mailbox ? { mailbox: input.mailbox } : {}),
    ...(tail[0] ? { lastEventAt: tail[0].at } : {}),
    seq: account.seq,
    caveats,
  }
}

/**
 * 时间轴上每位举手者**最近一次**撞到的闸。
 *
 * 尾读是新在前,所以第一次见到某个 agentId 就是它最近那一条 —— 后面再见到的都是
 * 更早的,跳过。
 */
function collabInspectLoggedGates(
  tail: readonly CollabSchedulerLogRow[],
): Map<string, CollabRoomHandBlock> {
  const gates = new Map<string, CollabRoomHandBlock>()
  for (const row of tail) {
    if (row.type !== 'gate-block') continue
    if (gates.has(row.agentId)) continue
    gates.set(row.agentId, row.gate)
  }
  return gates
}

/** 裁决窗此刻的样子 + 账本里最近一次的完整回放。 */
function collabInspectJudgment(
  account: CollabRoomAccount,
  tail: readonly CollabSchedulerLogRow[],
  now: number,
): CollabInspectJudgmentView {
  const verdict = tail.find(row => row.type === 'judge-verdict')
  const degraded = tail.find(row => row.type === 'judge-degraded')
  const replay: Pick<CollabInspectJudgmentView, 'lastVerdict' | 'lastDegraded'> = {
    ...(verdict && verdict.type === 'judge-verdict'
      ? {
          lastVerdict: {
            at: verdict.at,
            token: verdict.token,
            order: [...verdict.order],
            ...(verdict.why ? { why: verdict.why } : {}),
            elapsedMs: verdict.elapsedMs,
            ...(verdict.model ? { model: verdict.model } : {}),
          },
        }
      : {}),
    ...(degraded && degraded.type === 'judge-degraded'
      ? { lastDegraded: { at: degraded.at, token: degraded.token, reason: degraded.reason } }
      : {}),
  }

  const judgment = account.judgment
  if (!judgment) return { state: 'idle', ...replay }
  return {
    state: judgment.state,
    token: judgment.token,
    openedAt: judgment.openedAt,
    ageMs: Math.max(0, now - judgment.openedAt),
    ...(judgment.grants ? { grants: [...judgment.grants] } : {}),
    ...(judgment.why ? { why: judgment.why } : {}),
    ...replay,
  }
}

/* ── Agent 摘要 ───────────────────────────────────────────────────────────── */

export interface CollabInspectAgentSummary {
  agentId: string
  name?: string
  /** 扫**各房账**得来 —— 房间才是租约的权威(agent 账上那份是它自己的备份)。 */
  leases: Array<{
    roomSessionId: string
    roomName?: string
    leaseId: string
    since: number
    heldMs: number
  }>
  /** 此刻举着手的房(同样扫房账,不读 agent 账的 `hands` 备份)。 */
  hands: Array<{ roomSessionId: string; roomName?: string; at: number; waitedMs: number }>
  inbox: CollabInspectMailbox
  workers: Array<{
    cardId: string
    roomSessionId: string
    roomName?: string
    status: CollabWorkerStatus
    since: number
    ageMs: number
  }>
  /** 涉入房清单:agent 账里有记录的每一间。 */
  rooms: Array<{
    roomSessionId: string
    roomName?: string
    turns: number
    lastTurnAt?: number
    unreadFrom?: string
  }>
  lastTurnAt?: number
  /** 折叠缓冲里攒着的条数(还没被心智循环取走的信封)。 */
  foldDepth: number
  foldDropped: number
  deadLetters: number
  seq: number
}

/** 一位同事此刻的样子。**纯**。 */
export function summarizeCollabInspectAgent(
  input: CollabInspectAgentInput,
): CollabInspectAgentSummary {
  const { account, agentId, now } = input
  const leases: CollabInspectAgentSummary['leases'] = []
  const hands: CollabInspectAgentSummary['hands'] = []
  for (const room of input.rooms) {
    for (const lease of collabRoomActiveLeases(room.account, now)) {
      if (lease.agentId !== agentId) continue
      leases.push({
        roomSessionId: room.roomSessionId,
        ...(room.name ? { roomName: room.name } : {}),
        leaseId: lease.leaseId,
        since: lease.issuedAt,
        heldMs: Math.max(0, now - lease.issuedAt),
      })
    }
    for (const hand of room.account.hands) {
      if (hand.agentId !== agentId) continue
      hands.push({
        roomSessionId: room.roomSessionId,
        ...(room.name ? { roomName: room.name } : {}),
        at: hand.at,
        waitedMs: Math.max(0, now - hand.at),
      })
    }
  }

  const roomNames = new Map(input.rooms.map(room => [room.roomSessionId, room.name]))
  const nameOf = (roomSessionId: string): string | undefined => roomNames.get(roomSessionId)
  const rooms = Object.entries(account.rooms).map(([roomSessionId, entry]) => {
    const name = roomNames.get(roomSessionId)
    return {
      roomSessionId,
      ...(name ? { roomName: name } : {}),
      turns: entry.turns,
      ...(entry.lastTurnAt === undefined ? {} : { lastTurnAt: entry.lastTurnAt }),
      // 「读到哪了」—— 水位之后的都是它还没读的。
      ...(entry.readMessageId ? { unreadFrom: entry.readMessageId } : {}),
    }
  })
  rooms.sort((a, b) => (b.lastTurnAt ?? 0) - (a.lastTurnAt ?? 0))

  let lastTurnAt: number | undefined
  for (const room of Object.values(account.rooms)) {
    if (room.lastTurnAt === undefined) continue
    if (lastTurnAt === undefined || room.lastTurnAt > lastTurnAt) lastTurnAt = room.lastTurnAt
  }

  return {
    agentId,
    ...(input.name ? { name: input.name } : {}),
    leases,
    hands,
    inbox: input.inbox ?? { depth: 0 },
    workers: account.workers.map(record => {
      const roomName = nameOf(record.roomId)
      return {
        cardId: record.cardId,
        roomSessionId: record.roomId,
        ...(roomName ? { roomName } : {}),
        status: record.status,
        since: record.startedAt,
        ageMs: Math.max(0, now - record.startedAt),
      }
    }),
    rooms,
    ...(lastTurnAt === undefined ? {} : { lastTurnAt }),
    foldDepth: account.fold.length,
    foldDropped: account.foldDropped,
    deadLetters: input.deadLetters ?? 0,
    seq: account.seq,
  }
}

/* ── 时间轴:过滤与死信 ───────────────────────────────────────────────────── */

export interface CollabInspectRowFilter {
  types?: readonly CollabSchedulerLogType[]
  /** 只要与这位同事有关的行(举手/授牌/发言/让位/撤销/撞闸/工作卡)。 */
  agentId?: string
  limit?: number
}

/**
 * 行里那个「这是谁」的格子。没有 = 这一类行不属于任何人(posted / phase / 裁决)。
 *
 * 外部通路三类(E6)也属于某个人:少了它们,`--agent iris` 会把她那一整轮外部回合
 * 过滤掉 —— 而那恰恰是最想按人筛的一段。`interaction` 的 `agentId` 可能缺席(会话
 * 不在任何一轮 v3 回合里),照旧原样返回。
 */
export function collabInspectRowAgentId(row: CollabSchedulerLogRow): string | undefined {
  switch (row.type) {
    case 'posted':
      return row.authorId
    case 'hand':
    case 'grant':
    case 'gate-block':
    case 'speak':
    case 'yield':
    case 'revoke':
    case 'worker-spawn':
    case 'worker-result':
    case 'external-turn':
    case 'external-tool':
    case 'interaction':
      return row.agentId
    default:
      return undefined
  }
}

/** 过滤 + 截断。次序原样保留(尾读给的是新在前)。 */
export function filterCollabInspectRows(
  rows: readonly CollabSchedulerLogRow[],
  filter: CollabInspectRowFilter = {},
): CollabSchedulerLogRow[] {
  const wanted = filter.types && filter.types.length > 0 ? new Set<string>(filter.types) : null
  const out: CollabSchedulerLogRow[] = []
  for (const row of rows) {
    if (wanted && !wanted.has(row.type)) continue
    if (filter.agentId && collabInspectRowAgentId(row) !== filter.agentId) continue
    out.push(row)
    if (filter.limit !== undefined && out.length >= filter.limit) break
  }
  return out
}

export interface CollabInspectDeadLetterGroup {
  actor: string
  count: number
  /** 出过事的事件类型(去重,按首次出现序)。 */
  eventTypes: string[]
  latestAt: number
  latestError: string
  rooms: string[]
}

/**
 * 死信按 actor 分组。
 *
 * 分组键是**署名**(`room:<id>` / `agent:<id>`)而不是房:一封坏信说明的是「谁
 * 处理不了什么」,而同一个 actor 的同类坏信通常是一串 —— 按 actor 聚起来才看得出
 * 「是这个人一直在炸」还是「所有人都在同一类事件上炸」。
 */
export function groupCollabInspectDeadLetters(
  entries: ReadonlyArray<{ roomId: string; row: CollabSchedulerLogRow }>,
): CollabInspectDeadLetterGroup[] {
  const groups = new Map<string, CollabInspectDeadLetterGroup>()
  for (const entry of entries) {
    const row = entry.row
    if (row.type !== 'dead-letter') continue
    let group = groups.get(row.actor)
    if (!group) {
      group = { actor: row.actor, count: 0, eventTypes: [], latestAt: 0, latestError: '', rooms: [] }
      groups.set(row.actor, group)
    }
    group.count += 1
    if (!group.eventTypes.includes(row.eventType)) group.eventTypes.push(row.eventType)
    if (!group.rooms.includes(entry.roomId)) group.rooms.push(entry.roomId)
    if (row.at >= group.latestAt) {
      group.latestAt = row.at
      group.latestError = row.error
    }
  }
  return [...groups.values()].sort((a, b) => b.latestAt - a.latestAt)
}

/* ── 名字解析 ─────────────────────────────────────────────────────────────── */

export interface CollabInspectTarget {
  id: string
  name?: string
}

/**
 * `--room` / `--agent` 后面那串字符指的是谁。
 *
 * 三档,**先精确后模糊**:id 全等 → 名字全等(忽略大小写)→ 子串命中(id 或名字)。
 * 一间房的 id 是 uuid,没人愿意手抄;而名字会重(两间「测试」),所以模糊命中多于
 * 一个时**不猜**,把候选原样列出来让人再说一次 —— 诊断工具猜错目标的代价是「你
 * 看的是另一间房的账」,那种错误在屏幕上完全看不出来。
 */
export function matchCollabInspectTargets(
  query: string,
  entries: readonly CollabInspectTarget[],
): CollabInspectTarget[] {
  const text = query.trim()
  if (!text) return []
  const exactId = entries.filter(entry => entry.id === text)
  if (exactId.length > 0) return exactId
  const lower = text.toLowerCase()
  const exactName = entries.filter(entry => (entry.name ?? '').toLowerCase() === lower)
  if (exactName.length > 0) return exactName
  return entries.filter(entry =>
    entry.id.toLowerCase().includes(lower) || (entry.name ?? '').toLowerCase().includes(lower))
}

/* ── 格式化 ───────────────────────────────────────────────────────────────── */

/**
 * 时长。给人看的,所以**只留两个有效位**:「1m12s」比「72340ms」更快读懂,而
 * 诊断从来不需要那 340。
 */
export function formatCollabInspectDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`
}

/** `MM-DD HH:MM:SS`(本地时区)。时间轴的行首就是它。 */
export function formatCollabInspectStamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '(无)'
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 「多久以前」。总览里用它 —— 绝对时刻要人自己减一次。 */
export function formatCollabInspectAgo(ts: number | undefined, now: number): string {
  if (ts === undefined || !Number.isFinite(ts) || ts <= 0) return '(无)'
  return `${formatCollabInspectDuration(Math.max(0, now - ts))}前`
}

/** 短 id:uuid 全长在一行里挤掉了别的信息。**只在有标签时缩**,否则原样。 */
export function shortCollabInspectId(id: string, keep = 8): string {
  return id.length > keep + 2 ? `${id.slice(0, keep)}…` : id
}

export interface CollabInspectLabelOptions {
  /** id → 显示名。缺席 = 印 id。 */
  label?: (id: string) => string | undefined
}

function labelOf(id: string, options: CollabInspectLabelOptions | undefined): string {
  const name = options?.label?.(id)
  return name ? `${name}(${shortCollabInspectId(id)})` : id
}

const HAND_BLOCK_LABEL: Record<CollabRoomHandBlock, string> = {
  frozen: '冻结',
  budget: '预算闸',
  judging: '裁决中',
  phase: '相位挂起',
  seats: '等座位',
  chain: '链闸',
}

/** 六道闸的中文名。UI 那侧的徽标用的是同一套词(蓝图 §4.1)。 */
export function collabInspectHandBlockLabel(block: CollabRoomHandBlock): string {
  return HAND_BLOCK_LABEL[block] ?? block
}

const JUDGMENT_LABEL: Record<CollabInspectJudgmentView['state'], string> = {
  idle: '空',
  pending: '在飞',
  resolved: '已判',
  degraded: '降级',
}

/**
 * 总览里一间房的**一行**。
 *
 * 「持牌」而不是「发言中」:进程外分不出「真在生成」与「持牌等大脑」,而 v3 里
 * 后者是一个真实存在的状态(D8 §1)。一行里写不下那句解释,所以解释在总览的表头。
 */
export function formatCollabInspectRoomLine(
  summary: CollabInspectRoomSummary,
  options?: CollabInspectLabelOptions,
): string {
  const holders = summary.leases.length > 0
    ? summary.leases.map(lease => labelOf(lease.agentId, options)).join(',')
    : '—'
  const hands = summary.hands.length > 0
    ? `${summary.hands.length}(${collabInspectHandBlockLabel(summary.hands[0]!.blockedBy)})`
    : '0'
  const chainMax = summary.chain.max === null ? '∞' : String(summary.chain.max)
  const seatMax = summary.seats.max === null ? '∞' : String(summary.seats.max)
  const flags: string[] = []
  if (summary.frozen) flags.push('冻结')
  if (summary.phase) flags.push(`相位=${summary.phase}`)
  if (summary.deadLetters > 0) flags.push(`!死信${summary.deadLetters}`)
  if (summary.mailbox && summary.mailbox.depth > 0) flags.push(`信箱${summary.mailbox.depth}`)
  return `${summary.name ?? summary.roomId}  持牌 ${summary.seats.used}/${seatMax} [${holders}]`
    + ` 举手 ${hands} 裁决 ${JUDGMENT_LABEL[summary.judgment.state]}`
    + ` 链 ${summary.chain.value}/${chainMax} 策略 ${summary.policy}`
    + (flags.length > 0 ? `  ${flags.join(' ')}` : '')
}

/** 总览里一位同事的**一行**。 */
export function formatCollabInspectAgentLine(
  summary: CollabInspectAgentSummary,
  now: number,
): string {
  const flags: string[] = []
  if (summary.hands.length > 0) flags.push(`举手 ${summary.hands.length}`)
  if (summary.foldDepth > 0) flags.push(`折叠 ${summary.foldDepth}`)
  if (summary.deadLetters > 0) flags.push(`!死信 ${summary.deadLetters}`)
  if (summary.inbox.unreadable) flags.push(`!信箱读不动`)
  const running = summary.workers.filter(worker => worker.status === 'running').length
  return `${summary.name ?? summary.agentId}  持牌 ${summary.leases.length}`
    + ` 信箱 ${summary.inbox.depth} 工作卡 ${running}/${summary.workers.length}`
    + ` 上次开口 ${formatCollabInspectAgo(summary.lastTurnAt, now)}`
    + (flags.length > 0 ? `  ${flags.join(' ')}` : '')
}

/** 「持牌 N(执行态需进程内,见 UI)」—— 进程外那条诚实声明,只有一处出处。 */
export const COLLAB_INSPECT_EXECUTING_NOTE = '执行态需进程内,见 UI'

const CAVEAT_LINE: Record<CollabInspectCaveat, string> = {
  'budget-gate': '! 判据不含预算闸(用量账本不在房账里,进程外算不出)——真被预算拦住时重算结果会落到下游某道闸',
  executing: `! 「生成中」进程外推断不了(登记簿是内存态)——本命令只报持牌,${COLLAB_INSPECT_EXECUTING_NOTE}`,
  'no-room-config': '! 读不到房间配置(会话 meta 缺失)——闸按内置缺省算,成员表为空',
}

export function formatCollabInspectCaveats(caveats: readonly CollabInspectCaveat[]): string[] {
  return caveats.map(caveat => CAVEAT_LINE[caveat] ?? `! ${caveat}`)
}

/** 单房详情。返回逐行,由 CLI 决定怎么打印。 */
export function formatCollabInspectRoomDetail(
  summary: CollabInspectRoomSummary,
  tail: readonly CollabSchedulerLogRow[] | undefined,
  now: number,
  options?: CollabInspectLabelOptions,
): string[] {
  const lines: string[] = []
  lines.push(`# 房        ${summary.name ?? '(无名)'}  ${summary.roomId}`)
  lines.push(`# 策略      ${summary.policy}${summary.phase ? ` 相位=${summary.phase}` : ''}`
    + `  epoch=${summary.epoch} seq=${summary.seq}${summary.frozen ? '  **冻结**' : ''}`)
  const seatMax = summary.seats.max === null ? '∞' : String(summary.seats.max)
  const chainMax = summary.chain.max === null ? '∞(0=不限)' : String(summary.chain.max)
  lines.push(`# 闸        座位 ${summary.seats.used}/${seatMax}`
    + `  链 ${summary.chain.value}/${chainMax}`
    + `  死信 ${tail ? summary.deadLetters : '(未读时间轴)'}`)
  lines.push(`# 水位      ${summary.watermark?.messageId ?? '(无)'}`
    + `  ${formatCollabInspectAgo(summary.watermark?.at, now)}`)
  if (summary.mailbox) {
    lines.push(`# 房间信箱  积压 ${summary.mailbox.depth}`
      + (summary.mailbox.oldestAt ? `  最旧 ${formatCollabInspectAgo(summary.mailbox.oldestAt, now)}` : '')
      + (summary.mailbox.unreadable ? `  ! ${summary.mailbox.unreadable}` : ''))
  }
  lines.push('')

  lines.push(`租约(${summary.leases.length})  —— ${COLLAB_INSPECT_EXECUTING_NOTE}`)
  if (summary.leases.length === 0) lines.push('  (无人持牌)')
  for (const lease of summary.leases) {
    lines.push(`  ${labelOf(lease.agentId, options)}`
      + `  牌=${shortCollabInspectId(lease.leaseId, 12)} epoch=${lease.epoch}`
      + `  理由=${lease.reason ?? '?'}  持有 ${formatCollabInspectDuration(lease.heldMs)}`)
  }
  lines.push('')

  lines.push(`举手(${summary.hands.length})`)
  if (summary.hands.length === 0) lines.push('  (队列空)')
  for (const hand of summary.hands) {
    const logged = hand.loggedGate && hand.loggedGate !== hand.blockedBy
      ? `(账上记的是 ${collabInspectHandBlockLabel(hand.loggedGate)})`
      : ''
    lines.push(`  ${labelOf(hand.agentId, options)}`
      + `  卡在 ${collabInspectHandBlockLabel(hand.blockedBy)}${logged}`
      + `  来源=${hand.origin} 理由=${hand.reason}  已等 ${formatCollabInspectDuration(hand.waitedMs)}`)
  }
  lines.push('')

  lines.push('裁决窗')
  const judgment = summary.judgment
  lines.push(`  当前 ${JUDGMENT_LABEL[judgment.state]}`
    + (judgment.token ? `  token=${judgment.token}` : '')
    + (judgment.ageMs === undefined ? '' : `  开窗 ${formatCollabInspectDuration(judgment.ageMs)}前`)
    + (judgment.grants ? `  排序=${judgment.grants.map(id => labelOf(id, options)).join(' > ') || '(无人)'}` : '')
    + (judgment.why ? `  why=${judgment.why}` : ''))
  if (judgment.lastVerdict) {
    const replay = judgment.lastVerdict
    lines.push(`  最近一判 ${formatCollabInspectStamp(replay.at)}`
      + `  排序=${replay.order.map(id => labelOf(id, options)).join(' > ') || '(无人)'}`
      + `  耗时=${formatCollabInspectDuration(replay.elapsedMs)}`
      + (replay.model ? `  模型=${replay.model}` : '')
      + (replay.why ? `\n           why=${replay.why}` : ''))
  }
  if (judgment.lastDegraded) {
    lines.push(`  ! 最近降级 ${formatCollabInspectStamp(judgment.lastDegraded.at)}`
      + `  原因=${judgment.lastDegraded.reason}`)
  }
  lines.push('')

  lines.push(...formatCollabInspectCaveats(summary.caveats))
  lines.push(`${CAVEAT_LINE.executing}`)

  if (tail) {
    lines.push('')
    lines.push(`时间轴(尾 ${tail.length} 条,新在前)`)
    if (tail.length === 0) lines.push('  (账本为空 —— 这间房从没记过调度事件,或 14 天前的已被清掉)')
    for (const row of tail) lines.push(`  ${formatCollabInspectRow(row, options)}`)
  }
  return lines
}

/**
 * 单人详情。
 *
 * 这一份**不吃 label 选项**:整页里唯一会出现的 id 是房 id,而它已经在摘要里
 * 带着房名了。给一个用不上的 label 参数,下一个人会以为这里也认识别人的名字。
 */
export function formatCollabInspectAgentDetail(
  summary: CollabInspectAgentSummary,
  now: number,
): string[] {
  const lines: string[] = []
  lines.push(`# 同事      ${summary.name ?? '(无名)'}  ${summary.agentId}`)
  lines.push(`# 大脑      持牌 ${summary.leases.length}(${COLLAB_INSPECT_EXECUTING_NOTE})`
    + `  举手 ${summary.hands.length}  上次开口 ${formatCollabInspectAgo(summary.lastTurnAt, now)}`)
  lines.push(`# 信箱      积压 ${summary.inbox.depth}`
    + (summary.inbox.oldestAt ? `  最旧 ${formatCollabInspectAgo(summary.inbox.oldestAt, now)}` : '')
    + (summary.inbox.unreadable ? `  ! ${summary.inbox.unreadable}` : ''))
  lines.push(`# 折叠缓冲  ${summary.foldDepth} 条`
    + (summary.foldDropped > 0 ? `(丢弃过 ${summary.foldDropped})` : '')
    + `  死信 ${summary.deadLetters}  seq=${summary.seq}`)
  lines.push('')

  lines.push(`持牌(${summary.leases.length})`)
  if (summary.leases.length === 0) lines.push('  (无)')
  for (const lease of summary.leases) {
    lines.push(`  ${lease.roomName ?? lease.roomSessionId}`
      + `  牌=${shortCollabInspectId(lease.leaseId, 12)}`
      + `  持有 ${formatCollabInspectDuration(lease.heldMs)}`)
  }
  if (summary.hands.length > 0) {
    lines.push('')
    lines.push(`举手(${summary.hands.length})`)
    for (const hand of summary.hands) {
      lines.push(`  ${hand.roomName ?? hand.roomSessionId}  已等 ${formatCollabInspectDuration(hand.waitedMs)}`)
    }
  }
  lines.push('')

  lines.push(`工作卡(${summary.workers.length})`)
  if (summary.workers.length === 0) lines.push('  (无)')
  for (const worker of summary.workers) {
    lines.push(`  ${worker.status.padEnd(11)} 卡=${shortCollabInspectId(worker.cardId, 12)}`
      + `  房=${worker.roomName ?? worker.roomSessionId}  ${formatCollabInspectDuration(worker.ageMs)}前起`)
  }
  lines.push('')

  lines.push(`涉入房(${summary.rooms.length})`)
  if (summary.rooms.length === 0) lines.push('  (无)')
  for (const room of summary.rooms) {
    lines.push(`  ${room.roomName ?? room.roomSessionId}`
      + `  轮次=${room.turns}  上次 ${formatCollabInspectAgo(room.lastTurnAt, now)}`)
  }
  lines.push('')
  lines.push(CAVEAT_LINE.executing)
  return lines
}

/**
 * 时间轴的**一行**。
 *
 * 因果 `triggeredBy` 印在行尾的 `←` 后面:回查时眼睛沿着那一列往上走,就是
 * 「这一步是被上一步的什么东西勾出来的」。没有它只能靠时间戳猜因果,而并行的
 * 房间里那个猜法必然错(§3.3 的原话)。
 */
export function formatCollabInspectRow(
  row: CollabSchedulerLogRow,
  options?: CollabInspectLabelOptions,
): string {
  // 15 = 最长那个类型名(`judge-degraded`)+ 1,让正文那一列在所有行上对齐。
  const head = `${formatCollabInspectStamp(row.at)}  ${row.type.padEnd(15)}`
  const cause = row.triggeredBy ? `  ← ${shortCollabInspectId(row.triggeredBy, 12)}` : ''
  return `${head}${collabInspectRowBody(row, options)}${cause}`
}

function collabInspectRowBody(
  row: CollabSchedulerLogRow,
  options?: CollabInspectLabelOptions,
): string {
  switch (row.type) {
    case 'posted':
      return `${row.authorKind}${row.authorId ? ` ${labelOf(row.authorId, options)}` : ''}`
        + `${row.messageId ? ` msg=${shortCollabInspectId(row.messageId, 12)}` : ''}`
        + `${row.chainReset ? '  链清零' : ''}`
    case 'hand':
      return `${labelOf(row.agentId, options)}  来源=${row.origin} 理由=${row.reason}`
    case 'judge-open':
      return `token=${row.token}  候选=${row.candidates.map(id => labelOf(id, options)).join(',') || '(空)'}`
    case 'judge-verdict':
      return `token=${row.token}  排序=${row.order.map(id => labelOf(id, options)).join(' > ') || '(无人)'}`
        + `  耗时=${formatCollabInspectDuration(row.elapsedMs)}${row.model ? ` 模型=${row.model}` : ''}`
        + `${row.why ? `  why=${row.why}` : ''}`
    case 'judge-degraded':
      return `! token=${row.token}  降级=${row.reason}`
        + `${row.elapsedMs === undefined ? '' : ` 耗时=${formatCollabInspectDuration(row.elapsedMs)}`}`
    case 'grant':
      return `${labelOf(row.agentId, options)}  牌=${shortCollabInspectId(row.leaseId, 12)} 理由=${row.reason}`
    case 'gate-block':
      return `${labelOf(row.agentId, options)}  卡在 ${collabInspectHandBlockLabel(row.gate)}`
    case 'speak':
      return `${labelOf(row.agentId, options)}  牌=${shortCollabInspectId(row.leaseId, 12)}`
        + `${row.messageId ? ` msg=${shortCollabInspectId(row.messageId, 12)}` : ''}`
    case 'yield':
      return `${labelOf(row.agentId, options)}  牌=${shortCollabInspectId(row.leaseId, 12)}`
        + `${row.reason ? ` 原因=${row.reason}` : ''}`
    case 'revoke':
      return `${labelOf(row.agentId, options)}  牌=${shortCollabInspectId(row.leaseId, 12)} 因为=${row.cause}`
    case 'phase':
      return `${row.previousPhase ? `${row.previousPhase} → ` : ''}${row.name}  epoch=${row.epoch}`
    case 'worker-spawn':
      return `${labelOf(row.agentId, options)}  卡=${shortCollabInspectId(row.cardId, 12)}`
    case 'worker-result':
      return `${labelOf(row.agentId, options)}  卡=${shortCollabInspectId(row.cardId, 12)} 结果=${row.outcome}`
    case 'dead-letter':
      return `! ${row.actor}  事件=${row.eventType}  ${row.error}`
    /* ── 外部通路三类(E6,claude-code-integration-v2 §6)── */
    case 'external-turn':
      return `${labelOf(row.agentId, options)}  ${row.connectorId} ${row.phase}`
        + `${row.outcome ? ` 结果=${row.outcome}` : ''}`
        + `${row.elapsedMs === undefined ? '' : ` 耗时=${formatCollabInspectDuration(row.elapsedMs)}`}`
    case 'external-tool':
      // `宿主`/`SDK` 那一格是这一行最值钱的信息:同一个 `allow` 在两条路上意思完全
      // 不同(「放行给下游去审」vs「用户点了同意」)。
      return `${labelOf(row.agentId, options)}  ${row.hostTool ? '宿主' : 'SDK'} ${row.toolName}`
        + `  ${row.decision === 'allow' ? '放行' : '拒绝'}`
        + `${row.toolCallId ? ` call=${shortCollabInspectId(row.toolCallId, 12)}` : ''}`
    case 'interaction':
      return `${row.agentId ? `${labelOf(row.agentId, options)}  ` : ''}${row.phase}`
        + ` id=${shortCollabInspectId(row.interactionId, 12)}`
        + `${row.questionCount === undefined ? '' : ` ${row.questionCount} 题`}`
        + `${row.origin ? ` 来源=${row.origin}` : ''}`
    default:
      // 类型表已穷尽(`COLLAB_SCHEDULER_LOG_TABLE_IS_EXHAUSTIVE`),这条只兜住
      // 「盘上有一行是新版本写的」——诊断工具读老账/新账都不该炸。
      return JSON.stringify(row)
  }
}

/** 死信汇总的逐行形态。 */
export function formatCollabInspectDeadLetters(
  groups: readonly CollabInspectDeadLetterGroup[],
  now: number,
): string[] {
  if (groups.length === 0) {
    return ['死信 0 —— 全仓账本上没有一条事件处理失败(常绿即健康)。']
  }
  const lines: string[] = []
  let total = 0
  for (const group of groups) {
    total += group.count
    lines.push(`! ${group.actor}  ${group.count} 条  最近 ${formatCollabInspectAgo(group.latestAt, now)}`)
    lines.push(`    事件=${group.eventTypes.join(',')}`)
    lines.push(`    房=${group.rooms.join(',')}`)
    lines.push(`    首行=${group.latestError}`)
  }
  lines.push('')
  lines.push(`总计 ${total} 条,分布在 ${groups.length} 个 actor 上。`)
  return lines
}
