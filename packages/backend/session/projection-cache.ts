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
 * F1 把它翻成机制:写入口(`appendSessionLogEvent`)在同一个同步段里调
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
  createSessionProjectionState,
  reduceSessionProjection,
  type SessionProjectionState,
} from '@onething/core/session'
import {
  drainSessionLogEventTail,
  readSessionLogEventsSync,
  registerSessionLogEventAppendObserver,
} from './event-log.js'
import { prepareSessionEventsOnce } from './prepare.js'

interface LiveProjection {
  state: SessionProjectionState
  /** 已经折进 state 的最后一条 seq。 */
  lastSeq: number
}

const projections = new Map<string, LiveProjection>()

/**
 * 观察者的注册发生在**运行期**(第一次要建活投影的那一刻),不在 import 期 ——
 * 装配层的 import 纯净栅栏管着这条(`__tests__/import-side-effect-free.test.ts`)。
 */
let appendObserverRegistered = false

function ensureAppendObserver(): void {
  if (appendObserverRegistered) return
  appendObserverRegistered = true
  registerSessionLogEventAppendObserver((sessionId, record) => {
    const live = projections.get(sessionId)
    if (!live) return
    if (record.seq <= live.lastSeq) return
    try {
      live.state = reduceSessionProjection(live.state, record)
      live.lastSeq = record.seq
    } catch (error) {
      // 折不进去 = 这份活投影已经不可信(移动语义下 state 可能只改了一半)。
      // 丢掉它,下一次读从文件整份重折;写入口那边会把这次失败记成一行 error。
      projections.delete(sessionId)
      throw error
    }
  })
}

/** 这条会话的活投影,**推进到此刻**。 */
export function getLiveSessionProjection(sessionId: string): SessionProjectionState {
  ensureAppendObserver()
  let live = projections.get(sessionId)
  if (!live) {
    // 打开会话的那一刻(投影第一次建起来 = 事件层意义上的"打开"):把上一次
    // 进程死亡留下的未闭合 run 收掉。它自己每会话只真的跑一次,合成出来的事件
    // 走写入口那条尾巴,下面的 drain 会把它们折进来。
    prepareSessionEventsOnce(sessionId)
    live = { state: createSessionProjectionState(), lastSeq: 0 }
    for (const event of readSessionLogEventsSync(sessionId)) {
      live.state = reduceSessionProjection(live.state, event)
      live.lastSeq = Math.max(live.lastSeq, event.seq)
    }
    projections.set(sessionId, live)
    // 首次是从文件折的,写入口那条尾巴里的记录已经在文件里(或即将写进去),
    // 丢掉它以免同一条被折两次。
    const drained = drainSessionLogEventTail(sessionId)
    for (const event of drained.records) {
      if (event.seq <= live.lastSeq) continue
      live.state = reduceSessionProjection(live.state, event)
      live.lastSeq = event.seq
    }
    return live.state
  }

  const { records, overflowed } = drainSessionLogEventTail(sessionId)
  if (overflowed) {
    projections.delete(sessionId)
    return getLiveSessionProjection(sessionId)
  }
  for (const event of records) {
    if (event.seq <= live.lastSeq) continue
    live.state = reduceSessionProjection(live.state, event)
    live.lastSeq = event.seq
  }
  return live.state
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
export function liveSessionProjectionCursor(sessionId: string): number | undefined {
  return projections.get(sessionId)?.lastSeq
}

/** 这条会话现在有活投影吗(读路径据此决定走内存还是走文件分页)。 */
export function hasLiveSessionProjection(sessionId: string): boolean {
  return projections.has(sessionId)
}

/** 会话删除 / 测试:丢掉活投影。 */
export function resetSessionProjectionCache(sessionId?: string): void {
  if (sessionId) {
    projections.delete(sessionId)
    return
  }
  projections.clear()
}

/** 仅测试:直接看某条会话的活投影(不推进)。 */
export function peekSessionProjection(sessionId: string): SessionProjectionState | undefined {
  return projections.get(sessionId)?.state
}
