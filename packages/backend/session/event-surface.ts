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
  surfaceMessageIdOf,
  type SessionLogEventDataFor,
  type SessionLogEventRecord,
  type SessionLogEventType,
  type SessionSurfaceOp,
} from '@onething/core/session'
import type { SessionLogEventAppendObserver } from './event-log.js'
import { getCurrentBackend } from '../current.js'

export interface SessionSurfacePorts {
  readEvents(sessionId: string): SessionLogEventRecord[]
  isEnabled(sessionId: string): boolean
  observe(observer: SessionLogEventAppendObserver): () => void
}

interface SessionSurfaceState {
  index: SurfaceIndex
  /** 消息 id → 它在 surface 上那一格的 eventSeq(assistant 用 `run/start` 的)。 */
  seqByMessageId: Map<string, number>
  /**
   * F1-a(§16.15):`tool/result` 这一格**归属**哪条消息的那一格。
   *
   * `tool/result` 在 surface 上占一格,却不物化成一条历史消息 —— 它折进所属 run
   * 的那条 assistant 消息里。所以"这一格该不该跟着某次截断一起被遮"取决于
   * **它归属的那条 assistant 消息在不在同一段里**,而不取决于它自己排在哪。
   * 值是那条 run 的 `run/start` 的 seq(assistant 消息在 surface 上的那一格)。
   */
  ownerSeqBySurfaceSeq: Map<number, number>
  /** run id → 那条 run 的 `run/start` seq。 */
  runStartSeqByRunId: Map<string, number>
  /** 工具调用 id → 它所属 run 的 `run/start` seq(`tool/result` 缺 runId 时的解法)。 */
  runStartSeqByCallId: Map<string, number>
  /** 最近一条 `run/start` 的 seq(事件缺 runId 时的最后一手)。 */
  lastRunStartSeq?: number
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
   *
   * F1-a(§16.15):**尾随的"别人家的 `tool/result`"不进这一段**。见
   * `trimForeignTrailingToolResults`。
   */
  rangeFrom(messageId: string): { start: number; end: number; seqs: number[] } | undefined
  /** 整条 surface 的 replace range(清空 / 全量替换用)。 */
  wholeRange(): { start: number; end: number; seqs: number[] } | undefined
}


export function createSessionSurface(ports: SessionSurfacePorts) {
const states = new Map<string, SessionSurfaceState>()

/**
 * F1(§16.6):活 surface 的推进**只此一条路** —— 那扇门的同步可见观察者
 * (§17.7 #6:门内实现细节,不是外挂的第三件东西)。
 *
 * 从前推进挂在 `appendSurfaceAwareEvent` 自己身上,于是走另一扇门
 * (`appendSessionLogEvent`)落下的事件写侧永远看不见。`tool/result` 恰好既是
 * surface 节点、又只从采集点走那扇门(`session-event-recorder.ts`),所以同进程
 * 内落的 `tool/result` 从来进不了 `order`/`sourceEventSeqs` —— core 的
 * `declaredMessageGap` 注释里那条真机病历(`ec2437ff`:遮 257 格声明 173 个,
 * 差的 84 格全是 `tool/result`)说的就是它。挂到写入口上之后,写侧的活 surface
 * 与读侧 `foldSurface(整份文件)` 看到的是同一串事件。
 *
 * 注册同样发生在运行期(第一次建表时),不在 import 期。
 */
const unsubscribe = ports.observe((sessionId, record) => {
  const state = states.get(sessionId)
  if (state) applyToState(state, record)
})

/**
 * 立起这条会话的活 surface(**只立表,不推进**)。
 *
 * §17.7 #6:唯一的调用者是**那扇门**(`event-writer.ts`)——"写一条事件"这件事
 * 的第二步。首次会从 `events.jsonl` 同步 fold 一遍;之后是一次 Map 查询。
 */
function ensureSessionSurfaceState(sessionId: string): void {
  ensureState(sessionId)
}

function ensureState(sessionId: string): SessionSurfaceState {
  const existing = states.get(sessionId)
  if (existing) return existing
  const state: SessionSurfaceState = {
    index: new SurfaceIndex(),
    seqByMessageId: new Map(),
    ownerSeqBySurfaceSeq: new Map(),
    runStartSeqByRunId: new Map(),
    runStartSeqByCallId: new Map(),
  }
  // 首次使用:把盘上已有的那份 fold 一遍。老会话(只有 E0 七类)fold 出来是
  // 一张空 surface —— 那是**对的**:它的消息事实还在 messages.jsonl 里,
  // S2 的迁移脚本才会把它们变成 `message/imported`。
  for (const event of ports.readEvents(sessionId)) {
    applyToState(state, event)
  }
  states.set(sessionId, state)
  return state
}

function applyToState(state: SessionSurfaceState, event: SessionLogEventRecord): void {
  state.index.push(event)
  trackToolOwnership(state, event)
  if (!isSessionSurfaceNodeType(event.type)) return
  // 批 P-b:节点判定与"这条事件代表哪条消息"的判定都只此一份(core 的
  // `isSessionSurfaceNodeType` / `surfaceMessageIdOf`)—— 写侧曾自带一份同名
  // 函数,两份各自演化就是"切点切在读侧不认得的格上"那类静默错乱的温床。
  const messageId = surfaceMessageIdOf(event)
  if (messageId) state.seqByMessageId.set(messageId, event.seq)
}

/**
 * F1-a(§16.15):记住每一格 `tool/result` **归属**哪条 assistant 消息。
 *
 * 归属只认 run:`run/start` 建号,`tool/call` 把 callId 挂到当前 run 上,
 * `tool/result` 优先按自己的 runId 解、其次按 callId 解、最后退回最近一条
 * `run/start`(老账本这三格都可能缺 —— 解不出就是"没有归属",按不设限处理,
 * 与修复前逐字相同)。
 */
function trackToolOwnership(state: SessionSurfaceState, event: SessionLogEventRecord): void {
  switch (event.type) {
    case 'run/start': {
      state.runStartSeqByRunId.set(event.data.runId, event.seq)
      state.lastRunStartSeq = event.seq
      return
    }
    case 'tool/call': {
      const owner = resolveRunStartSeq(state, event.data.runId)
      if (owner !== undefined) state.runStartSeqByCallId.set(event.data.callId, owner)
      return
    }
    case 'tool/result': {
      const owner = resolveRunStartSeq(state, event.data.runId)
        ?? state.runStartSeqByCallId.get(event.data.callId)
      if (owner !== undefined) state.ownerSeqBySurfaceSeq.set(event.seq, owner)
      return
    }
    default:
      return
  }
}

function resolveRunStartSeq(state: SessionSurfaceState, runId: string | undefined): number | undefined {
  if (runId !== undefined) {
    const known = state.runStartSeqByRunId.get(runId)
    if (known !== undefined) return known
  }
  return state.lastRunStartSeq
}


/**
 * F1-a(§16.15):把"从 `at` 到末尾"这一段**尾部**那些归属在段外的 `tool/result`
 * 摘掉,返回真正该被这次 replace 遮蔽的那串 seq。
 *
 * 病历(真机 `ef079fd7`,两条):**工具在途时用户插了一句话**。那一刻 surface 上
 * 依次落下 `user/message@5127`(用户那句)、`tool/result@5130`(在途那次调用的结局,
 * 它归属的 `run/start@5106` 排在更前面)。随后的 edit-resend 从 5127 切到末尾,
 * 于是这条 replace 连带遮住了 5130 —— 而 5130 归属的那条 assistant 消息**还在
 * surface 上**。引擎那边这次截断只删了用户那句往后的消息,那条 assistant 消息连同
 * 它的工具调用一个字节没动;投影这边却因为结局格被遮而把整次调用摘掉,于是
 * 少一对 assistant+tool、正文并格 —— 每次请求复发一条影子失配。
 *
 * 判据是**归属**,不是位置:一格 `tool/result` 只有在"它归属的那条消息也在这一段里"
 * 时才跟着遮。归属解不出来(老账本缺 runId / callId 线索)= 不设限,与修复前逐字相同。
 *
 * 只修**尾随**格:replace 的 op 是位置上连续的一段(`SurfaceIndex.applyReplace`
 * 按 `order.slice(from, to+1)` 遮),中间挖洞表达不出来。而这一类格只会出现在尾部 ——
 * 它们是"这条消息落账之后、这次截断之前"那段时间里在途 run 落下的结局。
 */
function trimForeignTrailingToolResults(
  state: SessionSurfaceState,
  order: readonly number[],
  at: number,
): number[] {
  const seqs = order.slice(at)
  const inRange = new Set(seqs)
  let end = seqs.length
  while (end > 1) {
    const owner = state.ownerSeqBySurfaceSeq.get(seqs[end - 1])
    // 不是 `tool/result`(没有归属登记)/ 归属就在这一段里 → 到此为止。
    if (owner === undefined || inRange.has(owner)) break
    // 归属那一格已经不在 surface 上(早被遮过)→ 它不会再被谁读到,一起遮掉即可。
    if (order.indexOf(owner) === -1) break
    inRange.delete(seqs[end - 1])
    end -= 1
  }
  return end === seqs.length ? seqs : seqs.slice(0, end)
}

function sessionSurface(sessionId: string): SessionSurfaceView {
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
      const seqs = trimForeignTrailingToolResults(state, order, at)
      return { start: seqs[0], end: seqs[seqs.length - 1], seqs }
    },
    wholeRange() {
      const order = orderOf()
      if (order.length === 0) return undefined
      return { start: order[0], end: order[order.length - 1], seqs: order }
    },
  }
}

/*
 * `appendSurfaceAwareEvent` —— **已删除**(§17.7 #6:两门一眼收敛为单门)。
 *
 * 它做的两件"额外"的事(`prepareSessionEventsOnce` + 立活 surface)不是某一类
 * 事件的特权,是**每一条事件**都该走的步骤 —— 它们成了那扇门的第 1、2 步
 * (`event-writer.ts` 的 `appendSessionEvent`)。于是"走哪扇门"这道选择题没有了,
 * 而选错门的后果从来是静默的(`ec2437ff`:`tool/result` 走素门,本进程内落的
 * 那些格进不了活索引,压缩写下的 `sourceEventSeqs` 少 84 格)。
 */

/** 这个会话在记账吗 —— 翻译器的短路闸(legacy 会话一条都不写)。 */
function isSessionTranslationEnabled(sessionId: string): boolean {
  return ports.isEnabled(sessionId)
}

/** 清空进程内 surface 缓存。会话删除与测试用。 */
function resetSessionSurfaceCache(sessionId?: string): void {
  if (sessionId) {
    states.delete(sessionId)
    return
  }
  states.clear()
}

  return {
    ensure: ensureSessionSurfaceState,
    view: sessionSurface,
    isEnabled: isSessionTranslationEnabled,
    reset: resetSessionSurfaceCache,
    dispose() { unsubscribe(); states.clear() },
  }
}

export type SessionSurface = ReturnType<typeof createSessionSurface>
const currentSurface = (): SessionSurface => getCurrentBackend('sessionLayer').sessionLayer.events.surface
export const ensureSessionSurfaceState = (sessionId: string): void => currentSurface().ensure(sessionId)
export const sessionSurface = (sessionId: string): SessionSurfaceView => currentSurface().view(sessionId)
export const isSessionTranslationEnabled = (sessionId: string): boolean => currentSurface().isEnabled(sessionId)
export const resetSessionSurfaceCache = (sessionId?: string): void => currentSurface().reset(sessionId)
