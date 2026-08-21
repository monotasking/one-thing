/**
 * RoomActor(docs/design/collab-actor-v3.md §1.4)。
 *
 * 房间在 v3 里只是**消息通道 + 发言权仲裁者**:它不再知道谁该被"激活",不再持有
 * 队列泵、意愿判定、编排推进这些控制流 —— 那些在 v2 是 coordinator/queue/turn/
 * worker 四个文件里的 8k 行,在 v3 是几个动词。
 *
 * 这个文件是**装配**,不是规则。规则(账、三道闸、发牌、链账)全在纯层的
 * `collab/actors/room-rules.ts` 里,而且是同步纯函数 —— 这一条不是洁癖:
 *
 *   **金重放与真机必须走同一行代码。** v3 是直接替换、不留双轨(§7 风险 1),
 *   「新运行时行为对不对」只能靠旧房的真实剧本来验。重放架的接缝是同步的
 *   (`onPosted` 直接返回动词),actor 的循环是异步的;把决策抽成纯函数之后,
 *   两边调的是同一个 `applyCollabRoom*`,快照才有资格当行为对照。这个类里剩下的
 *   只有三件带副作用的事:**落账、写转录、投 mailbox**。
 *
 * 次序是契约(§3 三面纪律):
 *
 *   决策 → **落账**(同步原子写)→ 写转录(追加)→ 广播(逐个成员)
 *
 * 账在最前面,因为它是崩溃之后唯一能重建现场的东西;广播在最后面,因为它是
 * at-least-once 的 —— 崩在中途重启后续播,而账里那条在飞广播记录就是"续到哪儿"
 * 的答案。
 *
 * **本期不接引擎、不接宿主**(接线在 D6):所有外部依赖都从 `CollabRoomActorHost`
 * 进来。v2 的调度链仍然是生产,这里一行都没动它。
 */
import {
  ActorBase,
  createActorEvent,
  type ActorBaseOptions,
  type ActorEvent,
  type ActorMailboxSource,
} from '@onething/core/actors'
import { COLLAB_DEFAULT_DAILY_COST_USD, type CollabAddressable, type CollabAgentLike } from '../index.js'
import {
  applyCollabRoomPassthrough,
  applyCollabRoomPhaseChange,
  applyCollabRoomPosted,
  applyCollabRoomRaiseHand,
  applyCollabRoomSetPolicy,
  applyCollabRoomSpeak,
  applyCollabRoomYield,
  bumpCollabRoomEpoch,
  collabActorRef,
  collabRefereeSetFloorPolicy,
  collabRoomActiveLeases,
  collabRoomEventId,
  collabRoomHolders,
  deriveCollabSchedulerLogRows,
  isSameCollabRoomFloorPolicy,
  openCollabRoomBroadcast,
  pruneCollabRoomFloor,
  resolveCollabRoomHandBlock,
  revokeCollabRoomLease,
  settleCollabRoomBroadcast,
  type CollabActorVerb,
  type CollabFloorRevokeReason,
  type CollabResolvedFloorPolicy,
  type CollabRoomAccount,
  type CollabRoomEffects,
  type CollabRoomGates,
  type CollabRoomIdSource,
  type CollabRoomJudgmentRequest,
  type CollabRoomPendingBroadcast,
  type CollabRoomTranscriptMessage,
  type CollabSchedulerBlockLatch,
  type CollabSchedulerLogSink,
} from './index.js'
import type { CollabCoordinatorJudgment, CollabCoordinatorState } from '@shared/ipc.js'

import { createCollabRoomAccountFileStore, type CollabRoomAccountStore } from './room-account.js'
import { collabV3TurnsInRoom } from './turn-context.wiring.js'
import { getLogger } from '../../logging/index.js'

const log = getLogger('collab.actors.room')


/** 一个成员的信箱。真身是 `DurableMailbox`,测试与重放用内存版。 */
export interface CollabRoomMemberMailbox {
  append(event: ActorEvent<CollabActorVerb>): Promise<void>
}

/**
 * 房间要问外面的每一件事。
 *
 * 全部是**读口**,而且全部同步 —— 决策必须是同步的(见文件头),所以任何需要
 * 磁盘往返的读数(预算账本)由宿主自己缓存好再喂进来,这与 v2 协调器状态条读
 * `budgetSpentUSD` 那个 60s 缓存是同一套做法,不是新发明。
 */
export interface CollabRoomActorHost {
  /** 在职成员(授权面)。退休成员不在里面 —— 不被提名、不被 @ 到、不发牌。 */
  members(roomId: string): readonly CollabAgentLike[]
  /** 识别面:哪串字符算一个真身份(用户、退休成员)。缺省退回 `members`。 */
  directory?(roomId: string): readonly CollabAddressable[]
  /** 总闸。 */
  frozen(roomId: string): boolean
  /** 费用闸(宿主自己缓存,见上)。 */
  overBudget(roomId: string): boolean
  maxChain(roomId: string): number
  maxConcurrent(roomId: string): number
  /** agent ⇄ agent 的双成员私聊房?—— 冻结/链闸文案的分支。 */
  pairDm?(roomId: string): boolean
  /** 预算行要的两个数;拿不到就退化成不带数字的那句。 */
  budget?(roomId: string): { spentUSD: number; limitUSD: number } | undefined
  /** 牌的墙钟上限(ms)。缺省不设 —— 牌只被让位/撤销/换代作废。 */
  leaseTtlMs?(roomId: string): number | undefined
  /**
   * 这间房挂了裁判吗(D3)。挂了 → `free` 的举手先进裁决窗,等一次批量裁决。
   *
   * 缺省(不实现)= 没挂 —— 普通群不需要显式裁判,房间用内置的举手 FIFO(§1.5)。
   */
  referee?(roomId: string): boolean
  /**
   * 房间**设置**此刻要求哪一档发言策略(D6 接线,`resolveCollabRoomFloorPolicy`)。
   *
   * 与上面那一族闸的区别是它**不是**每次决策现读的:发言策略住在房账里(`ring`
   * 的环位、`waves` 的批位是账的一部分),现读会让每一次决策都可能悄悄换档,而
   * 换档要清游标 —— 那等于让环永远走不完第二步。所以它只在两个时刻被问:装配
   * (`syncFloorPolicy()`)与用户改完设置。不实现 = 这间房的策略只由裁判说了算。
   */
  floorPolicy?(roomId: string): CollabResolvedFloorPolicy | undefined
  /**
   * 房间开了一扇裁决窗 —— 拿去买那一次模型调用(`CollabRefereeActor.adjudicate`)。
   *
   * **通知,不是调用**:房间的决策必须同步,而裁决是一次网络往返。房间把窗记进账、
   * 把手挂起,然后喊一声就走;答案什么时候以 `referee:set-floor-policy` 的形式投
   * 回来,是裁判那一侧的事。不实现这个口 = 这间房没人裁决,窗会一直开着 —— 所以
   * `referee()` 与它是一对,要开一起开。
   */
  openJudgment?(request: CollabRoomJudgmentRequest): void
  /** 房间转录:追加一条消息。D6 接上 `store.addMessage`。 */
  appendMessage(roomId: string, message: CollabRoomTranscriptMessage): void
  /** 成员信箱。返回 undefined = 这位此刻没有信箱,跳过(不算投递失败)。 */
  memberMailbox(agentId: string): CollabRoomMemberMailbox | undefined
  /** 落库消息 id。真机传 `randomUUID`,重放传确定性派生。 */
  newMessageId(seed: string): string
  now(): number
}

/**
 * 房间设置换档时,`referee:set-floor-policy` 的署名。
 *
 * 不冒用某个真裁判的 id:排障时「这一档是谁定的」要分得开"用户在设置里选的"与
 * "裁判在某一轮判的",而动词表里只有 `refereeId` 这一格能回答它。
 */
export const COLLAB_ROOM_CONFIG_REFEREE_ID = 'room-config'

export interface CollabRoomActorOptions extends Omit<ActorBaseOptions<ActorEvent<CollabActorVerb>>, 'id'> {
  roomId: string
  host: CollabRoomActorHost
  /** 账的存取面。缺省落盘(`actors/room.json`)。 */
  store?: CollabRoomAccountStore
  mailbox: ActorMailboxSource<ActorEvent<CollabActorVerb>>
  /** 调度时间轴(D8 §3.3)。缺省不记 —— 金重放与纯测试跑的就是那一档。 */
  schedulerLog?: CollabSchedulerLogSink
}

/**
 * 一次广播投递失败。
 *
 * 单独一个类型而不是裸 Error:「一个成员的信箱写不进去」与「这条动词本身有问题」
 * 是两个完全不同的事故 —— 前者续播能自愈,后者续播只会一直炸。dead-letter 那侧
 * 要分得开这两者(ActorBase 的既定纪律)。
 */
export class CollabRoomBroadcastError extends Error {
  constructor(readonly eventId: string, readonly agentId: string, cause: unknown) {
    super(`[collab-room] broadcast to ${agentId} failed (${eventId}): ${String(cause)}`)
    this.name = 'CollabRoomBroadcastError'
  }
}

export class CollabRoomActor extends ActorBase<ActorEvent<CollabActorVerb>> {
  readonly roomId: string

  private readonly host: CollabRoomActorHost
  private readonly accountStore: CollabRoomAccountStore
  private readonly ids: CollabRoomIdSource
  private state: CollabRoomAccount
  /** 广播序号 —— 只给没有天然身份的动词派生事件 id 用(见 `collabRoomEventId`)。 */
  private broadcastOrdinal = 0
  private readonly schedulerLog: CollabSchedulerLogSink | undefined
  /** 撞闸闩锁:同一只手同一道闸只记一行(见 `deriveCollabSchedulerLogRows`)。 */
  private readonly blockLatch: CollabSchedulerBlockLatch = new Map()

  constructor(options: CollabRoomActorOptions) {
    super({ ...options, id: `room:${options.roomId}` })
    this.roomId = options.roomId
    this.host = options.host
    this.accountStore = options.store ?? createCollabRoomAccountFileStore()
    this.state = this.accountStore.load(options.roomId)
    this.ids = { newMessageId: seed => this.host.newMessageId(seed) }
    this.schedulerLog = options.schedulerLog
  }

  /** 当前的账。只读快照 —— 外面改它不会改到房间。 */
  get account(): CollabRoomAccount {
    return this.state
  }

  /** 三道闸这一刻的读数。每次决策现取 —— 缓存它就等于让房间用过期的闸判事。 */
  gates(): CollabRoomGates {
    const directory = this.host.directory?.(this.roomId)
    const budget = this.host.budget?.(this.roomId)
    const leaseTtlMs = this.host.leaseTtlMs?.(this.roomId)
    return {
      ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }),
      frozen: this.host.frozen(this.roomId),
      overBudget: this.host.overBudget(this.roomId),
      maxChain: this.host.maxChain(this.roomId),
      maxConcurrent: this.host.maxConcurrent(this.roomId),
      members: this.host.members(this.roomId),
      ...(directory ? { directory } : {}),
      ...(this.host.pairDm?.(this.roomId) ? { pairDm: true } : {}),
      ...(this.host.referee?.(this.roomId) ? { referee: true } : {}),
      now: this.host.now(),
      ...(budget ? { budgetSpentUSD: budget.spentUSD, budgetLimitUSD: budget.limitUSD } : {}),
    }
  }

  /**
   * **同步决策面** —— 金重放与真机的公共入口。
   *
   * 做两件事:把动词路由到纯层的转换,然后**把账落下去**。转录与广播不在这里,
   * 因为它们是副作用而重放不要副作用;返回的 effects 就是那张待执行清单。
   */
  decide(verb: CollabActorVerb): CollabRoomEffects {
    const before = this.state
    const step = this.route(verb)
    this.state = step.account
    // 账先于一切。这一行之后,即使进程当场没了,重启也知道牌发过、链走到哪。
    this.accountStore.save(this.state)
    // 记账排在落账**之后**:时间轴是诊断,不该跑在真账前面(那样一次崩溃会留下
    // 「账上没发牌,时间轴上发了」这种自相矛盾的现场)。
    this.recordSchedulerStep(before, step.effects, verb)
    return step.effects
  }

  /** 落转录 + 广播 + 把新开的裁决窗喊出去。账已经在 `decide` 里落过了。 */
  async commit(effects: CollabRoomEffects): Promise<void> {
    for (const message of effects.messages) {
      this.host.appendMessage(this.roomId, message)
    }
    await this.broadcast(effects.broadcast)
    // 裁决窗喊在广播**之后**:窗一开手就挂起了,而挂起这件事的可见形态是"这一轮
    // 没有 floor-granted"。先喊的话,裁判可能在成员还没收到这条消息时就判完了。
    if (effects.judgment) this.host.openJudgment?.(effects.judgment)
  }

  protected async handleEvent(event: ActorEvent<CollabActorVerb>): Promise<void> {
    await this.commit(this.decide(event.payload))
  }

  /**
   * 续播:把账里还没投完的广播接着投完。
   *
   * 起循环之前调一次。这是 v3 唯一的"恢复"动作 —— 没有全局对账器(§3),每个
   * actor 自己知道自己停在哪儿。
   */
  async resumeBroadcasts(): Promise<void> {
    for (const record of [...this.state.broadcasts]) {
      await this.deliver(record)
    }
  }

  /**
   * 把房间**设置**里的响应模式打进房账(D6 接线的生效点)。
   *
   * 两个调用时刻,一个都不能少:
   *  1. **装配**(`ensureRoom`,续播之后起循环之前)—— 冷启动、以及"用户在应用
   *     关着的时候改了设置"这两条路都只有这一次机会;
   *  2. **改完设置**(`setCollabRoomConfig` → `syncCollabV3RoomFloorPolicy`)——
   *     没有它,一个刚拨到"接力"的开关要等到下次重启才有反应。
   *
   * 走的是**换档那条既有的路**(`referee:set-floor-policy`,不带 verdictToken):
   * 清游标、作废在飞的裁决窗、按新策略立刻重排一次。没有新开一个"配置换档"动词,
   * 因为换档就是换档 —— 两个动词意味着 `policyState` 的清理规则要写两遍,而半份
   * 旧游标(`ring` 的环位喂给 `waves` 的批位)是一个查不出来的错。房间设置在这条
   * 路上就是**一位不说话的裁判**,`refereeId` 如实写成它自己。
   *
   * 两道守门:
   *  - **没变就不动**(`isSameCollabRoomFloorPolicy`)。每次装配都换一次档,等于
   *    每次重启都把环拨回起点、把在飞的编排打回原形;
   *  - **`phase` 不碰**。相位是裁判专属的一等表达(跨房),而房间设置是单房的 ——
   *    一间跑在相位上的房不该因为它的 `responseMode` 没配就被打回 `free`。
   *
   * 换档之后那次重排不会让一间空房自己开口:`ring` / `waves` 的起步要有由头
   * (`hasTrigger`),这正是那道门站着的位置。
   */
  async syncFloorPolicy(): Promise<void> {
    const desired = this.host.floorPolicy?.(this.roomId)
    if (!desired) return
    if (this.state.policy.name === 'phase') return
    if (isSameCollabRoomFloorPolicy(this.state.policy, desired)) return
    await this.commit(this.decide(collabRefereeSetFloorPolicy({
      roomId: this.roomId,
      refereeId: COLLAB_ROOM_CONFIG_REFEREE_ID,
      policy: desired.name,
      ...(desired.params ? { params: desired.params } : {}),
    })))
  }

  /** 换代:代数 +1,在外的牌全部作废。用户喊停 / 房间被冻住走这条。 */
  async bumpEpoch(reason: CollabFloorRevokeReason): Promise<void> {
    const before = this.state
    const step = bumpCollabRoomEpoch(this.state, reason, this.host.now())
    this.state = step.account
    this.accountStore.save(this.state)
    this.recordSchedulerStep(before, step.effects)
    await this.commit(step.effects)
  }

  /**
   * 点名收一张牌 + 立刻补发(E5 人级停止的账面动作)。
   *
   * 返回 false = 账上没这张在外的牌(已经让位/过期/换代作废了),什么都没发生。
   * 调用方据此回一句可操作的 `not-found`,而不是让界面收到一个说不清的 null。
   *
   * 形状与 `bumpEpoch` / `sweepExpiredLeases` 逐行一致(纯层算 → 落账 → 记时间轴
   * → commit),而不是走 `decide(verb)`:那条路是**动词**的入口,而「用户收牌」
   * 不是任何一位 actor 说出来的话 —— 它是宿主对房间的一次外科操作,与换代同类。
   */
  async revokeLease(leaseId: string): Promise<boolean> {
    const before = this.state
    const step = revokeCollabRoomLease(this.state, leaseId, this.gates(), this.ids)
    if (step.account === before) return false
    this.state = step.account
    this.accountStore.save(this.state)
    this.recordSchedulerStep(before, step.effects)
    await this.commit(step.effects)
    return true
  }

  /** 过期回收 + 立刻补发。宿主定期调(牌带 ttl 时才有事做)。 */
  async sweepExpiredLeases(): Promise<void> {
    const before = this.state
    const step = pruneCollabRoomFloor(this.state, this.gates(), this.ids)
    this.state = step.account
    this.accountStore.save(this.state)
    this.recordSchedulerStep(before, step.effects)
    await this.commit(step.effects)
  }

  /** C4 快照协议的供数面(§5「renderer 几乎不改」)。 */
  snapshot(): CollabCoordinatorState {
    return buildCollabRoomActorSnapshot({
      account: this.state,
      gates: this.gates(),
      // 「持牌等大脑」与「生成中」的分界:登记簿是唯一说得出后者的地方(D8 §1)。
      executingLeaseIds: new Set(collabV3TurnsInRoom(this.roomId).map(turn => turn.leaseId)),
      deadLetterCount: this.deadLetterCount,
    })
  }

  /**
   * 一次房间转换 → 时间轴上的几行。**账本在房间这侧的唯一写入点**。
   *
   * 三个调用点(`decide` / `bumpEpoch` / `sweepExpiredLeases`)是三种不同的状态转换,
   * 不是同一类行的三个产生者 —— 派生规则只有一条,在纯层的
   * `deriveCollabSchedulerLogRows` 里,「一类一点」的纪律落在那儿。
   *
   * 全程吞错:观测不能变成第二个故障源。
   */
  private recordSchedulerStep(
    before: CollabRoomAccount,
    effects: CollabRoomEffects,
    verb?: CollabActorVerb,
  ): void {
    const sink = this.schedulerLog
    if (!sink) return
    try {
      const rows = deriveCollabSchedulerLogRows({
        ...(verb ? { verb } : {}),
        before,
        after: this.state,
        effects,
        gates: this.gates(),
        at: this.host.now(),
        latch: this.blockLatch,
      })
      for (const row of rows) sink.append(this.roomId, row)
    } catch (error) {
      log.warn('scheduler row append failed', { roomId: this.roomId }, error)
    }
  }

  /**
   * 动词路由。`default` 分支把 `verb` 收窄成 `never` —— 新增一个动词却漏了处理,
   * typecheck 当场红(C3 纪律,与 `collabActorVerbDirection` 同一套)。
   */
  private route(verb: CollabActorVerb): { account: CollabRoomAccount; effects: CollabRoomEffects } {
    const gates = this.gates()
    switch (verb.type) {
      case 'room:posted':
        return applyCollabRoomPosted(this.state, verb, gates, this.ids)
      case 'agent:raise-hand':
        return applyCollabRoomRaiseHand(this.state, verb, gates, this.ids)
      case 'agent:speak':
        return applyCollabRoomSpeak(this.state, verb, gates, this.ids)
      case 'agent:yield':
        return applyCollabRoomYield(this.state, verb, gates, this.ids)
      case 'referee:set-floor-policy':
        return applyCollabRoomSetPolicy(this.state, verb, gates, this.ids)
      case 'room:phase-changed':
        // 带闸带 id:刚被激活的相位里,挂着的手当场兑现(D3「换相后重新裁决」)。
        return applyCollabRoomPhaseChange(this.state, verb.phase, gates.now, gates, this.ids)
      // 只落账 + 透传:语义分别归 D2(私聊生命周期)与 D3/D4(相位、看板)。
      case 'agent:dm-open':
      case 'agent:wake':
      case 'room:card-event':
      case 'room:membership-changed':
        return applyCollabRoomPassthrough(this.state, verb)
      // 两类信原样吞掉,都不当错误:
      //  - 房间**自己**的输出回流进自己的信箱(重投、或宿主接错线)。再广播一次
      //    就是一个自激环,而且账已经记过这件事了;
      //  - agent → self 的三个动词根本不该寻址到房间。一封投错的信不该让房间的
      //    循环去记一条 dead-letter。
      case 'room:floor-granted':
      case 'room:floor-revoked':
      case 'agent:note':
      case 'agent:spawn-worker':
      case 'agent:worker-result':
        return { account: this.state, effects: { broadcast: [], messages: [], granted: [] } }
      default:
        return assertNeverRoomVerb(verb)
    }
  }

  private async broadcast(verbs: readonly CollabActorVerb[]): Promise<void> {
    if (verbs.length === 0) return
    const memberIds = this.host.members(this.roomId).map(member => member.id)
    for (const verb of verbs) {
      this.broadcastOrdinal += 1
      const pending = collabRoomBroadcastRecipients(verb, memberIds)
      if (pending.length === 0) continue
      const record: CollabRoomPendingBroadcast = {
        eventId: collabRoomEventId(this.roomId, verb, this.broadcastOrdinal),
        pending,
        verb,
        at: this.host.now(),
      }
      // 先记在飞广播,再投 —— 反过来的话,崩在第二个成员上时账里什么都没有,
      // 续播无从谈起(而重新决策一次会把同一件事变成两个事实)。
      this.state = openCollabRoomBroadcast(this.state, record)
      this.accountStore.save(this.state)
      await this.deliver(record)
    }
  }

  /**
   * 逐个成员投递。**投一个销一个账**。
   *
   * 事件 id 对所有收件人是同一个:它是**事件的身份**,不是这一次投递的流水号
   * (core `envelope.ts` 的定义)。于是同一封信重投多少次,消费端的去重窗都认得出。
   *
   * 中途抛错时,已投的那几个已经从 `pending` 里销掉并落盘了 —— 重启后续播只会
   * 补上剩下的那些,成员不会重复收到。at-least-once 是底线,这条账把它抬到了
   * 「崩溃点续播不重复」。
   */
  private async deliver(record: CollabRoomPendingBroadcast): Promise<void> {
    for (const agentId of [...record.pending]) {
      const mailbox = this.host.memberMailbox(agentId)
      if (mailbox) {
        try {
          await mailbox.append(createActorEvent<CollabActorVerb>({
            id: record.eventId,
            at: record.at,
            type: record.verb.type,
            from: collabActorRef('room', this.roomId),
            to: collabActorRef('agent', agentId),
            payload: record.verb,
          }))
        } catch (error) {
          throw new CollabRoomBroadcastError(record.eventId, agentId, error)
        }
      }
      this.state = settleCollabRoomBroadcast(this.state, record.eventId, agentId)
      this.accountStore.save(this.state)
    }
  }
}

function assertNeverRoomVerb(verb: never): never {
  throw new Error(`[collab-room] unhandled verb: ${JSON.stringify(verb)}`)
}

/**
 * 谁该收到这条动词 —— 可见性边界(§0.1)。
 *
 * 三条:房间消息给全体成员(**除了作者自己**——它说的话不必再回声给它,那句话
 * 在它自己的经历流里,D2);发牌/收牌只给当事人(一张牌是私事,广播它等于把
 * 「轮到谁了」变成全房噪声);其余给全体。
 */
export function collabRoomBroadcastRecipients(
  verb: CollabActorVerb,
  memberIds: readonly string[],
): string[] {
  switch (verb.type) {
    case 'room:posted':
      return verb.author.kind === 'agent'
        ? memberIds.filter(id => id !== verb.author.id)
        : [...memberIds]
    case 'room:floor-granted':
    case 'room:floor-revoked':
      return memberIds.includes(verb.agentId) ? [verb.agentId] : []
    case 'agent:dm-open':
      return verb.peerKind === 'agent' ? [verb.peerId] : []
    case 'agent:wake':
      return [verb.peerId]
    default:
      return [...memberIds]
  }
}

function finiteMax(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/**
 * 房间 → renderer 的状态面(C4 快照协议原样复用,§5)。
 *
 * 形状与 v2 的 `buildCollabCoordinatorState` 完全一致 —— 渲染层一行不改就能读
 * v3 的房间,这是「转录零迁移」之外的第二条零迁移承诺。几处还给不出的字段诚实地
 * 给空值而不是编:
 *  - `typing`:打字灯是 C4 观察器的账,D6 接线时接回来;
 *  - `log`:「刚才」只活在内存环形缓冲里,D6 接线。
 *
 * D3 让两格重新有值,但含义变了,渲染层读到的数因此也变了 —— 这是有意的:
 *  - `judging`:v2 是「几个人在各自判定」(N 次调用),v3 是**一扇窗开着**
 *    (一次调用),所以它只会是 0 或 1。`judgingAgentIds` 是那一批候选 ——
 *    「谁在等裁决」这个问题在两代里问的是同一件事,答案的代价差了 N 倍;
 *  - `plan`:`waves` 策略的批次表,直接就是 v2 那份编排的形状。
 *
 * `agentSessionId` 用**牌号**顶着:停止按钮的靶子在 D1 还不存在(没有执行会话),
 * 而给一个空串会让下钻链接指向 undefined。牌号至少是一个真的、能查的东西。
 */
export function buildCollabRoomActorSnapshot(options: {
  account: CollabRoomAccount
  gates: CollabRoomGates
  at?: number
  /**
   * 此刻真在生成的那几张牌(turn-context 登记簿)。
   *
   * 缺席 = 一张都不在生成 —— 对没接登记簿的调用方(重放、纯测试)这是**真的**:
   * 那些环境里根本没有引擎在跑。
   */
  executingLeaseIds?: ReadonlySet<string>
  /** 这间房的 actor 处理事件失败了几次。缺席 = 0。 */
  deadLetterCount?: number
}): CollabCoordinatorState {
  const { account, gates } = options
  const leases = collabRoomActiveLeases(account, gates.now)
  const holders = collabRoomHolders(account, gates.now)
  const executing = options.executingLeaseIds
  // 举手全体同闸:闸是房间级的,而队里每一只手此刻卡的是同一道(见
  // `resolveCollabRoomHandBlock` 的次序说明)。现算一次,逐行抄。
  const blockedBy = account.hands.length > 0 ? resolveCollabRoomHandBlock(account, gates) : 'seats'
  const phase = buildCollabRoomActorPhaseView(account)

  return {
    roomSessionId: account.roomId,
    seq: account.seq,
    at: options.at ?? gates.now,
    mode: account.policy.name === 'ring'
      ? 'serial'
      : account.policy.name === 'free' ? 'parallel' : 'auto',
    frozen: gates.frozen,
    // 「谁在说话」= 此刻持有效牌的人。v2 那份占用视图(inFlight ∪ activeTurns)
    // 在 v3 退化成一句话:牌就是占用,没有第二张表可漂。
    speaking: [...holders],
    typing: [],
    turns: leases.map(lease => ({
      agentId: lease.agentId,
      reason: account.leaseReasons[lease.leaseId] ?? '',
      startedAt: lease.issuedAt,
      agentSessionId: lease.leaseId,
      executing: executing?.has(lease.leaseId) === true,
    })),
    queue: account.hands.map(hand => ({
      id: `hand:${hand.agentId}`,
      agentId: hand.agentId,
      reason: hand.reason,
      blockedBy,
    })),
    // 一扇窗 = 一次调用,所以这一格只会是 0 或 1(v2 那侧是 N)。
    judging: account.judgment?.state === 'pending' ? 1 : 0,
    judgingAgentIds: account.judgment?.state === 'pending'
      ? account.hands.map(hand => hand.agentId)
      : [],
    gates: {
      chain: { value: account.chainCount, max: finiteMax(gates.maxChain) },
      concurrency: { value: leases.length, max: finiteMax(gates.maxConcurrent) },
      budget: {
        value: gates.budgetSpentUSD ?? 0,
        max: gates.budgetLimitUSD ?? COLLAB_DEFAULT_DAILY_COST_USD,
      },
    },
    plan: buildCollabRoomActorPlanView(account),
    // 这间房此刻的代数(E5)。租约行上的「撤牌」拿它当乐观并发的前置条件 ——
    // 界面上那张牌与运行时手里那张必须是同一代,否则撤的是上一轮的人。
    floorEpoch: account.floor.epoch,
    log: [],
    judgment: buildCollabRoomActorJudgmentView(account),
    ...(phase ? { phase } : {}),
    deadLetterCount: options.deadLetterCount ?? 0,
  }
}

/**
 * 裁决窗 → C4 的四态视图(D8 §3.2)。
 *
 * `resolved` 映到 `idle` 是对的:答案已经兑现成牌了,窗对用户而言就是关着的。
 * `degraded` **必须单独一格** —— 它在旧的 `judging: 0` 里与「没有裁决在跑」长得
 * 一模一样,而那是一次必须修的链断。
 *
 * 降级那一格读的是 `account.lastDegraded` 而不是 `account.judgment`(O2 前置修):
 * 窗在裁决落地的**同一个同步步**里就被 `grantFloor` 关掉了,`judgment: 'degraded'`
 * 因此从来没有活到任何一次快照组装 —— O1 记下的那个"读不到"就是这件事。窗照旧当场
 * 关,痕留到下一次开窗,黄牌于是有了站的地方。
 *
 * `debouncing` 在 v3 没有产生点(房间是事件驱动开窗,不防抖),所以这里给不出它 ——
 * 那一格由运行时在 `roomSnapshotOf` 里补(防抖只有它知道)。
 */
function buildCollabRoomActorJudgmentView(account: CollabRoomAccount): CollabCoordinatorJudgment {
  const judgment = account.judgment
  if (judgment?.state === 'pending') {
    return {
      state: 'inflight',
      candidates: account.hands.map(hand => hand.agentId),
      since: judgment.openedAt,
    }
  }
  // `judgment.state === 'degraded'` 这条路在真机上走不到(见上),留着是因为它在
  // 逻辑上仍然是同一个答案 —— 一份没经过 `grantFloor` 的账(重放、纯测试)读得到它。
  if (judgment?.state === 'degraded') {
    return { state: 'degraded', reason: judgment.why ?? 'unspecified', at: judgment.openedAt }
  }
  const degraded = account.lastDegraded
  // 降级的成因(超时/读不懂/端口炸)在裁判那侧,账里只留下一句话与一个时刻。
  // 给一句诚实的占位而不是编一个原因 —— 完整成因在时间轴的 judge-degraded 行上。
  if (degraded) return { state: 'degraded', reason: degraded.reason || 'unspecified', at: degraded.at }
  return { state: 'idle' }
}

/** 相位 → C4 视图。`phase` 策略之外没有相位。 */
function buildCollabRoomActorPhaseView(
  account: CollabRoomAccount,
): CollabCoordinatorState['phase'] {
  if (!account.phase && account.policy.name !== 'phase') return undefined
  const activeRooms = account.policy.params?.activeRooms
  const suspended = activeRooms && activeRooms.length > 0 && !activeRooms.includes(account.roomId)
    ? account.hands.length
    : 0
  return {
    name: account.phase ?? '',
    ...(activeRooms ? { activeRooms: [...activeRooms] } : {}),
    suspendedHands: suspended,
  }
}

/**
 * `waves` 策略的批次表 → C4 的编排视图。其余三档没有编排,给 `null`。
 *
 * 形状与 v2 那份逐格相同(waves / waveIndex / waveCount / cycle / why / loops),
 * 所以状态条那块画布一行不用改 —— v3 换掉的是"编排从哪来"(裁判一次下发,而不是
 * plan-runner 现算),不是"编排长什么样"。
 */
function buildCollabRoomActorPlanView(
  account: CollabRoomAccount,
): CollabCoordinatorState['plan'] {
  if (account.policy.name !== 'waves') return null
  const waves = (account.policy.params?.waves ?? []).filter(wave => wave.length > 0)
  if (waves.length === 0) return null
  return {
    waves: waves.map(wave => [...wave]),
    waveIndex: account.policyState?.waveIndex ?? 0,
    waveCount: account.policyState?.waveCount ?? 0,
    cycle: account.policy.params?.cycle === true,
    why: account.policy.params?.why ?? '',
    loops: account.policy.params?.relayLoops ?? 0,
  }
}
