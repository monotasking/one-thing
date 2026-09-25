/**
 * 每会话的**活投影**(S1b 起,S2a 提出来共用)。
 *
 * 从前它住在 `shadow.ts` 里,是影子断言的私有物。S2a 的读路径也要它:
 * `sessionReads` 在 `events` 模式下把整会话的消息读成投影,而**两份缓存不行**
 * —— 写入口那条尾巴(`drainSessionLogEventTail`)是**取走式**的,两个消费者会
 * 互相偷走对方的记录,各自的投影都缺一段。所以缓存只有一份,影子与读路径共用。
 *
 * 纪律照旧:
 *  - 首次用的时候从文件同步折一遍,之后只折尾巴里的新事件(每次 O(新事件));
 *  - 尾巴溢出过就整份重折(宁可付一次全量,也不拿缺了一段的投影去用);
 *  - `reduceSessionProjection` 是**移动语义**的(S0 §9.7 判例 9):state 交出去
 *    之后不可再用,所以这里始终持有它返回的那一份。
 *
 * ## F1(§16.6):推进从"读的时候"提前到"写的时候"
 *
 * 从前这份投影只在 `getLiveSessionProjection` 被调用时才把尾巴折进来 —— 也就是
 * **惰性**推进。结果上没错(读之前一定先折),但"命令内读得到自己刚写的"是靠
 * 每个读口都记得先 drain 才成立的**约定**,而不是机制。
 *
 * F1 把它翻成机制:写入口(`writeSessionEvent`)在同一个同步段里调
 * `registerSessionLogEventAppendObserver` 注册的观察者,这里就是其中之一。
 * 一条事件分配到 seq 的那一刻就已经折进这份投影,落盘仍然排队异步。
 *
 * 两条边界:
 *  - **不主动建表**:观察者见到还没有活投影的会话原地返回。建表要读整份文件,
 *    挂在写路径上就等于每条 append 付一次同步全文件 IO;而且 `trace.ts` /
 *    `events-reads.ts` 明确不许"读一眼就把活投影建起来"。那一段仍由取走式尾巴
 *    兜着,首次建表时一并折进来(下面那段 drain 照旧,`seq <= lastSeq` 天然幂等)。
 *  - **折坏了就丢缓存**:reduce 抛出说明这份投影已经不可信,原地删掉它 ——
 *    下一次读从文件整份重折。事件本身照样落盘(写入口不会因为观察者抛出而停手)。
 */

import {
  createSessionAccountState,
  createSessionProjectionState,
  foldSessionLogicalDeltaAhead,
  materializeNode,
  reduceSessionAccount,
  reduceSessionProjection,
  type CoreTimelineMessage,
  type SessionAccountState,
  type SessionLogEventRecord,
  type SessionLogicalDelta,
  type SessionProjectionState,
} from '@onething/core/session'
import type { SessionLogEventAppendObserver } from './event-log.js'
import type { sessionProjectionOptions } from './projection-blobs.js'
import { getCurrentBackend } from '../current.js'

export interface SessionProjectionPorts {
  /** Pure, synchronous guard. A cache release never waits between this check and deletion. */
  evictionProtection?(sessionId: string): SessionProjectionProtection | undefined
  onEvict?(sessionId: string): void
  /**
   * 这条会话的事件。`fromByte` 在场 = 只要账本从那个**行首**往后的那一段
   * (工单 4 B 的检查点冷载路);缺席 = 整份(没有检查点的老路)。
   */
  readEvents(sessionId: string, fromByte?: number): SessionLogEventRecord[]
  drainTail: typeof import('./event-log.js').drainSessionLogEventTail
  prepareOnce(sessionId: string): void
  materializeOptions: typeof sessionProjectionOptions
  observe(observer: SessionLogEventAppendObserver): () => void
  /**
   * **投影检查点**(工单 4 B):上一次折到哪、从账本第几个字节接着折。
   *
   * 缺席(端口没接 / 这条会话没有检查点 / 检查点与账本对不上)= 从头折,与
   * 本单之前逐字相同。判据全在 `checkpoint-file.ts` 那四道门里,这一层只认
   * "给没给我一份"。
   */
  restore?(sessionId: string): {
    state: SessionProjectionState
    account: SessionAccountState
    lastSeq: number
    fromByte: number
  } | undefined
}

interface LiveProjection {
  lastAccessedAt: number
  estimatedBytes: number
  estimatedSeq: number
  state: SessionProjectionState
  /**
   * 这条会话的**会话账**(§17.7.1 批 2 / #8b-i)—— 与消息投影同源同刷新点:
   * 同一个 F1 观察者、同一次重建。它是**独立的值语义结构**,不挂进
   * `SessionProjectionState`(理由见 `core/session/account.ts` 文件头)。
   */
  account: SessionAccountState
  /** 已经折进 state 的最后一条 seq。 */
  lastSeq: number
  /**
   * **已经折进 state、但它那一行还压在编码器写缓冲里**的逻辑 delta 条数
   * (F4-c c3-a)。>0 = 这份活投影领先磁盘,`refold` 那道耐久门此刻不可比
   * (它比的是"文件字节重折 ≡ 内存活投影",而领先的那几条字节还没有)。
   */
  aheadDeltas: number
}

export type SessionProjectionProtection = 'active-run' | 'pending-deltas' | 'pending-write' | 'selected'

export interface SessionProjectionCachePolicy {
  maxIdleEntries: number
  maxIdleBytes: number
  idleTtlMs: number
  maintenanceIntervalMs: number
}

const DEFAULT_CACHE_POLICY: SessionProjectionCachePolicy = {
  maxIdleEntries: 8,
  maxIdleBytes: 64 * 1024 * 1024,
  idleTtlMs: 10 * 60_000,
  maintenanceIntervalMs: 60_000,
}

/** Approximate retained projection data, not V8 heap/RSS or materialized messages. */
function estimateProjectionBytes(live: LiveProjection): number {
  let bytes = 0
  const seen = new Set<object>()
  const pending: unknown[] = [live.state, live.account]
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === 'string') { bytes += value.length * 2; continue }
    if (!value || typeof value !== 'object') { bytes += 8; continue }
    if (seen.has(value)) continue
    seen.add(value)
    bytes += 32
    if (value instanceof Map) {
      bytes += value.size * 24
      for (const [key, item] of value) pending.push(key, item)
    } else if (value instanceof Set) {
      bytes += value.size * 16
      for (const item of value) pending.push(item)
    } else if (Array.isArray(value)) {
      bytes += value.length * 8
      for (const item of value) pending.push(item)
    } else {
      for (const [key, item] of Object.entries(value)) {
        bytes += key.length * 2 + 8
        pending.push(item)
      }
    }
  }
  return bytes
}

/**
 * **这里没有失效号**(§17.7.1 批 1)。
 *
 * c4-d 时这份对象上挂着一个进程级失效号,物化视图按它决定"上次算的还作不作数"
 * —— 一本外挂账:缓存的"谁作废"与领域对象分离,于是一条 delta 让整份列表报废。
 * 现在这件事住在节点自己身上(`BaseNode.rev`,由归约器的 `forWrite` 前进),
 * 这一层只管把事件折进去。
 */
export function createSessionProjectionCache(
  ports: SessionProjectionPorts,
  options: Partial<SessionProjectionCachePolicy> & { now?: () => number } = {},
) {
const projections = new Map<string, LiveProjection>()
const policy = { ...DEFAULT_CACHE_POLICY, ...options }
const now = options.now ?? Date.now

function protection(sessionId: string, live: LiveProjection): SessionProjectionProtection | undefined {
  if (live.state.activeRun) return 'active-run'
  if (live.aheadDeltas > 0) return 'pending-deltas'
  return ports.evictionProtection?.(sessionId)
}

/** Reads cached counters only; polling this must not warm caches or scan message payloads. */
function getMemoryStats() {
  const entries = [...projections].map(([sessionId, live]) => ({
    sessionId,
    nodeCount: live.state.nodes.length,
    lastAccessedAt: live.lastAccessedAt,
    estimatedBytes: live.estimatedBytes,
    estimateStale: live.estimatedSeq !== live.lastSeq || live.aheadDeltas > 0,
    protectedReason: protection(sessionId, live),
  }))
  const protectedCount = entries.filter(entry => entry.protectedReason !== undefined).length
  return {
    size: entries.length,
    idleCount: entries.length - protectedCount,
    protectedCount,
    estimatedBytes: entries.reduce((sum, entry) => sum + entry.estimatedBytes, 0),
    limits: { maxIdleEntries: policy.maxIdleEntries, maxIdleBytes: policy.maxIdleBytes, idleTtlMs: policy.idleTtlMs },
    entries,
  }
}

/** Reconstructible caches only. Never clears the ledger tail or ends an execution. */
function releaseIdle(options: { all?: boolean; protectedSessionIds?: readonly string[] } = {}) {
  const selected = new Set(options.protectedSessionIds)
  const idle = [...projections].filter(([id, live]) => !selected.has(id) && !protection(id, live))
  for (const [, live] of idle) {
    if (live.estimatedSeq !== live.lastSeq) {
      live.estimatedBytes = estimateProjectionBytes(live)
      live.estimatedSeq = live.lastSeq
    }
  }
  idle.sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt)
  let idleCount = idle.length
  let idleBytes = idle.reduce((sum, [, live]) => sum + live.estimatedBytes, 0)
  let releasedEstimatedBytes = 0
  const releasedSessionIds: string[] = []
  const time = now()
  for (const [id, live] of idle) {
    if (!options.all && idleCount <= policy.maxIdleEntries && idleBytes <= policy.maxIdleBytes
      && time - live.lastAccessedAt < policy.idleTtlMs) continue
    // Recheck after injected ports: even synchronous callbacks may append reentrantly.
    if (projections.get(id) !== live || protection(id, live)) continue
    ports.onEvict?.(id)
    if (projections.get(id) !== live || protection(id, live)) continue
    projections.delete(id)
    idleCount--
    idleBytes -= live.estimatedBytes
    releasedEstimatedBytes += live.estimatedBytes
    releasedSessionIds.push(id)
  }
  return { releasedSessionIds, releasedEstimatedBytes, remainingCount: projections.size }
}

const maintenance = policy.maintenanceIntervalMs > 0
  ? setInterval(() => releaseIdle(), policy.maintenanceIntervalMs)
  : undefined
maintenance?.unref?.()
/**
 * 观察者的注册发生在**运行期**(第一次要建活投影的那一刻),不在 import 期 ——
 * 装配层的 import 纯净栅栏管着这条(`__tests__/import-side-effect-free.test.ts`)。
 */


/**
 * 会话账折叠的上下文:**只有截断类事件**会真的调它(一个会话一生几次),
 * 所以它是惰性的 —— 普通事件一次都不物化。
 *
 * 交出去的是"这条事件折进投影**之后**"的可见消息:`reduceSessionAccount` 在
 * `reduceSessionProjection` 之后跑,`live.state` 此刻已经是事后那一份。
 */
function accountFoldContext(sessionId: string, live: LiveProjection) {
  return {
    sessionId,
    messagesAfter(): CoreTimelineMessage[] {
      const materialize = ports.materializeOptions(sessionId)
      return live.state.nodes
        .filter(node => !node.hidden)
        .map(node => materializeNode(node, materialize) as unknown as CoreTimelineMessage)
    },
  }
}

/** 把一条事件同时折进消息投影与会话账(两者永远同一个刷新点)。 */
function foldRecord(sessionId: string, live: LiveProjection, record: SessionLogEventRecord): void {
  live.state = reduceSessionProjection(live.state, record)
  live.account = reduceSessionAccount(live.account, record, accountFoldContext(sessionId, live))
}

const unsubscribe = ports.observe((sessionId, record, options) => {
    const live = projections.get(sessionId)
    if (!live) return
    if (record.seq <= live.lastSeq) return
    live.lastAccessedAt = now()
    try {
      // F4-c c3-a:这一行的每一条 delta 在**盖章那一刻**就已经折进去了
      // (`foldLiveSessionLogicalDelta`)。再折一遍 = 同一段正文进两次。
      // 游标照旧前进 —— 这一行确实已经在这份投影上了。
      // 判据不只看那句声明,还要看**这份投影自己记的领先条数** —— 中间若因为
      // 尾巴溢出 / 折坏而重建过(`projections.delete` + 从文件整份重折),那几条
      // 提前折进去的正文已经随旧 state 一起没了,`aheadDeltas` 会归零,这一行
      // 就必须照常折。少一句自证 = 一段正文静默消失。
      const preFolded = options?.preFoldedDeltaCount ?? 0
      if (options?.projectionPreFolded && preFolded > 0 && live.aheadDeltas >= preFolded) {
        live.lastSeq = record.seq
        live.aheadDeltas -= preFolded
        return
      }
      foldRecord(sessionId, live, record)
      live.lastSeq = record.seq
    } catch (error) {
      // 折不进去 = 这份活投影已经不可信(移动语义下 state 可能只改了一半)。
      // 丢掉它,下一次读从文件整份重折;写入口那边会把这次失败记成一行 error。
      projections.delete(sessionId)
      throw error
    }
  })

/** 这条会话的活投影,**推进到此刻**。 */
function getLiveSessionProjection(sessionId: string): SessionProjectionState {
  let live = projections.get(sessionId)
  // 一份**什么都没折进来**的投影不算数(工单 4 A4 追出来的)。
  //
  // 这份缓存建起来之后靠追加观察者保持最新,而观察者只认走写入口的那些事件。
  // legacy 整文件会话的**首触迁移**(`storage-driver.migrateLegacySessionNow`)
  // 是直接写盘换入的 —— 会话目录与整份 `events.jsonl` 凭空出现,观察者一无所知。
  // 于是「读一眼(建起一份空投影)→ 别处一句 `getSession` 触发迁移 → 再读」会
  // 一直读到那份空的,整段历史当场消失。空投影重折的代价是一次 open(文件不在
  // 就是一次失败的 open);非空的照旧命中缓存。
  if (live && live.lastSeq === 0) {
    projections.delete(sessionId)
    live = undefined
  }
  if (!live) {
    // 打开会话的那一刻(投影第一次建起来 = 事件层意义上的"打开"):把上一次
    // 进程死亡留下的未闭合 run 收掉。它自己每会话只真的跑一次,合成出来的事件
    // 走写入口那条尾巴,下面的 drain 会把它们折进来。
    ports.prepareOnce(sessionId)
    // **检查点**(工单 4 B):有一份对得上的备忘就从它接着折,没有就从头折。
    // `prepareOnce` 排在它前面不是可有可无 —— 那一步可能往账本追加"收尾未闭合
    // run"的合成事件,而检查点的字节数判据问的正是账本此刻多大;先补完再问,
    // 补出来的那几条才会被算成"检查点之后的那一段"。
    const restored = ports.restore?.(sessionId)
    live = restored
      ? { state: restored.state, account: restored.account, lastSeq: restored.lastSeq, aheadDeltas: 0,
        lastAccessedAt: now(), estimatedBytes: 0, estimatedSeq: -1 }
      : {
        state: createSessionProjectionState(),
        account: createSessionAccountState(),
        lastSeq: 0,
        aheadDeltas: 0,
        lastAccessedAt: now(),
        estimatedBytes: 0,
        estimatedSeq: -1,
      }
    for (const event of ports.readEvents(sessionId, restored?.fromByte)) {
      // 检查点覆盖到的那一段本来就不该再出现在这里(`fromByte` 是行首,读的是
      // 它**之后**),这一句是第二道:重折一条已经折过的事件 = 同一段正文进两次。
      if (event.seq <= live.lastSeq) continue
      foldRecord(sessionId, live, event)
      live.lastSeq = Math.max(live.lastSeq, event.seq)
    }
    projections.set(sessionId, live)
    // 首次是从文件折的,写入口那条尾巴里的记录已经在文件里(或即将写进去),
    // 丢掉它以免同一条被折两次。
    const drained = ports.drainTail(sessionId)
    for (const event of drained.records) {
      if (event.seq <= live.lastSeq) continue
      foldRecord(sessionId, live, event)
      live.lastSeq = event.seq
    }
    live.estimatedBytes = estimateProjectionBytes(live)
    live.estimatedSeq = live.lastSeq
    return live.state
  }

  live.lastAccessedAt = now()

  const { records, overflowed } = ports.drainTail(sessionId)
  if (overflowed) {
    projections.delete(sessionId)
    return getLiveSessionProjection(sessionId)
  }
  for (const event of records) {
    if (event.seq <= live.lastSeq) continue
    foldRecord(sessionId, live, event)
    live.lastSeq = event.seq
  }
  return live.state
}

/**
 * **一条盖过章的逻辑 delta 当场进折叠**(F4-c c3-a,§16.23)。
 *
 * 采集点(`session-event-recorder.ts` 的编码器 `onDelta`)在把 delta 推进写缓冲的
 * 同一刻调它。返回 `true` = 折进去了,调用方落那一行时必须声明
 * `projectionPreFolded`;返回 `false` = 没折(这条会话还没有活投影 / 这次执行的
 * 节点还不在),调用方照旧让打包行自己折。
 *
 * 两条边界与 F1 那个观察者逐字相同:**不主动建表**(建表要同步读整份文件,挂在
 * 逐 token 的热路径上就是每条 delta 一次全文件 IO),**折坏了就丢缓存**。
 */
function foldLiveSessionLogicalDelta(
  sessionId: string,
  runId: string,
  delta: SessionLogicalDelta,
): boolean {
  const live = projections.get(sessionId)
  if (!live) return false
  live.lastAccessedAt = now()
  try {
    if (!foldSessionLogicalDeltaAhead(live.state, runId, delta)) return false
    live.aheadDeltas += 1
  } catch {
    // 折不进去 = 这份投影已经不可信(移动语义下 state 可能只改了一半)。
    projections.delete(sessionId)
    return false
  }
  return true
}

/**
 * 这份活投影**领先磁盘**几条 delta(F4-c c3-a)。
 *
 * `refold` 那道耐久门只在 0 的时候可比 —— 与它原本那条游标守卫同一个道理:
 * 采样撞上写,比出来的"多了一段"说明的是采样时机,不是账本坏了。
 */
function liveSessionProjectionAheadDeltas(sessionId: string): number {
  return projections.get(sessionId)?.aheadDeltas ?? 0
}

/**
 * 活投影**折到第几条 seq 了**(S3w-2,`refold.ts` 用)。
 *
 * refold 要把"文件字节重折"与"内存活投影"摆在一起比,而这两侧只有在**折到
 * 同一条 seq** 时才可比:中间只要有人又写了一条(或有一条还没落盘),比出来的
 * "多了一段 / 少了一段"说明的是采样撞上了写,不是账本坏了。所以它先问一句
 * 游标,对不齐就跳过这次采样 —— 宁可少比一次,不许报一次假红。
 *
 * 不推进(不 drain 尾巴):推进由 `getLiveSessionProjection` 负责,这里只读游标。
 */
function liveSessionProjectionCursor(sessionId: string): number | undefined {
  return projections.get(sessionId)?.lastSeq
}

/** 这条会话现在有活投影吗(读路径据此决定走内存还是走文件分页)。 */
function hasLiveSessionProjection(sessionId: string): boolean {
  return projections.has(sessionId)
}

/**
 * 这条会话的**会话账**(§17.7.1 批 2)——**不建表**。
 *
 * 没有活投影就交回 `undefined`:建表要同步读整份文件,而这一口的唯一消费者是
 * 影子对拍(挂在命令写路的尾巴上)。为一次对拍付一次全文件 IO 是本末倒置,
 * 与 `portTargetExists` / F1 观察者的边界同源。
 */
function peekSessionAccount(sessionId: string): SessionAccountState | undefined {
  return projections.get(sessionId)?.account
}

/** 会话删除 / 测试:丢掉活投影。 */
function resetSessionProjectionCache(sessionId?: string): void {
  if (sessionId) {
    projections.delete(sessionId)
    return
  }
  projections.clear()
}

/** 仅测试:直接看某条会话的活投影(不推进)。 */
function peekSessionProjection(sessionId: string): SessionProjectionState | undefined {
  return projections.get(sessionId)?.state
}

  return {
    getMemoryStats,
    releaseIdle,
    /** 这条会话的活投影此刻为什么不能丢(没有活投影 / 不受保护 = `undefined`)。 */
    protectionOf(sessionId: string): SessionProjectionProtection | undefined {
      const live = projections.get(sessionId)
      return live ? protection(sessionId, live) : undefined
    },
    getLiveSessionProjection,
    foldLiveSessionLogicalDelta,
    liveSessionProjectionAheadDeltas,
    liveSessionProjectionCursor,
    hasLiveSessionProjection,
    peekSessionAccount,
    resetSessionProjectionCache,
    peekSessionProjection,
    dispose() { if (maintenance) clearInterval(maintenance); unsubscribe(); projections.clear() },
  }
}

export type SessionProjectionCache = ReturnType<typeof createSessionProjectionCache>
const currentProjections = (): SessionProjectionCache => getCurrentBackend('sessionLayer').sessionLayer.events.projections
export const getLiveSessionProjection: SessionProjectionCache['getLiveSessionProjection'] = (...args) => currentProjections().getLiveSessionProjection(...args)
export const foldLiveSessionLogicalDelta: SessionProjectionCache['foldLiveSessionLogicalDelta'] = (...args) => currentProjections().foldLiveSessionLogicalDelta(...args)
export const liveSessionProjectionAheadDeltas: SessionProjectionCache['liveSessionProjectionAheadDeltas'] = (...args) => currentProjections().liveSessionProjectionAheadDeltas(...args)
export const liveSessionProjectionCursor: SessionProjectionCache['liveSessionProjectionCursor'] = (...args) => currentProjections().liveSessionProjectionCursor(...args)
export const hasLiveSessionProjection: SessionProjectionCache['hasLiveSessionProjection'] = (...args) => currentProjections().hasLiveSessionProjection(...args)
export const peekSessionAccount: SessionProjectionCache['peekSessionAccount'] = (...args) => currentProjections().peekSessionAccount(...args)
export const resetSessionProjectionCache: SessionProjectionCache['resetSessionProjectionCache'] = (...args) => currentProjections().resetSessionProjectionCache(...args)
export const peekSessionProjection: SessionProjectionCache['peekSessionProjection'] = (...args) => currentProjections().peekSessionProjection(...args)
