/**
 * Agent 视角的**后端半边** —— docs/design/collab-v3-observability.md §3.1。
 *
 * 房间那本账(`inspector.ts`)回答「这间房怎么了」。这一本回答另一个问题:
 * **「这个人现在在干嘛」** —— 而那个问题在房间那本账里根本问不出来,它只看得见
 * 自己这一间房里的那一格。v3 把世界改成了 agent 中心:一个大脑、跨房的租约、
 * 一条持久信箱、一把工作卡。硬要从 N 份房间快照里拼一个人的状态,拼出来的是
 * N 份各自过期的碎片。
 *
 * ## 三条纪律,与 inspector 逐条相同
 *
 *  1. **不新增一份账**。九格全部从现成的真值现算:大脑读 AgentActor 的循环状态
 *     与 turn-context 登记簿,租约读**各房账**(房间才是租约的权威,agent 账里
 *     那份是它自己的备份),信箱读游标差,工作卡读 agent 账的子清单,死信读
 *     ActorBase 的环。这个文件里唯一属于自己的状态是 `seq` 与节流槽 —— 它们是
 *     **这条广播通道**的属性,不是任何人的状态。
 *  2. **不落盘**。活动是此刻,重启之后没有此刻。要回查历史请走调度时间轴。
 *  3. **不为计时广播**。「想了多久」这种连续量由渲染层自己走秒;这里只在状态真的
 *     变了的时候推。
 *
 * ## 保密纪律(蓝图 §7)
 *
 * 快照**永不携带消息正文**:信箱只给深度与最旧时刻,工作卡只给卡号与状态。
 * 正文只在房间转录里,按成员表的可见性走。契约层已经用一条测试把这件事钉死
 * (`shared/events/__tests__/collab-agent-changed.test.ts`),这里的组装照着办。
 *
 * ## 广播落到哪条会话上
 *
 * agent 快照不属于任何一间房 —— 但 `SessionEvent` 的信封必须有一个 sessionId。
 * 决定是:**发给这位同事此刻牵涉到的那几间房**(在飞回合的房 ∪ 持牌的房 ∪ 有手
 * 在做的房),渲染层按 `activity.agentId` 归档。不引入"无房广播"约定,因为
 * EventBus 的每一格(环形缓冲、重放游标)都是按会话开的,一条假会话 id 会在
 * 重放与订阅两侧各留一个只对这一种事件成立的特例。
 *
 * 一个必须的补丁:目标房还要**并上上一次广播的那几间**。牌一交,这个人就不再
 * "牵涉"那间房了 —— 只发当前集合的话,「它停下来了」这一帧永远到不了刚刚还在看
 * 它说话的那间房。这与 inspector 的「不丢最后一帧」是同一条纪律,只是丢的东西
 * 从时间上的最后一帧变成了空间上的最后一间。
 */
import type {
  CollabAgentActivitySnapshot,
  CollabAgentHeldLease,
  CollabAgentMind,
  CollabAgentWorkerCard,
} from '@shared/ipc.js'
import {
  collabRoomActiveLeases,
  type CollabAgentAccount,
  type CollabRoomAccount,
} from '@onething/runtime/collab/actors'
// 两个内核的**只读**口(E6 的 `waitingOn`)。引的是 core 而不是装配层的门面:
// 这个文件会被 IPC 层直接调用,一条通往门面的边会把「读一份快照」重新变成
// 「把半个主进程拉起来」—— 与文件头那条端口纪律同一个理由。
import { Interaction } from '@onething/core/interaction'
import { Permission } from '@onething/core/permission'

import { getEventBus } from '../../events/index.js'
import { collabV3TurnsOfAgent } from '@onething/runtime/collab/actors/turn-context.wiring'
import {
  clearCollabSnapshotThrottle,
  createCollabSnapshotThrottle,
  scheduleCollabSnapshot,
  type CollabSnapshotThrottle,
} from '@onething/runtime/collab/snapshot-throttle'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

/**
 * 一位同事的**原始事实**,由运行时喂进来。
 *
 * 这是一个端口而不是一条 `import '../actors/runtime.js'`,理由与
 * `configureCollabRoomSnapshotSource` 完全同款:运行时 import 半个主进程(引擎、
 * store、看板、计费),而这个文件会被 IPC 层直接调用。反向依赖会把「读一份快照」
 * 变成「把整条协作链拉起来」。
 */
export interface CollabAgentActivityView {
  /**
   * 心智循环此刻在哪间房跑回合(`null` = 空闲)。
   *
   * 这是「一个大脑」这条宪法的可观测形态:AgentActor 的 `turn` 至多有一个,所以
   * 它至多在一间房里想。
   */
  inFlight: { roomSessionId: string; since: number } | null
  /** 这位同事的账(工作卡子清单、每间房的 `lastTurnAt`)。 */
  account: CollabAgentAccount
  /** 信箱积压:**游标差**(O(1),不数文件行)+ 最旧那封未 ack 的信的到达时刻。 */
  inbox: { depth: number; oldestAt?: number }
  /** ActorBase 死信环此刻还翻得出来几封坏信。 */
  deadLetterCount: number
}

export interface CollabAgentActivityScope {
  canReadSession(sessionId: string): boolean
  /** Inbox/dead letters have no room attribution and require store-wide visibility. */
  includeUnscoped: boolean
}

export interface CollabAgentActivityRegistry {
  /** 这位同事此刻的事实。没开心智循环 = undefined(下面按"空闲"处理)。 */
  agent(agentId: string): CollabAgentActivityView | undefined
  /** 此刻开着心智循环的全部同事。GET 不带 `agentIds` 时枚举它。 */
  agentIds(): readonly string[]
  /** 各房账 —— **租约的唯一权威**。 */
  rooms(): Iterable<{ roomSessionId: string; account: CollabRoomAccount }>
  now(): number
  scopeForRoom?(roomSessionId: string): CollabAgentActivityScope | undefined
}

let registry: CollabAgentActivityRegistry | null = null

/** 装上(或以 null 摘下)供数口。摘下之后 GET 回空、广播是空操作。 */
export function configureCollabAgentActivitySource(
  source: CollabAgentActivityRegistry | null,
): void {
  registry = source
}

/** 这条广播通道**自己**的状态:号 + 节流槽 + 上一次播到哪几间房。 */
interface AgentChannelState {
  /** 每 agent 单调,发射时 +1(C4 纪律:渲染层据此丢弃比屏幕更旧的包)。 */
  seq: number
  /** per-agent 独立节流槽 —— 一个话痨不该拖累别人那一格的刷新(蓝图 §7)。 */
  throttle: CollabSnapshotThrottle
  /** 上一发的目标房。见文件头「不丢最后一间」。 */
  lastRooms: string[]
}

const channels = new Map<string, AgentChannelState>()

function channelState(agentId: string): AgentChannelState {
  let state = channels.get(agentId)
  if (!state) {
    state = { seq: 0, throttle: createCollabSnapshotThrottle(), lastRooms: [] }
    channels.set(agentId, state)
  }
  return state
}

/** 这位同事不在了(退休 / 硬删)。与 `forgetCollabInspector` 同一时机语义。 */
export function forgetCollabAgentActivity(agentId: string): void {
  const state = channels.get(agentId)
  if (state) clearCollabSnapshotThrottle(state.throttle)
  channels.delete(agentId)
}

/** 进程收摊:清掉所有待发的定时器,别让一次广播活过它的发行方。 */
export function shutdownCollabAgentActivity(): void {
  for (const state of channels.values()) clearCollabSnapshotThrottle(state.throttle)
  channels.clear()
}

/* ── 组装 ─────────────────────────────────────────────────────────────────── */

/** 空闲那一份。「读不到」与「空闲」在界面上必须是同一个样子,否则冷启动会闪白。 */
function idleActivity(agentId: string, seq: number, at: number): CollabAgentActivitySnapshot {
  return {
    agentId,
    seq,
    at,
    mind: { state: 'idle' },
    heldLeases: [],
    inbox: { depth: 0 },
    workers: [],
    deadLetterCount: 0,
  }
}

/**
 * 这位同事此刻的样子。**纯读**:一个字段都不写,任何时候调都安全。
 *
 * `seq` 从广播通道现取而**不发号** —— 一次冷启动 GET 是读,它不该显得比刚发出去
 * 的那一帧更新(C4 纪律逐字沿用)。
 */
export function buildCollabAgentActivity(agentId: string, scope?: CollabAgentActivityScope): CollabAgentActivitySnapshot {
  const seq = channels.get(agentId)?.seq ?? 0
  const source = registry
  if (!source) return idleActivity(agentId, seq, Date.now())
  const view = source.agent(agentId)
  const now = source.now()
  if (!view) return idleActivity(agentId, seq, now)

  // 登记簿:这几张牌里哪些**真在生成**。「持牌等大脑」与「生成中」的分界只有它
  // 说得出来(D8 §1 的词汇表修正)——租约只证明「轮到它了」。
  const canRead = scope?.canReadSession ?? (() => true)
  const turns = collabV3TurnsOfAgent(agentId).filter(turn => canRead(turn.roomSessionId) && canRead(turn.execSessionId))
  const executingLeaseIds = new Set(turns.map(turn => turn.leaseId))
  const lastSpokeAt = lastSpokeAtOf(view.account, canRead)
  const scopedView = view.inFlight && !canRead(view.inFlight.roomSessionId) ? { ...view, inFlight: null } : view
  const unscoped = !scope || scope.includeUnscoped

  return {
    agentId,
    seq,
    at: now,
    mind: buildMind(scopedView, turns),
    heldLeases: buildHeldLeases(agentId, source, executingLeaseIds, now).filter(lease => canRead(lease.roomSessionId)),
    inbox: !unscoped ? { depth: 0 } : view.inbox.oldestAt === undefined
      ? { depth: view.inbox.depth }
      : { depth: view.inbox.depth, oldestAt: view.inbox.oldestAt },
    workers: buildWorkers(view.account).filter(worker => canRead(worker.roomSessionId)),
    ...(lastSpokeAt === undefined ? {} : { lastSpokeAt }),
    deadLetterCount: unscoped ? view.deadLetterCount : 0,
    ...(() => {
      const waitingOn = buildWaitingOn(turns)
      return waitingOn ? { waitingOn } : {}
    })(),
  }
}

/**
 * 它在等人吗(E6,§6)。
 *
 * 读两个内核**现成的** pending 表,一个字段都不写 —— 第十格与前九格同一条纪律
 * (`buildCollabAgentActivity` 是纯读,任何时候调都安全)。为它新开一本账的代价
 * 已经在别处付过好几次:两本账迟早会漂,而漂的那一刻界面上是一盏永远亮着的
 * 「等你回答」,比没有这盏灯更坏。
 *
 * 扫的是这位同事**此刻在跑的那几个执行会话**:提问与审批都记在执行会话上
 * (回合就跑在那儿),而房间会话上从来没有 pending。
 *
 * 两条链都挂着时取**更早**的那一条:这一格答的是「这个人被卡住多久了」,
 * 不是「最新那张卡开了多久」。
 */
function buildWaitingOn(
  turns: ReadonlyArray<{ execSessionId: string }>,
): CollabAgentActivitySnapshot['waitingOn'] {
  let best: { kind: 'interaction' | 'permission'; since: number } | undefined
  const consider = (kind: 'interaction' | 'permission', since: number): void => {
    if (!Number.isFinite(since)) return
    if (!best || since < best.since) best = { kind, since }
  }
  for (const turn of turns) {
    for (const request of Interaction.getPending(turn.execSessionId)) {
      consider('interaction', request.createdAt)
    }
    for (const prompt of Permission.getPendingPrompts(turn.execSessionId)) {
      // `queued` 的那些排在别人后面,球还不在人这边 —— 亮灯会把「排队」说成
      // 「等你答」,而用户在界面上找不到那张要他点的卡。
      if (prompt.promptState !== 'actionable') continue
      consider('permission', prompt.createdAt)
    }
  }
  return best
}

/**
 * 大脑在哪。
 *
 * 两个来源按序:AgentActor 的循环状态优先(它是「一个大脑」这条不变式的实现者,
 * 而且剧本化的假端口环境里只有它);拿不到时退回 turn-context 登记簿 —— 引擎在
 * 起流之前落的那一笔,真机上它与循环状态说的是同一件事。
 */
function buildMind(
  view: CollabAgentActivityView,
  turns: ReadonlyArray<{ roomSessionId: string; startedAt: number }>,
): CollabAgentMind {
  if (view.inFlight) {
    return {
      state: 'thinking',
      roomSessionId: view.inFlight.roomSessionId,
      since: view.inFlight.since,
    }
  }
  const registered = turns[0]
  if (!registered) return { state: 'idle' }
  return { state: 'thinking', roomSessionId: registered.roomSessionId, since: registered.startedAt }
}

/**
 * 手里的牌 —— 扫**各房账**,不是 agent 账里那份备份。
 *
 * 房间才是租约的权威:一张已经在房里被换代作废的牌,可能还躺在这位同事的账上
 * (`floor-revoked` 那封信还在路上)。读 agent 账的结果是界面上多出一张早就不存在
 * 的牌,而那正是最难查的一类"它明明没在说话"。
 */
function buildHeldLeases(
  agentId: string,
  source: CollabAgentActivityRegistry,
  executingLeaseIds: ReadonlySet<string>,
  now: number,
): CollabAgentHeldLease[] {
  const leases: CollabAgentHeldLease[] = []
  for (const room of source.rooms()) {
    for (const lease of collabRoomActiveLeases(room.account, now)) {
      if (lease.agentId !== agentId) continue
      leases.push({
        roomSessionId: room.roomSessionId,
        leaseId: lease.leaseId,
        since: lease.issuedAt,
        executing: executingLeaseIds.has(lease.leaseId),
      })
    }
  }
  return leases
}

/** 工作卡:agent 账的子清单原样投影。**不带 summary** —— 那是模型写的正文。 */
function buildWorkers(account: CollabAgentAccount): CollabAgentWorkerCard[] {
  return account.workers.map(record => ({
    cardId: record.cardId,
    roomSessionId: record.roomId,
    status: record.status,
    since: record.startedAt,
  }))
}

/**
 * 上一次说话的时刻。
 *
 * 读的是账里每间房的 `lastTurnAt` 取最大 —— 那一格在每轮收尾时由
 * `recordCollabAgentTurn` 写下,是**现成的**。为这一格新开一条写路径(比如在
 * speak 时另记一个 `lastSpokeAt`)就是第二本会漂的账,而它能提供的精度差别
 * (「说完话的时刻」vs「跑完回合的时刻」)在界面上是一个人读不出来的量。
 */
function lastSpokeAtOf(account: CollabAgentAccount, canRead: (id: string) => boolean): number | undefined {
  let latest: number | undefined
  for (const [roomId, room] of Object.entries(account.rooms)) {
    if (!canRead(roomId)) continue
    if (room.lastTurnAt === undefined) continue
    if (latest === undefined || room.lastTurnAt > latest) latest = room.lastTurnAt
  }
  return latest
}

/* ── 发射 ─────────────────────────────────────────────────────────────────── */

/**
 * 推一次这位同事的活动(节流)。
 *
 * 发射点(全部是现成数据,只加发射):心智循环取批 / 回合起止、租约得失
 * (floor-granted 消费、yield、被收牌)、mailbox append/ack、worker spawn/result、
 * 死信入环。它们各自决定走哪一档 —— 会**动**的东西(大脑、牌、手)走活动档,
 * 数字类的(积压、死信)走普通档。
 */
export function broadcastCollabAgentActivity(
  agentId: string,
  options: { activity?: boolean } = {},
): void {
  if (!agentId || !registry) return
  const state = channelState(agentId)
  scheduleCollabSnapshot(state.throttle, () => { emitAgentActivity(agentId, state) }, options)
}

function emitAgentActivity(agentId: string, state: AgentChannelState): void {
  // 号在 build 之前 +1 —— `buildCollabAgentActivity` 读的就是这个字段,于是发出去
  // 的那一份自带比上一发更大的号。
  state.seq += 1
  const activity = buildCollabAgentActivity(agentId)
  const rooms = broadcastRoomsOf(activity)
  // 上一发的目标并进来:牌一交这个人就不再"牵涉"那间房了,而「它停下来了」这一帧
  // 恰恰要送到刚刚还在看它说话的那间房去(见文件头)。
  const targets = new Set([...rooms, ...state.lastRooms])
  state.lastRooms = rooms
  state.throttle.lastSentAt = Date.now()
  const bus = getEventBus()
  for (const roomSessionId of targets) {
    const scope = registry?.scopeForRoom?.(roomSessionId) ?? {
      canReadSession: (id: string) => id === roomSessionId,
      includeUnscoped: false,
    }
    void bus.emit(roomSessionId, {
      type: SESSION_EVENT_TYPES.COLLAB_AGENT_CHANGED,
      activity: buildCollabAgentActivity(agentId, scope),
    } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
  }
}

/** 这一份快照该播给哪几间房 —— 「此刻牵涉到的」。 */
function broadcastRoomsOf(activity: CollabAgentActivitySnapshot): string[] {
  const rooms: string[] = []
  const push = (roomSessionId: string): void => {
    if (roomSessionId && !rooms.includes(roomSessionId)) rooms.push(roomSessionId)
  }
  if (activity.mind.state === 'thinking') push(activity.mind.roomSessionId)
  for (const lease of activity.heldLeases) push(lease.roomSessionId)
  // 只算**在做**的卡:一张三天前做完的卡不该让这个人永远给那间房刷快照。
  for (const worker of activity.workers) {
    if (worker.status === 'running') push(worker.roomSessionId)
  }
  return rooms
}

/* ── GET 补水 ─────────────────────────────────────────────────────────────── */

/**
 * 冷启动补水(`collab:agent-activity-get`)。
 *
 * `agentIds` 缺席 = 此刻开着心智循环的那些。带上则**逐个都有回答**:一位没在跑
 * 循环的同事回一份空闲快照,而不是被悄悄跳过 —— 渲染层拿不到那一格时画的是
 * "加载中",而它其实就是"空闲"。
 */
export function getCollabAgentActivity(
  agentIds?: readonly string[],
  scope?: CollabAgentActivityScope,
): CollabAgentActivitySnapshot[] {
  const ids = agentIds ?? registry?.agentIds() ?? []
  return ids.map(agentId => buildCollabAgentActivity(agentId, scope))
}
