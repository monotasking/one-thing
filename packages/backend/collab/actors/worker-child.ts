/**
 * WorkerChildActor —— 一个大脑,多双手(docs/design/collab-actor-v3.md §1.6)。
 *
 * 一张卡一个短命 actor:绑 `{cardId, roomSessionId, workSessionId}`,独立循环跑
 * 一份工作,干完把结果**回投父的 mailbox**,然后收摊。
 *
 * ## 为什么它必须与心智循环并行
 *
 * §0.1 那条「执行归 AgentActor,全局唯一」的宪法约束的是**对话性**回合。重活不是
 * 说话,是一双手。把工作塞进心智循环的代价一目了然:一张跑三十分钟的卡会让这位
 * 同事在群里三十分钟不吭声 —— 群聊里那就是「他死了」。所以子 actor 与心智循环
 * 并行,这是**有意的豁免**(§1.6 明写),不是漏掉的一条串行。
 *
 * 代价是父在子跑着的时候会去答别的话。这不是 bug,是这个模型要的:一个人一边
 * 开会一边写代码不构成自相矛盾 —— 会跑偏的是「同时在两间房说话」,而那条仍然
 * 被 `awaitTurnSlot` 锁着。
 *
 * ## 「回投」为什么走信箱,而不是回调父的方法
 *
 * 子干完了直接调父的一个方法,是最短的路;但那条路会在父正跑着一轮对话的中间
 * 插进来改父的账 —— 而心智循环的全部价值就在于「寻址到我的事情按序一件一件
 * 处理」。回投走信箱,结果就变成一封普通的信:排在队列里,轮到它才被处理,处理
 * 的那一刻账是自洽的。父因此**不需要主动查**自己的活干完没有 —— 下一个对话回合
 * 的折叠信封里自然就有(v2 收养回声机制的泛化,§5 复用清单最后一行)。
 *
 * ## 三个端口,零生产调用点
 *
 *  - `CollabWorkerMindPort` —— 「跑一份工作」。真身在 `worker-mind-port.ts`
 *    (D6 接线),测试与金重放用这里的剧本化假件。
 *  - `CollabWorkerBoardPort` —— 「把卡推一格」。D4 **不直写 board store**:那是
 *    生产写路径,而 v2 的调度链此刻还在用它。假件只记调用。
 *  - `CollabWorkerSlotLedger` —— 全局并发的那一本账(跨 agent 共享)。per-agent
 *    那一半读父自己的子清单,没有第二本账。
 */
import {
  ActorBase,
  InMemoryMailbox,
  createActorEvent,
  type ActorBaseOptions,
  type ActorEvent,
} from '@onething/core/actors'
import {
  admitCollabWorker,
  collabAgentWorkerResult,
  truncateCollabWorkerSummary,
  type CollabActorVerb,
  type CollabAgentSpawnWorkerVerb,
  type CollabAgentWorkerResultVerb,
  type CollabWorkerEvidenceRef,
  type CollabWorkerLimits,
  type CollabWorkerOutcome,
} from '@onething/runtime/collab/actors'

import type { CollabMindSay } from './mind-port.js'

/* ── 端口:跑一份工作 ───────────────────────────────────────────────────── */

export interface CollabWorkerRunRequest {
  agentId: string
  workerId: string
  cardId: string
  /** 这张卡属于哪间房 —— 出站路由与权限亲和跟着房走。 */
  roomSessionId: string
  /** 续做:接着这条工作会话往下做。缺席 = 端口新建一条并回传它的 id。 */
  workSessionId?: string
  title: string
  description?: string
  /** 看板现状(端口不认识看板,由 board 端口喂进来)。 */
  boardDigest?: string
  /** 起流上限与总墙钟。端口是唯一掐得动流的那一方,所以由它执行。 */
  startTimeoutMs?: number
  totalTimeoutMs?: number
}

export interface CollabWorkerRunResult {
  outcome: CollabWorkerOutcome
  /** 这一段跑在哪条工作会话里。新建的话由端口回传 —— 账要记它(续做读它)。 */
  workSessionId?: string
  /** 它自己在房间里说过的话(「一句没说」的判据与收养兜底读它)。 */
  says?: CollabMindSay[]
  /** 代码采集的执行痕迹。**只有引用**。 */
  evidence?: CollabWorkerEvidenceRef[]
  /** 交回父的一句话。落进回投之前会被截断 + 转义。 */
  summary?: string
}

export interface CollabWorkerMindPort {
  readonly name: string
  /**
   * 跑一份工作。
   *
   * 与 `CollabMindPort.runConversationalTurn` 是**两个**端口而不是一个带开关的:
   * 两者的不变量不同(那个全局至多一路,这个按闸并发)、超时不同(10 分钟 vs
   * 30 分钟)、收割面不同(房间 say vs 看板 + evidence)。合并的话每一处差异都
   * 要靠一个参数来分叉,而参数分叉出来的两条路迟早会有一条没人测。
   */
  runWorkTurn(request: CollabWorkerRunRequest): Promise<CollabWorkerRunResult>
}

/* ── 端口:把卡推一格 ───────────────────────────────────────────────────── */

export interface CollabWorkerBoardStartedInput {
  roomId: string
  cardId: string
  agentId: string
  workSessionId?: string
  at: number
}

export interface CollabWorkerBoardSettledInput extends CollabWorkerBoardStartedInput {
  outcome: CollabWorkerOutcome
  summary?: string
  evidence?: CollabWorkerEvidenceRef[]
}

/**
 * 卡自己的说法(它在回合里调过 board complete / block)。
 *
 * **优先于回合终局** —— 与 v2 harvest 的第一个分支同一条判据:一个 abort 掉的
 * 半截回合,如果卡上已经写着「交付了」,那它就是交付了;反过来一个 `complete`
 * 的回合,如果卡上写着受阻,那它就是受阻。终局说的是「流怎么结束的」,卡说的是
 * 「这份工作怎么了」,后者才是父要知道的那件事。
 */
export interface CollabWorkerBoardVerdict {
  outcome: CollabWorkerOutcome
  summary?: string
}

/**
 * 卡状态的推进面。
 *
 * **谁写哪一格**,一条规矩:离事实最近的那一方写。子 actor 写它自己那一段
 * (开工、终局),父只写「子已经不在了」那一段(重启对账 → interrupted)。两个
 * 属主各管一段,而不是两个属主抢同一格 —— 后者的症状是卡状态在两条路之间来回
 * 跳,而且只在崩溃恢复那一次现身。
 */
export interface CollabWorkerBoardPort {
  started(input: CollabWorkerBoardStartedInput): void | Promise<void>
  settled(input: CollabWorkerBoardSettledInput): void | Promise<void>
  /** 孤儿:上一条命里在跑,这条命里没人接。由**父**在对账时写。 */
  interrupted(input: CollabWorkerBoardStartedInput): void | Promise<void>
  /** 看板现状 —— 任务书的一块。端口不给就没有这一块(不是错误)。 */
  digest?(input: { roomId: string; agentId: string }): string | undefined
  /** 卡自己的说法。缺席 = 以回合终局为准。 */
  verdict?(input: { roomId: string; cardId: string; agentId: string }): CollabWorkerBoardVerdict | undefined
}

export interface CollabWorkerBoardCall {
  kind: 'started' | 'settled' | 'interrupted'
  roomId: string
  cardId: string
  agentId: string
  outcome?: CollabWorkerOutcome
  summary?: string
  workSessionId?: string
  at: number
}

export interface CollabWorkerBoardRecorder extends CollabWorkerBoardPort {
  readonly calls: CollabWorkerBoardCall[]
}

/** 测试与金重放的那一个:只记调用。生产适配器(接 board-store)在 D6。 */
export function createCollabWorkerBoardRecorder(
  options: { digest?: (input: { roomId: string; agentId: string }) => string | undefined } = {},
): CollabWorkerBoardRecorder {
  const calls: CollabWorkerBoardCall[] = []
  return {
    calls,
    started(input): void {
      calls.push({ kind: 'started', ...pickBoardCall(input) })
    },
    settled(input): void {
      calls.push({
        kind: 'settled',
        ...pickBoardCall(input),
        outcome: input.outcome,
        ...(input.summary ? { summary: input.summary } : {}),
      })
    },
    interrupted(input): void {
      calls.push({ kind: 'interrupted', ...pickBoardCall(input) })
    },
    ...(options.digest ? { digest: options.digest } : {}),
  }
}

function pickBoardCall(input: CollabWorkerBoardStartedInput): Omit<CollabWorkerBoardCall, 'kind'> {
  return {
    roomId: input.roomId,
    cardId: input.cardId,
    agentId: input.agentId,
    ...(input.workSessionId ? { workSessionId: input.workSessionId } : {}),
    at: input.at,
  }
}

/* ── 全局并发的那一本账 ─────────────────────────────────────────────────── */

/**
 * 整机同时在外的手。
 *
 * 只管全局那一半 —— per-agent 那一半读父自己的子清单(账里那张表),因为它必须
 * 跨重启活着,而这本是纯内存的:进程死了,在外的手也一并死了,一个「记得上一
 * 条命开过 4 只手」的全局计数只会把新进程永久锁死。
 */
export interface CollabWorkerSlotLedger {
  running(): number
  acquire(): void
  release(): void
  /**
   * 槽位空出来了 —— 叫醒排队的人。返回退订。
   *
   * 没有这一条的话全局闸会**饿死**跨 agent 的队列:A 的手占满整机,B 的卡排在
   * 自己的队里,而 B 下一次泵队列的时机是「B 自己收到一封信」——那可能是明天。
   * 闸只挡不叫醒,就不是闸,是黑洞。
   */
  onRelease(listener: () => void): () => void
}

export function createCollabWorkerSlotLedger(): CollabWorkerSlotLedger {
  let count = 0
  const listeners = new Set<() => void>()
  return {
    running: () => count,
    acquire: () => {
      count += 1
    },
    release: () => {
      count = Math.max(0, count - 1)
      // 快照一份再叫:监听者在回调里泵队列,而泵队列会 acquire —— 直接迭代
      // 活集合的话,一次重入就能改到正在迭代的那个 Set。
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // 一个排队者自己炸了,不能连累其它排队者被跳过。
        }
      }
    },
    onRelease: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** 并发闸的判定 —— 纯规则在 `worker-rules.ts`,这里只是把两个来源拼齐。 */
export function admitCollabWorkerSpawn(input: {
  agentRunning: number
  slots: CollabWorkerSlotLedger
  limits?: CollabWorkerLimits
}): ReturnType<typeof admitCollabWorker> {
  return admitCollabWorker({
    agentRunning: input.agentRunning,
    globalRunning: input.slots.running(),
    ...(input.limits ? { limits: input.limits } : {}),
  })
}

/* ── 子 actor ───────────────────────────────────────────────────────────── */

export interface CollabWorkerChildActorOptions
  extends Omit<ActorBaseOptions<ActorEvent<CollabActorVerb>>, 'id' | 'mailbox'> {
  agentId: string
  workerId: string
  port: CollabWorkerMindPort
  board?: CollabWorkerBoardPort
  /**
   * 结果回投口 —— **写进父自己的信箱**(见文件头)。
   *
   * 投不出去不改变这只手的终局:它已经干完了,而回投失败是一件观测的事
   * (`postFailure`),不是一次重跑的理由。
   */
  postResult(verb: CollabAgentWorkerResultVerb): void | Promise<void>
  /** 自己的信箱。缺省现开一个内存信箱 —— 子 actor 是短命的,不跨重启。 */
  mailbox?: InMemoryMailbox<ActorEvent<CollabActorVerb>>
  limits?: { startTimeoutMs?: number; totalTimeoutMs?: number }
  summaryMaxChars?: number
}

/** 这只手最终交回去的东西(父的监护任务读它)。 */
export interface CollabWorkerChildOutcome {
  workerId: string
  cardId: string
  roomId: string
  outcome: CollabWorkerOutcome
  workSessionId?: string
  summary?: string
  evidence?: CollabWorkerEvidenceRef[]
}

export class CollabWorkerChildActor extends ActorBase<ActorEvent<CollabActorVerb>> {
  readonly agentId: string
  readonly workerId: string

  /** 「这只手收工了」。父的监护任务 await 它 —— 而**心智循环不 await**(并行豁免)。 */
  readonly settled: Promise<CollabWorkerChildOutcome>

  private readonly inbox: InMemoryMailbox<ActorEvent<CollabActorVerb>>
  private readonly port: CollabWorkerMindPort
  private readonly board: CollabWorkerBoardPort | undefined
  private readonly postResult: (verb: CollabAgentWorkerResultVerb) => void | Promise<void>
  private readonly limits: { startTimeoutMs?: number; totalTimeoutMs?: number }
  private readonly summaryMaxChars: number | undefined
  private readonly clock: () => number
  private readonly sideErrors: Error[] = []

  private resolveSettled!: (outcome: CollabWorkerChildOutcome) => void
  private finished = false

  constructor(options: CollabWorkerChildActorOptions) {
    const inbox = options.mailbox ?? new InMemoryMailbox<ActorEvent<CollabActorVerb>>()
    super({ ...options, id: `worker:${options.workerId}`, mailbox: inbox })
    this.agentId = options.agentId
    this.workerId = options.workerId
    this.inbox = inbox
    this.port = options.port
    this.board = options.board
    this.postResult = options.postResult
    this.limits = options.limits ?? {}
    this.summaryMaxChars = options.summaryMaxChars
    this.clock = options.now ?? Date.now
    this.settled = new Promise<CollabWorkerChildOutcome>(resolve => {
      this.resolveSettled = resolve
    })
  }

  /** 端口/看板那一侧出的岔子(不改变终局,只留痕)。 */
  get sideEffectErrors(): readonly Error[] {
    return [...this.sideErrors]
  }

  /**
   * 起跑:把任务书投进自己的信箱,起循环。
   *
   * 任务书**也是一封信**而不是一个构造参数:子 actor 与别的 actor 因此没有第二
   * 种被驱动的方式,金重放里它的输入与其它 actor 一样是一串事件。
   */
  async begin(verb: CollabAgentSpawnWorkerVerb, eventId: string): Promise<void> {
    this.start()
    await this.inbox.append(createActorEvent<CollabActorVerb>({
      id: eventId,
      at: this.clock(),
      type: verb.type,
      from: { kind: 'agent', id: this.agentId },
      to: { kind: 'worker', id: this.workerId },
      payload: verb,
    }))
  }

  protected async handleEvent(event: ActorEvent<CollabActorVerb>): Promise<void> {
    const verb = event.payload
    // 子 actor 只认它自己那一封任务书。别的信原样吞掉 —— 一双手没有第二件事要做。
    if (verb.type !== 'agent:spawn-worker') return
    if (verb.workerId !== this.workerId) return
    await this.runCard(verb)
  }

  private async runCard(verb: CollabAgentSpawnWorkerVerb): Promise<void> {
    if (this.finished) return
    this.finished = true

    const startedAt = this.clock()
    await this.side(() => this.board?.started({
      roomId: verb.roomId,
      cardId: verb.cardId,
      agentId: this.agentId,
      ...(verb.workSessionId ? { workSessionId: verb.workSessionId } : {}),
      at: startedAt,
    }))

    const digest = this.board?.digest?.({ roomId: verb.roomId, agentId: this.agentId })

    let result: CollabWorkerRunResult
    try {
      result = await this.port.runWorkTurn({
        agentId: this.agentId,
        workerId: this.workerId,
        cardId: verb.cardId,
        roomSessionId: verb.roomId,
        ...(verb.workSessionId ? { workSessionId: verb.workSessionId } : {}),
        title: verb.title ?? verb.cardId,
        ...(verb.description ? { description: verb.description } : {}),
        ...(digest ? { boardDigest: digest } : {}),
        ...(this.limits.startTimeoutMs === undefined ? {} : { startTimeoutMs: this.limits.startTimeoutMs }),
        ...(this.limits.totalTimeoutMs === undefined ? {} : { totalTimeoutMs: this.limits.totalTimeoutMs }),
      })
    } catch (error) {
      // 端口炸了 = 这一轮没跑成。**不重试** —— 重试的决定归父(它才知道这张卡
      // 今天已经炸过几次),而在这里默默再来一遍等于把预算烧成两倍。
      const failure = toError(error)
      this.sideErrors.push(failure)
      result = { outcome: 'error', summary: failure.message }
    }

    const workSessionId = result.workSessionId ?? verb.workSessionId
    // 卡自己说过话的话以卡为准(见 `CollabWorkerBoardVerdict`)。
    let verdict: CollabWorkerBoardVerdict | undefined
    await this.side(() => {
      verdict = this.board?.verdict?.({
        roomId: verb.roomId,
        cardId: verb.cardId,
        agentId: this.agentId,
      })
    })
    const outcomeOf = verdict?.outcome ?? result.outcome
    // 一句都没交代的话,退回它自己最后说的那句 —— 那是它对房间说过的话,已经
    // 公开,拿来当摘要不构成新的泄露。
    const summary = truncateCollabWorkerSummary(
      verdict?.summary ?? result.summary ?? result.says?.[result.says.length - 1]?.content,
      this.summaryMaxChars,
    )
    const settledAt = this.clock()

    await this.side(() => this.board?.settled({
      roomId: verb.roomId,
      cardId: verb.cardId,
      agentId: this.agentId,
      ...(workSessionId ? { workSessionId } : {}),
      at: settledAt,
      outcome: outcomeOf,
      ...(summary ? { summary } : {}),
      ...(result.evidence?.length ? { evidence: result.evidence } : {}),
    }))

    const outcome: CollabWorkerChildOutcome = {
      workerId: this.workerId,
      cardId: verb.cardId,
      roomId: verb.roomId,
      outcome: outcomeOf,
      ...(workSessionId ? { workSessionId } : {}),
      ...(summary ? { summary } : {}),
      ...(result.evidence?.length ? { evidence: result.evidence } : {}),
    }

    // 回投在最后一步:看板已经推过了,父的账才开始动 —— 反过来的话一次崩在
    // 中间的重启会看见「父以为干完了,而卡还停在 doing」。
    await this.side(() => this.postResult(collabAgentWorkerResult({
      agentId: this.agentId,
      workerId: this.workerId,
      cardId: verb.cardId,
      roomId: verb.roomId,
      outcome: outcomeOf,
      ...(summary ? { summary } : {}),
      ...(result.evidence?.length ? { evidence: result.evidence } : {}),
      ...(workSessionId ? { workSessionId } : {}),
    })))

    this.resolveSettled(outcome)
  }

  /** 旁路动作:失败留痕但不改终局(v2 的教训:harvest 失败不该把卡退回待办)。 */
  private async side(action: () => void | Promise<void>): Promise<void> {
    try {
      await action()
    } catch (error) {
      this.sideErrors.push(toError(error))
    }
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/* ── 剧本化的假端口 ─────────────────────────────────────────────────────── */

/** 剧本里的一份工作:这张卡跑出什么结果。 */
export interface CollabScriptedWork {
  cardId: string
  outcome?: CollabWorkerOutcome
  summary?: string
  says?: string[]
  evidence?: CollabWorkerEvidenceRef[]
  workSessionId?: string
}

export interface CollabScriptedWorkerCall {
  agentId: string
  workerId: string
  cardId: string
  roomSessionId: string
  workSessionId?: string
  /** 进入这次调用时,已经在跑的工作数。并发闸的测试盯着它的峰值。 */
  concurrentOnEntry: number
  /** 任务书里给到的看板现状(端口自己不认识看板)。 */
  boardDigest?: string
}

export interface CollabScriptedWorkerPort extends CollabWorkerMindPort {
  readonly calls: CollabScriptedWorkerCall[]
  readonly peakConcurrency: number
  readonly inFlight: number
  /** 让接下来的 `runWorkTurn` 挂住,直到 `release()`。并行豁免的测试要它。 */
  hold(): void
  release(): void
}

/**
 * 剧本化的假件:按卡出结果,可挂起。
 *
 * 与 `createCollabScriptedMindPort` 同一个身份 —— 住在生产目录里而不是
 * `__tests__/` 下,因为金重放要用它,而金重放是交付物不是测试脚手架。
 */
export function createCollabScriptedWorkerPort(
  script: readonly CollabScriptedWork[] = [],
): CollabScriptedWorkerPort {
  const queue = new Map<string, CollabScriptedWork[]>()
  for (const work of script) {
    const list = queue.get(work.cardId) ?? []
    list.push(work)
    queue.set(work.cardId, list)
  }

  const calls: CollabScriptedWorkerCall[] = []
  let inFlight = 0
  let peak = 0
  let gate: Promise<void> | null = null
  let open: (() => void) | null = null

  return {
    name: 'scripted-worker',
    calls,
    get peakConcurrency() {
      return peak
    },
    get inFlight() {
      return inFlight
    },
    hold(): void {
      if (gate) return
      gate = new Promise<void>(resolve => {
        open = resolve
      })
    },
    release(): void {
      open?.()
      gate = null
      open = null
    },
    async runWorkTurn(request: CollabWorkerRunRequest): Promise<CollabWorkerRunResult> {
      calls.push({
        agentId: request.agentId,
        workerId: request.workerId,
        cardId: request.cardId,
        roomSessionId: request.roomSessionId,
        ...(request.workSessionId ? { workSessionId: request.workSessionId } : {}),
        ...(request.boardDigest ? { boardDigest: request.boardDigest } : {}),
        concurrentOnEntry: inFlight,
      })
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        if (gate) await gate
        const work = queue.get(request.cardId)?.shift()
        return {
          outcome: work?.outcome ?? 'complete',
          // 会话 id 由端口给:剧本没指定的话按「一卡一会话」造一个确定性的。
          workSessionId: work?.workSessionId ?? request.workSessionId ?? `work:${request.cardId}`,
          says: (work?.says ?? []).map(content => ({ content })),
          ...(work?.summary === undefined ? {} : { summary: work.summary }),
          ...(work?.evidence ? { evidence: work.evidence } : {}),
        }
      } finally {
        inFlight -= 1
      }
    },
  }
}
