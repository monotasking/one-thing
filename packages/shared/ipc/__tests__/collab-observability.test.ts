/**
 * D8 观测契约的**穷尽守卫**(docs/design/collab-v3-observability.md §3.1/§3.2)。
 *
 * 这两条测试不验行为,它们验的是「有没有人偷偷往 wire 契约上加了一格却没人管」。
 * C3 纪律在 `protocol.ts` 的动词表上已经立过一次:一张字段表 + 双向 `Exclude`,
 * 联合里有而表里没有 → 红,表里有而联合里没有 → 也红。
 *
 * 为什么两个方向都要查:只查一个方向的话,**删掉**一个字段可以悄悄溜过去,而删
 * 字段正是最会让下游静默出错的那一类改动(渲染层读到 `undefined`,画出来的是
 * 一个看起来很正常的空状态)。
 *
 * 表放在测试里而不是源文件里,是因为 `ipc/collab.ts` 是一个**纯类型模块** ——
 * 往它里面塞一个 const 会让每一个 `import type` 的地方多出一段运行时代码。
 * 测试文件同样进 `tsconfig.node.json` 的 include,所以守卫照样在 typecheck 里红。
 */
import { describe, expect, it } from 'vitest'

import { collabRouter } from '../collab.js'
import type {
  CollabAgentActivityGetRequest,
  CollabAgentActivityGetResponse,
  CollabAgentActivitySnapshot,
  CollabAgentHeldLease,
  CollabAgentMind,
  CollabAgentWorkerCard,
  CollabCoordinatorBlockedBy,
  CollabCoordinatorJudgment,
  CollabCoordinatorPhase,
  CollabCoordinatorQueued,
  CollabCoordinatorState,
  CollabCoordinatorTurn,
  CollabSchedulerLogEntry,
  CollabSchedulerLogTailRequest,
  CollabSchedulerLogTailResponse,
} from '../collab.js'

/* ── agent 活动快照(§3.1)────────────────────────────────────────────────── */

const AGENT_ACTIVITY_FIELDS = [
  'agentId',
  'seq',
  'at',
  'mind',
  'heldLeases',
  'inbox',
  'workers',
  'lastSpokeAt',
  'deadLetterCount',
  // E6:第十格 —— 「球在人这边」。见 `CollabAgentActivitySnapshot.waitingOn`。
  'waitingOn',
] as const satisfies readonly (keyof CollabAgentActivitySnapshot)[]

type AgentActivityMissing = Exclude<
  keyof CollabAgentActivitySnapshot,
  (typeof AGENT_ACTIVITY_FIELDS)[number]
>
type AgentActivityStray = Exclude<
  (typeof AGENT_ACTIVITY_FIELDS)[number],
  keyof CollabAgentActivitySnapshot
>
const AGENT_ACTIVITY_IS_EXHAUSTIVE: [AgentActivityMissing] extends [never]
  ? [AgentActivityStray] extends [never]
    ? true
    : never
  : never = true

/* ── GET 补水通道(§3.1,O1)──────────────────────────────────────────────── */

const ACTIVITY_GET_REQUEST_FIELDS = ['agentIds'] as const satisfies
  readonly (keyof CollabAgentActivityGetRequest)[]
type ActivityGetRequestMissing = Exclude<
  keyof CollabAgentActivityGetRequest,
  (typeof ACTIVITY_GET_REQUEST_FIELDS)[number]
>
type ActivityGetRequestStray = Exclude<
  (typeof ACTIVITY_GET_REQUEST_FIELDS)[number],
  keyof CollabAgentActivityGetRequest
>
const ACTIVITY_GET_REQUEST_IS_EXHAUSTIVE: [ActivityGetRequestMissing] extends [never]
  ? [ActivityGetRequestStray] extends [never]
    ? true
    : never
  : never = true

const ACTIVITY_GET_RESPONSE_FIELDS = ['success', 'error', 'activities'] as const satisfies
  readonly (keyof CollabAgentActivityGetResponse)[]
type ActivityGetResponseMissing = Exclude<
  keyof CollabAgentActivityGetResponse,
  (typeof ACTIVITY_GET_RESPONSE_FIELDS)[number]
>
type ActivityGetResponseStray = Exclude<
  (typeof ACTIVITY_GET_RESPONSE_FIELDS)[number],
  keyof CollabAgentActivityGetResponse
>
const ACTIVITY_GET_RESPONSE_IS_EXHAUSTIVE: [ActivityGetResponseMissing] extends [never]
  ? [ActivityGetResponseStray] extends [never]
    ? true
    : never
  : never = true

/* ── 房间快照(§3.2)──────────────────────────────────────────────────────── */

const COORDINATOR_FIELDS = [
  'roomSessionId',
  'mode',
  'frozen',
  'turns',
  'queue',
  'speaking',
  'typing',
  'at',
  'seq',
  'judging',
  'judgingAgentIds',
  'gates',
  'plan',
  'log',
  'judgment',
  'phase',
  'deadLetterCount',
  // E5:撤牌那颗按钮的乐观并发前置条件(界面看见这张牌时房间是第几代)。
  'floorEpoch',
] as const satisfies readonly (keyof CollabCoordinatorState)[]

type CoordinatorMissing = Exclude<keyof CollabCoordinatorState, (typeof COORDINATOR_FIELDS)[number]>
type CoordinatorStray = Exclude<(typeof COORDINATOR_FIELDS)[number], keyof CollabCoordinatorState>
const COORDINATOR_IS_EXHAUSTIVE: [CoordinatorMissing] extends [never]
  ? [CoordinatorStray] extends [never]
    ? true
    : never
  : never = true

/** 六值枚举全表。少一个 = 有一种「排队中」在界面上又变回了笼统词。 */
const BLOCKED_BY: readonly CollabCoordinatorBlockedBy[] = [
  'judging',
  'seats',
  'chain',
  'phase',
  'frozen',
  'budget',
]

describe('D8 观测契约', () => {
  it('agent 活动快照的字段表是穷尽的(§3.1)', () => {
    expect(AGENT_ACTIVITY_IS_EXHAUSTIVE).toBe(true)
    expect(new Set(AGENT_ACTIVITY_FIELDS).size).toBe(AGENT_ACTIVITY_FIELDS.length)
    // 四个必答问题里的第二个(「这个人现在在干嘛」)靠这五格回答,一格都不能少。
    for (const field of ['mind', 'heldLeases', 'inbox', 'workers', 'deadLetterCount'] as const) {
      expect(AGENT_ACTIVITY_FIELDS).toContain(field)
    }
  })

  /**
   * 补水通道:一扇门 + 两个形状。
   *
   * 通道常量那一条断言随 P4a 一起退休 —— collab 域整只搬到了通用 RPC 通道,
   * 门的名字现在是 `collabRouter` 上的一个动词,而动词表本身就是白名单
   * (`registerRouterHandlers` 只绑表上有的方法)。改一处漏一处的那个现场没了。
   */
  it('GET 补水的请求/回应字段表是穷尽的,动词在册(§3.1)', () => {
    expect(ACTIVITY_GET_REQUEST_IS_EXHAUSTIVE).toBe(true)
    expect(ACTIVITY_GET_RESPONSE_IS_EXHAUSTIVE).toBe(true)
    expect(collabRouter.methods).toContain('agentActivityGet')
    // 地址(要问谁)是可选的:缺席 = 此刻开着心智循环的全部。
    const all: CollabAgentActivityGetRequest = {}
    const some: CollabAgentActivityGetRequest = { agentIds: ['iris'] }
    expect(all.agentIds).toBeUndefined()
    expect(some.agentIds).toEqual(['iris'])
  })

  /**
   * 时间轴那扇门(§3.3)。
   *
   * 这里**刻意没有字段穷尽表**:行的完整判别联合(14 类)属主在纯层的
   * `CollabSchedulerLogRow`,契约层只钉住"每一行都有的两格"并整体透传。抄一份
   * 14 类的表进来,就要在每次加一类行时记得改两处 —— 漏掉哪一处都不报错,只是
   * 那一类行在界面上静默地长成一个空白。所以这一条验的是**透传没有丢格**。
   */
  it('时间轴是只读的一扇门:动词在册、两格恒有、其余整体透传(§3.3)', () => {
    expect(collabRouter.methods).toContain('schedulerLogTail')
    // **只读**:这个域的动词表里没有一个往时间轴写的口。
    expect(collabRouter.methods.filter(m => m.startsWith('schedulerLog'))).toEqual(['schedulerLogTail'])

    // 一行 judge-verdict:`why` / `elapsedMs` / `model` 三格是这一行存在的全部
    // 理由(「刚才为什么没人理我」),它们必须原样过得来。
    const verdict: CollabSchedulerLogEntry = {
      at: 1_000,
      type: 'judge-verdict',
      token: 'room#J1',
      order: ['iris'],
      why: '她提的问题',
      elapsedMs: 820,
      model: 'deepseek-chat',
      triggeredBy: 'room#J1',
    }
    expect(verdict.why).toBe('她提的问题')
    expect(verdict.elapsedMs).toBe(820)

    const request: CollabSchedulerLogTailRequest = { roomSessionId: 'room-1' }
    const filtered: CollabSchedulerLogTailRequest = {
      roomSessionId: 'room-1',
      limit: 40,
      types: ['dead-letter'],
    }
    const response: CollabSchedulerLogTailResponse = { success: true, rows: [verdict] }
    expect(request.limit).toBeUndefined()
    expect(filtered.types).toEqual(['dead-letter'])
    expect(response.rows?.[0]?.type).toBe('judge-verdict')
  })

  it('房间快照的字段表是穷尽的,且 D8 三格都在(§3.2)', () => {
    expect(COORDINATOR_IS_EXHAUSTIVE).toBe(true)
    expect(new Set(COORDINATOR_FIELDS).size).toBe(COORDINATOR_FIELDS.length)
    for (const field of ['judgment', 'phase', 'deadLetterCount'] as const) {
      expect(COORDINATOR_FIELDS).toContain(field)
    }
  })

  it('blockedBy 是六值,不多不少 —— 「排队中」的六种成因', () => {
    expect(BLOCKED_BY).toHaveLength(6)
    expect(new Set(BLOCKED_BY).size).toBe(6)
  })

  it('裁决四态是判别联合:降级必带理由、在飞必带候选', () => {
    // 类型层面的断言(能编译 = 形状对);运行时只是把它们摆出来当文档。
    const states: CollabCoordinatorJudgment[] = [
      { state: 'idle' },
      { state: 'debouncing', opensAt: 1 },
      { state: 'inflight', candidates: ['a'], since: 2 },
      { state: 'degraded', reason: 'timeout', at: 3 },
    ]
    expect(states.map(entry => entry.state)).toEqual(['idle', 'debouncing', 'inflight', 'degraded'])
    // 平行布尔画不出这条:降级没有理由这种状态在这里根本组装不出来。
    const degraded = states[3]
    expect(degraded?.state === 'degraded' && degraded.reason).toBe('timeout')
  })

  it('mind 是判别联合 —— 「一个大脑」这条宪法写在类型里', () => {
    const idle: CollabAgentMind = { state: 'idle' }
    const busy: CollabAgentMind = { state: 'thinking', roomSessionId: 'room-1', since: 9 }
    expect(idle.state).toBe('idle')
    // thinking 只有**一个** roomSessionId,不是一张房间表:同一时刻至多在一间房里想。
    expect(busy.state === 'thinking' && busy.roomSessionId).toBe('room-1')
  })

  it('持牌与工作卡带得动「持牌等大脑」与「干活中」两种徽标', () => {
    const lease: CollabAgentHeldLease = {
      roomSessionId: 'room-1',
      leaseId: 'room-1#L1',
      since: 1,
      executing: false,
    }
    const card: CollabAgentWorkerCard = {
      cardId: 'card-1',
      roomSessionId: 'room-1',
      status: 'running',
      since: 2,
    }
    const turn: CollabCoordinatorTurn = {
      agentId: 'a',
      reason: 'mention',
      startedAt: 1,
      agentSessionId: 'room-1#L1',
      executing: false,
    }
    const queued: CollabCoordinatorQueued = {
      id: 'hand:b',
      agentId: 'b',
      reason: 'self-elected',
      blockedBy: 'chain',
    }
    const phase: CollabCoordinatorPhase = { name: 'night', suspendedHands: 2 }
    // 持牌但不在生成 —— v3 特有的第三种状态,v2 的词汇表里没有它。
    expect(lease.executing).toBe(false)
    expect(turn.executing).toBe(false)
    expect(card.status).toBe('running')
    expect(queued.blockedBy).toBe('chain')
    expect(phase.suspendedHands).toBe(2)
  })
})
