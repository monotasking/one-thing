/**
 * 发言策略族(docs/design/collab-actor-v3.md §1.5)。
 *
 * v2 的 planner / plan-runner / speaking-order / willingness-runner 是**四条代码
 * 路径**:谁能说话藏在四个文件的控制流里,想换一种排法就得改控制流。v3 把它翻成
 * 一个接口 + 若干实现 —— 房间只问一句「这一刻该给谁发牌」,怎么答是策略的事。
 *
 * D1 只落地 `free`(裁判缺席时的内置档);D3 补齐 `ring` / `waves` / `phase`,
 * 它们与 `free` 的区别**全部落在这个 `decide` 上,房间一行都不用改** —— 这正是把
 * 策略做成接口(而不是在房间里写 switch)的理由,而 D3 是它第一次兑现。
 *
 * 这一层是**纯函数**:不碰时钟(`now` 一律由调用方传)、不碰账(只读入参、只返回
 * 决定)、不认识租约的落盘形态。发不发得成、发出去要不要计链,是房间的账说了算
 * (`room-rules.ts`)—— 策略只排队,不管闸。两件事分开的理由很实际:闸只有一套
 * (三道,单账),而策略会长出四种;把闸写进策略等于把它抄四遍。
 *
 * ## 四条策略的一句话
 *
 * | 策略 | 谁说话由什么决定 | 花不花模型调用 |
 * | --- | --- | --- |
 * | `free` | 一次批量裁决排全场;裁判缺席/答不上来 → 举手 FIFO | 一个触发事件一次 |
 * | `ring` | 一个确定性的环,棒子依次传 | **零** |
 * | `waves` | 裁判一次给出的批次表,批内并行批间串行 | 出编排时一次 |
 * | `phase` | 当前相位活着的房才发牌;非活跃相位举手挂起 | **零** |
 *
 * 四条**共有**的一件事:`@` 提及直通授牌(§8 保留的已拍板决策)。它写在
 * `takeMentioned()` 里,四个 `decide` 各调一次 —— 抽成公共第一步是因为"@ 在某个
 * 策略下不灵"这件事必须是不可能的,而不是"我们记得每处都写了"。
 *
 * ## 策略自己的游标住在账里,不住在闭包里
 *
 * `ring` 要记环走到哪、`waves` 要记批走到哪。它们**不能**是策略对象的字段:策略
 * 是每次决策现 `resolve` 出来的(房间不缓存它),而且账崩溃后要重建 —— 一个活在
 * 闭包里的游标,重启之后环就从头开始了。所以游标进 `CollabFloorPolicyState`:
 * 策略从入参读它,把新值放进 `decision.state`,房间原样落账。策略仍是纯函数。
 */
import type { CollabActivationReason } from '../activation.js'
import {
  buildCollabRelayRing,
  collabRelayLoopsFor,
  pickCollabRelayStarter,
  type CollabRelayRoomLike,
} from '../speaking-order.js'
import type { CollabAgentLike } from '../types.js'
import type { CollabRoomJudgment } from './referee-rules.js'
import type { CollabFloorPolicyName, CollabFloorPolicyParams, CollabHandUrgency } from './protocol.js'

/**
 * 一只举着的手。
 *
 * `origin` 不是装饰:`@` 提及在任何策略下都是**直通授牌**(§1.5 保留的已拍板
 * 决策),座位满时它退化成一只**排在最前面**的手,而不是退化成一只普通的手 ——
 * 后者会让「我点名了 A,结果先说话的是排队更久的 B」成为常态,而那正是 @ 这个
 * 社交信号存在的意义要否掉的事。
 */
export interface CollabRaisedHand {
  agentId: string
  /** 举手时刻(ms)。FIFO 就按它排。 */
  at: number
  /** `mention` = 被点名但当时没座位;`hand` = 自己举的。 */
  origin: 'mention' | 'hand'
  /** 这只手对应的激活理由 —— 链闸的分档读它(task-event 豁免)。 */
  reason: CollabActivationReason
  urgency?: CollabHandUrgency
  why?: string
  /** 触发这次举手的房间消息(链闸清零判定与排障要它)。 */
  sourceMessageId?: string
}

/** 策略选中的一个候选。发不发得出去还要过三道闸(房间的账说了算)。 */
export interface CollabFloorGrantCandidate {
  agentId: string
  origin: 'mention' | 'hand'
  reason: CollabActivationReason
  sourceMessageId?: string
}

/**
 * 策略自己的游标 —— **住在房间账里**(见文件头)。
 *
 * 一个可选字段袋而不是四个策略各自的类型:房间只负责把 `decision.state` 原样落回
 * 账里,它不该认识 ring 与 waves 的区别。策略之间字段不复用(ring 不读 wave*),
 * 换策略时整袋清空(`applyCollabRoomSetPolicy`)—— 半份旧游标比没有游标更糟。
 */
export interface CollabFloorPolicyState {
  /** `ring`:环上**下一个**该拿棒的人的下标。 */
  ringCursor?: number
  /** `ring`:已经走完几圈。`relayLoops` 到顶就收棒。 */
  ringLaps?: number
  /** `waves`:当前批次的下标。 */
  waveIndex?: number
  /** `waves`:当前这一批**已经发过牌**了吗 —— 批边界推进读它。 */
  waveIssued?: boolean
  /** `waves`:总共发过几批。`relayLoops × waves.length` 到顶就停。 */
  waveCount?: number
}

export interface CollabFloorDecisionInput {
  /** 这一刻被 @ 到的成员(调用方已按名册过滤、已排除作者)。 */
  mentioned: readonly string[]
  /** 举手队列(房间账里的原序)。 */
  hands: readonly CollabRaisedHand[]
  /** 此刻手里有牌的人 —— 同一个 agent 不并发持两张同房租约。 */
  holders: ReadonlySet<string>
  /** 在外的有效租约数。 */
  activeLeases: number
  /** 并发上限。**0 或负数 = 不限**(与 dailyCostUSD / maxChain 同一套约定)。 */
  maxConcurrent: number
  /** 在职成员。不传 = 不校验(重放里名册从转录现取的场合)。 */
  members?: readonly string[]
  /** 在职成员的完整形态(`ring` 要按名册序补环尾;不传就退回 `members`)。 */
  roster?: readonly CollabAgentLike[]
  /** 当前相位(`phase` 策略读它;其余忽略)。 */
  phase?: string
  /** 这间房的 id —— `phase` 拿它去对活跃相位表。 */
  roomId?: string
  /** 策略自己的游标(上一次决策留下的)。 */
  state?: CollabFloorPolicyState
  /**
   * 裁决窗此刻的状态(`free` 读它)。
   *  - `undefined` —— 没开窗:该开就开,不该开就 FIFO;
   *  - `pending` —— 开着等答案:手全部挂起,只放 @;
   *  - `resolved` —— 答案来了:按 `grants` 的次序发;
   *  - `degraded` —— 答不上来:回落 FIFO(= D1 的 `free`)。
   */
  judgment?: CollabRoomJudgment
  /** 触发这次决策的消息 —— 开窗时记下来。 */
  sourceMessageId?: string
  /** 这间房免裁决吗(双成员私聊:没有第二个人要排次序)。 */
  pairDm?: boolean
  params?: CollabFloorPolicyParams
}

export interface CollabFloorDecision {
  /** 按发牌次序排好的候选。 */
  grants: CollabFloorGrantCandidate[]
  /**
   * 这次决策要求**开一扇裁决窗**:队里的手先别发,等裁判一次判一批。
   *
   * 是一个请求而不是一个动作 —— 策略是纯的,开窗要写账、要通知裁判,那是房间的事。
   */
  openJudgment?: boolean
  /** 策略游标的新值。缺席 = 这次决策没动游标。 */
  state?: CollabFloorPolicyState
}

export interface CollabFloorPolicy {
  readonly name: CollabFloorPolicyName
  decide(input: CollabFloorDecisionInput): CollabFloorDecision
}

/**
 * 还剩几个座位。`maxConcurrent <= 0` = 不限。
 *
 * 单独一个函数而不是内联三次:`0 = 不限` 这条约定在这个仓库里被写错过
 * (`maxChainFor` 曾把 0 读成"没配"而回落默认),一处判定省一次翻案。
 */
export function collabFloorSeats(input: Pick<CollabFloorDecisionInput, 'activeLeases' | 'maxConcurrent'>): number {
  if (!Number.isFinite(input.maxConcurrent) || input.maxConcurrent <= 0) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor(input.maxConcurrent) - input.activeLeases)
}

/**
 * 举手队列的发牌次序:**被点名的在前,其余按举手时刻 FIFO**,同刻按入队原序。
 *
 * 不动输入数组(账是不可变的,`sort` 就地改会让上一份账在调用方手里悄悄变形)。
 */
export function orderCollabHands(hands: readonly CollabRaisedHand[]): CollabRaisedHand[] {
  return hands
    .map((hand, index) => ({ hand, index }))
    .sort((a, b) => {
      const aMention = a.hand.origin === 'mention' ? 0 : 1
      const bMention = b.hand.origin === 'mention' ? 0 : 1
      return aMention - bMention || a.hand.at - b.hand.at || a.index - b.index
    })
    .map(entry => entry.hand)
}

/* ── 四条策略共用的取座位器 ──────────────────────────────────────────────── */

/**
 * 一次决策里的座位账。
 *
 * 本地副本而不是直接读入参:一次决策里先被选中的人立刻算作"手里有牌",否则同一条
 * 消息里 @ 了同一个人两次会发出两张牌。四个策略共用同一个 —— 「同 agent 不双持」
 * 与「座位有限」这两条在任何策略下都成立,抄四遍等于给它们四次漂开的机会。
 */
function createSeatTaker(input: CollabFloorDecisionInput): {
  take(candidate: CollabFloorGrantCandidate): boolean
  grants: CollabFloorGrantCandidate[]
  seatsLeft(): number
} {
  const grants: CollabFloorGrantCandidate[] = []
  const holders = new Set(input.holders)
  const members = input.members ? new Set(input.members) : null
  let seats = collabFloorSeats(input)

  return {
    grants,
    seatsLeft: () => seats,
    take(candidate: CollabFloorGrantCandidate): boolean {
      if (seats <= 0) return false
      if (holders.has(candidate.agentId)) return false
      if (members && !members.has(candidate.agentId)) return false
      holders.add(candidate.agentId)
      seats -= 1
      grants.push(candidate)
      return true
    },
  }
}

/**
 * 第一步,四条策略都一样:**@ 提及直通授牌**(§8 保留的已拍板决策)。
 *
 * 抽成一个共用函数不是为了省几行 —— 是为了让"@ 在某个策略下不灵"成为一件**不可能**
 * 的事。写四遍的话,它就只是"我们记得每处都写了"。
 */
function takeMentioned(
  input: CollabFloorDecisionInput,
  seats: ReturnType<typeof createSeatTaker>,
): void {
  for (const agentId of input.mentioned) {
    seats.take({
      agentId,
      origin: 'mention',
      reason: 'mention',
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    })
  }
}

function candidateOf(hand: CollabRaisedHand): CollabFloorGrantCandidate {
  return {
    agentId: hand.agentId,
    origin: hand.origin,
    reason: hand.reason,
    ...(hand.sourceMessageId ? { sourceMessageId: hand.sourceMessageId } : {}),
  }
}

/** 举手 FIFO —— `free` 的降级路径,也是 D1 的全部行为。 */
function takeHandsFifo(
  input: CollabFloorDecisionInput,
  seats: ReturnType<typeof createSeatTaker>,
): void {
  for (const hand of orderCollabHands(input.hands)) seats.take(candidateOf(hand))
}

/**
 * 这一刻**有由头开口**吗 —— 有人被点名、有人举着手、或者有一条消息触发了这次决策。
 *
 * `ring` 与 `waves` 起步前问它一次,原因是一条很实际的:换档(`set-floor-policy`)
 * 之后房间会立刻重排一次,而一间**空着的**房不该因为"用户在设置里把模式改成接力"
 * 就自己开始说话。那不是换了个排法,那是凭空起了一场对话 —— 而且它烧的是真钱。
 *
 * 起步之后就不再问:接力的下一棒、编排的下一批都是由**让位**触发的,而让位没有
 * 消息 id 也可能没有举手(接力免举手)。把这条门加在起步处而不是每一次决策,
 * 「起步要有由头」与「起来了就自己往下走」这两件事才不会互相咬。
 */
function hasTrigger(input: CollabFloorDecisionInput): boolean {
  return input.mentioned.length > 0
    || input.hands.length > 0
    || input.sourceMessageId !== undefined
}

/* ── free:批量举手裁决(默认档) ─────────────────────────────────────────── */

/**
 * 自由发言 + **批量举手裁决**(qm P0-2,O(N)→O(1))。
 *
 * D1 的 `free` 是「@ 直通 + 举手 FIFO」。D3 在中间插进一步:举手不再直接排队,而是
 * 攒进**裁决窗**,由裁判对这个触发事件的全部候选**一次**模型调用,输出排序 + 授牌
 * 名单。v2 那侧是每人一次「你要不要说」,八个人的房间买八次调用、八份上下文,而且
 * 每个人只看得见自己那一半 —— 「谁该先说」这个问题在那个形状里根本没人回答。
 *
 * 四条支路,`judgment` 那一格全说了:
 *  1. **没挂裁判 / 私聊房 / 没人举手** → 原地 FIFO。`free` 因此永远是那条不花钱的
 *     路径(§7 风险 3 要的「对照与降级」),而不是"降级模式";
 *  2. **该开窗** → 只放 @ 直通的,手一只不发,请房间开窗(`openJudgment`);
 *  3. **窗开着(`pending`)** → 手继续挂着。**这一条就是 O(1)**:窗开着的时候再来
 *     十只手,也还是那一次调用;
 *  4. **答案回来了(`resolved`)** → 按裁决的次序发牌;`degraded` → 回落第 1 条。
 *
 * `urgency` 与 `why` 在这一档终于有了消费者:它们进裁决的候选行,由裁判在**一次**
 * 判断里统一定夺 —— 而不是每个 agent 自己说了算(那等于给每人一个自评优先级的旋钮)。
 */
export function createCollabFreeFloorPolicy(): CollabFloorPolicy {
  return {
    name: 'free',
    decide(input: CollabFloorDecisionInput): CollabFloorDecision {
      const seats = createSeatTaker(input)
      takeMentioned(input, seats)

      const judgment = input.judgment
      if (judgment?.state === 'pending') {
        // 挂起:手留在队里(房间的队列结算只摘"真发出去了"的那些)。
        return { grants: seats.grants }
      }
      if (judgment?.state === 'resolved') {
        // 裁决的次序是**授牌次序**,不是候选池:只有被点名的人这一轮上场。
        //
        // 没被点名的那几只手**当场放下** —— 但那一步不在这里:decide 是纯决策,
        // 手的增删是账的事(`room-rules.ts` 的队列结算)。这里少发一张牌,那里
        // 少留一只手,同一个决定的两半刻意分在两层,免得策略与账各存一份队列。
        const queued = new Map(input.hands.map(hand => [hand.agentId, hand]))
        for (const agentId of judgment.grants ?? []) {
          const hand = queued.get(agentId)
          if (hand) seats.take(candidateOf(hand))
          // 队里没有这只手 = 它在裁决往返期间已经拿到牌了(比如被 @ 直通)。跳过。
        }
        return { grants: seats.grants }
      }

      const wantsReferee = input.params?.referee === true
        && input.pairDm !== true
        && input.hands.length > 0
      if (wantsReferee && judgment === undefined && seats.seatsLeft() > 0) {
        return { grants: seats.grants, openJudgment: true }
      }

      // 裁判缺席、私聊房、或裁决答不上来 —— D1 的行为,一字不差。
      takeHandsFifo(input, seats)
      return { grants: seats.grants }
    },
  }
}

/* ── ring:接力 ──────────────────────────────────────────────────────────── */

/** 环的构造:名册序 + `order` 的相对次序(`speaking-order.ts` 的既有语义)。 */
function ringOf(input: CollabFloorDecisionInput): string[] {
  const roster: CollabAgentLike[] = input.roster
    ? [...input.roster]
    : (input.members ?? []).map(id => ({ id, name: id }))
  return buildCollabRelayRing({
    ...(input.params?.order ? { speakOrder: input.params.order } : {}),
    members: roster,
  })
}

/** 收棒圈数。0 / 未配 = 不限(与 `maxChain` / `dailyCostUSD` 同一套约定)。 */
function relayLoopsOf(params: CollabFloorPolicyParams | undefined): number {
  const configured = params?.relayLoops
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 0) return 0
  return Math.floor(configured)
}

/**
 * 接力:一个**确定性的环**,棒子依次传(v2 `speaking-order.ts` 的语义在策略接口下重生)。
 *
 * 它存在的理由是一个验收用例:四人房里说一句「按顺序从 1 数到 10」。判定形态下这件事
 * 的成败取决于连续约 30 次独立 yes/no 全部答对,任何一个 no 都让计数静默停住;接力
 * 把它变成确定性的环 —— **一次模型调用都不买**。
 *
 * 四条:
 *  - **@ 定起棒人**:环上最靠前的那位被点名者接棒(次序由房间配置决定,不由用户
 *    敲字的顺序决定 —— 后者正是 `order` 这张表要消除的东西);
 *  - **一次只发一张**:接力就是一根棒子。座位再多也不并发发环上的下一位 —— 那会
 *    让"依次"变成"一起",而选接力的动机恰恰是不要一起;
 *  - **收棒在配置**(`relayLoops`,§8 保留的已拍板决策),不在模型;
 *  - **人类消息重置环**(在 `room-rules.ts` 的清链那一步一起做:清链与重置环是
 *    同一件事的两面 —— 讨论重新开始了)。
 */
export function createCollabRingFloorPolicy(): CollabFloorPolicy {
  return {
    name: 'ring',
    decide(input: CollabFloorDecisionInput): CollabFloorDecision {
      const seats = createSeatTaker(input)
      takeMentioned(input, seats)

      const ring = ringOf(input)
      if (ring.length === 0) return { grants: seats.grants }

      let cursor = input.state?.ringCursor
      let laps = input.state?.ringLaps ?? 0
      // 起棒要有由头:光把模式切成接力,不该让一间空房自己数起数来。
      if (cursor === undefined && !hasTrigger(input)) return { grants: seats.grants }
      // 起棒:@ 到的人里环上最靠前的那位。没 @ 且没走过 → 环首。
      if (cursor === undefined) {
        const starter = pickCollabRelayStarter(ring, input.mentioned)
        cursor = starter ? Math.max(0, ring.indexOf(starter)) : 0
      }

      // 直通拿牌的人如果在环上,**棒子跳到他之后**:他已经在说话了,把棒子再递给
      // 他等于让环卡在原地(下一次决策看到"轮到的人正拿着牌",什么都发不出去)。
      //
      // 跳过不计圈:一次点名不是接力走了一圈,把它算进 `relayLoops` 会让「@ 一下」
      // 白白吃掉用户配的圈数。
      if (seats.grants.length > 0) {
        let furthest = -1
        for (const grant of seats.grants) {
          const index = ring.indexOf(grant.agentId)
          if (index < 0) continue
          furthest = Math.max(furthest, (index - cursor + ring.length) % ring.length)
        }
        if (furthest >= 0) cursor = (cursor + furthest + 1) % ring.length
        // 这一轮已经有人被点名开口了 —— 棒子等他们说完再传(一根棒子)。
        return { grants: seats.grants, state: { ringCursor: cursor, ringLaps: laps } }
      }

      const loops = relayLoopsOf(input.params)
      // 收棒:圈数到顶就不再发牌(§8「接力收棒权在配置,不在模型」)。
      if (loops > 0 && laps >= loops) {
        return { grants: seats.grants, state: { ringCursor: cursor, ringLaps: laps } }
      }

      // 一根棒子:环上找下一个能接的人,最多找一圈(全员都在说话就这轮不发)。
      for (let step = 0; step < ring.length; step += 1) {
        const index = (cursor + step) % ring.length
        const agentId = ring[index]
        const hand = input.hands.find(entry => entry.agentId === agentId)
        // 接力**不要求先举手**:轮到谁谁说,这正是"免判定"的含义。手在队里就带上
        // 它的理由(排障读得出这一棒是怎么来的),不在就记 `relay`。
        const taken = seats.take(hand ? candidateOf(hand) : {
          agentId,
          origin: 'hand',
          reason: 'relay',
          ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        })
        if (!taken) continue
        const next = index + 1
        if (next >= ring.length) laps += 1
        cursor = next % ring.length
        break
      }

      return { grants: seats.grants, state: { ringCursor: cursor, ringLaps: laps } }
    },
  }
}

/* ── waves:编排 ─────────────────────────────────────────────────────────── */

/**
 * 编排:**批内并行、批间串行**(v2 `plan.ts` 的 waves 语义)。
 *
 * 「模式」这个概念在这里消失 —— 并行是"一个 wave",顺序是"N 个单人 wave",
 * 而 `[[a],[b,c]]`(A 先说,B 和 C 补充)是两种模式都表达不了的东西。
 *
 * 批边界怎么推进:**当前批的人全部交牌了,就发下一批**。判据是租约而不是"说没说
 * 话" —— 一个拿了牌却选择沉默的人同样占着这一批,而 v2 数"说了几句"要认 harvest /
 * thinking / pass 三种标记(那正是链账双实现的病根)。
 *
 * 终止:非循环编排走完最后一批就停;`cycle` 的从头再来,由 `relayLoops × 批数`
 * 封顶(与接力共用同一个旋钮 —— 用户面上它就是"一趟最多几圈")。
 *
 * **编排答空 → 回落 `free` 批量裁决**:一份空编排不是"这轮没人说",它是"裁判这次
 * 没给出编排"。让房间就此哑掉的话,一条用户消息会被静默吞掉;交给 `free`,至少
 * 还有裁决 + FIFO 两层接得住。
 */
export function createCollabWavesFloorPolicy(): CollabFloorPolicy {
  const free = createCollabFreeFloorPolicy()
  return {
    name: 'waves',
    decide(input: CollabFloorDecisionInput): CollabFloorDecision {
      const waves = (input.params?.waves ?? []).filter(wave => Array.isArray(wave) && wave.length > 0)
      if (waves.length === 0) return free.decide(input)

      const seats = createSeatTaker(input)
      // @ 机械插批:被点名的人在编排之外直通,不等他那一批(§8「@ = 直通授牌」在
      // 编排下同样成立 —— 一份编排不该让点名落空)。
      takeMentioned(input, seats)

      let waveIndex = input.state?.waveIndex ?? 0
      let waveIssued = input.state?.waveIssued === true
      let waveCount = input.state?.waveCount ?? 0
      const maxWaves = relayLoopsOf(input.params) * waves.length

      // 第一批同样要有由头(见 `hasTrigger`)。生产里这一条从不挡路:裁判下发编排
      // 的那一刻,队里正举着手(那就是裁决窗开着的原因)。它挡的是"没人在等的房
      // 收到一份编排就自己开演"。
      if (!waveIssued && waveCount === 0 && !hasTrigger(input)) {
        return { grants: seats.grants }
      }

      const batchBusy = (index: number): boolean =>
        (waves[index] ?? []).some(agentId => input.holders.has(agentId))

      // 当前批还有人在说 → 什么都不发(批间串行的全部含义)。
      if (waveIssued && batchBusy(waveIndex)) {
        return { grants: seats.grants, state: { waveIndex, waveIssued, waveCount } }
      }
      // 当前批发过牌、人也散了 → 推进到下一批。
      if (waveIssued) {
        const next = waveIndex + 1
        if (next < waves.length) {
          waveIndex = next
        } else if (input.params?.cycle === true) {
          waveIndex = 0
        } else {
          // 编排跑完了。要不要续排是裁判的事(再下发一份新的),不是这里的事。
          return { grants: seats.grants, state: { waveIndex, waveIssued, waveCount } }
        }
        waveIssued = false
      }
      if (maxWaves > 0 && waveCount >= maxWaves) {
        return { grants: seats.grants, state: { waveIndex, waveIssued, waveCount } }
      }

      const queued = new Map(input.hands.map(hand => [hand.agentId, hand]))
      let issued = false
      for (const agentId of waves[waveIndex]) {
        const hand = queued.get(agentId)
        // 编排同样**不要求先举手** —— 编排就是"我安排你说",与接力同一条纪律。
        const taken = seats.take(hand ? candidateOf(hand) : {
          agentId,
          origin: 'hand',
          reason: 'relay',
          ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        })
        issued = issued || taken
      }
      if (issued) {
        waveIssued = true
        waveCount += 1
      }

      return { grants: seats.grants, state: { waveIndex, waveIssued, waveCount } }
    },
  }
}

/* ── phase:换相 ─────────────────────────────────────────────────────────── */

/**
 * 相位控制 —— 狼人杀这类回合制的裁判第一次有了一等表达(§1.5)。
 *
 * 语义只有一句:**当前相位只有 `activeRooms` 里的房能发牌**。夜相激活狼房,群房
 * 的手全部挂起;昼相反转。挂起而不是丢弃 —— 换相后那些手重新参与裁决,否则一个
 * 在夜里举了手的村民,天亮时得再被戳一次才说得上话。
 *
 * 两层门,由粗到细:
 *  1. **房**:`activeRooms` 没列到我 → 一张牌都不发(@ 也不发 —— 相位是硬门,
 *     它管的是"这间房此刻存不存在",而不是"谁优先"。夜里 @ 一个村民,他应该
 *     天亮再说话,不是立刻开口把狼的行动暴露给全场);
 *  2. **人**:`activeMembers` 限定这一相位里谁能开口(狼房里只有狼)。
 *
 * 免裁决:相位表本身就是裁判已经做过的判断,再买一次调用是重复付费。
 */
export function createCollabPhaseFloorPolicy(): CollabFloorPolicy {
  return {
    name: 'phase',
    decide(input: CollabFloorDecisionInput): CollabFloorDecision {
      const activeRooms = input.params?.activeRooms
      // 未配活跃表 = 所有房都活跃(一间没配相位的房不该因为别人换了相位而哑掉)。
      if (activeRooms && input.roomId !== undefined && !activeRooms.includes(input.roomId)) {
        return { grants: [] }
      }

      const active = input.params?.activeMembers
      const allowed = active ? new Set(active) : null
      const scoped: CollabFloorDecisionInput = allowed
        ? {
            ...input,
            mentioned: input.mentioned.filter(agentId => allowed.has(agentId)),
            hands: input.hands.filter(hand => allowed.has(hand.agentId)),
          }
        : input

      const seats = createSeatTaker(scoped)
      takeMentioned(scoped, seats)
      takeHandsFifo(scoped, seats)
      return { grants: seats.grants }
    },
  }
}

/**
 * 按名字取策略。四档齐了 —— 认不出的名字回落 `free` 而不是抛:一间账被写坏成
 * `policy: "rong"` 的房应该照常能说话,而不是整间房打不开。
 */
export function resolveCollabFloorPolicy(name: CollabFloorPolicyName | undefined): CollabFloorPolicy {
  switch (name) {
    case 'ring':
      return createCollabRingFloorPolicy()
    case 'waves':
      return createCollabWavesFloorPolicy()
    case 'phase':
      return createCollabPhaseFloorPolicy()
    case 'free':
    default:
      return createCollabFreeFloorPolicy()
  }
}

/* ── 房间设置 → 策略档 ───────────────────────────────────────────────────── */

/** 房账 `policy` 那一格的形状 —— 映射的产物,也是「换没换档」的比较单位。 */
export interface CollabResolvedFloorPolicy {
  name: CollabFloorPolicyName
  params?: CollabFloorPolicyParams
}

/**
 * 「响应模式三件套」→ 一档发言策略 —— **映射规则的单点**(D6 接线遗漏的补口)。
 *
 * v2 的 `responseMode` 有自己的一条消费链(`isCollabPlanRoom` → planner →
 * plan-runner);D6-b 把那条链整层删掉之后,这三个字段在 v3 一度**没有消费者** ——
 * 房账新建一律 `free`,而换档的唯一动词 `referee:set-floor-policy` 在生产里零发出口。
 * 后果是用户在设置里选的"接力"根本不生效(docs/audit/collab-v3-walkthrough-2026-08-03
 * §1.4)。这个函数就是那条链在 v3 的全部残留:**一次纯翻译**,没有控制流。
 *
 * 三条映射:
 *  - `serial` → `ring`。`speakOrder` 就是环的相对次序(`buildCollabRelayRing` 的
 *    既有语义),`relayLoops` 就是收棒圈数 —— 两个旋钮在 v2 面板上已经是这个意思,
 *    换一套参数名只会让同一个开关在两代之间对不上号;
 *  - `auto` → `waves`。编排本身由裁判下发(`params.waves`),这里只把房间**放到**
 *    编排档上:没有编排时 `waves` 自己回落 `free` 的批量裁决,所以"裁判还没说话"
 *    与"没挂裁判"在行为上是同一件事,不需要第三种状态;
 *  - 其余(`parallel` / 未配 / 认不出)→ `free`。**未配走 free 不走 auto**:
 *    翻默认是一次独立的产品决定,不能由一次接线顺手做掉。
 *
 * `phase` **不在这张表里**:它没有 v2 对应物,是裁判专属的一等表达(相位是跨房的,
 * 而房间设置是单房的)。同样地,一间已经跑在 `phase` 上的房不该被这张表打回 `free`
 * —— 那一侧的守门在 `CollabRoomActor.syncFloorPolicy()`。
 *
 * 私聊房一律 `free`:单成员房用户开口即免判激活唯一那位,双成员房 agent 开口即
 * 激活对面 —— 两种形态本来就是"依次",再套一个环只会把人类也排进去(v2
 * `isCollabPlanRoom` 排除私聊,同一条理由)。
 */
export function resolveCollabRoomFloorPolicy(
  room: CollabRelayRoomLike | null | undefined,
): CollabResolvedFloorPolicy {
  if (!room || room.dm === true) return { name: 'free' }
  // 0 = 不限(与 `maxChain` / `dailyCostUSD` 同一套约定),所以 0 就是"没配",
  // 不必进 params —— 少一个字段,账与快照都少一处噪声。
  const loops = collabRelayLoopsFor(room)
  if (room.responseMode === 'serial') {
    const order = (room.speakOrder ?? []).filter(agentId => typeof agentId === 'string' && agentId.length > 0)
    return withParams('ring', {
      ...(order.length > 0 ? { order: [...order] } : {}),
      ...(loops > 0 ? { relayLoops: loops } : {}),
    })
  }
  if (room.responseMode === 'auto') {
    return withParams('waves', loops > 0 ? { relayLoops: loops } : {})
  }
  return { name: 'free' }
}

/** 空参数袋不进账:`{ name: 'free' }` 与 `{ name: 'free', params: {} }` 是同一件事。 */
function withParams(
  name: CollabFloorPolicyName,
  params: CollabFloorPolicyParams,
): CollabResolvedFloorPolicy {
  return Object.keys(params).length > 0 ? { name, params } : { name }
}

/**
 * 账上这一档,与设置要求的那一档,是同一档吗。
 *
 * 只比**设置管得着**的那几格(档名 + 环序 + 圈数):`waves` 的批次表、`phase` 的
 * 活跃房表都是裁判现场下发的,把它们算进比较,等于让"裁判刚排的编排"每次都被读成
 * 「设置变了」,于是每一次装配都把一份在跑的编排打回原形。
 *
 * `relayLoops` 走 `relayLoopsOf` 而不是直接比字段:`undefined` 与 `0` 在这一族
 * 旋钮里是同一个意思(不限),按字段比会让它们看起来不同。
 */
export function isSameCollabRoomFloorPolicy(
  current: CollabResolvedFloorPolicy,
  desired: CollabResolvedFloorPolicy,
): boolean {
  if (current.name !== desired.name) return false
  if (relayLoopsOf(current.params) !== relayLoopsOf(desired.params)) return false
  const currentOrder = current.params?.order ?? []
  const desiredOrder = desired.params?.order ?? []
  return currentOrder.length === desiredOrder.length
    && currentOrder.every((agentId, index) => desiredOrder[index] === agentId)
}
