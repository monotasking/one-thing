/**
 * 每会话的**当前执行**登记处(S1a,§10.6 第 1 条)。
 *
 * `runId` 在引擎执行入口 `randomUUID()` 一次,然后:
 *  - 盖在 assistant 消息上(`ChatMessage.runId`,照旧随 messages.jsonl 落盘);
 *  - 写进 `run/start` / `run/end` 两条事件;
 *  - 由 recorder(请求/响应/delta/工具)、权限层、压缩各自**取用**而不是各自生成。
 *
 * 为什么是一张会话级的表而不是穿参:`Permission.ask` 与 `tool/audit` 那两条路
 * 离引擎入口隔着五六层与两个包(core → toolkit → 权限核),把 runId 一路穿下去
 * 要改十几个签名,而它们要问的其实就是一句"这条会话现在跑的是哪次执行"。
 * 表是**进程内**的:S1 的前提(one-core A 期)是一个 store 一个引擎。
 *
 * 收尾纪律:`endRun` 在**每一条**出口上调,包括 abort 与 error —— 一次没有
 * `run/end` 的 `run/start` 在投影里就是"永远在生成中"的那条消息。
 */

import { randomUUID } from 'node:crypto'
import type { SessionRunKind } from '@onething/core/session'
import { appendSurfaceAwareEvent } from './event-surface.js'
import { flushSessionEventLog } from './event-log.js'

export interface BeginSessionRunInput {
  kind: SessionRunKind
  assistantMessageId: string
  agentId?: string
  provider?: string
  model?: string
  /** 触发这次执行的那条消息(S1 里 eventSeq 通常解不出来,见事件类型注释)。 */
  triggerMessageId?: string
  triggerEventSeq?: number
}

export interface SessionRunHandle {
  runId: string
  sessionId: string
  assistantMessageId: string
  kind: SessionRunKind
  /** `run/start` 的 eventSeq(没记账时 undefined)。 */
  startSeq?: number
  /**
   * 这次执行**当前**在跑第几次请求(会话级的 requestIndex,由
   * `nextSessionRequestIndex` 分配)。recorder 写它,错误路径与压缩读它 ——
   * 一个回合里"现在是哪一次请求"只该有一个答案。
   */
  requestIndex?: number
  /**
   * part 序号的分配器。text / reasoning / tool-input / image 共用一条序列:
   * `partIndex` 是"这次执行的第几段输出",跨请求单调 —— 投影按它排 `contentParts`,
   * 每次请求各数各的会让第二轮的正文插到第一轮前面去。
   */
  partCounter: number
  /**
   * 收场的**预告**。abort / error 在引擎内部就被接住了(执行器把它翻成
   * `stream:aborted` / 一条错误消息,不再往上抛),于是 `executeMessageStream`
   * 的 finally 看到的是一次"正常返回" —— 照它写就会把一次中断记成 completed。
   * 谁接住的谁在这里留一句(`markSessionRunOutcome`),收尾时优先用它。
   */
  pendingOutcome?: EndSessionRunInput['outcome']
  pendingError?: unknown
}

/** 会话 → 当前执行。一个会话同一时刻只有一次执行(引擎的 activeStreams 保证)。 */
const currentRuns = new Map<string, SessionRunHandle>()

/**
 * 开一次执行:分配 runId,写 `run/start`(surface 上是助手消息那一格)。
 *
 * `run/start` 带 `surfaceOp: 'append'` —— 助手消息节点从这里开始,它在模型可见
 * 历史上占一格(§9.2 的 surface 分类表)。
 */
export function beginSessionRun(sessionId: string, input: BeginSessionRunInput): SessionRunHandle {
  // 上一次没收尾就走到这里 = 引擎在同一条会话上开了第二次执行。把旧的按
  // `interrupted` 结掉(它确实被打断了),而不是让两条 run/start 悬在那里。
  const stale = currentRuns.get(sessionId)
  if (stale) endSessionRun(sessionId, stale.runId, { outcome: 'interrupted' })

  const runId = randomUUID()
  const startSeq = appendSurfaceAwareEvent(
    sessionId,
    'run/start',
    {
      runId,
      kind: input.kind,
      assistantMessageId: input.assistantMessageId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
      ...(input.triggerEventSeq !== undefined ? { triggerEventSeq: input.triggerEventSeq } : {}),
    },
    { surfaceOp: 'append' },
  )

  const handle: SessionRunHandle = {
    runId,
    sessionId,
    assistantMessageId: input.assistantMessageId,
    kind: input.kind,
    partCounter: 0,
    ...(startSeq !== undefined ? { startSeq } : {}),
  }
  currentRuns.set(sessionId, handle)
  return handle
}

/**
 * "这条会话正在跑的执行"就是这一条,没有就开一条。
 *
 * 两个入口都要开 run,但它们**嵌套**:`executeMessageStream` 是四条引擎路径的
 * 交汇点,而 `executeAgentLoopStreamGeneration` 还额外接住"确认后恢复"那一条
 * (它绕过前者直接调)。一条 assistant 消息一个 run,所以判据是
 * `assistantMessageId` 相等 —— 相等就是同一次执行,内层不再开第二条,也不负责
 * 收尾(`started:false`)。
 */
export function ensureSessionRun(
  sessionId: string,
  input: BeginSessionRunInput,
): { run: SessionRunHandle; started: boolean } {
  const current = currentRuns.get(sessionId)
  if (current && current.assistantMessageId === input.assistantMessageId) {
    return { run: current, started: false }
  }
  return { run: beginSessionRun(sessionId, input), started: true }
}

export interface EndSessionRunInput {
  outcome: 'completed' | 'aborted' | 'error' | 'interrupted'
  error?: unknown
}

/**
 * 收一次执行。幂等:同一个 runId 收两次只写一条 `run/end`
 * (finally 与 catch 都会调它,而那两条路在 abort 时会同时走到)。
 */
export function endSessionRun(
  sessionId: string,
  runId: string | undefined,
  input: EndSessionRunInput,
): void {
  const handle = currentRuns.get(sessionId)
  if (!handle) return
  if (runId !== undefined && handle.runId !== runId) return
  currentRuns.delete(sessionId)

  const outcome = input.outcome === 'completed' && handle.pendingOutcome
    ? handle.pendingOutcome
    : input.outcome
  const error = normalizeRunError(input.error ?? handle.pendingError)
  appendSurfaceAwareEvent(sessionId, 'run/end', {
    runId: handle.runId,
    outcome,
    ...(error ? { error } : {}),
  })
  // 语义检查点:run 结束(§10.3 ③)。不 await —— 收尾路径上不该多一次等待,
  // 队列已经保序,fsync 只是把它推到盘上。
  void flushSessionEventLog(sessionId)
}

function normalizeRunError(error: unknown): { name?: string; message: string } | undefined {
  if (error === undefined || error === null) return undefined
  if (error instanceof Error) {
    return { ...(error.name ? { name: error.name } : {}), message: error.message }
  }
  return { message: String(error) }
}

/** 这条会话现在跑的是哪次执行(recorder / 权限 / 压缩取用)。 */
export function currentSessionRun(sessionId: string): SessionRunHandle | undefined {
  return currentRuns.get(sessionId)
}

export function currentSessionRunId(sessionId: string): string | undefined {
  return currentRuns.get(sessionId)?.runId
}

/** 记下这次执行现在跑到第几次请求(recorder 在 `turn-start` 调)。 */
export function setSessionRunRequestIndex(sessionId: string, requestIndex: number): void {
  const handle = currentRuns.get(sessionId)
  if (handle) handle.requestIndex = requestIndex
}

/**
 * 预告收场:abort / error 在引擎内部被接住的那一刻记一句,`endSessionRun` 优先
 * 用它。只认**比 completed 更坏**的结论 —— 一次 abort 之后不该被随后的
 * "正常返回"覆盖回去。
 */
export function markSessionRunOutcome(
  sessionId: string,
  outcome: EndSessionRunInput['outcome'],
  error?: unknown,
): void {
  const handle = currentRuns.get(sessionId)
  if (!handle || outcome === 'completed') return
  handle.pendingOutcome = outcome
  if (error !== undefined) handle.pendingError = error
}

/** 分配下一个 part 序号(0 起)。没有活跃执行时返回 undefined。 */
export function nextSessionRunPartIndex(sessionId: string): number | undefined {
  const handle = currentRuns.get(sessionId)
  if (!handle) return undefined
  const index = handle.partCounter
  handle.partCounter = index + 1
  return index
}

/**
 * 换助手消息锚点(steering 的 `response-boundary`:当前响应结束、新响应开始)。
 *
 * 这是**两次**执行:旧的按 completed 收尾,新的以 `kind:'steer'` 开张 ——
 * 一条 assistant 消息一个 run 是投影的前提(`run/start` 就是那条消息的节点)。
 */
export function rotateSessionRun(
  sessionId: string,
  input: BeginSessionRunInput,
): SessionRunHandle {
  const previous = currentRuns.get(sessionId)
  if (previous) endSessionRun(sessionId, previous.runId, { outcome: 'completed' })
  return beginSessionRun(sessionId, input)
}

/** 仅测试 / 会话删除。 */
export function resetSessionRuns(sessionId?: string): void {
  if (sessionId) {
    currentRuns.delete(sessionId)
    return
  }
  currentRuns.clear()
}
