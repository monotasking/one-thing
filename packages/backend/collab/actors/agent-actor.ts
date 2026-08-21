/**
 * AgentActor —— 一个大脑,多本相册,一本笔记(docs/design/collab-actor-v3.md §1.2)。
 *
 * v2 里「这个 agent 现在在干什么」没有属主:coordinator 的队列、queue 的激活记录、
 * turn 的 agent 锁、drive-guard 的世代号,四个地方各存一角,而跨房自相矛盾靠的是
 * 提示词纪律。v3 把它收成**一条循环**:寻址到我的每一封信按序进这里,一封一封处理。
 *
 * ## 「一个大脑」在代码里是哪一行
 *
 * 是 `awaitTurnSlot()` —— 每一次要起对话性回合之前,先等上一轮跑完。同一时刻全局
 * 至多一路对话性 LLM 调用代表这个 agent,不是靠约定,是靠这一个 await。
 *
 * **为什么不是「在 handleEvent 里 await 到底」**:那样这条循环在回合期间是聋的,
 * 而 v3 明确保留了 steer(§1.2「回合期间:同房新 posted 事件在工具边界注入」)——
 * 一条中途到达的消息如果要等这一轮跑完才被看见,steer 这个机制就不存在了。
 * 所以回合是**起了就放手**,循环继续收信;下一次要起回合时在 `awaitTurnSlot()`
 * 那里排队。两个性质同时成立:
 *
 *  - 对话性回合严格串行(测试:一批里两张牌顺序跑,`peakConcurrency === 1`);
 *  - 回合期间同房 posted 走注入端口,他房 posted 只进折叠缓冲(测试同上)。
 *
 * ## 次序是契约(§3 三面纪律)
 *
 *     决策 → **落账**(同步原子写)→ 动作(投信 / 起回合 / 写笔记)
 *
 * 账在最前面,因为它是崩溃之后唯一能重建现场的东西。两个水位为什么要分开(投递
 * 水位 vs 已读水位)见 `mind-rules.ts` 的文件头 —— 合并成一个的代价是模型永远
 * 读到「零未读」。
 *
 * ## 蓝图修正:经历流 = 既有的执行会话
 *
 * 蓝图 §1.2/§4 原计划把分区经历流放 `agents-v3/<agentId>/rooms/*.jsonl` 并迁移
 * 执行会话。实施改为:**经历流就是既有的 `agent-exec-<agentId>-<roomId>`
 * ChatSession**(id 与格式不变),AgentActor 接管它的所有权。引擎(流式/工具/
 * 权限)、会话仓库、UI 履历页全部按 ChatSession 工作 —— 保留它 = 引擎零改造 +
 * 经历零迁移。这个类因此只经由 `CollabMindPort` 认识那条会话的 id,不认识它的
 * 内容。
 *
 * **本期不接引擎、不接宿主**(接线在 D6):所有外部依赖都从 `CollabAgentActorHost`
 * 与 `CollabMindPort` 进来。v2 的调度链仍然是生产,这里一行都没动它。
 */
import {
  ActorBase,
  type ActorBaseOptions,
  type ActorEvent,
  type ActorMailboxSource,
  type FloorLease,
} from '@onething/core/actors'
import {
  formatCollabNotificationBlock,
  isCollabRoomFact,
  type CollabAgentLike,
  type CollabMessageLike,
} from '@onething/runtime/collab'
import {
  adoptCollabAgentWorkerOrphans,
  advanceCollabAgentDelivered,
  advanceCollabAgentRead,
  buildCollabFoldedEnvelope,
  buildCollabMindDrive,
  buildCollabWorkerFoldEntry,
  collabSchedulerWorkerResult,
  collabSchedulerWorkerSpawn,
  clearCollabAgentHand,
  collabAgentSpawnWorker,
  collabWorkerRunning,
  collabWorkerRunningForCard,
  createCollabWorkerRecord,
  settleCollabAgentWorker,
  startCollabAgentWorker,
  collabAgentLeaseOf,
  collabAgentRoomAccount,
  collabAgentSpeak,
  collabAgentRaiseHand,
  collabAgentYield,
  collabPostedSpeakerId,
  createCollabHeuristicHandEvaluator,
  dropCollabAgentLease,
  pushCollabAgentFold,
  raiseCollabAgentHand,
  recordCollabAgentLease,
  recordCollabAgentTurn,
  recordCollabAgentWorkerResult,
  takeCollabAgentFold,
  type CollabActorVerb,
  type CollabAgentAccount,
  type CollabAgentNoteVerb,
  type CollabAgentSpawnWorkerVerb,
  type CollabAgentWorkerRecord,
  type CollabAgentWorkerResultVerb,
  type CollabFoldEntry,
  type CollabHandEvaluator,
  type CollabWorkerLimits,
  type CollabRoomCardEventVerb,
  type CollabRoomFloorGrantedVerb,
  type CollabRoomFloorRevokedVerb,
  type CollabRoomMembershipChangedVerb,
  type CollabRoomPhaseChangedVerb,
  type CollabRoomPostedVerb,
  type CollabSchedulerLogRow,
  type CollabSchedulerLogSink,
} from '@onething/runtime/collab/actors'

import {
  createCollabAgentAccountFileStore,
  type CollabAgentAccountStore,
} from './agent-mailbox.js'
import type { CollabMindPort, CollabMindTurnResult } from './mind-port.js'
import { buildCollabAgentNotebookBlock, type CollabNotebookStore } from './notebook-store.js'
import {
  CollabWorkerChildActor,
  admitCollabWorkerSpawn,
  createCollabWorkerSlotLedger,
  type CollabWorkerBoardPort,
  type CollabWorkerMindPort,
  type CollabWorkerSlotLedger,
} from './worker-child.js'
import { getLogger } from '../../wiring/logging/index.js'

const log = getLogger('collab.actors.agent')


/** 房间的投递口 —— agent → room 的动词从这里出去。 */
export interface CollabAgentOutbox {
  post(verb: CollabActorVerb): Promise<void>
}

/** drive 里「当前房那一块」要的事实。渲染归宿主(它才认识 store 与投影)。 */
export interface CollabAgentRoomContextInput {
  agentId: string
  roomId: string
  execSessionId: string
  /** 已读水位。缺席 = 首轮铺底(与 v2 `buildDriveRoomContext` 同一条判据)。 */
  seenMessageId?: string
  bootstrap: boolean
  now: number
}

/**
 * AgentActor 要问外面的每一件事。
 *
 * 与 `CollabRoomActorHost` 同一套做法:全部是窄口、大部分同步。异步只有一处
 * (`roomOutbox().post`),因为投信本来就是 IO。
 */
export interface CollabAgentActorHost {
  /**
   * 这个 agent 在这间房的经历流会话 id。
   *
   * `null` = 拼不出来(agent 被删了、迁移期的旧形状)。那一轮直接交牌 —— 一张
   * 发出去却没人接的牌会把座位永久占住。
   */
  execSessionId(agentId: string, roomId: string): string | null
  /** 当前房增量投影(D6 接 `buildCollabDriveRoomContext`)。 */
  buildRoomContext(input: CollabAgentRoomContextInput): string
  /** 房间的投递口。`undefined` = 这间房此刻没有信箱,跳过(不算投递失败)。 */
  roomOutbox(roomId: string): CollabAgentOutbox | undefined
  /** 在职成员 —— 裸 `@名字` 的解析要它。 */
  members(roomId: string): readonly CollabAgentLike[]
  /** 这间房是私聊吗(启发式举手的第二条)。 */
  dm?(roomId: string): boolean
  /** roomId → 房间名(信封的 `room` 属性、笔记的房间语境)。 */
  roomLabel?(roomId: string): string | undefined
  /** agentId → 「名字#句柄」(信封的 `from`)。 */
  speakerLabel?(agentId: string): string | undefined
  /**
   * 这一轮**将会**读到哪一条为止 —— 已读水位的候选值,drive 之前取。
   *
   * 缺省用账里的投递水位:mailbox 保序且 at-least-once,「我收到的最后一条」
   * 就是「这一轮投影会读到的最后一条」。宿主要更精确(直接读房间尾巴)可以覆盖它。
   */
  projectedThrough?(roomId: string): { messageId?: string; at?: number } | undefined
  /** 已读水位落到经历流会话上(UI 与投影读它)。D6 接 store。 */
  persistSeen?(input: {
    agentId: string
    roomId: string
    execSessionId: string
    messageId: string
    at: number
  }): void
  /** 中途来消息的注入信封 —— 与房间投影同源(v2 `steer.ts` 的第一处收窄)。 */
  formatSteerBody?(message: CollabMessageLike): string
  now(): number
}

/** 一轮回合炸了。与 dead-letter 分开 —— 「这封信有问题」和「这一轮跑砸了」是两回事。 */
export interface CollabAgentTurnFailure {
  roomId: string
  leaseId: string
  error: Error
  at: number
}

/** 一只手炸了(派生/监护那一侧,不是工作本身跑砸了 —— 后者是一个正常的终局)。 */
export interface CollabAgentWorkerFailure {
  cardId: string
  workerId: string
  error: Error
  at: number
}

/** 孤儿处置。默认 `interrupt` —— 理由见 `recoverWorkers`。 */
export type CollabAgentOrphanPolicy = 'interrupt' | 'respawn'

/**
 * 一次值得播出去的活动转变(D8 观测体系 §3.1 的发射点)。
 *
 * 四类不是随手分的,它们决定走哪一档节流:前三类是界面上会**动**的东西(大脑的
 * 忙闲、牌的得失、手的起落 —— 徽标从🟡翻到🟢就是它们),走 120ms 的活动档;
 * `inbox` 是一个数字(积压深度),走 1s 的普通档。
 *
 * 这个 actor **不认识**广播链路:钩子由宿主接(与 `onTurnFailure` / `schedulerLog`
 * 同一条纪律)。一个 import 了 inspector 的 actor 会把「跑一轮回合」的测试面
 * 拉上整条会话事件总线。
 */
export type CollabAgentActivityTransition = 'mind' | 'lease' | 'worker' | 'inbox'

/**
 * 重活委托的接线(D4 §1.6)。**不配 = 这个 agent 没有手**:收到 spawn-worker 会
 * 进 dead-letter,而不是被静静吞掉 —— 一张永远不会开工的卡是这套系统里最贵的
 * 一种沉默。
 */
export interface CollabAgentWorkerOptions {
  port: CollabWorkerMindPort
  /**
   * 结果回投口 —— 写进**父自己的信箱**(而不是回调父的方法)。
   * 理由见 `worker-child.ts` 文件头:回投必须与别的信排同一条队。
   */
  postResult(verb: CollabAgentWorkerResultVerb): void | Promise<void>
  /** 卡状态的推进面。缺席 = 不推(D4 的测试面就是这样跑的)。 */
  board?: CollabWorkerBoardPort
  /**
   * 全局并发的那本账。**必须由宿主注入同一个实例**,不然「全局」就退化成
   * 「per-agent 的第二个名字」——默认现开一本正是这个退化,它只对单 agent 的
   * 测试成立。
   */
  slots?: CollabWorkerSlotLedger
  limits?: CollabWorkerLimits
  /** 墙钟(端口执行)。缺省走 `worker-rules.ts` 里那两个数。 */
  timeouts?: { startTimeoutMs?: number; totalTimeoutMs?: number }
  orphanPolicy?: CollabAgentOrphanPolicy
  summaryMaxChars?: number
  /** 重派时新手的 id。缺省 `<旧 id>~resume` —— 旧记录因此不会被覆盖掉。 */
  newWorkerId?(input: { cardId: string; previousWorkerId: string }): string
}

/** 一次重启对账的结果。 */
export interface CollabAgentWorkerRecovery {
  /** 上一条命留下的在跑记录(**账里已经标成 interrupted**)。 */
  orphans: CollabAgentWorkerRecord[]
  policy: CollabAgentOrphanPolicy
  /** 重派出去的新 workerId(policy = interrupt 时为空)。 */
  respawned: string[]
}

export interface CollabAgentActorOptions
  extends Omit<ActorBaseOptions<ActorEvent<CollabActorVerb>>, 'id'> {
  agentId: string
  host: CollabAgentActorHost
  mindPort: CollabMindPort
  notebook: CollabNotebookStore
  mailbox: ActorMailboxSource<ActorEvent<CollabActorVerb>>
  /** 账的存取面。缺省落盘(`agents-v3/<agentId>/state.json`)。 */
  store?: CollabAgentAccountStore
  /** 举手评估器。缺省 D2 启发式;D3 换成 referee 侧的批量裁决。 */
  handEvaluator?: CollabHandEvaluator
  /** 折叠信封的渲染上限(测试注入)。 */
  foldLimits?: { maxEvents?: number; maxPerRoom?: number }
  /** 折叠缓冲的容量与幂等窗口(测试注入)。 */
  foldBuffer?: { max?: number; seenMax?: number }
  /** 笔记注入预算(字符)。 */
  notebookBudget?: number
  /** 一轮回合炸了的观测钩子。 */
  onTurnFailure?: (failure: CollabAgentTurnFailure) => void
  /** 回合失败环形容量,默认 50。 */
  maxTurnFailures?: number
  /** 重活委托(D4)。不配 = 这个 agent 只会说话,不会干活。 */
  worker?: CollabAgentWorkerOptions
  /** 一只手炸了的观测钩子。 */
  onWorkerFailure?: (failure: CollabAgentWorkerFailure) => void
  /**
   * 调度时间轴(D8 §3.3)。缺省不记。
   *
   * 这里记的只有两类:`worker-spawn` 与 `worker-result` —— 它们是**这个 actor**
   * 转换的状态(工作卡的子清单在 agent 账里)。发言、举手、让位那几类归房间记,
   * 因为改的是房账;两边各记各的,一件事永远只有一个产生点。
   */
  schedulerLog?: CollabSchedulerLogSink
  /**
   * 活动转变的观测钩子(D8 §3.1)。缺省不通知。
   *
   * 每一处调用点都紧跟在**账真的变了**之后 —— 观测不跑在真值前面(与
   * `recordSchedulerRow` 同一条纪律)。节流归宿主,这里是无脑每次都喊。
   */
  onActivity?: (transition: CollabAgentActivityTransition) => void
}

interface InFlightTurn {
  roomId: string
  leaseId: string
  execSessionId: string
  /** 起跑时刻 —— agent 快照的 `mind.since` 读它(「想了多久」)。 */
  startedAt: number
  /** 牌在回合中途被收了(换相 / 冻结 / 用户喊停)。收尾时不再交牌、不再发言。 */
  revoked: boolean
  /**
   * 注入迟到的那几条 —— 这一轮已经读不到它们了。
   *
   * 推迟到**交牌之后**再做激活决策:此刻举手会被房间当成空操作吃掉(它看见我
   * 手里有牌),而那等于把这条消息静静丢了。v2 在这里退回 engage,v3 的等价物
   * 就是「等我交完牌,再按普通消息评估一次」。
   */
  missed: Array<{ verb: CollabRoomPostedVerb; message: CollabMessageLike }>
  done: Promise<void>
}

const DEFAULT_TURN_FAILURE_CAPACITY = 50

export class CollabAgentActor extends ActorBase<ActorEvent<CollabActorVerb>> {
  readonly agentId: string

  private readonly host: CollabAgentActorHost
  private readonly mindPort: CollabMindPort
  private readonly notebook: CollabNotebookStore
  private readonly accountStore: CollabAgentAccountStore
  private readonly handEvaluator: CollabHandEvaluator
  private readonly foldLimits: { maxEvents?: number; maxPerRoom?: number }
  private readonly foldBuffer: { max?: number; seenMax?: number }
  private readonly notebookBudget: number | undefined
  private readonly onTurnFailure: ((failure: CollabAgentTurnFailure) => void) | undefined
  private readonly maxTurnFailures: number
  private readonly failures: CollabAgentTurnFailure[] = []
  private readonly worker: CollabAgentWorkerOptions | undefined
  private readonly workerSlots: CollabWorkerSlotLedger
  private readonly onWorkerFailure: ((failure: CollabAgentWorkerFailure) => void) | undefined
  private readonly schedulerLog: CollabSchedulerLogSink | undefined
  private readonly onActivity: ((transition: CollabAgentActivityTransition) => void) | undefined
  private readonly workerFailures: CollabAgentWorkerFailure[] = []
  /** 在外的手,按 workerId。**内存态** —— 跨重启的那一面在账的子清单里。 */
  private readonly children = new Map<string, CollabWorkerChildActor>()
  /**
   * 被并发闸挡住、排着队的那些卡。
   *
   * **只在内存里**(与 v2 `pendingByRoom` 同一条):进程死了队列没了,而卡还在
   * 板上 —— 续做是一个决定(人 / 负责人 / 下一次回合里的 agent 用 board start
   * 作出),不是一次自动重驱。
   */
  private readonly workerQueue: CollabAgentSpawnWorkerVerb[] = []
  private readonly unsubscribeSlots: (() => void) | undefined

  private state: CollabAgentAccount
  private turn: InFlightTurn | null = null

  constructor(options: CollabAgentActorOptions) {
    super({ ...options, id: `agent:${options.agentId}` })
    this.agentId = options.agentId
    this.host = options.host
    this.mindPort = options.mindPort
    this.notebook = options.notebook
    this.accountStore = options.store ?? createCollabAgentAccountFileStore()
    this.handEvaluator = options.handEvaluator ?? createCollabHeuristicHandEvaluator()
    this.foldLimits = options.foldLimits ?? {}
    this.foldBuffer = options.foldBuffer ?? {}
    this.notebookBudget = options.notebookBudget
    this.onTurnFailure = options.onTurnFailure
    this.maxTurnFailures = options.maxTurnFailures ?? DEFAULT_TURN_FAILURE_CAPACITY
    this.worker = options.worker
    this.workerSlots = options.worker?.slots ?? createCollabWorkerSlotLedger()
    this.onWorkerFailure = options.onWorkerFailure
    this.schedulerLog = options.schedulerLog
    this.onActivity = options.onActivity
    // 别人放开一个槽位,轮到我排队的那张卡走了 —— 不订这一条,全局闸会把跨
    // agent 的队列饿死(见 `CollabWorkerSlotLedger.onRelease`)。
    this.unsubscribeSlots = options.worker
      ? this.workerSlots.onRelease(() => {
        void this.pumpWorkerQueue().catch((error: unknown) => {
          this.recordWorkerFailure('', error)
        })
      })
      : undefined
    this.state = this.accountStore.load(options.agentId)
  }

  /** 当前的账。只读快照。 */
  get account(): CollabAgentAccount {
    return this.state
  }

  /** 此刻在跑的那一轮(没有就是 null)。观测用。 */
  get inFlightRoomId(): string | null {
    return this.turn?.roomId ?? null
  }

  /**
   * 此刻在跑的那一轮 + 它起跑的时刻(D8 §3.1 的 `mind`)。
   *
   * 与 `inFlightRoomId` 是同一份真相的两个投影,留着后者是因为它已经有调用点。
   * 「一个大脑」这条宪法在这里是可观测的:`this.turn` 至多一个,所以这个 getter
   * 永远至多指向一间房。
   */
  get inFlightTurn(): { roomId: string; startedAt: number } | null {
    return this.turn ? { roomId: this.turn.roomId, startedAt: this.turn.startedAt } : null
  }

  get turnFailures(): readonly CollabAgentTurnFailure[] {
    return [...this.failures]
  }

  /** 等在飞的那一轮跑完。**「一个大脑」这条不变式的实现就在这里**。 */
  async settle(): Promise<void> {
    while (this.turn) await this.turn.done
  }

  /** 积压清空 **且** 在飞回合跑完。回合不在 mailbox 的账上,所以要多这一步。 */
  override async drain(): Promise<void> {
    for (;;) {
      await super.drain()
      if (!this.turn) return
      await this.settle()
      // 回合收尾会往房间投信,房间可能立刻回一批 —— 再走一圈。
      if (this.mailbox.pendingCount() === 0 && !this.turn) return
    }
  }

  /**
   * 停循环,并等在飞的那一轮跑完(优雅停机没必要制造半个回合)。
   *
   * **不等在外的手**:一个 30 分钟墙钟的工作不该把退出卡住。它们在账上仍是
   * `running`,下一条命的 `recoverWorkers` 认领 —— 崩溃与优雅停机在这一面走
   * 同一条路,于是那条路每次启动都在被走(而不是只在事故里被走)。
   */
  override async stop(): Promise<void> {
    this.unsubscribeSlots?.()
    await super.stop()
    await this.settle()
  }

  /**
   * 一封信 —— 外加一次「积压变了」的通知。
   *
   * 通知排在 `finally` 里而不是成功路径上:一封炸掉的信同样把它从积压里划走了
   * (ActorBase 记 dead-letter 之后照常 ack 整批),而快照里那个深度必须跟着走。
   * 只在成功时通知,一条坏信会让界面上的积压永远比真值多一。
   */
  protected async handleEvent(event: ActorEvent<CollabActorVerb>): Promise<void> {
    try {
      await this.dispatch(event.payload, event.at)
    } finally {
      this.noteActivity('inbox')
    }
  }

  private dispatch(verb: CollabActorVerb, eventAt: number): Promise<void> {
    switch (verb.type) {
      case 'room:posted':
        return this.onPosted(verb, eventAt)
      case 'room:floor-granted':
        return this.onFloorGranted(verb)
      case 'room:floor-revoked':
        return this.onFloorRevoked(verb)
      case 'room:phase-changed':
        return this.onPhaseChanged(verb, eventAt)
      case 'room:membership-changed':
        return this.onMembershipChanged(verb, eventAt)
      case 'room:card-event':
        return this.onCardEvent(verb, eventAt)
      case 'agent:spawn-worker':
        return this.onSpawnWorker(verb)
      case 'agent:worker-result':
        return this.onWorkerResult(verb, eventAt)
      case 'agent:note':
        return this.onNote(verb, eventAt)
      // 寻址错了的信原样吞掉,**不记 dead-letter**:这几个动词是 agent → room /
      // referee → room 的,投到一个 agent 的信箱里只可能是宿主接错了线或一次
      // 回流。让它污染 dead-letter,「它没回应」与「它试过但炸了」就分不开了。
      case 'agent:raise-hand':
      case 'agent:speak':
      case 'agent:yield':
      case 'agent:dm-open':
      case 'agent:wake':
      case 'referee:set-floor-policy':
        return Promise.resolve()
      default:
        return assertNeverAgentVerb(verb)
    }
  }

  /* ── room:posted ──────────────────────────────────────────────────────── */

  /**
   * 一条房间消息。
   *
   * 四件事,按序:推投递水位 → (在飞同房)注入 → 折叠素材 → 举手评估。
   *
   * 注入排在折叠之前,是因为它是**同一条消息的两种去处**:并进当前这一轮的,
   * 就不该再折进下一轮的信封 —— 那会让模型在下一轮读到一条「有人找过你」,
   * 而那句话它上一轮已经逐字读过了。
   */
  private async onPosted(verb: CollabRoomPostedVerb, eventAt: number): Promise<void> {
    const message = verb.message
    const at = message.timestamp ?? eventAt
    const speakerId = collabPostedSpeakerId(verb)

    this.save(advanceCollabAgentDelivered(this.state, verb.roomId, message.id, at))

    // 自己说的话不必回声给自己:它在自己的经历流里,而且它不是「有人找我」。
    if (speakerId === this.agentId) return

    const turn = this.turn
    if (turn && turn.roomId === verb.roomId && !turn.revoked) {
      const accepted = this.mindPort.steer
        ? await this.mindPort.steer({
            agentId: this.agentId,
            roomSessionId: verb.roomId,
            execSessionId: turn.execSessionId,
            body: this.host.formatSteerBody?.(message) ?? message.content,
          })
        : false
      // 并进去了 = 这一轮已经读到它了,到此为止:再折进下一轮的信封,模型会
      // 在下一轮读到一条「有人找过你」,而那句话它上一轮已经逐字读过了。
      if (accepted) return
      // 迟到:推迟到交牌之后再评估(见 `InFlightTurn.missed`)。不折叠 —— 它是
      // 本房的消息,已读水位没越过它,下一轮的房间投影里它照样是未读。
      turn.missed.push({ verb, message })
      return
    }

    if (isCollabRoomFact(message)) {
      this.fold({
        kind: 'got',
        at,
        roomId: verb.roomId,
        key: foldKey('got', verb.roomId, message.id ?? `${at}:${speakerId ?? 'user'}:${message.content.length}`),
        ...(speakerId ? { fromAgentId: speakerId } : {}),
        count: 1,
      })
    }

    await this.evaluateHand(verb, message)
  }

  /**
   * 举手评估。
   *
   * **本地不去重**:同一间房重复举手由房间的 `enqueueCollabHand` 结构性地并成
   * 一只手。在这里再判一次「我是不是已经举过了」等于给同一条规则开第二个属主,
   * 而那两份判断只要有一次不同步,症状就是「它明明被 @ 了却一声不吭」——
   * 这套系统里最难查的一类症状。手里已经有牌则跳过:那是**另一件事**(它已经
   * 站在台上了),而且这一条房间那侧也判,两处一致。
   */
  private async evaluateHand(verb: CollabRoomPostedVerb, message: CollabMessageLike): Promise<void> {
    if (collabAgentLeaseOf(this.state, verb.roomId)) return

    const verdict = await this.handEvaluator.evaluate({
      agentId: this.agentId,
      roomId: verb.roomId,
      message,
      author: verb.author,
      members: this.host.members(verb.roomId),
      ...(this.host.dm?.(verb.roomId) ? { dm: true } : {}),
    })
    if (!verdict.raise) return

    this.save(raiseCollabAgentHand(this.state, verb.roomId))
    await this.post(verb.roomId, collabAgentRaiseHand({
      roomId: verb.roomId,
      agentId: this.agentId,
      ...(verdict.why ? { why: verdict.why } : {}),
      ...(verdict.urgency ? { urgency: verdict.urgency } : {}),
      ...(message.id ? { sourceMessageId: message.id } : {}),
    }))
  }

  /* ── 发牌 / 收牌 ──────────────────────────────────────────────────────── */

  private async onFloorGranted(verb: CollabRoomFloorGrantedVerb): Promise<void> {
    if (verb.agentId !== this.agentId) return
    const lease = verb.lease

    // 「一个大脑」的落点:上一轮没跑完,这一轮在这里排队。
    await this.settle()

    this.save(recordCollabAgentLease(this.state, {
      roomId: verb.roomId,
      leaseId: lease.leaseId,
      epoch: lease.epoch,
      issuedAt: lease.issuedAt,
    }))
    // 「持牌等大脑」这一帧的产生点(D8 §1):牌到手了,而这一轮还没起跑 ——
    // 那正是 v2 词汇表里根本没有的第三种状态,不播出去就永远看不见。
    this.noteActivity('lease')

    const execSessionId = this.host.execSessionId(this.agentId, verb.roomId)
    if (!execSessionId) {
      // 会话都建不出来:立刻交牌。一张发出去却没人接的牌会把座位永久占住,
      // 而并发上限是按在外的牌数算的。
      await this.releaseLease(verb.roomId, lease.leaseId, 'nothing-to-add')
      return
    }

    const now = this.host.now()
    const driveContent = this.buildDrive(verb.roomId, execSessionId, now)
    // 已读水位的候选值在 drive **之前**取:投影是这一刻的,而回合跑完时房间早就
    // 前进了。取得早一点 = 这几毫秒里到达的消息算未读 —— 多读一遍是安全方向,
    // 反过来(水位越过一条模型没看见的消息)就是永久丢消息。
    const through = this.host.projectedThrough?.(verb.roomId)
      ?? this.deliveredWatermark(verb.roomId)

    const turn: InFlightTurn = {
      roomId: verb.roomId,
      leaseId: lease.leaseId,
      execSessionId,
      startedAt: now,
      revoked: false,
      missed: [],
      done: Promise.resolve(),
    }
    this.turn = turn
    // 大脑亮了。排在 `runTurn` **之前**:那一行不 await,而观测要的是"这一刻它
    // 开始想了",不是"这一轮跑完之后回头看它想过"。
    this.noteActivity('mind')
    // **起了就放手**:循环继续收信,steer 因此还有机会并进这一轮(见文件头)。
    turn.done = this.runTurn(turn, lease, driveContent, through, now)
  }

  private async runTurn(
    turn: InFlightTurn,
    lease: FloorLease,
    driveContent: string,
    through: { messageId?: string; at?: number } | undefined,
    startedAt: number,
  ): Promise<void> {
    try {
      const result = await this.mindPort.runConversationalTurn({
        agentId: this.agentId,
        roomSessionId: turn.roomId,
        execSessionId: turn.execSessionId,
        lease,
        driveContent,
      })
      await this.settleTurn(turn, result, through, startedAt)
    } catch (error) {
      this.recordTurnFailure(turn, error)
    } finally {
      if (this.turn === turn) {
        this.turn = null
        // 大脑灭了。在 `finally` 里 —— 一轮跑砸了的回合同样要把灯关掉,否则界面上
        // 那个人会永远停在"正在思考"。
        this.noteActivity('mind')
      }
    }
  }

  /**
   * 一轮的收尾:说出去的话 → 推已读水位 → 记回合 → 交牌。
   *
   * 说的话走 `agent:speak` 回房间,是**协议面**的形态(§2「speak 的工具面形态
   * 就是 send_message」)。D6 接线之后 say 工具自己会发这个动词,端口返回的
   * `says` 退回它的第二个用途:对账与「写而未发」的收养兜底。
   */
  private async settleTurn(
    turn: InFlightTurn,
    result: CollabMindTurnResult,
    through: { messageId?: string; at?: number } | undefined,
    startedAt: number,
  ): Promise<void> {
    for (const say of result.says) {
      // 牌在中途被收了就不再开口:房间那侧也会拒(验票在 `applyCollabRoomSpeak`
      // 的第一行),这里先停是为了不让一条注定被拒的话跑一趟 IO。
      if (turn.revoked) break
      if (!say.content.trim()) continue
      /**
       * **已经在房间里的那些不再发一遍**(D6 接线)。
       *
       * `messageId` 是「这句话已经落库」的凭据(见 `CollabMindSay` 的定义):
       * 生产适配器收割的是房间转录里真实存在的消息 —— 那是 `send_message` 自己
       * 经租约发进去的,再发一次就是同一句话进群两遍。剧本化的假端口不给这一格,
       * 于是 D2 的回合语义(端口返回什么就说什么)一字不动。
       */
      if (say.messageId) continue
      await this.post(turn.roomId, collabAgentSpeak({
        roomId: turn.roomId,
        agentId: this.agentId,
        leaseId: turn.leaseId,
        content: say.content,
        ...(say.mentions?.length ? { mentions: say.mentions } : {}),
      }))
    }

    // 水位只在回合**真的跑完**之后前进:一个 abort/超时的回合可能一个字都没读到,
    // 虚假前进的水位会把那批消息永久变成「已读」。
    if (result.outcome === 'complete' && through?.messageId) {
      const at = through.at ?? startedAt
      this.save(advanceCollabAgentRead(this.state, turn.roomId, through.messageId, at))
      this.host.persistSeen?.({
        agentId: this.agentId,
        roomId: turn.roomId,
        execSessionId: turn.execSessionId,
        messageId: through.messageId,
        at,
      })
    }

    this.save(recordCollabAgentTurn(this.state, turn.roomId, this.host.now()))
    if (!turn.revoked) {
      await this.releaseLease(turn.roomId, turn.leaseId, result.says.length ? 'done' : 'nothing-to-add')
    } else {
      this.save(dropCollabAgentLease(this.state, turn.leaseId))
      this.noteActivity('lease')
    }

    // 牌交完了,再回头处理注入迟到的那几条。次序不能反 —— 举手要在「我手里
    // 没有牌」的那一刻发出去,否则房间会把它当成空操作吃掉。
    for (const missed of turn.missed) {
      await this.evaluateHand(missed.verb, missed.message)
    }
  }

  private async releaseLease(
    roomId: string,
    leaseId: string,
    reason: 'done' | 'nothing-to-add',
  ): Promise<void> {
    // 账先落:交牌的信可能投不出去(房间没了),而「我不再持有这张牌」是本地事实。
    this.save(dropCollabAgentLease(this.state, leaseId))
    this.noteActivity('lease')
    await this.post(roomId, collabAgentYield({ roomId, agentId: this.agentId, leaseId, reason }))
  }

  private onFloorRevoked(verb: CollabRoomFloorRevokedVerb): Promise<void> {
    if (verb.agentId !== this.agentId) return Promise.resolve()
    if (this.turn?.leaseId === verb.leaseId) this.turn.revoked = true
    this.save(clearCollabAgentHand(dropCollabAgentLease(this.state, verb.leaseId), verb.roomId))
    this.noteActivity('lease')
    return Promise.resolve()
  }

  /* ── 折叠素材 ─────────────────────────────────────────────────────────── */

  private onPhaseChanged(verb: CollabRoomPhaseChangedVerb, at: number): Promise<void> {
    this.fold({
      kind: 'phase',
      at,
      roomId: verb.roomId,
      key: foldKey('phase', verb.roomId, `${verb.epoch}:${verb.phase}`),
      phase: verb.phase,
    })
    return Promise.resolve()
  }

  private onMembershipChanged(verb: CollabRoomMembershipChangedVerb, at: number): Promise<void> {
    if (verb.joined.length === 0 && verb.left.length === 0) return Promise.resolve()
    this.fold({
      kind: 'members',
      at,
      roomId: verb.roomId,
      key: foldKey('members', verb.roomId, `${at}:${verb.joined.join(',')}:${verb.left.join(',')}`),
      joined: verb.joined.length,
      left: verb.left.length,
    })
    return Promise.resolve()
  }

  private onCardEvent(verb: CollabRoomCardEventVerb, at: number): Promise<void> {
    this.fold({
      kind: 'card',
      at,
      roomId: verb.roomId,
      key: foldKey('card', verb.roomId, `${verb.cardId}:${verb.event}`),
      cardId: verb.cardId,
      event: verb.event,
    })
    return Promise.resolve()
  }

  /* ── 重活委托(D4 §1.6) ──────────────────────────────────────────────── */

  /**
   * 派活。
   *
   * 触发源是**对话回合里的 board start**(D6 接线):群里被指派只是通知,开工
   * 由被指派的人自己说了算 —— 「assign = 通知 ≠ 开工」这条已拍板决策在 v3 一字
   * 不改(§8)。这个方法只管「已经决定要开工了,现在派一只手」。
   *
   * 两道去重都在这里,而且都是**结构性**的:同一张卡已经有手在做、或已经排在
   * 队里,再来一封 spawn 是空操作。判据是卡不是 workerId —— 一次重投与「群里
   * 又催了一次」在这一层是同一件事,而两只手做同一张卡会互相覆盖对方的写入。
   */
  private async onSpawnWorker(verb: CollabAgentSpawnWorkerVerb): Promise<void> {
    if (verb.agentId !== this.agentId) return
    if (!this.worker) {
      // 抛出去 = 这封信进 dead-letter。静静吞掉的话,症状是「那张卡永远停在
      // todo」,而排障要从看板一路查到接线,才发现根本没人配过工作端口。
      throw new Error(`[collab-agent] ${this.agentId} 未配工作端口,收到 spawn-worker(card=${verb.cardId})`)
    }
    if (collabWorkerRunningForCard(this.state.workers, verb.cardId)) return
    if (this.workerQueue.some(entry => entry.cardId === verb.cardId)) return
    this.workerQueue.push(verb)
    await this.pumpWorkerQueue()
  }

  /**
   * 队列泵:能派几只派几只。
   *
   * 两个触发点(手收工时、回投落账时)都调它,而且它是幂等的 —— 每一次都重新
   * 问一遍闸。**不能只在收工时泵**:per-agent 的在跑数读的是账里的子清单,而
   * 子清单是在回投那封信被处理时才收尾的,比手收工晚一步。
   */
  private async pumpWorkerQueue(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    while (this.workerQueue.length > 0) {
      const admission = admitCollabWorkerSpawn({
        agentRunning: collabWorkerRunning(this.state.workers).length,
        slots: this.workerSlots,
        ...(worker.limits ? { limits: worker.limits } : {}),
      })
      if (!admission.admitted) return
      const verb = this.workerQueue.shift()
      if (!verb) return
      await this.startWorker(verb)
    }
  }

  private async startWorker(verb: CollabAgentSpawnWorkerVerb): Promise<void> {
    const worker = this.worker
    if (!worker) return
    const at = this.host.now()

    // 账先落(§3 三面纪律)。崩在这一行与派生之间,重启对账认得出这个孤儿 ——
    // 反过来(先派生后落账)崩掉的那只手在账上从来没存在过,永远查不出来。
    this.save(startCollabAgentWorker(this.state, createCollabWorkerRecord({
      workerId: verb.workerId,
      cardId: verb.cardId,
      roomId: verb.roomId,
      startedAt: at,
      ...(verb.workSessionId ? { workSessionId: verb.workSessionId } : {}),
    })))
    // 派手记账 —— 排在落账之后、派生之前:时间轴不该跑在真账前面(D8 §3.3)。
    this.recordSchedulerRow(verb.roomId, collabSchedulerWorkerSpawn({
      at,
      agentId: this.agentId,
      workerId: verb.workerId,
      cardId: verb.cardId,
      triggeredBy: verb.cardId,
    }))
    // 「干活中」那盏🔵灯的产生点。与记账同一处、同一时刻:两者读的是刚落下去的
    // 那一份子清单,不会各说各的。
    this.noteActivity('worker')
    this.workerSlots.acquire()

    const child = new CollabWorkerChildActor({
      agentId: this.agentId,
      workerId: verb.workerId,
      port: worker.port,
      ...(worker.board ? { board: worker.board } : {}),
      postResult: result => worker.postResult(result),
      ...(worker.timeouts ? { limits: worker.timeouts } : {}),
      ...(worker.summaryMaxChars === undefined ? {} : { summaryMaxChars: worker.summaryMaxChars }),
      now: () => this.host.now(),
    })
    this.children.set(verb.workerId, child)
    await child.begin(verb, `worker:${verb.workerId}:card:${verb.cardId}`)
    // **不 await 收工** —— 并行豁免的落点(见 `worker-child.ts` 文件头)。心智
    // 循环立刻回去收信,这只手在外面自己跑。
    void this.superviseWorker(verb.workerId, child)
  }

  /** 监护任务:等这只手收工,放槽位,再泵一次队列。**不在心智循环里跑**。 */
  private async superviseWorker(workerId: string, child: CollabWorkerChildActor): Promise<void> {
    let cardId = ''
    try {
      cardId = (await child.settled).cardId
    } catch (error) {
      this.recordWorkerFailure(workerId, error)
    }
    this.workerSlots.release()
    this.children.delete(workerId)
    try {
      await child.stop()
      await this.pumpWorkerQueue()
    } catch (error) {
      this.recordWorkerFailure(workerId, error, cardId)
    }
  }

  /**
   * 回投落地:记账 → 收尾子清单 → 进折叠素材 → 泵队列。
   *
   * 折叠素材那一行就是**「父不需要主动查」**的兑现:下一个对话回合的信封里自然
   * 有一条「你那张卡完了/没完」,而正文一个字都没有(卡的标题本身就是正文 ——
   * 见 `worker-rules.ts` 的 `buildCollabWorkerFoldEntry`)。
   */
  private async onWorkerResult(verb: CollabAgentWorkerResultVerb, at: number): Promise<void> {
    if (verb.agentId !== this.agentId) return
    let next = recordCollabAgentWorkerResult(this.state)
    next = settleCollabAgentWorker(next, {
      workerId: verb.workerId,
      outcome: verb.outcome,
      at,
      ...(verb.workSessionId ? { workSessionId: verb.workSessionId } : {}),
    })
    this.save(next)
    this.fold(buildCollabWorkerFoldEntry({
      workerId: verb.workerId,
      cardId: verb.cardId,
      outcome: verb.outcome,
      at,
    }))
    // 交活记账。**只带终局枚举,不带 summary** —— 那句话是模型写的正文,归工作会话
    // 与看板的报告字段,不进这本谁都能 `cat` 的诊断账(保密纪律,蓝图 §7)。
    this.recordSchedulerRow(verb.roomId, collabSchedulerWorkerResult({
      at,
      agentId: this.agentId,
      workerId: verb.workerId,
      cardId: verb.cardId,
      outcome: verb.outcome,
      triggeredBy: verb.workerId,
    }))
    this.noteActivity('worker')
    await this.pumpWorkerQueue()
  }

  /**
   * 往调度时间轴记一行。**工作卡两类行在这个 actor 里的唯一出口**。
   *
   * 按 `roomId` 归档:时间轴是按房落盘的(一间房的调度史读一个文件就够),而一只手
   * 永远属于某一间房的某张卡。全程吞错 —— 观测不能变成第二个故障源。
   */
  private recordSchedulerRow(roomId: string, row: CollabSchedulerLogRow): void {
    if (!this.schedulerLog) return
    try {
      this.schedulerLog.append(roomId, row)
    } catch (error) {
      log.warn('scheduler row append failed', { agentId: this.agentId, roomId }, error)
    }
  }

  /**
   * 重启对账(§3「各 actor 独立自愈」)。
   *
   * 账里还挂着 `running` 的记录,只可能是上一条命没来得及给它收尾 —— 流从不
   * 恢复,只重驱。两档处置:
   *
   *  - `interrupt`(**缺省**)—— 标断,把卡推回「没人在做」,并往折叠缓冲里放
   *    一条素材:父在下一个对话回合自然知道这张卡断在半路。为什么这是缺省:
   *    续做是一个**决定**(人 / 负责人 / 下一次回合里的 agent 用 board start
   *    作出),v2 在真机上已经把它写死过一次 —— 自动重驱会在「机器重启」这种
   *    与卡本身无关的原因上,把一张跑了 25 分钟的卡从头再跑一遍。
   *  - `respawn` —— 带着原来的工作会话重派(现场就在那条会话里)。给自治度高
   *    的房间留的档,由宿主显式选。
   */
  async recoverWorkers(options: { policy?: CollabAgentOrphanPolicy } = {}): Promise<CollabAgentWorkerRecovery> {
    const at = this.host.now()
    const adoption = adoptCollabAgentWorkerOrphans(this.state, at)
    this.save(adoption.account)
    // 上一条命留下的那几只手全部标断了 —— 冷启动的第一份快照该看见这件事。
    if (adoption.orphans.length > 0) this.noteActivity('worker')

    const policy = options.policy ?? this.worker?.orphanPolicy ?? 'interrupt'
    const respawned: string[] = []

    for (const orphan of adoption.orphans) {
      if (policy === 'respawn' && this.worker) {
        const workerId = this.worker.newWorkerId?.({
          cardId: orphan.cardId,
          previousWorkerId: orphan.workerId,
        }) ?? `${orphan.workerId}~resume`
        this.workerQueue.push(collabAgentSpawnWorker({
          agentId: this.agentId,
          workerId,
          cardId: orphan.cardId,
          roomId: orphan.roomId,
          ...(orphan.workSessionId ? { workSessionId: orphan.workSessionId } : {}),
        }))
        respawned.push(workerId)
        continue
      }
      // 折叠素材只在 interrupt 那一档放:重派的话这张卡还在手上,「断了」是一句
      // 会被下一条结果立刻推翻的话。
      this.fold(buildCollabWorkerFoldEntry({
        workerId: orphan.workerId,
        cardId: orphan.cardId,
        outcome: 'interrupted',
        at,
      }))
      try {
        await this.worker?.board?.interrupted({
          roomId: orphan.roomId,
          cardId: orphan.cardId,
          agentId: this.agentId,
          ...(orphan.workSessionId ? { workSessionId: orphan.workSessionId } : {}),
          at,
        })
      } catch (error) {
        this.recordWorkerFailure(orphan.workerId, error, orphan.cardId)
      }
    }

    if (respawned.length > 0) await this.pumpWorkerQueue()
    return { orphans: adoption.orphans, policy, respawned }
  }

  /** 在外的手(观测用)。 */
  get runningWorkerIds(): string[] {
    return [...this.children.keys()]
  }

  get queuedWorkerCards(): string[] {
    return this.workerQueue.map(verb => verb.cardId)
  }

  get workerFailureLog(): readonly CollabAgentWorkerFailure[] {
    return [...this.workerFailures]
  }

  /**
   * 等在外的手全部收工。
   *
   * **`stop()` 刻意不调它**:一个 30 分钟墙钟的工作不该把退出卡住,而账里的
   * `running` 记录会在下次启动被 `recoverWorkers` 认领 —— 崩溃与优雅停机在这一
   * 面走同一条路,于是那条路每次启动都在被走。
   */
  async settleWorkers(): Promise<void> {
    while (this.children.size > 0) {
      await Promise.all([...this.children.values()].map(child => child.settled))
      // 监护任务把 children 摘干净要一个微任务;摘完之后可能又泵起了下一只手。
      await Promise.resolve()
    }
  }

  private recordWorkerFailure(workerId: string, error: unknown, cardId = ''): void {
    const failure: CollabAgentWorkerFailure = {
      cardId,
      workerId,
      error: error instanceof Error ? error : new Error(String(error)),
      at: this.host.now(),
    }
    this.workerFailures.push(failure)
    while (this.workerFailures.length > this.maxTurnFailures) this.workerFailures.shift()
    try {
      this.onWorkerFailure?.(failure)
    } catch {
      // 观测钩子自己炸了不能反过来影响循环(与 ActorBase 的 dead-letter 同一条)。
    }
  }

  /** 写笔记。转义在落盘那一侧(见 `notebook-store.ts` 文件头)。 */
  private onNote(verb: CollabAgentNoteVerb, at: number): Promise<void> {
    if (verb.agentId !== this.agentId) return Promise.resolve()
    const note = verb.note.trim()
    if (!note) return Promise.resolve()
    const roomLabel = verb.roomId ? this.host.roomLabel?.(verb.roomId) : undefined
    this.notebook.append({
      agentId: this.agentId,
      note,
      at,
      ...(roomLabel ? { roomLabel } : {}),
    })
    return Promise.resolve()
  }

  /* ── drive 组装 ───────────────────────────────────────────────────────── */

  /**
   * 一条 drive = 当前房增量投影 + mailbox 折叠信封 + 笔记尾窗。
   *
   * 折叠缓冲在这里**取走**(取走即清):一个事件只在它真的发生的那一刻被写进一条
   * drive。渲染时当前房被滤掉 —— 它的消息在房间投影里逐字都有。
   */
  private buildDrive(roomId: string, execSessionId: string, now: number): string {
    const room = collabAgentRoomAccount(this.state, roomId)
    const roomContext = this.host.buildRoomContext({
      agentId: this.agentId,
      roomId,
      execSessionId,
      ...(room.readMessageId ? { seenMessageId: room.readMessageId } : {}),
      bootstrap: room.turns === 0,
      now,
    })

    const take = takeCollabAgentFold(this.state, now)
    this.save(take.account)
    const envelope = buildCollabFoldedEnvelope({
      entries: take.entries,
      currentRoomId: roomId,
      droppedBefore: take.dropped,
      ...(take.since === undefined ? {} : { since: take.since }),
      ...(this.host.roomLabel ? { resolveRoomLabel: id => this.host.roomLabel?.(id) } : {}),
      ...(this.host.speakerLabel ? { resolveSpeakerLabel: id => this.host.speakerLabel?.(id) } : {}),
      ...this.foldLimits,
    })

    const notebook = buildCollabAgentNotebookBlock(this.notebook, this.agentId, this.notebookBudget)

    return buildCollabMindDrive({
      roomContext,
      envelope,
      notebook,
      // 三块全空(比如任务事件把它叫起来,而房里一条未读都没有)。空 drive 就是
      // 一条空的 user 消息;`count="0"` 至少是一条真数据。
      fallback: formatCollabNotificationBlock({ lines: [], emitWhenEmpty: true }),
    })
  }

  /* ── 小工具 ───────────────────────────────────────────────────────────── */

  private deliveredWatermark(roomId: string): { messageId?: string; at?: number } | undefined {
    const room = collabAgentRoomAccount(this.state, roomId)
    if (!room.deliveredMessageId) return undefined
    return {
      messageId: room.deliveredMessageId,
      ...(room.deliveredAt === undefined ? {} : { at: room.deliveredAt }),
    }
  }

  /** 落账。**同步原子写**,而且只在账真的变了的时候写(转换是不可变的)。 */
  private save(next: CollabAgentAccount): void {
    if (next === this.state) return
    this.state = next
    this.accountStore.save(next)
  }

  private fold(entry: CollabFoldEntry): void {
    this.save(pushCollabAgentFold(this.state, entry, this.foldBuffer))
  }

  /**
   * 活动转变的**唯一**通知出口(D8 §3.1)。
   *
   * 与 `recordSchedulerRow` 同一条纪律:全程吞错 —— 观测不能变成第二个故障源。
   * 节流不在这里:这个 actor 无脑每次都喊,攒不攒由宿主那侧的 per-agent 槽决定。
   */
  private noteActivity(transition: CollabAgentActivityTransition): void {
    try {
      this.onActivity?.(transition)
    } catch {
      // 观测钩子自己炸了不能反过来影响循环(与 ActorBase 的 dead-letter 同一条)。
    }
  }

  private async post(roomId: string, verb: CollabActorVerb): Promise<void> {
    const outbox = this.host.roomOutbox(roomId)
    // 没有投递口 = 这间房此刻不在(还没起 actor、或已经关了)。不算失败:
    // 下一次这间房醒过来会重新广播,而一封投不出去的信不该杀掉这条循环。
    if (!outbox) return
    await outbox.post(verb)
  }

  private recordTurnFailure(turn: InFlightTurn, error: unknown): void {
    const failure: CollabAgentTurnFailure = {
      roomId: turn.roomId,
      leaseId: turn.leaseId,
      error: error instanceof Error ? error : new Error(String(error)),
      at: this.host.now(),
    }
    this.failures.push(failure)
    while (this.failures.length > this.maxTurnFailures) this.failures.shift()
    try {
      this.onTurnFailure?.(failure)
    } catch {
      // 观测钩子自己炸了不能反过来影响循环(与 ActorBase 的 dead-letter 同一条)。
    }
  }
}

function assertNeverAgentVerb(verb: never): never {
  throw new Error(`[collab-agent] unhandled verb: ${JSON.stringify(verb)}`)
}

/**
 * 折叠素材的幂等键。
 *
 * 判据是**事件的身份**而不是它的内容:同一个人在同一分钟说两句话是两件事,而
 * 同一封信重投两次是一件事。房间消息用它自己的 id;没有 id 的老形状退回一个
 * 指纹 —— 少一点精度,总好过把去重整个关掉。
 */
function foldKey(kind: string, scope: string, suffix: string): string {
  return `${kind}:${scope}:${suffix}`
}
