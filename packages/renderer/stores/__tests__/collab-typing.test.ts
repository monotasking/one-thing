/**
 * 「谁在说话 / 谁在打字」的**单一账本**(架构收敛 C4 §1/§2)。
 *
 * 这一面从前钉的是 `collab:typing` 事件的加减账。那本账有两处治不好的病:窗口
 * 重载之后它凭空归零(没有任何补水),而且"迟到的一条 false 抹掉后一轮已经开的
 * true"只能靠各自补一道令牌防线 —— 停止按钮那一侧补了,打字灯这一侧没有。
 *
 * 现在两件事都是**协调器快照**的字段,渲染层只做三件事:按 seq 去序、按快照
 * 时间戳做陈旧兜底、把 speaking / typing 派生出来。事件仍在线上,但这里刻意
 * 不接 —— 接了就是第二本账。
 */
import { readFileSync } from 'node:fs'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollabCoordinatorState } from '@shared/ipc'
import { useCollabBoardStore } from '../collabBoard'

function readRendererFile(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8')
}

const mocks = vi.hoisted(() => ({
  handlers: [] as Array<(envelope: { sessionId: string; event: unknown }) => void>,
  coordinatorGet: vi.fn(async (_request: { roomSessionId: string }) => ({ success: false }) as {
    success: boolean
    state?: CollabCoordinatorState
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

// collab 域走通用 RPC 通道(P4a):方法名是 router 上的动词,入参是信封。
vi.mock('@/platform/collab-client', () => ({
  collabApi: {
    boardGet: vi.fn().mockResolvedValue({ success: false }),
    coordinatorGet: (request: { roomSessionId: string }) => mocks.coordinatorGet(request),
  },
}))

let seq = 0

function snapshot(patch: Partial<CollabCoordinatorState> = {}): CollabCoordinatorState {
  return {
    roomSessionId: 'room-1',
    mode: 'parallel',
    frozen: false,
    seq: ++seq,
    at: Date.now(),
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
    judgment: { state: 'idle' },
    deadLetterCount: 0,
    ...patch,
  }
}

/** 一次协调器广播。 */
function emitSnapshot(sessionId: string, patch: Partial<CollabCoordinatorState> = {}): void {
  const state = snapshot({ roomSessionId: sessionId, ...patch })
  for (const handler of mocks.handlers) {
    handler({ sessionId, event: { type: 'collab:coordinator-changed', state } })
  }
}

beforeEach(() => {
  mocks.handlers.length = 0
  mocks.coordinatorGet.mockReset()
  mocks.coordinatorGet.mockResolvedValue({ success: false })
  seq = 0
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-03T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('collabBoard store: typing 走快照(C4 §2)', () => {
  it('快照点亮、快照熄灭 —— typing 不再是加减出来的账', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    expect(store.typingAgents('room-1')).toEqual([])

    emitSnapshot('room-1', { typing: ['agent-li'] })
    expect(store.typingAgents('room-1')).toEqual(['agent-li'])

    emitSnapshot('room-1', { typing: [] })
    expect(store.typingAgents('room-1')).toEqual([])
  })

  it('名单顺序照抄快照(后端 Set 的插入序 = 谁先开的口)', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    emitSnapshot('room-1', { typing: ['agent-li', 'agent-yan'] })
    expect(store.typingAgents('room-1')).toEqual(['agent-li', 'agent-yan'])

    emitSnapshot('room-1', { typing: ['agent-yan'] })
    expect(store.typingAgents('room-1')).toEqual(['agent-yan'])
  })

  it('按房间分格', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    emitSnapshot('room-1', { typing: ['agent-li'] })
    emitSnapshot('room-2', { typing: ['agent-yan'] })

    expect(store.typingAgents('room-1')).toEqual(['agent-li'])
    expect(store.typingAgents('room-2')).toEqual(['agent-yan'])
    expect(store.typingAgents('room-3')).toEqual([])
  })

  it('陈旧兜底挂在快照时间戳上:60s 没有新快照就忘掉这盏灯', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    emitSnapshot('room-1', { typing: ['agent-li'] })

    vi.advanceTimersByTime(59_000)
    expect(store.typingAgents('room-1')).toEqual(['agent-li'])

    vi.advanceTimersByTime(2_000)
    expect(store.typingAgents('room-1')).toEqual([])
  })

  it('新快照刷新死线', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    emitSnapshot('room-1', { typing: ['agent-li'] })
    vi.advanceTimersByTime(50_000)
    emitSnapshot('room-1', { typing: ['agent-li'] })

    vi.advanceTimersByTime(30_000)
    expect(store.typingAgents('room-1')).toEqual(['agent-li'])
  })

  it('**不再**拿 collab:typing 记账 —— 事件在线上,账本只有快照那一本', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    for (const handler of mocks.handlers) {
      handler({ sessionId: 'room-1', event: { type: 'collab:typing', agentId: 'agent-li', typing: true } })
      handler({ sessionId: 'room-1', event: undefined })
    }
    expect(store.typingAgents('room-1')).toEqual([])

    // 快照才算数。
    emitSnapshot('room-1', { typing: ['agent-li'] })
    expect(store.typingAgents('room-1')).toEqual(['agent-li'])

    // 一条迟到的 false 也抹不掉它 —— 它根本不是账本的输入。
    for (const handler of mocks.handlers) {
      handler({ sessionId: 'room-1', event: { type: 'collab:typing', agentId: 'agent-li', typing: false } })
    }
    expect(store.typingAgents('room-1')).toEqual(['agent-li'])
  })

  it('会话 id 缺失 → 空名单', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    emitSnapshot('room-1', { typing: ['agent-li'] })
    expect(store.typingAgents(undefined)).toEqual([])
    expect(store.typingAgents('')).toEqual([])
  })
})

describe('collabBoard store: 停止按钮与 hasLiveTurn 的同一格(C4 §1)', () => {
  it('speaking 非空 = 有可以停的一轮', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    expect(store.isRoomTurnActive('room-1')).toBe(false)

    emitSnapshot('room-1', { speaking: ['agent-li'], turns: [] })
    expect(store.isRoomTurnActive('room-1')).toBe(true)
    // 同一份快照喂给设置面板那句「将中止正在进行的发言」—— 两处读同一本账。
    expect(store.coordinatorFor('room-1')?.speaking).toEqual(['agent-li'])

    emitSnapshot('room-1', { speaking: [] })
    expect(store.isRoomTurnActive('room-1')).toBe(false)
  })

  it('乱序到达:比屏幕上更旧的快照直接丢掉(seq 去序)', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    for (const handler of mocks.handlers) {
      handler({
        sessionId: 'room-1',
        event: { type: 'collab:coordinator-changed', state: snapshot({ seq: 7, speaking: ['agent-li'] }) },
      })
      // 一条在广播之前发出、之后才回来的 GET 回包。
      handler({
        sessionId: 'room-1',
        event: { type: 'collab:coordinator-changed', state: snapshot({ seq: 3, speaking: [] }) },
      })
    }

    expect(store.isRoomTurnActive('room-1')).toBe(true)
    expect(store.coordinatorFor('room-1')?.seq).toBe(7)

    // 号更大的那一份照收。
    for (const handler of mocks.handlers) {
      handler({
        sessionId: 'room-1',
        event: { type: 'collab:coordinator-changed', state: snapshot({ seq: 8, speaking: [] }) },
      })
    }
    expect(store.isRoomTurnActive('room-1')).toBe(false)
  })

  it('冷启动补水:窗口重载后 GET 一次,停止按钮的账不再丢(每间房只问一次)', async () => {
    const store = useCollabBoardStore()
    mocks.coordinatorGet.mockResolvedValue({
      success: true,
      state: snapshot({ speaking: ['agent-li'], typing: ['agent-li'] }),
    })

    store.ensureCoordinator('room-1')
    await vi.runAllTimersAsync()

    expect(mocks.coordinatorGet).toHaveBeenCalledWith({ roomSessionId: 'room-1' })
    expect(store.isRoomTurnActive('room-1')).toBe(true)
    expect(store.typingAgents('room-1')).toEqual(['agent-li'])

    store.ensureCoordinator('room-1')
    await vi.runAllTimersAsync()
    expect(mocks.coordinatorGet).toHaveBeenCalledTimes(1)
  })
})

/**
 * 接线:四个口径合成一个之后,消费点必须**读同一个派生**。
 *
 * 行为断言(上面那两组)证明账本是对的;这一组证明没人绕过它 —— 一个组件只要
 * 自己再攒一份 typing / turn 账,前面那些断言就全部照样通过,而真机上会重新
 * 出现口径漂移。这个仓库对这类"同一口径的接线"已有先例(useSceneLedger)。
 */
describe('同一账本的接线(C4 §1)', () => {
  const store = readRendererFile('stores/collabBoard.ts')

  it('停止按钮、设置面板那句「将中止正在进行的发言」、「在忙」读的是同一个 selector', () => {
    expect(readRendererFile('components/chat/InputBox.vue'))
      .toContain('collabBoardStore.isRoomTurnActive(sessionId)')
    expect(readRendererFile('components/chat/RoomSettingsDialog.vue'))
      .toContain('collabBoardStore.isRoomTurnActive(props.sessionId)')
    expect(readRendererFile('composables/useSceneLedger.ts'))
      .toContain('collabBoardStore.isRoomTurnActive?.(sessionId)')
  })

  it('store 里不再有第二本账:turn-active 的表和 typing 的表都退役了', () => {
    expect(store).not.toContain('roomTurnAgents')
    expect(store).not.toContain('function setTyping')
    expect(store).not.toContain('function setRoomTurnActive')
  })

  it('speaking / typing 都从协调器快照派生', () => {
    expect(store).toContain('coordinators.value[sessionId]?.speaking')
    expect(store).toContain('snapshot.typing')
  })
})
