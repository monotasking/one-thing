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
 */

import {
  createSessionProjectionState,
  reduceSessionProjection,
  type SessionProjectionState,
} from '@onething/core/session'
import { drainSessionLogEventTail, readSessionLogEventsSync } from './event-log.js'
import { prepareSessionEventsOnce } from './prepare.js'

interface LiveProjection {
  state: SessionProjectionState
  /** 已经折进 state 的最后一条 seq。 */
  lastSeq: number
}

const projections = new Map<string, LiveProjection>()

/** 这条会话的活投影,**推进到此刻**。 */
export function getLiveSessionProjection(sessionId: string): SessionProjectionState {
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
