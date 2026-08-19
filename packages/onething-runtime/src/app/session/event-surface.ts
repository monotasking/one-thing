/**
 * 每会话的**活 surface**(S1a,§10.6 第 2 条)。
 *
 * 翻译器要回答的问题只有两个,而且都必须**同步**作答(seq 是同步分配的):
 *
 *  - 这条消息在 surface 上的那一格是哪条事件?(`user/message-edited` /
 *    `message/deleted` 的 `surfaceOp.start` 从这里取)
 *  - 从那一格到末尾,被遮蔽的是哪些 seq?(`sourceEventSeqs` 必须列全,
 *    否则 `SurfaceIndex` 的校验会报 `source-seqs-incomplete`,而模型历史里
 *    旧的一问一答会原封不动地留着 —— S0 §9.7 判例 3 那条坑)
 *
 * 所以这里持有 core 的 `SurfaceIndex` 与一张 `messageId → eventSeq` 表,
 * **首次使用时从 `events.jsonl` 同步 fold 一遍**建起来,之后每追加一条 surface
 * 事件就增量 push。fold 与 push 结果相同是 S0 合同测试钉住的。
 *
 * 为什么不每次现读文件:那是一次同步全文件读(几十 MB 级),而 §7.2 M7 点名
 * 的正是这一条 —— 这个投影跑在主线程上。
 */

import {
  SurfaceIndex,
  isSessionSurfaceNodeType,
  type SessionLogEventDataFor,
  type SessionLogEventRecord,
  type SessionLogEventType,
  type SessionSurfaceOp,
} from '@onething/core/session'
import {
  appendSessionLogEvent,
  isSessionEventLogEnabled,
  readSessionLogEventsSync,
} from './event-log.js'

interface SessionSurfaceState {
  index: SurfaceIndex
  /** 消息 id → 它在 surface 上那一格的 eventSeq(assistant 用 `run/start` 的)。 */
  seqByMessageId: Map<string, number>
}

const states = new Map<string, SessionSurfaceState>()

/** 一条事件在 surface 上代表哪条消息(不代表任何消息的返回 undefined)。 */
function messageIdOf(event: SessionLogEventRecord): string | undefined {
  switch (event.type) {
    case 'user/message':
    case 'system/message':
    case 'message/imported':
      return event.data.message.id
    case 'user/message-edited':
      return event.data.message.id
    case 'run/start':
      return event.data.assistantMessageId
    case 'session/compacted':
      return event.data.messageId
    default:
      return undefined
  }
}

function ensureState(sessionId: string): SessionSurfaceState {
  const existing = states.get(sessionId)
  if (existing) return existing
  const state: SessionSurfaceState = { index: new SurfaceIndex(), seqByMessageId: new Map() }
  // 首次使用:把盘上已有的那份 fold 一遍。老会话(只有 E0 七类)fold 出来是
  // 一张空 surface —— 那是**对的**:它的消息事实还在 messages.jsonl 里,
  // S2 的迁移脚本才会把它们变成 `message/imported`。
  for (const event of readSessionLogEventsSync(sessionId)) {
    applyToState(state, event)
  }
  states.set(sessionId, state)
  return state
}

function applyToState(state: SessionSurfaceState, event: SessionLogEventRecord): void {
  state.index.push(event)
  if (!isSessionSurfaceNodeType(event.type)) return
  const messageId = messageIdOf(event)
  if (messageId) state.seqByMessageId.set(messageId, event.seq)
}

export interface SessionSurfaceView {
  /** 这条消息在 surface 上那一格的 eventSeq。 */
  seqOf(messageId: string): number | undefined
  /** surface 上现在依次是哪些 eventSeq(呈现序,不是升序)。 */
  order(): number[]
  /**
   * "从这条消息(含)到 surface 末尾"的那一段 —— 编辑重发 / 截断的 replace
   * range 与 `sourceEventSeqs` 都从这里来。
   *
   * **按位置切,不按 seq 大小**:压缩之后那个节点排在最前面而 seq 最大,
   * 按大小筛会把它一起圈进来。
   */
  rangeFrom(messageId: string): { start: number; end: number; seqs: number[] } | undefined
  /** 整条 surface 的 replace range(清空 / 全量替换用)。 */
  wholeRange(): { start: number; end: number; seqs: number[] } | undefined
}

export function sessionSurface(sessionId: string): SessionSurfaceView {
  const state = ensureState(sessionId)
  const orderOf = (): number[] => state.index.snapshot().order
  return {
    seqOf: messageId => state.seqByMessageId.get(messageId),
    order: orderOf,
    rangeFrom(messageId) {
      const start = state.seqByMessageId.get(messageId)
      if (start === undefined) return undefined
      const order = orderOf()
      const at = order.indexOf(start)
      if (at === -1) return undefined
      const seqs = order.slice(at)
      return { start: seqs[0], end: seqs[seqs.length - 1], seqs }
    },
    wholeRange() {
      const order = orderOf()
      if (order.length === 0) return undefined
      return { start: order[0], end: order[order.length - 1], seqs: order }
    },
  }
}

/**
 * 追加一条事件**并**把它推进本会话的 surface 索引。
 *
 * 翻译器只走这一扇门:直接调 `appendSessionLogEvent` 的话索引就漏了那一条,
 * 下一次 `rangeFrom` 会少遮蔽一格(而那种错是静默的)。
 */
export function appendSurfaceAwareEvent<TType extends SessionLogEventType>(
  sessionId: string,
  type: TType,
  data: SessionLogEventDataFor<TType>,
  options: { surfaceOp?: SessionSurfaceOp; sourceEventSeqs?: number[] } = {},
): number | undefined {
  const seq = appendSessionLogEvent(sessionId, type, data, options)
  if (seq === undefined) return undefined
  applyToState(ensureState(sessionId), {
    seq,
    time: Date.now(),
    type,
    data,
    ...(options.surfaceOp !== undefined ? { surfaceOp: options.surfaceOp } : {}),
    ...(options.sourceEventSeqs !== undefined ? { sourceEventSeqs: options.sourceEventSeqs } : {}),
  } as SessionLogEventRecord)
  return seq
}

/** 这个会话在记账吗 —— 翻译器的短路闸(legacy 会话一条都不写)。 */
export function isSessionTranslationEnabled(sessionId: string): boolean {
  return isSessionEventLogEnabled(sessionId)
}

/** 清空进程内 surface 缓存。会话删除与测试用。 */
export function resetSessionSurfaceCache(sessionId?: string): void {
  if (sessionId) {
    states.delete(sessionId)
    return
  }
  states.clear()
}
