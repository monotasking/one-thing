/**
 * 跨房唤醒的兑现器(docs/design/collab-send-channel-and-wake.md §3)。
 *
 * 四件事,每一件都是"漏了就静默失效"的那一类:
 *  1. **时机**:等对方在私聊房里的那一轮 settle,不是 dm 一落库就兑现 —— 否则
 *     群里那句「收到」跟状态板在竞速;
 *  2. **兜底**:120s 没等到就照发 —— 冻结/退休/预算把激活拦在驱动侧时,那间房
 *     根本不会有回合窗口,发起方却在等;
 *  3. **形状**:poke 是一条以**发起人**身份、落进 wakeRoom 的普通消息,内容是
 *     固定模板;随后链闸清零 + 显式入队(与跨房 dm 注入同规则);
 *  4. **只发一次**:兑现前先注销,免得 settle 与超时各发一条。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type BusHandler = (envelope: { event?: Record<string, unknown> }) => void

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Set<BusHandler>>(),
  said: [] as Array<{ sessionId: string; content: string; room?: string }>,
  sayResult: { ok: true, messageId: 'poke-1' } as { ok: boolean; messageId?: string; error?: string },
  notes: [] as Array<{ roomSessionId: string; entry: Record<string, unknown> }>,
}))

vi.mock('../../events/index.js', () => ({
  getEventBus: () => ({
    onAny(sessionId: string, handler: BusHandler) {
      const set = mocks.handlers.get(sessionId) ?? new Set<BusHandler>()
      set.add(handler)
      mocks.handlers.set(sessionId, set)
      return () => { set.delete(handler) }
    },
  }),
}))

vi.mock('../../wiring/agents/index.js', () => ({
  findAgent: (id: string) => (id === 'pm' ? { id: 'pm', name: '阿明' } : null),
}))

vi.mock('../say-tool.js', () => ({
  speakIntoCollabRoom: async (input: { sessionId: string; content: string; room?: string }) => {
    mocks.said.push(input)
    return mocks.sayResult
  },
}))

vi.mock('../inspector.js', () => ({
  noteCollabSchedule: (roomSessionId: string, entry: Record<string, unknown>) => {
    mocks.notes.push({ roomSessionId, entry })
  },
}))

const {
  COLLAB_WAKE_TIMEOUT_MS,
  clearCollabWakeFollowups,
  pendingCollabWakeCount,
  registerCollabWakeFollowup,
} = await import('../wake-followup.js')

const DM_ROOM = 'agent-dm-room-fe--pm'
const GAME_ROOM = 'room-game'

function register(): void {
  registerCollabWakeFollowup({
    dmRoomSessionId: DM_ROOM,
    targetAgentId: 'pm',
    wakeRoomSessionId: GAME_ROOM,
    senderSessionId: 'agent-exec-fe-room-game',
    senderAgentId: 'fe',
    sinceMessageId: 'msg-1',
  })
}

/** 那间私聊房里的回合窗口边(turn.ts 的 `emitCollabTurnActive`)。 */
function turnActive(agentId: string, active: boolean): void {
  for (const handler of mocks.handlers.get(DM_ROOM) ?? []) {
    handler({ event: { type: 'collab:turn-active', agentId, active } })
  }
}

/** 等兑现那条 async 链跑完(兑现是在事件回调里 fire-and-forget 起的)。 */
async function settleMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.handlers.clear()
  mocks.said.length = 0
  mocks.notes.length = 0
  mocks.sayResult = { ok: true, messageId: 'poke-1' }
})

afterEach(() => {
  clearCollabWakeFollowups()
  vi.useRealTimers()
})

describe('兑现时机', () => {
  it('对方回合 settle → poke 落群(带清零标记)', async () => {
    register()
    expect(pendingCollabWakeCount()).toBe(1)

    // 回合开始那一边什么都不做:settle 是**落**边。
    turnActive('pm', true)
    await settleMicrotasks()
    expect(mocks.said).toEqual([])

    turnActive('pm', false)
    await settleMicrotasks()

    // poke 以发起人的会话身份说,落进 wakeRoom,内容是固定模板。
    expect(mocks.said).toEqual([{
      sessionId: 'agent-exec-fe-room-game',
      content: '@阿明#pm 我在私聊里给你发了消息 —— 看完后请回到这里回应。',
      room: GAME_ROOM,
      // 清零的可重放那一半:标记落在 poke 这条消息上,boot 重算认它(A2)。
      chainReset: true,
    }])
    // 由头来自别处的一个回合 = 新的外部输入(collab-turn-protocol-and-identity.md C)。
    // **清链与激活都归房间**(D6-b):poke 是一条普通的 say,RoomActor 收到带
    // `chainReset` 的 posted 之后自己清链、按 @ 直通授牌。此前这里还手工改一遍
    // 内存 `chainCount` 并显式 enqueue —— 两段随 v2 调度链一起删了,所以这一面
    // 只剩「poke 有没有带着标记落进那间群」这一个断言。
    expect(pendingCollabWakeCount()).toBe(0)
  })

  it('别人的回合 settle 不算数', async () => {
    register()
    turnActive('other', false)
    await settleMicrotasks()
    expect(mocks.said).toEqual([])
    expect(pendingCollabWakeCount()).toBe(1)
  })

  it('120s 没等到就照发 —— 激活被冻结/预算拦掉时那间房不会有回合窗口', async () => {
    register()
    await vi.advanceTimersByTimeAsync(COLLAB_WAKE_TIMEOUT_MS - 1)
    expect(mocks.said).toEqual([])

    await vi.advanceTimersByTimeAsync(2)
    await settleMicrotasks()
    expect(mocks.said).toHaveLength(1)
  })

  it('只发一次:settle 之后超时不再补一条', async () => {
    register()
    turnActive('pm', false)
    await settleMicrotasks()
    await vi.advanceTimersByTimeAsync(COLLAB_WAKE_TIMEOUT_MS * 2)
    await settleMicrotasks()
    expect(mocks.said).toHaveLength(1)
  })

  it('同一对人重复登记不叠第二条 poke', async () => {
    register()
    register()
    expect(pendingCollabWakeCount()).toBe(1)
    turnActive('pm', false)
    await settleMicrotasks()
    expect(mocks.said).toHaveLength(1)
  })
})

describe('兑现时失败:只留痕,不回执', () => {
  it('冻结/超预算 → poke 不落,inspector 里有一条', async () => {
    mocks.sayResult = { ok: false, error: '消息未送达:这个群聊已被暂停(总闸)。' }
    register()
    turnActive('pm', false)
    await settleMicrotasks()

    expect(mocks.notes).toHaveLength(1)
    expect(mocks.notes[0]).toMatchObject({
      roomSessionId: GAME_ROOM,
      entry: { kind: 'blocked', agentId: 'pm' },
    })
  })
})

describe('收摊', () => {
  it('clear 拆掉订阅与定时器 —— 之后既不会被 settle 也不会被超时叫醒', async () => {
    register()
    clearCollabWakeFollowups()
    expect(pendingCollabWakeCount()).toBe(0)

    turnActive('pm', false)
    await vi.advanceTimersByTimeAsync(COLLAB_WAKE_TIMEOUT_MS * 2)
    await settleMicrotasks()
    expect(mocks.said).toEqual([])
  })
})
