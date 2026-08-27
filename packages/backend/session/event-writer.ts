/**
 * **事件写入口 —— 全仓唯一的一扇门**(§17.7 #6,2026-08-28)。
 *
 * ## 它替掉的是"两门一眼"
 *
 * 在这之前,"一条事件怎么进系统"是三件东西拼出来的:
 *
 *  - **带 surface 的门**(`appendSurfaceAwareEvent`):prepare + 立活 surface + 落账;
 *  - **素门**(`appendSessionLogEvent`):只落账;
 *  - **F1 的观察者眼**(`registerSessionLogEventAppendObserver`):补前两者的缝 ——
 *    活 surface / 活投影 / 会话账的推进挂在它上面,不管事件从哪扇门进来。
 *
 * 这是历史累积形态,不是设计。它的病历是 `ec2437ff`(§15.21):`tool/result`
 * 既是 surface 节点、又只从采集点走素门,于是**本进程内**落的那些格进不了活
 * surface —— 压缩写下的 `sourceEventSeqs` 少 84 格。F1 的眼把那条缝补上了
 * (观察者对两扇门一视同仁),可"走哪扇门"这道选择题还在:新事件类型的作者
 * 得自己知道该选哪个,而选错的后果是**静默的**。
 *
 * 现在只有一扇门。surface 记账、活投影/会话账推进、落盘排队,全是它的内部步骤:
 *
 * ```
 * writeSessionEvent
 *   ├─ prepareSessionEventsOnce   崩溃残留在写第一个字之前收掉(§13.10 M6)
 *   ├─ ensureSessionSurfaceState  活 surface 立起来(首次从文件 fold 一遍)
 *   └─ appendSessionLogEvent      分配 seq → 编码 → **同步通知观察者** → 排队落盘
 *        └─ 观察者(门内实现细节):活 surface / 活投影 + 会话账
 * ```
 *
 * **新事件类型不再有选择题**:走这扇门就自动拿到 surface / 折叠 / 落盘全套。
 * 是不是 surface 节点由**词表**决定(`isSessionSurfaceNodeType`),不由调用点
 * 决定 —— 非 surface 事件(`assistant/chunks` / `request/*` / `tool/call` …)
 * 在门内自然分流,不会被"为了合门"强造出一个 surface 格。
 *
 * ## 对外最小签名
 *
 * 门只有一个方法。`registerSessionEventObserver` 一并从这里出口 —— "谁跟着事件
 * 走"是门的契约的一部分,不该让消费者去底层模块里找。低层 `appendSessionLogEvent`
 * 仍在 `event-log.ts`(它管 seq / 编码 / 队列 / `SessionEventWriteError` 上抛),
 * 但**除了这扇门没有人该直接调它** —— `scripts/headless-boundary-check.ts` 的
 * `checkSessionEventSingleWriteDoor` 守着这条。
 */

import type {
  SessionLogEventDataFor,
  SessionLogEventType,
  SessionSurfaceOp,
} from '@onething/core/session'
import {
  appendSessionLogEvent,
  registerSessionLogEventAppendObserver,
  type SessionLogEventAppendObserver,
} from './event-log.js'
import { ensureSessionSurfaceState } from './event-surface.js'
import { prepareSessionEventsOnce } from './prepare.js'

export interface WriteSessionEventOptions {
  /** 这条事件在 surface 上怎么落格(`append` / `replace` 段)。非 surface 事件不给。 */
  surfaceOp?: SessionSurfaceOp
  /** 因果 / 遮蔽引用:被这条事件遮蔽或导出它的那些 eventSeq。 */
  sourceEventSeqs?: number[]
  /** 时钟同源(§17.7.1 批 2 裁定 1):调用方已取过刻,原样递给写入口。 */
  time?: number
  /** 这一行的内容已经折进活投影了(F4-c c3-a 的提前折);观察者只推游标。 */
  projectionPreFolded?: boolean
  /** 它提前折进去了几条。 */
  preFoldedDeltaCount?: number
}

/**
 * **写一条事件**。返回分配到的 seq(这条会话不记账时返回 `undefined`)。
 *
 * 返回之前,内存里的每一份活状态(surface / 投影 / 会话账)都已经含有这条事件
 * (F1 同步可见,§16.6);落盘仍然是排队异步的。账本写不进去的那一类失败
 * (`SessionEventWriteError`)**往上抛**(§14.6 裁定 7)。
 */
export function writeSessionEvent<TType extends SessionLogEventType>(
  sessionId: string,
  type: TType,
  data: SessionLogEventDataFor<TType>,
  options: WriteSessionEventOptions = {},
): number | undefined {
  // 1. 崩溃残留:这个进程往这份账本写第一个字之前收掉(§13.10 M6)。
  //    递归安全 —— `prepareSessionEventsOnce` 在真跑之前就把会话记进了 `prepared`,
  //    它自己合成的那几条事件走回这里时是一次 `Set.has`。
  prepareSessionEventsOnce(sessionId)
  // 2. 活 surface 立起来(**只立表,不推进**:推进归门内那只观察者)。首次会从
  //    文件 fold 一遍;之后是一次 Map 查询。素门从前不做这一步,于是"本进程内
  //    落的 surface 格进不了活索引"——`ec2437ff` 那条病历。
  ensureSessionSurfaceState(sessionId)
  // 3. 落账:分配 seq → 编码 → 同步通知观察者(活 surface / 活投影 / 会话账)
  //    → 排队落盘。
  return appendSessionLogEvent(sessionId, type, data, options)
}

/**
 * 注册一个**跟着事件走**的观察者(活 surface / 活投影 + 会话账都是它的用户)。
 *
 * 它是门的契约的一部分:门保证在 `writeSessionEvent` 返回**之前**、在同一个
 * 同步段里把这条事件交给每一位观察者。返回注销函数。
 */
export const registerSessionEventObserver: (
  observer: SessionLogEventAppendObserver,
) => () => void = registerSessionLogEventAppendObserver
