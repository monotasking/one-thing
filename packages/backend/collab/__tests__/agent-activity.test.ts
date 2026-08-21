/**
 * Agent 视角的后端半边(docs/design/collab-v3-observability.md §3.1)。
 *
 * 钉四件事:
 *  1. **九格各自从正确的源取数** —— 这条测试的存在理由是那条「不新增一份账」的
 *     纪律:每一格都该指向一个早就存在的真值,而不是一份为了显示而记的副本。
 *     假数据源逐格摆布,断言这一格真的跟着那个源走;
 *  2. **`executing` 联登记簿** —— 「持牌等大脑」与「生成中」的分界,v3 特有的
 *     第三种状态;
 *  3. **发射与节流** —— per-agent 独立槽、双档、窗口里攒成一次尾发、seq 单调;
 *  4. **GET 是读不是写** —— 补水拿到的是当前号,不该显得比刚发出去的那一帧更新。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CollabAgentAccount, CollabRoomAccount } from '@onething/runtime/collab/actors'
import { Interaction } from '@onething/core/interaction'
import { Permission } from '@onething/core/permission'

const mocks = vi.hoisted(() => ({
  emitted: [] as Array<{ sessionId: string; event: Record<string, unknown> }>,
}))

vi.mock('../../events/index.js', () => ({
  getEventBus: () => ({
    emit: async (sessionId: string, event: Record<string, unknown>) => {
      mocks.emitted.push({ sessionId, event })
    },
  }),
}))

const {
  broadcastCollabAgentActivity,
  buildCollabAgentActivity,
  configureCollabAgentActivitySource,
  forgetCollabAgentActivity,
  getCollabAgentActivity,
  shutdownCollabAgentActivity,
} = await import('../agent-activity.js')
const {
  beginCollabV3Turn,
  clearCollabV3Turns,
  endCollabV3Turn,
} = await import('../actors/turn-context.js')

/* ── 假数据源 ─────────────────────────────────────────────────────────────── */

const NOW = 10_000

function account(patch: Partial<CollabAgentAccount> = {}): CollabAgentAccount {
  return {
    version: 1,
    agentId: 'iris',
    rooms: {},
    fold: [],
    foldDropped: 0,
    foldSeen: [],
    hands: [],
    leases: [],
    workerResults: 0,
    workers: [],
    seq: 0,
    ...patch,
  }
}

/** 一间房账 —— 只摆 `heldLeases` 要读的那几格(租约表 + 代数)。 */
function roomAccount(
  roomId: string,
  leases: Array<{ agentId: string; leaseId: string; issuedAt: number; expiresInMs?: number }>,
): CollabRoomAccount {
  return {
    version: 1,
    roomId,
    floor: {
      roomId,
      epoch: 1,
      active: leases.map(lease => ({
        leaseId: lease.leaseId,
        roomId,
        agentId: lease.agentId,
        epoch: 1,
        issuedAt: lease.issuedAt,
        ...(lease.expiresInMs === undefined ? {} : { expiresInMs: lease.expiresInMs }),
      })),
      revoked: [],
    },
    leaseReasons: {},
    hands: [],
    chainCount: 0,
    policy: { name: 'free' },
    broadcasts: [],
    judgmentSeq: 0,
    seq: 0,
  } as unknown as CollabRoomAccount
}

interface Fake {
  inFlight: { roomSessionId: string; since: number } | null
  account: CollabAgentAccount
  inbox: { depth: number; oldestAt?: number }
  deadLetterCount: number
}

let agents: Map<string, Fake>
let rooms: Array<{ roomSessionId: string; account: CollabRoomAccount }>

function serve(agentId: string, patch: Partial<Fake> = {}): void {
  agents.set(agentId, {
    inFlight: null,
    account: account({ agentId }),
    inbox: { depth: 0 },
    deadLetterCount: 0,
    ...patch,
  })
}

function changes(agentId?: string): Array<Record<string, unknown>> {
  return mocks.emitted
    .filter(entry => entry.event.type === 'collab:agent-changed')
    .map(entry => entry.event.activity as Record<string, unknown>)
    .filter(activity => !agentId || activity.agentId === agentId)
}

function targets(): string[] {
  return mocks.emitted
    .filter(entry => entry.event.type === 'collab:agent-changed')
    .map(entry => entry.sessionId)
}

beforeEach(() => {
  vi.useRealTimers()
  shutdownCollabAgentActivity()
  clearCollabV3Turns()
  mocks.emitted.length = 0
  agents = new Map()
  rooms = []
  configureCollabAgentActivitySource({
    agent: agentId => agents.get(agentId),
    agentIds: () => [...agents.keys()],
    rooms: () => rooms,
    now: () => NOW,
  })
})

/* ── 组装:九格逐格 ───────────────────────────────────────────────────────── */

describe('组装', () => {
  it('供数口没装上 → 一份空闲快照,而不是 null(「读不到」与「空闲」必须同一个样子)', () => {
    configureCollabAgentActivitySource(null)
    const activity = buildCollabAgentActivity('ghost')
    expect(activity).toMatchObject({
      agentId: 'ghost',
      mind: { state: 'idle' },
      heldLeases: [],
      inbox: { depth: 0 },
      workers: [],
      deadLetterCount: 0,
    })
    expect(activity.lastSpokeAt).toBeUndefined()
  })

  it('这位同事没在跑循环 → 同样是一份空闲快照', () => {
    expect(buildCollabAgentActivity('nobody').mind).toEqual({ state: 'idle' })
  })

  it('mind 读 AgentActor 的循环状态 —— 一个大脑至多在一间房里想', () => {
    serve('iris', { inFlight: { roomSessionId: 'room-1', since: 900 } })
    expect(buildCollabAgentActivity('iris').mind)
      .toEqual({ state: 'thinking', roomSessionId: 'room-1', since: 900 })
  })

  it('循环状态给不出时退回 turn-context 登记簿(引擎在起流之前落的那一笔)', () => {
    serve('iris')
    beginCollabV3Turn({
      agentId: 'iris',
      roomSessionId: 'room-2',
      execSessionId: 'exec-1',
      leaseId: 'L1',
      epoch: 1,
      startedAt: 777,
    })
    expect(buildCollabAgentActivity('iris').mind)
      .toEqual({ state: 'thinking', roomSessionId: 'room-2', since: 777 })
  })

  it('heldLeases 扫的是**各房账**,不是 agent 账里那份备份', () => {
    // agent 账上还挂着一张早就被换代作废的牌 —— 读它就会画出一张不存在的牌。
    serve('iris', {
      account: account({
        agentId: 'iris',
        leases: [{ roomId: 'room-9', leaseId: 'STALE', epoch: 1, issuedAt: 1 }],
      }),
    })
    rooms = [
      { roomSessionId: 'room-1', account: roomAccount('room-1', [{ agentId: 'iris', leaseId: 'L1', issuedAt: 100 }]) },
      { roomSessionId: 'room-2', account: roomAccount('room-2', [{ agentId: 'bram', leaseId: 'L2', issuedAt: 200 }]) },
    ]
    const leases = buildCollabAgentActivity('iris').heldLeases
    expect(leases).toEqual([
      { roomSessionId: 'room-1', leaseId: 'L1', since: 100, executing: false },
    ])
  })

  it('executing 联登记簿:同一张牌,登记了是 true,没登记是 false', () => {
    serve('iris')
    rooms = [{
      roomSessionId: 'room-1',
      account: roomAccount('room-1', [
        { agentId: 'iris', leaseId: 'L1', issuedAt: 100 },
        { agentId: 'iris', leaseId: 'L2', issuedAt: 110 },
      ]),
    }]
    // 一个人可以同时持两张牌而只在其中一间房里真的动着笔。
    beginCollabV3Turn({
      agentId: 'iris',
      roomSessionId: 'room-1',
      execSessionId: 'exec-1',
      leaseId: 'L1',
      epoch: 1,
      startedAt: 120,
    })
    expect(buildCollabAgentActivity('iris').heldLeases.map(lease => lease.executing))
      .toEqual([true, false])

    endCollabV3Turn('exec-1', 'L1')
    expect(buildCollabAgentActivity('iris').heldLeases.map(lease => lease.executing))
      .toEqual([false, false])
  })

  it('inbox 就是游标差 + 最旧未 ack 的时刻,原样透传', () => {
    serve('iris', { inbox: { depth: 3, oldestAt: 4_242 } })
    expect(buildCollabAgentActivity('iris').inbox).toEqual({ depth: 3, oldestAt: 4_242 })
    // 没有积压时 `oldestAt` 缺席而不是 0 —— 0 会被读成「1970 年就压在那儿了」。
    serve('iris', { inbox: { depth: 0 } })
    expect(buildCollabAgentActivity('iris').inbox).toEqual({ depth: 0 })
  })

  it('workers 读 agent 账的子清单,**不带 summary**(保密纪律 §7)', () => {
    serve('iris', {
      account: account({
        agentId: 'iris',
        workers: [
          { workerId: 'w1', cardId: 'card-1', roomId: 'room-1', startedAt: 500, status: 'running' },
          { workerId: 'w2', cardId: 'card-2', roomId: 'room-2', startedAt: 300, status: 'done', outcome: 'complete' },
        ],
      }),
    })
    const workers = buildCollabAgentActivity('iris').workers
    expect(workers).toEqual([
      { cardId: 'card-1', roomSessionId: 'room-1', status: 'running', since: 500 },
      { cardId: 'card-2', roomSessionId: 'room-2', status: 'done', since: 300 },
    ])
    // 卡号与状态之外一个字都没有:workerId 与 outcome 都不进 wire。
    expect(JSON.stringify(workers)).not.toContain('w1')
    expect(JSON.stringify(workers)).not.toContain('complete')
  })

  it('lastSpokeAt 是各房 lastTurnAt 的最大值 —— 现成的账,不新开写路径', () => {
    serve('iris', {
      account: account({
        agentId: 'iris',
        rooms: {
          'room-1': { turns: 2, lastTurnAt: 500 },
          'room-2': { turns: 1, lastTurnAt: 900 },
          'room-3': { turns: 0 },
        },
      }),
    })
    expect(buildCollabAgentActivity('iris').lastSpokeAt).toBe(900)
  })

  it('deadLetterCount 读 ActorBase 的环长', () => {
    serve('iris', { deadLetterCount: 4 })
    expect(buildCollabAgentActivity('iris').deadLetterCount).toBe(4)
  })

  it('快照永不携带正文(保密纪律 §7)', () => {
    serve('iris', {
      inFlight: { roomSessionId: 'room-1', since: 900 },
      inbox: { depth: 2, oldestAt: 800 },
      account: account({
        agentId: 'iris',
        workers: [{ workerId: 'w1', cardId: 'card-1', roomId: 'room-1', startedAt: 500, status: 'running' }],
      }),
    })
    const serialized = JSON.stringify(buildCollabAgentActivity('iris'))
    expect(serialized).not.toContain('content')
    expect(serialized).not.toContain('summary')
  })

  /**
   * 第十格 `waitingOn`(E6,claude-code-integration-v2 §6)。
   *
   * 它答的是「球在人这边吗」—— 在它之前,一次挂在提问或审批上的等待与「正在写一段
   * 很长的回答」在快照上长得一模一样(F3 里 Iris 挂了 2 分 11 秒,界面只说生成中)。
   */
  describe('waitingOn —— 球在人这边(E6)', () => {
    beforeEach(() => {
      // clearSession 而不是 shutdown:前者**逐条 settle** 再删表(内核纪律),
      // 于是上一条用例挂的那只 deadline 定时器不会活到下一条里去。
      Interaction.clearSession('exec-1')
      Permission.clearSession('exec-1')
    })

    it('没挂任何等待时这一格缺席(不是一个空对象)', () => {
      serve('iris', { inFlight: { roomSessionId: 'room-1', since: 900 } })
      beginCollabV3Turn({
        agentId: 'iris', roomSessionId: 'room-1', execSessionId: 'exec-1',
        leaseId: 'L1', epoch: 1, startedAt: 900,
      })
      expect(buildCollabAgentActivity('iris').waitingOn).toBeUndefined()
    })

    it('提问挂着 → kind=interaction,since 是提问发起的时刻', () => {
      serve('iris', { inFlight: { roomSessionId: 'room-1', since: 900 } })
      beginCollabV3Turn({
        agentId: 'iris', roomSessionId: 'room-1', execSessionId: 'exec-1',
        leaseId: 'L1', epoch: 1, startedAt: 900,
      })
      // 内核自己挂表,不需要 EventBus 在场(E1 的全部意义)。
      void Interaction.ask({
        sessionId: 'exec-1',
        origin: 'external-agent',
        questions: [{ id: 'q1', question: '暖色还是冷色?', options: [{ label: '暖' }] }],
        timeoutMs: 60_000,
      })
      const waitingOn = buildCollabAgentActivity('iris').waitingOn
      expect(waitingOn?.kind).toBe('interaction')
      expect(waitingOn?.since).toBeGreaterThan(0)
      // 大脑那一格照旧说「在想」—— 两件事同时成立,呈现层决定先读哪一句。
      expect(buildCollabAgentActivity('iris').mind.state).toBe('thinking')
    })

    it('会话不在任何一轮 v3 回合里 → 读不到(提问记在执行会话上,房间会话没有 pending)', () => {
      serve('iris', {})
      void Interaction.ask({
        sessionId: 'exec-1',
        origin: 'external-agent',
        questions: [{ id: 'q1', question: '?', options: [] }],
        timeoutMs: 60_000,
      })
      expect(buildCollabAgentActivity('iris').waitingOn).toBeUndefined()
    })
  })
})

/* ── 发射 ─────────────────────────────────────────────────────────────────── */

describe('发射', () => {
  it('播到这位同事此刻牵涉到的那几间房 —— 在飞 / 持牌 / 有手在做', () => {
    serve('iris', {
      inFlight: { roomSessionId: 'room-think', since: 1 },
      account: account({
        agentId: 'iris',
        workers: [
          { workerId: 'w1', cardId: 'c1', roomId: 'room-work', startedAt: 1, status: 'running' },
          // 做完的卡不该让这个人永远给那间房刷快照。
          { workerId: 'w2', cardId: 'c2', roomId: 'room-old', startedAt: 1, status: 'done' },
        ],
      }),
    })
    rooms = [{ roomSessionId: 'room-lease', account: roomAccount('room-lease', [{ agentId: 'iris', leaseId: 'L1', issuedAt: 1 }]) }]

    broadcastCollabAgentActivity('iris')
    expect(new Set(targets())).toEqual(new Set(['room-think', 'room-lease', 'room-work']))
  })

  it('**不丢最后一间**:牌一交,「它停下来了」这一帧仍然送到刚才那间房', async () => {
    vi.useFakeTimers()
    rooms = [{ roomSessionId: 'room-1', account: roomAccount('room-1', [{ agentId: 'iris', leaseId: 'L1', issuedAt: 1 }]) }]
    serve('iris', { inFlight: { roomSessionId: 'room-1', since: 1 } })
    broadcastCollabAgentActivity('iris', { activity: true })
    expect(targets()).toEqual(['room-1'])

    // 交牌 + 回合收尾:这个人已经不"牵涉"任何一间房了。
    rooms = []
    serve('iris')
    mocks.emitted.length = 0
    await vi.advanceTimersByTimeAsync(200)
    broadcastCollabAgentActivity('iris', { activity: true })
    // 只发当前集合的话这里是空的,而那意味着 room-1 的界面永远停在"它在说话"。
    expect(targets()).toEqual(['room-1'])
    expect(changes('iris').at(-1)?.mind).toEqual({ state: 'idle' })

    // 再播一次:上一发的目标已经消费掉,不再无限期地给一间无关的房刷快照。
    mocks.emitted.length = 0
    await vi.advanceTimersByTimeAsync(200)
    broadcastCollabAgentActivity('iris', { activity: true })
    expect(targets()).toEqual([])
    vi.useRealTimers()
  })

  it('seq 每发一次 +1,单调;GET 读的是当前号,**不发号**', () => {
    serve('iris', { inFlight: { roomSessionId: 'room-1', since: 1 } })
    expect(buildCollabAgentActivity('iris').seq).toBe(0)

    broadcastCollabAgentActivity('iris')
    expect(changes('iris').at(-1)?.seq).toBe(1)
    // 纯读不发号:一次冷启动补水不该显得比刚发出去的那一帧更新。
    expect(buildCollabAgentActivity('iris').seq).toBe(1)
    expect(getCollabAgentActivity(['iris'])[0]?.seq).toBe(1)
    expect(buildCollabAgentActivity('iris').seq).toBe(1)
  })

  it('窗口里的多次转变攒成一次尾发,带的是**当下**的状态', async () => {
    vi.useFakeTimers()
    serve('iris', { inFlight: { roomSessionId: 'room-1', since: 1 }, inbox: { depth: 1 } })
    broadcastCollabAgentActivity('iris', { activity: true })   // 立即发一次
    expect(changes('iris')).toHaveLength(1)

    serve('iris', { inFlight: { roomSessionId: 'room-1', since: 1 }, inbox: { depth: 2 } })
    broadcastCollabAgentActivity('iris', { activity: true })
    serve('iris', { inFlight: null, inbox: { depth: 9 } })
    broadcastCollabAgentActivity('iris', { activity: true })
    expect(changes('iris')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(200)
    const all = changes('iris')
    expect(all).toHaveLength(2)
    // 尾发是终态,不是进窗口那一刻的旧值 —— 而终态通常正是"它停下来了"。
    expect(all[1]?.mind).toEqual({ state: 'idle' })
    expect(all[1]?.inbox).toEqual({ depth: 9 })
    vi.useRealTimers()
  })

  it('活动档不必陪普通档等满一秒(双档共用一个待发槽,到期早者赢)', async () => {
    vi.useFakeTimers()
    serve('iris', { inFlight: { roomSessionId: 'room-1', since: 1 } })
    broadcastCollabAgentActivity('iris')            // 立即发一次
    broadcastCollabAgentActivity('iris')            // 普通:排到 1s 之后
    expect(changes('iris')).toHaveLength(1)

    broadcastCollabAgentActivity('iris', { activity: true })  // 要在 120ms 内说
    await vi.advanceTimersByTimeAsync(200)
    expect(changes('iris')).toHaveLength(2)
    vi.useRealTimers()
  })

  it('**per-agent 独立槽**:一个话痨不拖累别人那一格的刷新', async () => {
    vi.useFakeTimers()
    serve('iris', { inFlight: { roomSessionId: 'room-1', since: 1 } })
    serve('bram', { inFlight: { roomSessionId: 'room-1', since: 1 } })

    broadcastCollabAgentActivity('iris')   // iris 立即发,并进入自己的节流窗
    broadcastCollabAgentActivity('iris')   // 被自己的窗压住
    expect(changes('iris')).toHaveLength(1)

    // bram 的槽是干净的 —— 它不该因为 iris 刚说过而被压住。
    broadcastCollabAgentActivity('bram')
    expect(changes('bram')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_100)
    expect(changes('iris')).toHaveLength(2)
    expect(changes('bram')).toHaveLength(1)
    vi.useRealTimers()
  })

  it('收摊 / 忘掉一位同事时清掉待发定时器 —— 一发广播不该活过它的发行方', async () => {
    vi.useFakeTimers()
    serve('iris', { inFlight: { roomSessionId: 'room-1', since: 1 } })
    broadcastCollabAgentActivity('iris')
    broadcastCollabAgentActivity('iris')
    forgetCollabAgentActivity('iris')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(changes('iris')).toHaveLength(1)

    serve('bram', { inFlight: { roomSessionId: 'room-1', since: 1 } })
    broadcastCollabAgentActivity('bram')
    broadcastCollabAgentActivity('bram')
    shutdownCollabAgentActivity()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(changes('bram')).toHaveLength(1)
    vi.useRealTimers()
  })

  it('供数口摘下之后广播是空操作(收摊之后的迟到转变不该再播)', () => {
    serve('iris', { inFlight: { roomSessionId: 'room-1', since: 1 } })
    configureCollabAgentActivitySource(null)
    broadcastCollabAgentActivity('iris')
    expect(changes()).toHaveLength(0)
  })
})

/* ── GET 补水 ─────────────────────────────────────────────────────────────── */

describe('GET 补水', () => {
  it('不带 agentIds = 此刻开着心智循环的全部', () => {
    serve('iris')
    serve('bram')
    expect(getCollabAgentActivity().map(activity => activity.agentId)).toEqual(['iris', 'bram'])
  })

  it('带上就**逐个都有回答**:没在跑循环的回一份空闲快照,不是被跳过', () => {
    serve('iris', { inbox: { depth: 2 } })
    const activities = getCollabAgentActivity(['iris', 'ghost'])
    expect(activities.map(activity => activity.agentId)).toEqual(['iris', 'ghost'])
    expect(activities[1]).toMatchObject({ mind: { state: 'idle' }, inbox: { depth: 0 } })
  })

  it('空数组就是零个 —— 不当成"缺席"再兜回全要', () => {
    serve('iris')
    expect(getCollabAgentActivity([])).toEqual([])
  })

  it('运行时没起 → 空数组', () => {
    configureCollabAgentActivitySource(null)
    expect(getCollabAgentActivity()).toEqual([])
  })
})
