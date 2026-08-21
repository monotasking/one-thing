/**
 * RefereeActor —— 「调度即策略,策略即参与者」(docs/design/collab-actor-v3.md §1.5,D3)。
 *
 * 裁判在 v3 里只做两件事,都以**一个动词**落地(`referee:set-floor-policy`):
 *
 *  1. **换档** —— 给一间房下发发言策略(`free` / `ring` / `waves` / `phase`),
 *     以及相位切换(`phase` 的活跃房表);
 *  2. **裁决** —— 房间开了一扇裁决窗时,对**这一个触发事件的全部候选一次模型调用**,
 *     输出授牌次序(qm P0-2:O(N)→O(1))。
 *
 * ## 为什么是独立 actor,不是房间里内嵌的裁决器
 *
 * 三条,由硬到软:
 *
 *  1. **房间的决策必须同步**。金重放与真机走同一行代码是 D1 立下的规矩(重放架的
 *     接缝 `onPosted` 同步返回动词),而一次模型调用不可能同步。裁决器内嵌就意味着
 *     `RoomActor.decide()` 得 `async`,快照那条对照当场失效;
 *  2. **协议里裁判已经是一等身份**(`CollabActorKind = 'referee'`,动词方向
 *     `referee->room`)。把它做成房间的私有方法,等于让蓝图 §1.5 的「策略即参与者」
 *     退回成房间的一个实现细节;
 *  3. **一个裁判管多间房**。狼人杀的换相要同时对狼房和群房下发活跃表 —— 那是一个
 *     跨房的决定,而房间按定义只认识自己。
 *
 * 反过来,裁决的**规则**(材料怎么拼、答案怎么读)不在这里,在纯层的
 * `collab/actors/referee-rules.ts` —— 与 room-rules 分家的同一条理由:金重放要
 * 拿一份脚本化的裁决顶替那次调用,而其余每一行都是真的。
 *
 * ## 它不是 `ActorBase`
 *
 * `ActorBase` 消费的是**协议动词的信封**,而裁判的输入是裁决窗(`CollabRoomJudgmentRequest`)
 * ——一张待办,不是一封信。硬套一个信封类型只是为了长得像 actor,而代价是协议里
 * 多一个没人发的动词。它保留了 actor 真正要紧的那一条纪律:**同一间房同时至多一次
 * 裁决在飞**(见 `inFlight`)。
 *
 * **本期不接引擎、不接宿主**(接线在 D6):模型调用经 `CollabRefereeJudgePort` 注入,
 * 生产适配器在 `referee-judge.ts`(写好,零调用点)—— 与 MindPort 同款纪律。
 */
import type { CollabAgentLike, CollabMessageLike, CollabPlanMemberState } from '@onething/runtime/collab'
import {
  collabRefereeSetFloorPolicy,
  collabRefereeVerdictVerb,
  type CollabActorVerb,
  type CollabFloorPolicyName,
  type CollabFloorPolicyParams,
  type CollabRaisedHand,
  type CollabRefereeVerdict,
  type CollabRoomJudgmentRequest,
} from '@onething/runtime/collab/actors'
import { getLogger } from '../../logging/index.js'

const log = getLogger('collab.referee')


/** 裁判的死线。与 v2 判定同一个档位 —— 裁决是每条房间消息都要付的延迟税。 */
export const COLLAB_REFEREE_TIMEOUT_MS = 8_000

/* ── 端口 ────────────────────────────────────────────────────────────────── */

/** 交给模型的一次裁决 —— 材料已经由 actor 从宿主那里收齐。 */
export interface CollabRefereeJudgeRequest {
  roomId: string
  roomName: string
  token: string
  sourceMessageId?: string
  /** 举了手的人。裁决只在他们之间取舍 —— 裁判没有凭空点人的权力。 */
  candidates: readonly CollabRaisedHand[]
  members: readonly CollabAgentLike[]
  recent: readonly CollabMessageLike[]
  userLabel?: string
  mentionedAgentIds?: readonly string[]
  memberState?: readonly CollabPlanMemberState[]
  constraints?: readonly string[]
  resolvePersona?: (agentId: string) => string | undefined
  resolveAgentName?: (agentId: string) => string | undefined
  signal?: AbortSignal
}

/**
 * 「替这一批候选排个次序」这件事的端口。
 *
 * 与 `CollabMindPort` 同款纪律,买到同样两样东西:**测试里没有模型**(裁决的性质
 * ——O(1)、降级链、@ 直通 —— 靠剧本化的假端口就能钉死),以及 **D6 的接线是换一个
 * 实现,不是改 actor**。
 */
export interface CollabRefereeJudgePort {
  readonly name: string
  judge(request: CollabRefereeJudgeRequest): Promise<CollabRefereeVerdict>
}

/* ── 宿主 ────────────────────────────────────────────────────────────────── */

/** 裁决下发口:把动词投回房间的信箱。 */
export interface CollabRefereeOutbox {
  post(verb: CollabActorVerb): Promise<void> | void
}

export interface CollabRefereeActorHost {
  /**
   * **这一刻**队里还举着的手 —— 真正的候选。
   *
   * 不用开窗那一刻的名单:举手是异步到的(每个 agent 自己的心智循环各自决定要不要
   * 举),开窗那一刻的名单只是下限。真机上「触发 → 开窗」与「agent 收到广播 → 举手」
   * 之间隔着一次投递,不现取的话第一轮几乎总是判一个空名单。
   */
  candidates(roomId: string): readonly CollabRaisedHand[]
  members(roomId: string): readonly CollabAgentLike[]
  /** 房间转录尾巴 —— 压缩窗在纯层裁。 */
  recent(roomId: string): readonly CollabMessageLike[]
  roomLabel?(roomId: string): string | undefined
  userLabel?(roomId: string): string | undefined
  /** 候选行的「他是谁」(persona 节选)。 */
  persona?(agentId: string): string | undefined
  /** 名字解析(离房成员)。 */
  agentName?(agentId: string): string | undefined
  /** 每位候选此刻的状况(在做什么卡、落后几条)。 */
  memberState?(roomId: string): readonly CollabPlanMemberState[]
  /** 约束提示:链闸还剩几条、座位还剩几个。 */
  constraints?(roomId: string): readonly string[]
  /** 这条触发消息 @ 到了谁(他们已经直通授牌)。 */
  mentioned?(roomId: string): readonly string[]
  roomOutbox(roomId: string): CollabRefereeOutbox | undefined
  now(): number
}

export interface CollabRefereeActorOptions {
  refereeId: string
  host: CollabRefereeActorHost
  judge: CollabRefereeJudgePort
  /** 每次裁决的死线。缺省 8s(v2 判定同档)。 */
  timeoutMs?: number
  /** 裁决出错时的观测口。不给就往 console 记一行。 */
  onError?(error: unknown, request: CollabRoomJudgmentRequest): void
  /**
   * 判完一次的观测口(D8 §3.3 的 `judge-verdict` / `judge-degraded` **唯一产生点**)。
   *
   * 挂在这里而不是 `judge` 端口上:端口是可替换的(脚本化的那个也要能被观测到),
   * 而「这间房刚判了一次」这件事的属主只有 actor 一个。
   */
  onJudged?(trace: CollabRefereeTrace): void
}

/** 一次裁决的账 —— 测试与排障读它(判了几次、降级过几次)。 */
export interface CollabRefereeTrace {
  roomId: string
  token: string
  /** 候选数。O(1) 的证据:一次调用覆盖 N 个候选。 */
  candidateCount: number
  grants: string[]
  degraded: boolean
  /** 没买模型调用(没人举手 / 端口都不用问)。 */
  skipped?: boolean
  reason?: 'no-candidates' | 'timeout' | 'error' | 'unreadable'
  /**
   * 这一次判决花了多久(ms),以及裁判给的一句话理由、买调用用的模型。
   *
   * 三格在 D8 之前都是**用完即弃**:`why` 只进了房账的一格(还会被下一次覆盖),
   * `elapsedMs` 与 `model` 根本没人接。「刚才为什么没人理我」从猜变成查,靠的就是
   * 它们落进时间轴(蓝图 §3.3)。
   */
  elapsedMs: number
  why?: string
  model?: string
}

/* ── actor ───────────────────────────────────────────────────────────────── */

export class CollabRefereeActor {
  readonly refereeId: string

  private readonly host: CollabRefereeActorHost
  private readonly judge: CollabRefereeJudgePort
  private readonly timeoutMs: number
  private readonly onError: CollabRefereeActorOptions['onError']
  private readonly onJudged: CollabRefereeActorOptions['onJudged']
  /**
   * 每间房在飞的那一次裁决。
   *
   * 同一间房**至多一次**:房间那侧一扇窗开着的时候不会再开第二扇(那正是 O(1) 的
   * 定义),但重投、续播、以及"窗开了又被人类消息顶掉又开"都可能让同一个 roomId
   * 的请求前后脚到。后到的 token 不同,前一次的答案会被房间按 token 丢掉 ——
   * 这张表让它连发都不发。
   */
  private readonly inFlight = new Map<string, string>()
  private readonly traces: CollabRefereeTrace[] = []

  constructor(options: CollabRefereeActorOptions) {
    this.refereeId = options.refereeId
    this.host = options.host
    this.judge = options.judge
    this.timeoutMs = options.timeoutMs ?? COLLAB_REFEREE_TIMEOUT_MS
    this.onError = options.onError
    this.onJudged = options.onJudged
  }

  /** 判过的每一次。O(1) 的测试数它的长度。 */
  get judgements(): readonly CollabRefereeTrace[] {
    return this.traces
  }

  /**
   * 接住一扇裁决窗,判一批,把裁决下发回房间。
   *
   * **永远会下发一个答案** —— 这是「裁决端口崩溃/超时不悬死房间」的落点:超时、
   * 抛错、读不懂,三种失败都变成一份 `degraded` 裁决,房间据此回落举手 FIFO
   * (= D1 的 `free`,那条不花钱的路径)。什么都不发的话,那扇窗会一直开着,
   * 而窗开着的时候房间不发牌 —— 一次网络抖动会让一间房永久失语。
   */
  async adjudicate(request: CollabRoomJudgmentRequest): Promise<CollabRefereeVerdict> {
    const previous = this.inFlight.get(request.roomId)
    if (previous === request.token) {
      // 同一扇窗重投。答案已经在路上,再判一次就是两次调用判同一件事。
      return { token: request.token, grants: [] }
    }
    this.inFlight.set(request.roomId, request.token)
    try {
      const verdict = await this.run(request)
      await this.deliver(request.roomId, verdict)
      return verdict
    } finally {
      if (this.inFlight.get(request.roomId) === request.token) {
        this.inFlight.delete(request.roomId)
      }
    }
  }

  /** 换档:给一间房下发发言策略。 */
  async setFloorPolicy(
    roomId: string,
    policy: CollabFloorPolicyName,
    params?: CollabFloorPolicyParams,
  ): Promise<void> {
    await this.host.roomOutbox(roomId)?.post(collabRefereeSetFloorPolicy({
      roomId,
      refereeId: this.refereeId,
      policy,
      ...(params ? { params } : {}),
    }))
  }

  /**
   * 换相 —— 狼人杀的夜/昼(§1.5「回合制的裁判第一次有了一等表达」)。
   *
   * 下发给**每一间**参与的房,而不是只给活跃的那几间:一间房要知道自己此刻**不**
   * 活跃,才谈得上把手挂起来等下一相。只通知活跃的那些,不活跃的那几间会拿着上
   * 一相的活跃表继续发牌。
   */
  async changePhase(options: {
    phase: string
    /** 参与这次相位的全部房。 */
    rooms: readonly string[]
    /** 这一相里能发牌的房。 */
    activeRooms: readonly string[]
    /** 这一相里能开口的成员(可选,房内再收一层)。 */
    activeMembers?: readonly string[];
  }): Promise<void> {
    for (const roomId of options.rooms) {
      await this.setFloorPolicy(roomId, 'phase', {
        phase: options.phase,
        activeRooms: [...options.activeRooms],
        ...(options.activeMembers ? { activeMembers: [...options.activeMembers] } : {}),
      })
    }
  }

  /* ── 内部 ──────────────────────────────────────────────────────────────── */

  private async run(request: CollabRoomJudgmentRequest): Promise<CollabRefereeVerdict> {
    // 计时从**接住这扇窗**起算,不是从发出请求起算:候选现取、材料拼装、provider
    // 解析都在这条路上,而「判一次要多久」问的是用户等了多久,不是网络往返多久。
    const startedAt = this.host.now()
    const candidates = this.host.candidates(request.roomId)
    if (candidates.length === 0) {
      // 没人举手 = 没什么可排的。**不买调用** —— 这是一个答案(空裁决),不是失败:
      // 房间据此关窗,而不是回落 FIFO 去发一个空队列。
      this.record({
        roomId: request.roomId,
        token: request.token,
        candidateCount: 0,
        grants: [],
        degraded: false,
        skipped: true,
        reason: 'no-candidates',
        elapsedMs: this.host.now() - startedAt,
      })
      // 空候选集:这次谁都没被判过,房间因此一只手都不放(队里那些是窗开之后才到的)。
      return { token: request.token, grants: [], candidates: [] }
    }

    const members = this.host.members(request.roomId)
    const judgeRequest: CollabRefereeJudgeRequest = {
      roomId: request.roomId,
      roomName: this.host.roomLabel?.(request.roomId) ?? request.roomId,
      token: request.token,
      ...(request.sourceMessageId ? { sourceMessageId: request.sourceMessageId } : {}),
      candidates,
      members,
      recent: this.host.recent(request.roomId),
      ...(this.host.userLabel?.(request.roomId) ? { userLabel: this.host.userLabel(request.roomId)! } : {}),
      ...(this.host.mentioned?.(request.roomId)?.length
        ? { mentionedAgentIds: this.host.mentioned(request.roomId) }
        : {}),
      ...(this.host.memberState?.(request.roomId)?.length
        ? { memberState: this.host.memberState(request.roomId) }
        : {}),
      ...(this.host.constraints?.(request.roomId)?.length
        ? { constraints: this.host.constraints(request.roomId) }
        : {}),
      ...(this.host.persona ? { resolvePersona: agentId => this.host.persona?.(agentId) } : {}),
      ...(this.host.agentName ? { resolveAgentName: agentId => this.host.agentName?.(agentId) } : {}),
    }

    try {
      const verdict = await withRefereeDeadline(
        this.judge.judge(judgeRequest),
        this.timeoutMs,
        { token: request.token, grants: [], degraded: true },
      )
      this.record({
        roomId: request.roomId,
        token: request.token,
        candidateCount: candidates.length,
        grants: [...verdict.grants],
        degraded: verdict.degraded === true,
        ...(verdict.degraded ? { reason: 'unreadable' as const } : {}),
        elapsedMs: this.host.now() - startedAt,
        ...(verdict.why ? { why: verdict.why } : {}),
        ...(verdict.model ? { model: verdict.model } : {}),
      })
      // token 对不上的答案当降级处理:端口答的是另一扇窗,拿它去发牌是错的,而
      // 沉默会把房间挂住。
      if (verdict.token !== request.token) {
        return { token: request.token, grants: [], degraded: true }
      }
      // 判过谁由**这里**说了算,不由端口说了算:候选是这个方法现取的,而
      // 「没被点名的手当场放下」这条规则的分母必须与真正送进模型的那一份一致。
      return { ...verdict, candidates: candidates.map(hand => hand.agentId) }
    } catch (error) {
      if (this.onError) this.onError(error, request)
      else log.error('adjudication failed, falling back to raise-hand FIFO', { roomId: request.roomId }, error)
      this.record({
        roomId: request.roomId,
        token: request.token,
        candidateCount: candidates.length,
        grants: [],
        degraded: true,
        reason: 'error',
        elapsedMs: this.host.now() - startedAt,
      })
      return { token: request.token, grants: [], degraded: true }
    }
  }

  /**
   * 记一次裁决 + 喊一次观测口。**判决账的唯一产生点**。
   *
   * 观测口自己炸了不能反过来打断裁决(与 ActorBase 的 dead-letter 钩子同一条纪律:
   * 观测是旁路,旁路不许改主路的结果)。
   */
  private record(trace: CollabRefereeTrace): void {
    this.traces.push(trace)
    try {
      this.onJudged?.(trace)
    } catch (error) {
      log.warn('adjudication trace hook failed', { roomId: trace.roomId }, error)
    }
  }

  private async deliver(roomId: string, verdict: CollabRefereeVerdict): Promise<void> {
    await this.host.roomOutbox(roomId)?.post(collabRefereeVerdictVerb({
      roomId,
      refereeId: this.refereeId,
      verdict,
    }))
  }
}

/**
 * 死线。超时给回 `fallback`(一份降级裁决),**不抛** —— 抛的话调用方要在两个地方
 * 兜同一件事。与 v2 判定那侧 `withDeadline` 同一个形状,独立一份:那个文件属于 v2
 * 调度链,D6 会整层删掉。
 */
function withRefereeDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work
  return new Promise<T>(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    void work.then(
      value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

/* ── 剧本化的假端口 ─────────────────────────────────────────────────────── */

/** 剧本里的一次裁决:这间房第 N 次被问时,答什么。 */
export interface CollabScriptedJudgement {
  roomId: string
  /** 授牌次序(agentId)。省略 = 空裁决(这轮谁都不该说)。 */
  grants?: string[]
  why?: string
  /** 这一次是哪个模型答的(D8 观测:时间轴上 `judge-verdict` 的 `model` 那一格)。 */
  model?: string
  /** 这一次答不上来 —— 降级链的测试造它。 */
  degraded?: boolean
  /** 这一次直接抛(端口崩溃的测试造它)。 */
  throws?: boolean
  /** 这一次永不返回(超时的测试造它)。 */
  hangs?: boolean
}

export interface CollabScriptedRefereeJudgePort extends CollabRefereeJudgePort {
  /** 收到的每一次请求。**O(1) 的测试数它的长度**。 */
  readonly calls: CollabRefereeJudgeRequest[]
}

/**
 * 按剧本答的假裁判。
 *
 * 与 `createCollabScriptedMindPort` 同一个身份:它住在生产目录里而不是 `__tests__/`
 * 下,因为**金重放要用它**,而金重放是交付物不是测试脚手架。
 *
 * 剧本用完之后一律答**空裁决**(而不是降级):剧本写到哪儿就是这间房被问了几次,
 * 多出来的那些说明测试的预期与实际调用数对不上 —— 用空裁决收场,那个差异会以
 * 「没人说话」的形式立刻暴露,而降级会被 FIFO 悄悄兜住。
 */
export function createCollabScriptedRefereeJudgePort(
  script: readonly CollabScriptedJudgement[] = [],
): CollabScriptedRefereeJudgePort {
  const queue = new Map<string, CollabScriptedJudgement[]>()
  for (const entry of script) {
    const list = queue.get(entry.roomId) ?? []
    list.push(entry)
    queue.set(entry.roomId, list)
  }
  const calls: CollabRefereeJudgeRequest[] = []

  return {
    name: 'scripted',
    calls,
    async judge(request: CollabRefereeJudgeRequest): Promise<CollabRefereeVerdict> {
      calls.push(request)
      const next = queue.get(request.roomId)?.shift()
      if (next?.throws) throw new Error(`[scripted-referee] ${request.roomId} 裁决端口崩了`)
      if (next?.hangs) return new Promise<CollabRefereeVerdict>(() => {})
      return Promise.resolve({
        token: request.token,
        grants: [...(next?.grants ?? [])],
        ...(next?.why ? { why: next.why } : {}),
        ...(next?.model ? { model: next.model } : {}),
        ...(next?.degraded ? { degraded: true } : {}),
      })
    },
  }
}
