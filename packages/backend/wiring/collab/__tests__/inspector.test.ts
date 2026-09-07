/**
 * 协调器状态条的后端半边(docs/design/collab-coordinator-inspector.md)。
 *
 * 钉三件事:快照读的是**运行时本身**(不是第二本账)、「刚才」是定长的、
 * 广播按秒节流但**不丢最后一帧**——最后那一次通常正是"停下来了"这种最该被看见
 * 的状态,丢了界面就永远停在倒数第二帧。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../../session/testing/facade-mock.js'

interface FakeSession {
  id: string
  name: string
  kind?: string
  room?: {
    memberAgentIds: string[]
    frozen?: boolean
    responseMode?: 'auto' | 'parallel' | 'serial'
    speakOrder?: string[]
    relayLoops?: number
    budgets?: { maxChain?: number; maxConcurrentTurns?: number; dailyCostUSD?: number }
  }
  messages: unknown[]
}

const AGENTS: Record<string, { id: string; name: string; status?: string }> = {
  a: { id: 'a', name: '阿般' },
  b: { id: 'b', name: '小李' },
  c: { id: 'c', name: 'Iris' },
}

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  emitted: [] as Array<{ sessionId: string; event: Record<string, unknown> }>,
}))

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../../session/reads.js', () => import('../../../session/testing/facade-mock.js'))
vi.mock('../../../session/commands.js', () => import('../../../session/testing/facade-mock.js'))
bindSessionFacadeMock((id: string) => mocks.sessions.get(id))

vi.mock('@onething/core/storage', () => ({
  readJsonFile: <T>(_path: string, fallback: T) => fallback,
  writeJsonFile: () => {},
}))

vi.mock('@onething/runtime/storage', () => ({ getOnethingStorePath: () => '/tmp/onething-collab-inspector' }))

vi.mock('../../../store.js', () => ({
  // drive 现在要渲染用户署名(v3 V1),因此读一次设置里的身份。
  getSettings: () => ({}),
  getSession: (id: string) => mocks.sessions.get(id),
  getSessionsList: () => [...mocks.sessions.values()],
  addMessage: () => {},
  updateSessionAgent: () => true,
}))

vi.mock('../../../events/index.js', () => ({
  getEventBus: () => ({
    emit: async (sessionId: string, event: Record<string, unknown>) => {
      mocks.emitted.push({ sessionId, event })
    },
  }),
}))

vi.mock('../../engine/index.js', () => ({ getStreamEngineSafe: () => undefined }))
vi.mock('../../agents/index.js', () => ({ findAgent: (id: string) => AGENTS[id] ?? null }))

const {
  broadcastCollabCoordinator,
  buildCollabCoordinatorState,
  forgetCollabInspector,
  noteCollabSchedule,
  setCollabTypingState,
  shutdownCollabInspector,
  configureCollabRoomSnapshotSource,
  configureCollabInspector,
  createCollabInspector,
  getCollabInspector,
  COLLAB_LOG_LIMIT,
} = await import('../inspector.js')
const { emitCollabRoomUpdated } = await import('../room-runtime.js')

/**
 * 房账的**替身**(D6-b)。
 *
 * 调度那几格从 D6-a 起就来自 RoomActor 的账,而这个文件测的从来不是账怎么算 ——
 * 它测的是「拿到一份账之后,seq / typing / 「刚才」怎么盖上去、什么时候播」。
 * 所以这里给一个可以随手摆布的供数口,而不是起一整个 v3 运行时。
 *
 * D6-b 之前这些用例摆布的是 v2 的 `roomRuntime`(`activeTurns` / `queue` /
 * `judgements` / `state.chainCount`)—— 那张表随调度链一起删了,断言的**语义**
 * 一条没变,换的只是同一份数据从哪儿来。
 */
let v3Snapshot: Record<string, unknown> | null = null
function serveSnapshot(patch: Record<string, unknown> | null): void {
  v3Snapshot = patch === null ? null : { ...idleSnapshot(), ...patch }
}
function idleSnapshot(): Record<string, unknown> {
  return {
    roomSessionId: ROOM,
    seq: 0,
    at: 0,
    mode: 'parallel',
    frozen: false,
    speaking: [],
    typing: [],
    turns: [],
    queue: [],
    judging: 0,
    judgingAgentIds: [],
    gates: {
      chain: { value: 0, max: 32 },
      concurrency: { value: 0, max: 6 },
      budget: { value: 0, max: 5 },
    },
    plan: null,
    log: [],
  }
}

const ROOM = 'room-1'

function seed(room: Partial<NonNullable<FakeSession['room']>> = {}): void {
  mocks.sessions.set(ROOM, {
    id: ROOM,
    name: '官网改版组',
    kind: 'room',
    room: { memberAgentIds: ['a', 'b', 'c'], ...room },
    messages: [],
  } satisfies FakeSession)
}

function events(): Array<Record<string, unknown>> {
  return mocks.emitted
    .filter(entry => entry.event.type === 'collab:coordinator-changed')
    .map(entry => entry.event)
}

beforeEach(async () => {
  vi.useRealTimers()
  shutdownCollabInspector()
  const { getSession } = await import('../../../store.js')
  const { getEventBus } = await import('../../../events/index.js')
  configureCollabInspector(createCollabInspector({
    getSession, emit: getEventBus().emit, isActive: () => true, onError: error => { throw error },
  }))
  v3Snapshot = null
  configureCollabRoomSnapshotSource(roomId => (roomId === ROOM ? v3Snapshot : null) as never)
  mocks.sessions.clear()
  mocks.emitted.length = 0
  seed()
})

afterEach(async () => { await getCollabInspector()?.drain(); vi.useRealTimers() })

describe('快照', () => {
  it('不是房间会话 → 没有状态可谈', () => {
    mocks.sessions.set('chat-1', { id: 'chat-1', name: '直聊', messages: [] })
    expect(buildCollabCoordinatorState('chat-1')).toBeNull()
    expect(buildCollabCoordinatorState('nope')).toBeNull()
  })

  it('房账还没建起来时也给完整快照 —— "读不到"和"空闲"在界面上必须一模一样', () => {
    const snapshot = buildCollabCoordinatorState(ROOM)
    expect(snapshot).toMatchObject({
      mode: 'parallel',
      frozen: false,
      turns: [],
      queue: [],
      judging: 0,
      plan: null,
    })
    expect(snapshot?.gates.chain.max).toBe(32)
  })

  it('调度那几格原样透传房账:在跑 / 排队 / 判定在飞 / 链长', () => {
    serveSnapshot({
      turns: [
        { agentId: 'a', reason: 'mention', startedAt: 4_242, agentSessionId: 'agent-exec-a-room-1' },
      ],
      queue: [{ id: 'q1', agentId: 'b', reason: 'self-elected' }],
      judging: 1,
      judgingAgentIds: ['b', 'c'],
      gates: {
        chain: { value: 7, max: 32 },
        concurrency: { value: 1, max: 6 },
        budget: { value: 0, max: 5 },
      },
    })

    const snapshot = buildCollabCoordinatorState(ROOM)
    expect(snapshot?.turns).toEqual([
      { agentId: 'a', reason: 'mention', startedAt: 4_242, agentSessionId: 'agent-exec-a-room-1' },
    ])
    expect(snapshot?.queue).toEqual([{ id: 'q1', agentId: 'b', reason: 'self-elected' }])
    expect(snapshot?.judging).toBe(1)
    // 在问谁也要带出来 —— 常驻条那句「N 人在判断要不要接话」读的就是它,
    // 而在 §8 之前它是个恒空的数组、于是那句话是够不着的死分支。
    expect(snapshot?.judgingAgentIds).toEqual(['b', 'c'])
    expect(snapshot?.gates.chain).toEqual({ value: 7, max: 32 })
    expect(snapshot?.gates.concurrency).toEqual({ value: 1, max: 6 })
  })

  it('**不限的闸序列化成 0,不是 Infinity** —— 后者过不了 JSON,到了界面就是个静默的谎', () => {
    seed({ budgets: { maxChain: 0, maxConcurrentTurns: 0 } })
    const snapshot = buildCollabCoordinatorState(ROOM)
    expect(snapshot?.gates.chain.max).toBe(0)
    expect(snapshot?.gates.concurrency.max).toBe(0)
    expect(JSON.parse(JSON.stringify(snapshot)).gates.chain.max).toBe(0)
  })

  it('预算读的是房账里那份同步缓存 —— 与预算闸比对的是同一个数,而且不碰磁盘', () => {
    serveSnapshot({
      gates: {
        chain: { value: 0, max: 32 },
        concurrency: { value: 0, max: 6 },
        budget: { value: 4.21, max: 5 },
      },
    })
    expect(buildCollabCoordinatorState(ROOM)?.gates.budget).toEqual({ value: 4.21, max: 5 })
  })

  it('编排在飞时给出 waves / 进度 / 理由;没有编排时是 null', () => {
    seed({ responseMode: 'auto' })
    serveSnapshot({
      plan: {
        waves: [['a'], ['b', 'c']],
        waveIndex: 1,
        waveCount: 3,
        cycle: true,
        why: '先让阿般定调',
        loops: 0,
      },
    })
    expect(buildCollabCoordinatorState(ROOM)?.plan).toEqual({
      waves: [['a'], ['b', 'c']],
      waveIndex: 1,
      waveCount: 3,
      cycle: true,
      why: '先让阿般定调',
      loops: 0,
    })

    // 画的是**正在执行的那份编排**,不是从名册现算一个环 —— 现算的环画不出
    // 「b 和 c 一起说」这种批次。
    serveSnapshot({ plan: null })
    expect(buildCollabCoordinatorState(ROOM)?.plan).toBeNull()
  })

  it('mode 三态:显式并行 / 显式顺序 / 其余算智能', () => {
    seed({ responseMode: 'parallel' })
    expect(buildCollabCoordinatorState(ROOM)?.mode).toBe('parallel')
    seed({ responseMode: 'serial' })
    expect(buildCollabCoordinatorState(ROOM)?.mode).toBe('serial')
    seed({ responseMode: 'auto' })
    expect(buildCollabCoordinatorState(ROOM)?.mode).toBe('auto')
  })
})

describe('「刚才」', () => {
  it('记一条就推一次,且带完整快照', () => {
    noteCollabSchedule(ROOM, { kind: 'received' })
    const all = events()
    expect(all).toHaveLength(1)
    expect((all[0].state as { log: unknown[] }).log).toEqual([
      expect.objectContaining({ kind: 'received' }),
    ])
  })

  it('定长:超了从头砍,最新的一定留着', () => {
    for (let index = 0; index < COLLAB_LOG_LIMIT + 10; index++) {
      noteCollabSchedule(ROOM, { kind: 'spoke', agentId: 'a', count: index })
    }
    const log = buildCollabCoordinatorState(ROOM)?.log ?? []
    expect(log).toHaveLength(COLLAB_LOG_LIMIT)
    expect(log.at(-1)).toMatchObject({ count: COLLAB_LOG_LIMIT + 9 })
  })

  it('房间没了,它的「刚才」也没了', () => {
    noteCollabSchedule(ROOM, { kind: 'received' })
    forgetCollabInspector(ROOM)
    expect(buildCollabCoordinatorState(ROOM)?.log).toEqual([])
  })

  it('死房不复活:删房后的异步收尾不再立新表项(有界泄漏,2026-08-02 三审)', () => {
    noteCollabSchedule(ROOM, { kind: 'received' })
    // 删房:会话没了,inspector 表项也清了。
    mocks.sessions.delete(ROOM)
    forgetCollabInspector(ROOM)
    // 被中止回合的异步收尾还会路过 note/broadcast —— 不该重建表项。
    noteCollabSchedule(ROOM, { kind: 'silent', agentId: 'a' })
    broadcastCollabCoordinator(ROOM)
    // 可观测面:同 id 的房间再建起来时,「刚才」必须是空的 —— 表项若在死房期间
    // 被复活过,这里就会带着那条 silent。
    seed()
    expect(buildCollabCoordinatorState(ROOM)?.log).toEqual([])
  })
})

describe('广播节流', () => {
  it('窗口里的多次推送攒成一次尾发,**不丢最后一帧**', async () => {
    vi.useFakeTimers()
    broadcastCollabCoordinator(ROOM)          // 立即发一次(距上次已久)
    expect(events()).toHaveLength(1)

    serveSnapshot({ gates: { chain: { value: 1, max: 32 }, concurrency: { value: 0, max: 6 }, budget: { value: 0, max: 5 } } })
    broadcastCollabCoordinator(ROOM)          // 落进节流窗口
    // 窗口里状态又变了
    serveSnapshot({ gates: { chain: { value: 9, max: 32 }, concurrency: { value: 0, max: 6 }, budget: { value: 0, max: 5 } } })
    broadcastCollabCoordinator(ROOM)
    expect(events()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_100)
    const all = events()
    expect(all).toHaveLength(2)
    // 尾发带的是**当下**的状态,不是进窗口那一刻的旧值。
    expect((all[1].state as { gates: { chain: { value: number } } }).gates.chain.value).toBe(9)
    vi.useRealTimers()
  })

  it('收摊时清掉待发定时器 —— 一次广播不该活过协调器本身', async () => {
    vi.useFakeTimers()
    broadcastCollabCoordinator(ROOM)
    broadcastCollabCoordinator(ROOM)
    shutdownCollabInspector()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(events()).toHaveLength(1)
    vi.useRealTimers()
  })

  /**
   * 活动窗口(架构收敛 C4 §1):「谁在说 / 谁在打字」是界面上会**动**的东西 ——
   * 停止按钮的出现、打字波纹的亮灭。按秒节流的话,想打断的人要等最多一秒按钮
   * 才画出来,而一句短 `say` 的灯会被整个吞掉。
   */
  it('活动转变走短窗口,不必陪一次普通推送等满一秒', async () => {
    vi.useFakeTimers()
    broadcastCollabCoordinator(ROOM)                  // 立即发一次
    broadcastCollabCoordinator(ROOM)                  // 普通推送:排到 1s 之后
    expect(events()).toHaveLength(1)

    setCollabTypingState(ROOM, 'a', true)             // 活动:要在 120ms 内说
    await vi.advanceTimersByTimeAsync(200)
    const all = events()
    expect(all).toHaveLength(2)
    expect((all[1].state as { typing: string[] }).typing).toEqual(['a'])
    vi.useRealTimers()
  })
})

describe('活动快照(C4 §1/§2)', () => {
  it('speaking 是 turns 的超集 —— 举着手/拿着牌还没开口的人也占着位子', () => {
    // 房账里 speaking 是**占用视图**(在外的租约 ∪ 在跑的回合),而 turns 只有
    // 真的在流的那些。喊停对两者同样有效 —— 停止按钮的可见性因此与"停得掉的
    // 东西"同宽,这条不变量在 v2 是 `inFlight ∪ activeTurns`,在 v3 是租约账。
    serveSnapshot({
      turns: [{ agentId: 'a', reason: 'mention', startedAt: 1, agentSessionId: 'agent-exec-a-room-1' }],
      speaking: ['a', 'b'],
    })

    const snapshot = buildCollabCoordinatorState(ROOM)
    expect(snapshot?.turns.map(turn => turn.agentId)).toEqual(['a'])
    expect(new Set(snapshot?.speaking)).toEqual(new Set(['a', 'b']))
  })

  it('房账不存在时 speaking 是空的,而不是读不到', () => {
    expect(buildCollabCoordinatorState(ROOM)?.speaking).toEqual([])
    expect(buildCollabCoordinatorState(ROOM)?.typing).toEqual([])
  })

  it('typing 由灭灯漏斗记账:点亮 → 名单里有,熄灭 → 名单里没有', () => {
    setCollabTypingState(ROOM, 'a', true)
    setCollabTypingState(ROOM, 'b', true)
    expect(buildCollabCoordinatorState(ROOM)?.typing).toEqual(['a', 'b'])

    setCollabTypingState(ROOM, 'a', false)
    expect(buildCollabCoordinatorState(ROOM)?.typing).toEqual(['b'])

    // 没记过的人熄灯是空操作 —— 四个生产点都会兜底发 false。
    setCollabTypingState(ROOM, 'ghost', false)
    expect(buildCollabCoordinatorState(ROOM)?.typing).toEqual(['b'])
  })

  it('seq 单调递增,每广播一次 +1;GET 带的是上一次广播的号', () => {
    expect(buildCollabCoordinatorState(ROOM)?.seq).toBe(0)

    broadcastCollabCoordinator(ROOM)
    const first = events().at(-1)?.state as { seq: number }
    expect(first.seq).toBe(1)
    // 纯读不发号:一次冷启动 GET 不该显得比刚发出去的那一帧更新。
    expect(buildCollabCoordinatorState(ROOM)?.seq).toBe(1)
  })

  it('房间没了,号也从头开始(表项跟着房一起收)', () => {
    broadcastCollabCoordinator(ROOM)
    expect(buildCollabCoordinatorState(ROOM)?.seq).toBe(1)
    forgetCollabInspector(ROOM)
    expect(buildCollabCoordinatorState(ROOM)?.seq).toBe(0)
  })
})

describe('房间配置推送(C4 §3)', () => {
  function updates(): Array<Record<string, unknown>> {
    return mocks.emitted
      .filter(entry => entry.event.type === 'session:collab-updated')
      .map(entry => entry.event)
  }

  it('带全量小快照(房名 + room),读的是刚落下去的那一份', () => {
    seed({ frozen: true, responseMode: 'serial' })
    emitCollabRoomUpdated(ROOM)

    const all = updates()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      name: '官网改版组',
      room: { memberAgentIds: ['a', 'b', 'c'], frozen: true, responseMode: 'serial' },
    })
  })

  it('不是房间会话就没有可播的 —— 一条 room 缺席的推送比不推更坏', () => {
    mocks.sessions.set('chat-1', { id: 'chat-1', name: '直聊', messages: [] })
    emitCollabRoomUpdated('chat-1')
    emitCollabRoomUpdated('nope')
    expect(updates()).toHaveLength(0)
  })
})
