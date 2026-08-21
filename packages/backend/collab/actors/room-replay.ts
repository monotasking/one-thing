/**
 * 金重放:把**真的 RoomActor** 接进重放架(docs/design/collab-actor-v3.md §7 风险 1)。
 *
 * D0 立了架子,管线只有一个直通 stub;这里插进第一个真实现。喂进去的是旧房的
 * 转录,吐出来的是 v3 会做的全部决策 —— 举手、发牌、说话、让位、撞闸。快照因此
 * 回答的是一个很具体的问题:**同一段真实对话,新运行时会怎么处理?**
 *
 * 转录 → 动词的翻译规则(只有三条,但每一条都是一个判断):
 *
 * 1. **人类/系统消息** → 直接投给房间(`room:posted`)。清链、推水位、按策略发牌
 *    全在房间的账里发生。
 * 2. **agent 的发言** → 先替它**举手**。转录里"它说了这句"在 v3 的语义是
 *    "它当时想说话",而想说话与说得成是两回事 —— 中间隔着三道闸。手举了没拿到
 *    牌,这条发言在快照里就**没有 speak 动词**:那正是重放要暴露的东西(v3 会
 *    拦下哪些话)。
 * 3. 拿到牌之后 `speak`,然后立刻 `yield`。为什么一句一交牌:转录里没有"回合
 *    边界"这个信息 —— 一个 agent 连说三句和说一句再被打断,落在纸上一模一样。
 *    一句一牌是唯一不需要猜的解释,而且它让并发上限在重放里有确定的含义。
 *
 * 名册从转录里现取(`collabRoomMembersFromTranscript`):重放是事后视角,谁在这
 * 间房里是已知的。真机那侧名册来自房间设置,两者在这一点上必然不同,所以它是
 * 一个显式的入参而不是藏在默认值里。
 *
 * 数据纪律沿用 D0:fixture 全部合成,真实用户转录只用同目录外的只读脚本手工对照。
 */
import { InMemoryMailbox, type ActorEvent } from '@onething/core/actors'
import type { CollabAgentLike, CollabRelayRoomLike } from '@onething/runtime/collab'
import {
  collabAgentRaiseHand,
  collabAgentSpeak,
  collabAgentYield,
  collabRefereeSetFloorPolicy,
  collabRefereeVerdictVerb,
  collabRoomActiveLeases,
  collabRoomHolders,
  resolveCollabRoomFloorPolicy,
  type CollabActorReplayContext,
  type CollabActorReplayPipeline,
  type CollabActorReplayTranscript,
  type CollabActorVerb,
  type CollabFloorPolicyName,
  type CollabFloorPolicyParams,
  type CollabRefereeVerdict,
  type CollabRoomAccount,
  type CollabRoomJudgmentRequest,
  type CollabRoomTranscriptMessage,
} from '@onething/runtime/collab/actors'

import { createCollabRoomAccountMemoryStore } from './room-account.js'
import { CollabRoomActor, type CollabRoomActorHost } from './room-actor.js'

export interface CollabRoomReplayOptions {
  roomId: string
  /** 在职成员。缺省从转录里现取。 */
  members?: readonly CollabAgentLike[]
  /** 链闸上限。缺省 `Infinity`(不设闸的剧本)。 */
  maxChain?: number
  /** 并发上限。0 = 不限。缺省 1 —— 一句一牌的重放里,这是最能读懂的档。 */
  maxConcurrent?: number
  frozen?: boolean
  overBudget?: boolean
  pairDm?: boolean
  /** 时钟起点。重放不碰 `Date.now()`,时刻从转录派生。 */
  startedAt?: number
  /* ── D3:策略与裁判 ─────────────────────────────────────────────────── */
  /** 开局的发言策略。缺省 `free`(裁判缺席时的内置档)。 */
  policy?: CollabFloorPolicyName
  /** 策略参数(`ring` 的 `order`、`waves` 的批次表、`phase` 的活跃房表)。 */
  policyParams?: CollabFloorPolicyParams
  /**
   * **房间设置**(响应模式三件套)—— 走 `resolveCollabRoomFloorPolicy` 映射成上面
   * 那两格(D6 接线)。
   *
   * 与直接给 `policy` / `policyParams` 的区别不是写法,是**问的问题不同**:后者
   * 问"跑在 ring 上会怎样",前者问"用户在设置里选了接力会怎样"—— 而 D6 漏掉的
   * 恰恰是这两者之间那一步。给了它就不必再给 `policy`(显式给的优先,便于对照)。
   */
  room?: CollabRelayRoomLike
  /** 开局相位(`phase` 剧本)。 */
  phase?: string
  /** 这间房挂了裁判吗 —— 挂了,`free` 的举手先进裁决窗。 */
  referee?: boolean
  /**
   * **脚本化的裁决**(金重放专用)。
   *
   * 重放架的接缝是同步的,而真裁决是一次网络往返 —— 所以这里换成一个同步函数:
   * 房间开窗 → 立刻问它 → 把答案当 `referee:set-floor-policy` 投回去。除了这次
   * 「模型怎么想」,其余每一行都是真的(房间的账、闸、发牌、队列结算全走真代码)。
   *
   * 返回 `null` = 这一次裁判答不上来 → 降级裁决 → 房间回落举手 FIFO。
   */
  judge?(request: CollabRoomJudgmentRequest, account: CollabRoomAccount): CollabRefereeVerdict | null
}

/** 重放管线额外暴露的观测面 —— 测试拿它比账,不必去翻内部。 */
export interface CollabRoomActorReplayPipeline extends CollabActorReplayPipeline {
  /** 跑完之后房间的账。 */
  account(): CollabRoomAccount
  /** 落进转录的消息(重放不真写盘,写到这里)。 */
  messages(): CollabRoomTranscriptMessage[]
  /** 全部动词,按序 —— 与 `replayRoomTranscript` 捕获的那一串相同。 */
  verbs(): CollabActorVerb[]
  /**
   * 买过几次裁决(D3)。**O(1) 的断言数它** —— 一个触发事件恰好一次,N 个候选
   * 不是 N 次。
   */
  judgeCalls(): number
}

/** 转录里出现过的 agent,按首次出现序。重放的名册就是它。 */
export function collabRoomMembersFromTranscript(
  transcript: CollabActorReplayTranscript,
): CollabAgentLike[] {
  const seen = new Set<string>()
  const members: CollabAgentLike[] = []
  for (const message of transcript.messages) {
    const agentId = message.agentId
    if (!agentId || seen.has(agentId)) continue
    seen.add(agentId)
    // 名字用 id 顶着:重放里没有花名册,而名字只影响"裸 @名字"的扫描兜底 ——
    // fixture 里的 @ 都带 mentions[],走的是 id 那条精确路径。
    members.push({ id: agentId, name: agentId })
  }
  return members
}

/**
 * 造一条重放管线。
 *
 * 里面是一个**真的** `CollabRoomActor`,只是账落在内存、转录落在数组、信箱是
 * 内存版 —— 决策那条路径与真机逐字相同(`decide()` 是同一个方法)。
 */
export function createCollabRoomActorReplayPipeline(
  options: CollabRoomReplayOptions,
): CollabRoomActorReplayPipeline {
  const members = options.members ? [...options.members] : []
  const maxChain = options.maxChain ?? Number.POSITIVE_INFINITY
  const maxConcurrent = options.maxConcurrent ?? 1
  const messages: CollabRoomTranscriptMessage[] = []
  const verbs: CollabActorVerb[] = []
  // 重放的时钟:从转录的时间戳走,拿不到就用一个单调计数。碰 `Date.now()` 会让
  // 金快照每次都变(D0 已经为这条立过测试)。
  let clock = options.startedAt ?? 0

  /** 房间开出来的裁决窗,攒在这里等同步结算(见 `settleJudgments`)。 */
  let pendingJudgments: CollabRoomJudgmentRequest[] = []
  /** 判过几次。**O(1) 的金重放断言数它** —— N 个候选一次调用。 */
  let judgeCalls = 0

  const host: CollabRoomActorHost = {
    members: () => members,
    frozen: () => options.frozen === true,
    overBudget: () => options.overBudget === true,
    maxChain: () => maxChain,
    maxConcurrent: () => maxConcurrent,
    pairDm: () => options.pairDm === true,
    referee: () => options.referee === true,
    openJudgment: request => {
      pendingJudgments.push(request)
    },
    appendMessage: (_roomId, message) => {
      messages.push(message)
    },
    // 重放不投信箱:动词序列本身就是"谁收到什么"的完整记录,再投一遍内存信箱
    // 只是把同一件事记两遍。
    memberMailbox: () => undefined,
    newMessageId: seed => seed,
    now: () => clock,
  }

  let actor = newActor()

  function newActor(): CollabRoomActor {
    return new CollabRoomActor({
      roomId: options.roomId,
      host,
      store: createCollabRoomAccountMemoryStore(),
      // 信箱建了但循环不起:重放只调同步的 `decide()`,不走 actor 的事件循环 ——
      // 那一层管的是"什么时候处理",而重放问的是"处理成什么样"。
      mailbox: new InMemoryMailbox<ActorEvent<CollabActorVerb>>(),
    })
  }

  /**
   * 跑一个动词:记下它,再记下房间因它产生的全部动词。
   *
   * 广播里与输入**同一个对象**的那一条要滤掉:一条用户 posted 进来,房间原样播
   * 出去,那是同一封信的两次出现 —— 记两遍会让快照读起来像房间把每条消息都
   * 复读了一遍,而且链账的 fold 会把同一个清零事件数两次(结果不变,但理由变脏了)。
   *
   * `decide()` 不走 `commit()`(重放不落转录、不投信箱),所以裁决窗要在这里自己
   * 接一下 —— 真机那侧它由 `commit` 喊出去。
   */
  function run(verb: CollabActorVerb): void {
    verbs.push(verb)
    const effects = actor.decide(verb)
    for (const message of effects.messages) messages.push(message)
    verbs.push(...effects.broadcast.filter(entry => entry !== verb))
    if (effects.judgment) pendingJudgments.push(effects.judgment)
  }

  /**
   * 把开着的裁决窗**当场结算掉**。
   *
   * 只在窗真的开着、且账里已经有手的时候判 —— 窗是在 `posted` 那一刻开的,而举手
   * 发生在其后(重放里由 `onPosted` 替 agent 举),所以开窗那一刻候选常常是空的。
   * 这与真机的时序是同一件事:那边隔着一次 mailbox 投递,这里隔着一个函数调用。
   *
   * 一扇窗**至多判一次**(窗关了就不再进这个循环)—— 这就是 O(1) 在金重放里的
   * 可见形态:剧本里五个人举手,`judgeCalls` 也只会 +1。
   */
  function settleJudgments(): void {
    for (let guard = 0; guard < 8 && pendingJudgments.length > 0; guard += 1) {
      const open = pendingJudgments
      pendingJudgments = []
      for (const request of open) {
        const account = actor.account
        if (account.judgment?.token !== request.token || account.judgment.state !== 'pending') continue
        if (account.hands.length === 0) continue
        judgeCalls += 1
        const verdict = options.judge?.(request, account)
          // 没给 `judge` = 这间房挂了裁判但没人接 —— 降级,房间回落举手 FIFO。
          // 悬着不判的话那扇窗永不关闭,而窗开着房间就不发牌(那正是要测的失败态)。
          ?? { token: request.token, grants: [], degraded: true }
        run(collabRefereeVerdictVerb({
          roomId: options.roomId,
          refereeId: 'replay-referee',
          verdict,
        }))
      }
    }
  }

  /**
   * 开局下发一次策略 —— 剧本从第一条消息起就跑在那一档上。
   *
   * 给了 `room` 就先把它映射一遍(真机装配那一步的同一个函数),显式的
   * `policy` / `policyParams` 仍然压过映射结果:一份剧本因此可以两种给法各跑一遍,
   * 「配置驱动」与「显式换档」的行为是否逐字节相同,成了一条可断言的事。
   */
  function primePolicy(): void {
    if (!options.policy && !options.policyParams && !options.phase && !options.room) return
    const mapped = options.room ? resolveCollabRoomFloorPolicy(options.room) : undefined
    run(collabRefereeSetFloorPolicy({
      roomId: options.roomId,
      refereeId: 'replay-referee',
      policy: options.policy ?? mapped?.name ?? 'free',
      params: {
        ...mapped?.params,
        ...options.policyParams,
        ...(options.phase ? { phase: options.phase } : {}),
      },
    }))
  }

  primePolicy()

  return {
    name: 'room-actor',
    reset: () => {
      messages.length = 0
      verbs.length = 0
      clock = options.startedAt ?? 0
      pendingJudgments = []
      judgeCalls = 0
      if (options.members) {
        members.splice(0, members.length, ...options.members)
      } else {
        members.length = 0
      }
      actor = newActor()
      primePolicy()
    },
    judgeCalls: () => judgeCalls,
    account: () => actor.account,
    messages: () => [...messages],
    verbs: () => [...verbs],
    onPosted: (event, _context: CollabActorReplayContext): CollabActorVerb[] => {
      const before = verbs.length
      const message = event.payload.message
      clock = message.timestamp ?? clock + 1

      // 名册没显式给的话按首次出现补 —— 一个还没说过话的人此刻确实不在房里,
      // 而 fixture 的 @ 目标要提前进名册,那就显式传 members。
      if (!options.members && message.agentId && !members.some(member => member.id === message.agentId)) {
        members.push({ id: message.agentId, name: message.agentId })
      }

      if (event.payload.author.kind !== 'agent') {
        run(event.payload)
        // 人类/系统消息也可能开窗(它是触发事件),但那一刻队里通常没有手 ——
        // 结算一次是为了让"窗开了、没人举手"这条路径也走到底(空裁决即关窗)。
        settleJudgments()
        return verbs.slice(before)
      }

      const agentId = event.payload.author.id
      if (!collabRoomHolders(actor.account, clock).has(agentId)) {
        run(collabAgentRaiseHand({
          roomId: options.roomId,
          agentId,
          ...(message.id ? { sourceMessageId: message.id } : {}),
        }))
        // 手举完了才判 —— 这一步就是「攒进裁决窗」的可见形态。
        settleJudgments()
      }

      const lease = collabRoomActiveLeases(actor.account, clock).find(entry => entry.agentId === agentId)
      if (!lease) {
        // 撞闸:这句话在 v3 说不出口。快照里因此没有 speak —— 这不是缺失,
        // 是结论。
        return verbs.slice(before)
      }

      run(collabAgentSpeak({
        roomId: options.roomId,
        agentId,
        leaseId: lease.leaseId,
        content: message.content,
        ...(message.mentions ? { mentions: message.mentions } : {}),
      }))
      run(collabAgentYield({
        roomId: options.roomId,
        agentId,
        leaseId: lease.leaseId,
        reason: 'done',
      }))
      // 说完这句话本身是一次 posted(它回流进房间),可能又开一扇窗 —— 结算掉,
      // 否则下一条消息进来时会撞上一扇上一轮的陈旧窗。
      settleJudgments()
      return verbs.slice(before)
    },
  }
}
