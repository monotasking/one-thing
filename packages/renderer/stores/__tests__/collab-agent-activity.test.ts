/**
 * 「这个人现在在干嘛」的**单一账本**(D8 观测体系 §3.1/§4.6)。
 *
 * 这本账与协调器那本是两本互不派生的账,但纪律逐条相同,而三条纪律各自防的是
 * 一类真机上出过的病:
 *  - **seq 去序** —— 广播与冷启动 GET 会赛跑,到达顺序什么都证明不了;
 *  - **每人一次补水** —— 一间八人房开一次面不该打八次以上的 IPC;
 *  - **陈旧兜底挂快照 at** —— 丢一帧「它停下来了」的房间最多顶十分钟旧样子,
 *    而不是永远亮着一颗「在思考」。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollabAgentActivitySnapshot } from '@shared/ipc'
import { useCollabBoardStore } from '../collabBoard'

const mocks = vi.hoisted(() => ({
  handlers: [] as Array<(envelope: { sessionId: string; event: unknown }) => void>,
  agentActivityGet: vi.fn(async (_request: { agentIds?: string[] }) => ({ success: false }) as {
    success: boolean
    activities?: CollabAgentActivitySnapshot[]
  }),
}))

vi.mock('@/platform', () => ({
  platformApi: {
    onSessionEvent: (handler: (envelope: { sessionId: string; event: unknown }) => void) => {
      mocks.handlers.push(handler)
      return () => {}
    },
  },
}))

// collab 域走通用 RPC 通道(P4a):方法名是 router 上的动词,入参是信封 ——
// `agentIds` 缺席时发的是 `{}`,而不是一个位置上的 undefined。
vi.mock('@/platform/collab-client', () => ({
  collabApi: {
    boardGet: vi.fn().mockResolvedValue({ success: false }),
    coordinatorGet: vi.fn().mockResolvedValue({ success: false }),
    agentActivityGet: (request: { agentIds?: string[] }) => mocks.agentActivityGet(request),
  },
}))

function activity(
  agentId: string,
  patch: Partial<CollabAgentActivitySnapshot> = {},
): CollabAgentActivitySnapshot {
  return {
    agentId,
    seq: 1,
    at: Date.now(),
    mind: { state: 'idle' },
    heldLeases: [],
    inbox: { depth: 0 },
    workers: [],
    deadLetterCount: 0,
    ...patch,
  }
}

/** 一次 agent 广播(信封挂在房上,账按 agentId 归)。 */
function emit(sessionId: string, snapshot: CollabAgentActivitySnapshot): void {
  for (const handler of mocks.handlers) {
    handler({ sessionId, event: { type: 'collab:agent-changed', activity: snapshot } })
  }
}

describe('collabBoard 的 agents 账', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.handlers = []
    mocks.agentActivityGet.mockReset()
    mocks.agentActivityGet.mockResolvedValue({ success: false })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('广播落账,按 agentId 归 —— 同一个人从两间房各来一份也只有一格', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    emit('room-1', activity('ana', { seq: 3, mind: { state: 'thinking', roomSessionId: 'room-1', since: 10 } }))
    emit('room-2', activity('ana', { seq: 3, mind: { state: 'thinking', roomSessionId: 'room-1', since: 10 } }))
    emit('room-1', activity('bo', { seq: 1 }))

    expect(Object.keys(store.agents).sort()).toEqual(['ana', 'bo'])
    expect(store.agentActivityFor('ana')?.mind).toEqual({
      state: 'thinking',
      roomSessionId: 'room-1',
      since: 10,
    })
  })

  it('比屏幕上更旧的一份丢掉 —— 号小就不算数', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    emit('room-1', activity('ana', { seq: 5, inbox: { depth: 7 } }))
    // 迟到的旧包(比如一次在广播之前发出的 GET 回来了)。
    emit('room-1', activity('ana', { seq: 2, inbox: { depth: 0 } }))
    expect(store.agentActivityFor('ana')?.inbox.depth).toBe(7)

    // 新的照收。
    emit('room-1', activity('ana', { seq: 6, inbox: { depth: 9 } }))
    expect(store.agentActivityFor('ana')?.inbox.depth).toBe(9)
  })

  it('缺 seq 的旧数据读作 0,照收不冻住', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()
    const legacy = { ...activity('ana', { inbox: { depth: 4 } }) } as Partial<CollabAgentActivitySnapshot>
    delete legacy.seq
    emit('room-1', legacy as CollabAgentActivitySnapshot)
    expect(store.agentActivityFor('ana')?.inbox.depth).toBe(4)
  })

  it('冷启动补水每人只问一次,之后跟着广播走', async () => {
    mocks.agentActivityGet.mockResolvedValue({
      success: true,
      activities: [activity('ana', { seq: 2 }), activity('bo', { seq: 2 })],
    })
    const store = useCollabBoardStore()

    store.ensureAgentActivity(['ana', 'bo'])
    await vi.waitFor(() => expect(Object.keys(store.agents).sort()).toEqual(['ana', 'bo']))

    store.ensureAgentActivity(['ana', 'bo'])
    store.ensureAgentActivity(['ana'])
    expect(mocks.agentActivityGet).toHaveBeenCalledTimes(1)

    // 没问过的人照旧要问。
    store.ensureAgentActivity(['cy'])
    expect(mocks.agentActivityGet).toHaveBeenCalledTimes(2)
    expect(mocks.agentActivityGet).toHaveBeenLastCalledWith({ agentIds: ['cy'] })
  })

  it('广播先到的人不再补水 —— 事件已经把那一格填满了', async () => {
    mocks.agentActivityGet.mockResolvedValue({ success: true, activities: [] })
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    emit('room-1', activity('ana', { seq: 4 }))
    store.ensureAgentActivity(['ana'])
    expect(mocks.agentActivityGet).not.toHaveBeenCalled()
  })

  it('补水的答案同样走去序 —— 迟到的 GET 顶不掉更新的广播', async () => {
    type GetResolver = (value: { success: boolean; activities?: CollabAgentActivitySnapshot[] }) => void
    const pending: GetResolver[] = []
    mocks.agentActivityGet.mockImplementation(
      () => new Promise(resolve => { pending.push(resolve as GetResolver) }),
    )
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    store.ensureAgentActivity(['ana'])
    // 广播先落账(号 9),在飞的那次 GET 之后才回来(号 4)—— 它已经过期了。
    emit('room-1', activity('ana', { seq: 9, inbox: { depth: 3 } }))
    pending[0]?.({ success: true, activities: [activity('ana', { seq: 4, inbox: { depth: 0 } })] })
    await vi.waitFor(() => expect(store.agentActivityFor('ana')).toBeTruthy())

    expect(store.agentActivityFor('ana')?.inbox.depth).toBe(3)
  })

  it('不带 agentIds 就是「全要」,而且不进每人一次的去重表', () => {
    mocks.agentActivityGet.mockResolvedValue({ success: true, activities: [] })
    const store = useCollabBoardStore()

    store.ensureAgentActivity()
    store.ensureAgentActivity()
    expect(mocks.agentActivityGet).toHaveBeenCalledTimes(2)
    expect(mocks.agentActivityGet).toHaveBeenLastCalledWith({})
  })

  it('陈旧的一份读作没有 —— 兜底挂在快照的 at 上,读的时候判', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T12:00:00Z'))
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    emit('room-1', activity('ana', {
      seq: 1,
      at: Date.now(),
      mind: { state: 'thinking', roomSessionId: 'room-1', since: Date.now() },
    }))
    expect(store.agentActivityFor('ana')?.mind.state).toBe('thinking')

    // 九分钟:一个长回合完全可能这么久,还算数。
    vi.advanceTimersByTime(9 * 60_000)
    expect(store.agentActivityFor('ana')?.mind.state).toBe('thinking')

    // 过了十分钟就不再算数 —— 但账本身没被删,下一发广播照旧顶上来。
    vi.advanceTimersByTime(2 * 60_000)
    expect(store.agentActivityFor('ana')).toBeNull()
    expect(store.agents.ana).toBeDefined()
  })

  it('读不到与空闲在界面上是同一个样子(都给 null,不给加载态)', () => {
    const store = useCollabBoardStore()
    expect(store.agentActivityFor('nobody')).toBeNull()
    expect(store.agentActivityFor('')).toBeNull()
    expect(store.agentActivityFor(null)).toBeNull()
  })
})
