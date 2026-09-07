/**
 * 协调器状态条的**后端半边** —— docs/design/collab-coordinator-inspector.md。
 *
 * 房间里最贵、最不可见的一步是调度:谁被问了、谁答了不说、谁排在队里、卡在哪道
 * 闸上,全发生在用户看不见的地方。这个文件把它变成一个可读的快照 + 一条「刚才」
 * 的事件流。
 *
 * 三条纪律,与那份设计的 §3 逐条对应:
 *
 *  1. **不新增一份账**。在跑读 `runtime.activeTurns`,排队读 `runtime.queue`,
 *     判定在飞读 `runtime.judgements`,闸读 `state.chainCount` / 预算缓存,
 *     编排读 `state.plan`。协调器已经握着全部真相,这里只是把它读出来 ——
 *     任何"为了显示而记的第二本账"都会先于真相腐烂。唯一的例外是下面那条
 *     环形缓冲,而它记的是**历史**,不是状态(历史没有别处可读)。
 *  2. **不落盘**。「刚才」说的就是刚才,重启之后没有刚才。落盘账本是
 *     `qm-collab-learnings` 的 P2-8,目的不同(换判定算法时对照效果),不绑一起。
 *  3. **不为计时广播**。「跑了多久」这种连续量由渲染层自己走秒;这里按秒节流,
 *     只在**状态真的变了**的时候推。
 */
import {
  COLLAB_DEFAULT_DAILY_COST_USD,
  isCollabPlanRoom,
} from '@onething/runtime/collab'
import type {
  CollabCoordinatorLogEntry,
  CollabCoordinatorState,
} from '@shared/ipc.js'
import type * as store from '../../store.js'
import type { EventBus } from '../../events/event-bus.js'
import { maxChainFor, maxConcurrentTurnsFor } from './room-runtime.js'
import {
  clearCollabSnapshotThrottle,
  createCollabSnapshotThrottle,
  scheduleCollabSnapshot,
  type CollabSnapshotThrottle,
} from '@onething/runtime/collab/snapshot-throttle'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

/** 「刚才」最多留几条。定长环形缓冲 —— 一间房不会因为聊得久而涨内存。 */
export const COLLAB_LOG_LIMIT = 32

interface InspectorRoomState {
  log: CollabCoordinatorLogEntry[]
  /**
   * 此刻在打字的人 —— 快照里 `typing` 的**唯一**真值来源(架构收敛 C4 §1/§2)。
   *
   * 这是文件头第 1 条纪律("不新增一份账")的第二个例外,理由与「刚才」同款:
   * typing 没有别处可读。它不像 `activeTurns` 那样是调度自己握着的状态,而是
   * `say` 的参数流打出来的一串脉冲,过去只以事件形式存在 —— 于是每个消费者都得
   * 自己攒一本,而窗口一重载那本账就归零。
   *
   * 写入点只有 `emitCollabTyping` 一处(四个生产点全从那道漏斗过),所以"事件发了
   * 但账没记"这种分家不可能发生。
   */
  typing: Set<string>
  /** 已经广播过几次 —— 快照的单调序号(渲染层据此丢弃乱序到达的旧快照)。 */
  seq: number
  /** 双档节流槽(共用件在 `snapshot-throttle.ts`)。 */
  throttle: CollabSnapshotThrottle
}

interface InspectorOwner {
  rooms: Map<string, InspectorRoomState>
  source: CollabRoomSnapshotSource | null
  accepting: boolean
  emissions: Set<Promise<unknown>>
  options: CollabInspectorOptions
}

export interface CollabInspectorOptions {
  getSession: typeof store.getSession
  emit: EventBus['emit']
  isActive(): boolean
  onError(error: unknown): void
}

export interface CollabInspector {
  build(roomSessionId: string): CollabCoordinatorState | null
  broadcast(roomSessionId: string, options?: { activity?: boolean }): void
  note(roomSessionId: string, entry: Omit<CollabCoordinatorLogEntry, 'at'>): void
  typing(roomSessionId: string, agentId: string, typing: boolean): void
  forget(roomSessionId: string): void
  configureSource(source: CollabRoomSnapshotSource | null): () => void
  quiesce(): void
  drain(): Promise<void>
}

/** Every Backend owns this view, including hosts that do not boot room actors. */
export function createCollabInspector(options: CollabInspectorOptions): CollabInspector {
  const owner: InspectorOwner = { rooms: new Map(), source: null, accepting: true, emissions: new Set(), options }
  const quiesce = () => {
    owner.accepting = false
    owner.source = null
    for (const state of owner.rooms.values()) clearCollabSnapshotThrottle(state.throttle)
    owner.rooms.clear()
  }
  return {
    build: id => buildCoordinatorState(owner, id),
    broadcast: (id, options) => broadcastCoordinator(owner, id, options),
    note: (id, entry) => noteSchedule(owner, id, entry),
    typing: (id, agentId, typing) => setTypingState(owner, id, agentId, typing),
    forget: id => forgetInspectorRoom(owner, id),
    configureSource(source) {
      if (!isActive(owner)) return () => {}
      owner.source = source
      return () => { if (owner.source === source) owner.source = null }
    },
    quiesce,
    async drain() {
      quiesce()
      while (owner.emissions.size) await Promise.allSettled([...owner.emissions])
    },
  }
}

let currentInspector: CollabInspector | null = null

export function configureCollabInspector(inspector: CollabInspector): () => void {
  currentInspector?.quiesce()
  currentInspector = inspector
  return () => { if (currentInspector === inspector) currentInspector = null }
}

/** Capture before scheduling work; a callback from A must never resolve B here. */
export function getCollabInspector(): CollabInspector | null { return currentInspector }

function isActive(owner: InspectorOwner): boolean {
  return owner.accepting && owner.options.isActive()
}

/**
 * v3 房账的供数口(D6-a 接线)。
 *
 * C4 快照协议是「renderer 几乎不改」那条承诺的落点,而广播的**次序纪律**(seq
 * 单调、节流、活动窗)全在这个文件里。所以 v3 不另开一条广播路,只把「调度那几格
 * 从哪儿读」换掉:装上之后 `speaking / turns / queue / judging / gates / plan` 来自
 * RoomActor 的账,没装(或这间房还没有 v3 actor)就照旧读 v2 运行时。
 *
 * 两格**不**从 v3 拿:
 *  - `typing` —— 打字灯是这个文件的账(见 `InspectorRoomState.typing`),v3 的
 *    房账里没有它,也不该有:它是 `say` 参数流打出来的脉冲,不是调度状态;
 *  - `log` —— 「刚才」同理,历史没有别处可读。
 *
 * `seq` 同样由这里盖:它是**这条广播通道**的号,不是房账的版本号。用房账的 seq
 * 会让两间房各说各的号,而渲染层拿它做的是「比屏幕上那份新吗」的判断。
 */
type CollabRoomSnapshotSource = (roomSessionId: string) => CollabCoordinatorState | null
export function configureCollabRoomSnapshotSource(source: CollabRoomSnapshotSource | null): () => void {
  return currentInspector?.configureSource(source) ?? (() => {})
}

function inspectorState(owner: InspectorOwner, roomSessionId: string): InspectorRoomState | null {
  if (!isActive(owner)) return null
  let state = owner.rooms.get(roomSessionId)
  if (!state) {
    // 死房不复活(2026-08-02 三审):删房时 `forgetCollabInspector` 已经清过表项,
    // 但被中止回合的**异步收尾**(silent note、泵的 finally 广播)还会路过这里 ——
    // 无条件重建的话,表项(log + 可能armed的节流 timer)从此常驻,反复建删房的
    // 长进程里单调增长。会话已经不是房间就不再立新表项;已有表项照常用,
    // 它们由 forget 负责收。
    if (owner.options.getSession(roomSessionId)?.kind !== 'room') return null
    state = { log: [], typing: new Set(), seq: 0, throttle: createCollabSnapshotThrottle() }
    owner.rooms.set(roomSessionId, state)
  }
  return state
}

/** 房间没了,它的「刚才」也就没了(与 `deleteRoomRuntime` 同一时机)。 */
function forgetInspectorRoom(owner: InspectorOwner, roomSessionId: string): void {
  const state = owner.rooms.get(roomSessionId)
  if (state) clearCollabSnapshotThrottle(state.throttle)
  owner.rooms.delete(roomSessionId)
}

/** 进程收摊:清掉所有待发的定时器,别让一次广播活过协调器本身。 */
export function shutdownCollabInspector(): void {
  currentInspector?.quiesce()
}

/**
 * 无上限的闸读作 0 —— 契约里 `max: 0` 就是"这道闸关着"。
 *
 * `maxChainFor` / `maxConcurrentTurnsFor` 对"不限"返回的是 `Infinity`,而
 * `Infinity` 过不了 JSON(序列化成 `null`),到了渲染层就成了一个静默的谎。
 */
function finiteMax(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/**
 * 这间房此刻的样子。**纯读**:一个字段都不写,任何时候调都安全。
 *
 * 运行时不存在(这间房从没被驱动过)时仍然给一个完整快照 —— 空闲也是状态,
 * 而"读不到"和"空闲"在界面上必须是同一个样子,否则冷启动会闪一下空白。
 */
function buildCoordinatorState(owner: InspectorOwner, roomSessionId: string): CollabCoordinatorState | null {
  if (!isActive(owner)) return null
  const session = owner.options.getSession(roomSessionId)
  if (session?.kind !== 'room') return null
  const inspector = owner.rooms.get(roomSessionId)

  // 调度那几格来自房账(D6-a 接线);seq / typing / 「刚才」仍归这里(见上)。
  const v3 = owner.source?.(roomSessionId) ?? null
  if (v3) {
    return {
      ...v3,
      // 每次 build 都现取一个新号是错的:冷启动 GET 是**读**,它不该显得比刚发
      // 出去的那一帧更新。带上"上一次广播的号",于是一发新广播总能顶掉一条迟到
      // 的回包,而一条比屏幕更旧的回包会被渲染层丢掉。
      seq: inspector?.seq ?? 0,
      at: Date.now(),
      typing: [...(inspector?.typing ?? [])],
      log: [...(inspector?.log ?? [])],
    }
  }

  /**
   * 供数口还没装上,或者这间房还没有 v3 actor —— 给一份**空闲**快照。
   *
   * D6-b 之前这里是 v2 运行时的读法(`roomOccupancy` / `activeTurns` / `queue` /
   * `judgements` / `state.plan`),随调度链一起删了。留一份空闲而不是 null,是
   * 文件头那条老纪律:「读不到」和「空闲」在界面上必须是同一个样子,否则冷启动
   * 会闪一下空白。闸的**上限**照读(它们是房间配置,不是运行时状态),读数为 0
   * —— 这间房此刻确实一格都没占。
   */
  return {
    roomSessionId,
    seq: inspector?.seq ?? 0,
    at: Date.now(),
    mode: session.room?.responseMode === 'serial'
      ? 'serial'
      : isCollabPlanRoom(session.room) ? 'auto' : 'parallel',
    frozen: session.room?.frozen === true,
    speaking: [],
    typing: [...(inspector?.typing ?? [])],
    turns: [],
    queue: [],
    judging: 0,
    judgingAgentIds: [],
    gates: {
      chain: { value: 0, max: finiteMax(maxChainFor(session)) },
      concurrency: { value: 0, max: finiteMax(maxConcurrentTurnsFor(session)) },
      budget: {
        value: 0,
        max: session.room?.budgets?.dailyCostUSD ?? COLLAB_DEFAULT_DAILY_COST_USD,
      },
    },
    plan: null,
    log: [...(inspector?.log ?? [])],
    // D8 的三格在这条空闲路径上同样是**真值**:没有 actor 就没有裁决窗、没有相位、
    // 没有死信。给 0 与 idle 不是占位,是这间房此刻的实况。
    judgment: { state: 'idle' },
    deadLetterCount: 0,
  }
}

/**
 * 记一条调度事件,并推一次状态。
 *
 * 协调器各处的状态变化点调它 —— 一行,不用管节流也不用管房间存不存在。
 */
function noteSchedule(
  owner: InspectorOwner,
  roomSessionId: string,
  entry: Omit<CollabCoordinatorLogEntry, 'at'>,
): void {
  const state = inspectorState(owner, roomSessionId)
  if (!state) return
  state.log.push({ at: Date.now(), ...entry })
  // 定长:超了从头砍。`splice` 而不是 `slice` —— 快照读的是同一个数组引用的拷贝,
  // 换引用会让"刚才"在极窄的窗口里丢一条。
  if (state.log.length > COLLAB_LOG_LIMIT) {
    state.log.splice(0, state.log.length - COLLAB_LOG_LIMIT)
  }
  broadcastCoordinator(owner, roomSessionId)
}

/**
 * 打字灯的**唯一**记账点(架构收敛 C4 §2)。
 *
 * 四个生产点(观察器的起落、调度泵激活收尾的兜底、冻结清队、成员移除)照旧各管
 * 各的职责 —— 它们改的是**后端真值**;传播则统一走快照。于是"迟到的 false 抹掉
 * 了新一轮的 true"这条老病没有了容身之处:渲染层不再按 agentId 直删,它只认
 * 带序号的整份名单。
 *
 * 与灯同步推一次快照,走短窗口:这盏灯是会动的东西,按秒节流会把短句整个吞掉。
 */
function setTypingState(owner: InspectorOwner, roomSessionId: string, agentId: string, typing: boolean): void {
  const state = inspectorState(owner, roomSessionId)
  if (!state) return
  const changed = typing ? !state.typing.has(agentId) : state.typing.delete(agentId)
  if (typing) state.typing.add(agentId)
  // 没变就不推:一轮里 `say` 会连着确认好几次 true,每次都推等于把节流白费掉。
  if (!changed) return
  broadcastCoordinator(owner, roomSessionId, { activity: true })
}

/**
 * 推一次状态(节流)。
 *
 * 双档规则与它的三条论证全在 `snapshot-throttle.ts` —— agent 快照那条链用的是同
 * 一个件,而不是同一段被抄了第二遍的代码。这里只负责「谁在播、播的是什么」。
 */
function broadcastCoordinator(
  owner: InspectorOwner,
  roomSessionId: string,
  options: { activity?: boolean } = {},
): void {
  const state = inspectorState(owner, roomSessionId)
  if (!state) return
  scheduleCollabSnapshot(
    state.throttle,
    () => { emitCoordinatorState(owner, roomSessionId, state) },
    options,
  )
}

function emitCoordinatorState(owner: InspectorOwner, roomSessionId: string, state: InspectorRoomState): void {
  if (!isActive(owner) || owner.rooms.get(roomSessionId) !== state) return
  // 号在 build 之前 +1 —— `buildCollabCoordinatorState` 读的就是这个字段,
  // 于是发出去的那一份自带比上一发更大的号。
  state.seq += 1
  const snapshot = buildCoordinatorState(owner, roomSessionId)
  if (!snapshot) return
  state.throttle.lastSentAt = Date.now()
  const emission = owner.options.emit(roomSessionId, {
    type: SESSION_EVENT_TYPES.COLLAB_COORDINATOR_CHANGED,
    state: snapshot,
  } as Parameters<EventBus['emit']>[1])
  owner.emissions.add(emission)
  void emission.then(() => owner.emissions.delete(emission), error => {
    owner.emissions.delete(emission)
    owner.options.onError(error)
  })
}

export function buildCollabCoordinatorState(roomSessionId: string): CollabCoordinatorState | null {
  return currentInspector?.build(roomSessionId) ?? null
}

export function forgetCollabInspector(roomSessionId: string): void { currentInspector?.forget(roomSessionId) }

export function noteCollabSchedule(roomSessionId: string, entry: Omit<CollabCoordinatorLogEntry, 'at'>): void {
  currentInspector?.note(roomSessionId, entry)
}

export function setCollabTypingState(roomSessionId: string, agentId: string, typing: boolean): void {
  currentInspector?.typing(roomSessionId, agentId, typing)
}

export function broadcastCollabCoordinator(roomSessionId: string, options: { activity?: boolean } = {}): void {
  currentInspector?.broadcast(roomSessionId, options)
}
