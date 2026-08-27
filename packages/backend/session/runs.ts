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
import { prepareSessionEventsOnce } from './prepare.js'
import { flushSessionEventLog } from './event-log.js'
import { scheduleSessionRefold } from './refold.js'
import { bumpSessionShadowStats, isSessionShadowEnabled } from './event-stats.js'

export interface BeginSessionRunInput {
  kind: SessionRunKind
  assistantMessageId: string
  /**
   * 这条助手消息归哪个 agent(A4,§13.1)。
   *
   * core 的三个入口(send / edit-resend / retry)一个都不传,于是 collab 工作
   * 会话里"这条是哪个 agent 说的"在账本上一直是空的,而**消息上有** ——
   * `stampCollabAgentId` 在 `addMessage` 那一刻按会话形态盖的章。
   *
   * 所以来源就是**那条占位消息本身**,不在这里重写一遍"哪种会话才盖章"的规则
   * (那会立刻变成第二个判定点,而普通聊天会话的 `session.agentId` 是恒有值的
   * —— 照它盖章会让投影凭空多出一格)。
   *
   * **F4-a(§16.12)把口径说准了:盖章仍是单实现,调用点指认那一处。** 从前这里
   * 写的是"谁**读到**那条占位消息,谁把这一格递进来" —— 那句话把"回读 store"
   * 写成了纪律的一部分,而回读只是当时值路由的走法(还带着一个可以不存在的
   * 时序窗口)。今天 `store.addMessage` 直接把**入库的那一条**交回创建点,
   * 创建点顺着执行入口递到这里 —— 盖章依旧只在 `appendMessage` 里发生一次,
   * 这里只收结果。`timestamp` / `origin` 同一条路,同一条消息上带着。
   */
  agentId?: string
  /**
   * 助手占位消息上的 `source`(§13.9)—— 与 `agentId` **同一格章**:
   * `stampCollabAgentId` 在 `addMessage` 那一刻按会话形态(room / agent)同时盖
   * `agentId` 与 `source: 'collab-turn'`。A4 只接了前一格,于是 agent 执行会话
   * 里每条助手消息在投影上都少一格 `source`(真机 `agent-exec-…`)。
   *
   * 与 `agentId` 逐字同一条路数(F4-a 之后也一样):调用点拿着 `addMessage` 交回
   * 的那条**入库**占位消息,把这一格递进来 —— 不在这里重写一遍"哪种会话才盖章"
   * 的规则。
   */
  messageSource?: string
  provider?: string
  model?: string
  /** 触发这次执行的那条消息(S1 里 eventSeq 通常解不出来,见事件类型注释)。 */
  triggerMessageId?: string
  triggerEventSeq?: number
  /**
   * 助手消息自己的时刻(`ChatMessage.timestamp`)。
   *
   * S1b 的影子断言按它比:投影把 `run/start` 那一格物化成助手消息,时刻若取
   * 事件写入时刻,就会与引擎建那条占位消息的时刻差几毫秒 —— 每一个 run 都不等,
   * 而那个"不等"不说明任何事。占位消息先建、run 后开,所以时刻要跟着消息走。
   */
  timestamp?: number
  /**
   * 触发这次执行的命令来源(助手占位消息上的 `origin`)。它不经翻译器,
   * 只能住在 `run/start` 里 —— 理由见事件类型上的注释。
   */
  origin?: Record<string, unknown>
  /**
   * 这次 run 接着哪一次 run 的**执行**往下跑。只有 `rotateSessionRun` 填 ——
   * 换的是助手消息,不是执行:agent-loop 的回合计数器与用量累加器都不重置。
   * 理由与后果见 `SessionRunStartEventData.continuesRunId`。
   */
  continuesRunId?: string
}

export interface SessionRunHandle {
  runId: string
  sessionId: string
  assistantMessageId: string
  kind: SessionRunKind
  /** 触发这次执行的那条用户消息 —— 影子断言按它切"这个 run 的消息"。 */
  triggerMessageId?: string
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
  /**
   * 这**同一次执行**在轮换之前用过的 runId(steering:`rotateSessionRun`)。
   *
   * 收尾的调用方(`executeMessageStream` / resume 入口)记着的是**进门时**那个
   * runId,而 steering 在执行中途把 run 换掉了。`endSessionRun` 的归属判据只认
   * `handle.runId === runId` 时,收尾那一下就会被当成"别人的 run"直接返回 ——
   * 于是 steer run 一直挂着,直到下一条用户消息进 `beginSessionRun` 被当成
   * 陈旧 run 按 `interrupted` 结掉(真机 `5e4d2cea` 的 d55cf1bd:13:53:50 正常
   * 收流,run/end 却是 13:56:03 的 interrupted,投影因此扣掉整条消息的 usage,
   * §13.7)。轮换是"同一次执行换了消息锚点",所以旧 id 仍然是这次执行的凭据。
   */
  continuedRunIds: Set<string>
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
  // 上一个**进程**没收尾的那些 run 先收掉(S2a `prepare`,每会话一次)。排在
  // 这里而不是别处:它必须发生在这条会话有任何一次活着的执行之前。
  prepareSessionEventsOnce(sessionId)
  // 上一次没收尾就走到这里 = 引擎在同一条会话上开了第二次执行。把旧的按
  // `interrupted` 结掉(它确实被打断了),而不是让两条 run/start 悬在那里。
  const stale = currentRuns.get(sessionId)
  // `void`:开一次执行是同步路径(返回 handle),不能为了旧 run 的 fsync 停下来。
  // 落账与清账都在 `endSessionRun` 的第一个 await 之前完成,所以顺序仍然是对的。
  if (stale) void endSessionRun(sessionId, stale.runId, { outcome: 'interrupted' })

  const runId = randomUUID()
  const agentId = input.agentId
  const startSeq = appendSurfaceAwareEvent(
    sessionId,
    'run/start',
    {
      runId,
      kind: input.kind,
      assistantMessageId: input.assistantMessageId,
      ...(agentId ? { agentId } : {}),
      ...(input.messageSource ? { messageSource: input.messageSource } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
      ...(input.triggerEventSeq !== undefined ? { triggerEventSeq: input.triggerEventSeq } : {}),
      ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.continuesRunId ? { continuesRunId: input.continuesRunId } : {}),
    },
    { surfaceOp: 'append' },
  )

  const handle: SessionRunHandle = {
    runId,
    sessionId,
    assistantMessageId: input.assistantMessageId,
    kind: input.kind,
    partCounter: 0,
    continuedRunIds: new Set<string>(),
    ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
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
  /**
   * U0(§10.15):**影子等这一下再比**。
   *
   * steering 的换锚点被提到了 agent-loop 发 boundary 的同步点(事件出生即带
   * runId),而引擎那边把上一条助手消息**写完**要晚一步(执行器隔着异步事件
   * 队列)。影子比的是"抄本 vs 投影",抄本这一侧还没写完就比,比出来的不等
   * 不说明任何事 —— 所以换锚点的人递一个闸进来,引擎收完上一条消息再开闸。
   *
   * 不给 = 照旧(落盘检查点之后立刻比)。闸永远不 resolve 的话这条 run 的
   * 影子就不比 —— 所以调用方必须在**收尾路径**上也开闸(执行器的 finally)。
   */
  shadowGate?: PromiseLike<unknown>
}

/**
 * 收一次执行。幂等:同一个 runId 收两次只写一条 `run/end`
 * (finally 与 catch 都会调它,而那两条路在 abort 时会同时走到)。
 *
 * ## 返回的 promise = **只有那一次 fsync**(§15.12(c))
 *
 * 四个语义检查点里,`run/end` 这一处从 `void` 改成"可 await":一次执行收账时
 * "已落盘"这句话必须是真的 —— 那正是崩溃窗口最值钱的一格(§14.7 风险②),
 * 而收尾路径本来就已经在等更贵的东西了。另外三处(recorder 的响应/工具检查点)
 * 保持 `void`:它们在**流的中途**,每一次都换一次 fsync 等待会把延迟摊进每个
 * 回合,而它们丢的最多是"还没到下一个检查点的那一小段"。
 *
 * **刻意不包含影子与 refold 那条链**:`input.shadowGate` 是调用方自己开的闸,
 * 它完全可能永远不 resolve(注释见 `EndSessionRunInput.shadowGate`),
 * await 它等于把收尾挂死。所以链子照旧 fire-and-forget,只有 flush 被交出去。
 *
 * 函数体在第一个 await 之前是**同步**的(`run/end` 的落账与 `currentRuns` 的
 * 清账都在那之前),所以幂等与顺序语义一字未变;调用方不 await 也照旧工作。
 */
export async function endSessionRun(
  sessionId: string,
  runId: string | undefined,
  input: EndSessionRunInput,
): Promise<void> {
  const handle = currentRuns.get(sessionId)
  if (!handle) return
  // 归属判据 = "这次执行的 run",不是"这一个 runId":steering 轮换之后当前 run 是
  // 新的那一条,而收尾的人手里还是进门时那个 id(见 `continuedRunIds`)。
  if (runId !== undefined && handle.runId !== runId && !handle.continuedRunIds.has(runId)) return
  // F13(§13.2):清账之后再落盘的东西**不会**因此丢账 —— 记录器攒的每一批
  // delta / 每一段 part 都在**开它的时候**就记下了自己的 runId
  // (`ChunkBatch.runId` / `PartState.runId`),不再落盘时现取"当前是哪次执行"。
  // 那正是 2 秒定时器晚于这一行触发时整批 delta 静默消失的病根;调用方仍然
  // 应当先 `recorder.flush()` 再收尾(执行器的 finally 就是这个顺序),
  // 但顺序现在只影响**什么时候**落盘,不影响**落不落得下**。
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
  // 语义检查点:run 结束(§10.3 ③)。S3w-4 起**交给调用方 await**(见函数头):
  // 收一次执行时"已落盘"必须是真的。`catch` 兜底是因为这个 promise 现在有两个
  // 消费者(返回值 + 下面那条链),而 flush 的失败不该变成收尾路径上的异常
  // —— 写失败自己的出口是 `appendFailures` 与裁定 7 的上抛,不是这里。
  // F4-c c4:"这一轮跑了多少个 run"从前是恒等门顺手记的一笔;门退役之后由这里记
  // (见 `SessionShadowStats.runs`)。它是 `run/end` 落账的事实,与哪道门在比无关。
  if (isSessionShadowEnabled()) bumpSessionShadowStats({ runs: 1 })
  const flushed = flushSessionEventLog(sessionId).catch(() => undefined)
  //
  // 对账排在检查点**之后**(§10.4:"`run/end` 落盘后"):比对读的是活投影,
  // 但一条还没落盘的 run 万一进程当场没了,记下的"相等"就没有对应的账。
  //
  // F4-c c4:这个缝上从前挂着两道门 —— 语义层的恒等门(`scheduleSessionRunShadow`)
  // 与耐久层的 refold。恒等门已退役(§16.24),refold 留任,挂点与判据一字未动。
  void flushed
    // U0:换锚点递进来的那道闸(见 `EndSessionRunInput.shadowGate`)。
    .then(() => input.shadowGate)
    .then(() => {
      // S3w-2(§14.3-B):耐久层这道门要的前提是"文件字节此刻是全的",而那只有
      // 在语义检查点之后成立。自己按会话采样,不是每个 run 都跑。
      scheduleSessionRefold(sessionId, handle.runId)
    })

  await flushed
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
 * 账本上这是**两条 run**:旧的按 completed 收尾,新的以 `kind:'steer'` 开张 ——
 * 一条 assistant 消息一个 run 是投影的前提(`run/start` 就是那条消息的节点)。
 *
 * 但引擎那边**只有一次执行**:agent-loop 的 turnIndex 与 accumulatedUsage
 * 跨过这个边界继续走。所以新 run 必须把旧 run 的 id 带上(`continuesRunId`),
 * 否则投影只能按"每个 run 从第 1 轮数起"猜 —— 见事件类型上的注释。
 */
export function rotateSessionRun(
  sessionId: string,
  input: BeginSessionRunInput,
  options: { shadowGate?: PromiseLike<unknown> } = {},
): SessionRunHandle {
  const previous = currentRuns.get(sessionId)
  if (previous) {
    // `void`:轮换发生在 agent-loop 的**同步点**上(返回新 handle),这里等一次
    // fsync 等于把每一次 steering 都加一次盘等待。收账本身是同步的(见函数头)。
    void endSessionRun(sessionId, previous.runId, {
      outcome: 'completed',
      // U0:轮换现在发生在 agent-loop 的同步点,而引擎把上一条消息写完要晚
      // 一步 —— 影子等引擎那边收完再比(见 `EndSessionRunInput.shadowGate`)。
      ...(options.shadowGate ? { shadowGate: options.shadowGate } : {}),
    })
  }
  const handle = beginSessionRun(sessionId, {
    ...input,
    ...(previous ? { continuesRunId: previous.runId } : {}),
  })
  // 轮换只换消息锚点,执行还是同一次 —— 旧 id 从此也是这条 handle 的凭据,
  // 否则执行收尾时按进门那个 id 找不到自己(见 `continuedRunIds`)。
  if (previous) {
    for (const id of previous.continuedRunIds) handle.continuedRunIds.add(id)
    handle.continuedRunIds.add(previous.runId)
  }
  return handle
}

/** 仅测试 / 会话删除。 */
export function resetSessionRuns(sessionId?: string): void {
  if (sessionId) {
    currentRuns.delete(sessionId)
    return
  }
  currentRuns.clear()
}
