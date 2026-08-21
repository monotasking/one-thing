// @vitest-environment happy-dom
/**
 * 已读水位与未读判定(docs/design/agent-im-dm.md §6 P4 / D9)。
 *
 * 徽标的价值全在"不误报"上:红点误报一次,用户就再也不看它了。所以这里钉的
 * 主要不是"能亮",而是**什么时候绝不该亮**:
 * - 首次启用(存量会话一条水位都没有)不许全量爆红;
 * - 自己刚说完的会话不许被自己标未读;
 * - 正看着的会话不许标未读;
 * - 系统台账行(预算/断路器)不是"有人跟你说话"。
 *
 * 判定只有 store 那一处(`isUnreadSession`),所以这里对着它测,不去测各消费点。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionsStore } from '../sessions'
import {
  parsePersistedReadMarks,
  serializeReadMarks,
  type PersistedSessionReadMarks,
} from '../session-read-marks'

const saveUIState = vi.hoisted(() =>
  vi.fn(async (_patch: Record<string, unknown>) => ({ success: true })),
)
// 「屏幕上有哪些会话」由工作区回答。这里把它替成一个可控的集合:本文件测的是
// 水位规则,不是分栏树 —— `visibleSessionIds` 自己的真身在 workspace.test.ts。
const visible = vi.hoisted(() => new Set<string>())

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    },
  })
})

vi.mock('@/platform', () => ({
  platformApi: {
    capabilities: { collabRooms: true },
  },
}))

// app-state 域已迁到通用 RPC 通道(P4c):水位落盘走壳外客户端 `appStateApi`,
// 不再是 platformApi 上的 saveUIState。
vi.mock('@/platform/app-state-client', () => ({
  appStateApi: {
    get: vi.fn(async () => ({ currentSessionId: '', currentWorkspaceId: null })),
    saveUiState: (patch: Record<string, unknown>) => saveUIState(patch),
  },
}))

vi.mock('../workspace', () => ({
  useWorkspaceStore: () => ({
    hydrated: true,
    visibleSessionIds: visible,
    openSession: () => {},
  }),
}))

const T0 = 1_700_000_000_000

function seed() {
  const store = useSessionsStore()
  store.sessions.push(
    {
      id: 'agent-dm-fe',
      name: '小李',
      kind: 'room',
      room: { dm: true, memberAgentIds: ['fe'] },
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: 'room-1',
      name: '官网改版组',
      kind: 'room',
      room: { memberAgentIds: ['fe', 'pm'] },
      createdAt: T0,
      updatedAt: T0,
    },
    { id: 'chat-1', name: '普通会话', createdAt: T0, updatedAt: T0 },
  )
  return store
}

/** 把某个会话放到"屏幕上"(= 某个分栏的当前页签)。 */
function showOnScreen(sessionId: string): void {
  visible.add(sessionId)
}

beforeEach(() => {
  setActivePinia(createPinia())
  visible.clear()
  saveUIState.mockClear()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} })
})

describe('首启:没有水位 = 已读到当前', () => {
  it('存量会话一条水位都没有时,谁都不未读(不全量爆徽标)', () => {
    const store = seed()
    store.hydrateReadMarks(null)
    expect(store.unreadSessionIds.size).toBe(0)
    expect(store.isUnreadSession('agent-dm-fe')).toBe(false)
    expect(store.isUnreadSession('room-1')).toBe(false)
    expect(store.isUnreadSession('chat-1')).toBe(false)
  })

  it('水位从此刻起算:启用之后来的对方消息才算未读', () => {
    const store = seed()
    store.hydrateReadMarks(null)
    store.noteInboundActivity('agent-dm-fe', T0 + 1000)
    expect(store.isUnreadSession('agent-dm-fe')).toBe(true)
    expect(store.isUnreadSession('room-1')).toBe(false)
  })
})

describe('未读判定', () => {
  it('对方消息晚于水位 = 未读', () => {
    const store = seed()
    store.hydrateReadMarks(null)
    store.markSessionRead('room-1', T0 + 100)
    store.noteInboundActivity('room-1', T0 + 200)
    expect(store.isUnreadSession('room-1')).toBe(true)
    expect([...store.unreadSessionIds]).toEqual(['room-1'])
  })

  it('自己说话推进水位 —— 刚说完的会话不会被自己标未读', () => {
    const store = seed()
    store.hydrateReadMarks(null)
    store.noteInboundActivity('room-1', T0 + 200)
    expect(store.isUnreadSession('room-1')).toBe(true)
    // 用户自己在这间房里说了一句(ingress 的 message:user-created)。
    store.markSessionRead('room-1', T0 + 300)
    expect(store.isUnreadSession('room-1')).toBe(false)
  })

  it('正打开(可见 + 窗口在前台)的会话来消息也不未读', () => {
    const store = seed()
    store.hydrateReadMarks(null)
    showOnScreen('agent-dm-fe')
    store.noteInboundActivity('agent-dm-fe', T0 + 500)
    expect(store.isUnreadSession('agent-dm-fe')).toBe(false)
    // 而且切走之后也不会补冒出来 —— 水位已经推过去了。
    expect(store.readMarks.get('agent-dm-fe')?.readAt).toBe(T0 + 500)
  })

  it('人不在场(窗口失焦)时来的消息照常攒着,回到前台一次清掉', () => {
    const store = seed()
    store.hydrateReadMarks(null)
    showOnScreen('agent-dm-fe')
    store.setWindowFocused(false)
    store.noteInboundActivity('agent-dm-fe', T0 + 600)
    expect(store.isUnreadSession('agent-dm-fe')).toBe(true)

    store.setWindowFocused(true)
    expect(store.isUnreadSession('agent-dm-fe')).toBe(false)
  })

  it('后台页签不算看见:开着但被盖住的会话照样未读', () => {
    const store = seed()
    store.hydrateReadMarks(null)
    // room-1 也开着,但当前页签停在私聊房 —— 只有私聊房在 visible 集合里。
    showOnScreen('agent-dm-fe')
    store.noteInboundActivity('room-1', T0 + 700)
    expect(store.isUnreadSession('room-1')).toBe(true)
    expect(store.isUnreadSession('agent-dm-fe')).toBe(false)
  })

  it('时间只进不退:乱序/重放的旧消息拖不回水位', () => {
    const store = seed()
    store.hydrateReadMarks(null)
    store.noteInboundActivity('room-1', T0 + 900)
    store.noteInboundActivity('room-1', T0 + 100)
    expect(store.readMarks.get('room-1')?.inboundAt).toBe(T0 + 900)
    store.markSessionRead('room-1', T0 + 1000)
    store.markSessionRead('room-1', T0 + 10)
    expect(store.readMarks.get('room-1')?.readAt).toBe(T0 + 1000)
  })

  it('空 id / 非法时间戳一律不写账', () => {
    const store = seed()
    store.hydrateReadMarks(null)
    store.noteInboundActivity('', T0 + 100)
    store.noteInboundActivity('room-1', Number.NaN)
    store.markSessionRead('', T0 + 100)
    expect(store.readMarks.size).toBe(0)
    expect(store.isUnreadSession(null)).toBe(false)
    expect(store.isUnreadSession(undefined)).toBe(false)
  })
})

describe('持久化与重启存活', () => {
  it('水位落盘走 UI 状态(app-state),不碰会话文件', async () => {
    vi.useFakeTimers()
    try {
      const store = seed()
      store.hydrateReadMarks(null)
      store.noteInboundActivity('agent-dm-fe', T0 + 100)
      await vi.advanceTimersByTimeAsync(500)
      expect(saveUIState).toHaveBeenCalled()
      const patch = saveUIState.mock.calls.at(-1)?.[0] as unknown as {
        sessionReadMarks: PersistedSessionReadMarks
      }
      expect(patch.sessionReadMarks.version).toBe(1)
      expect(patch.sessionReadMarks.marks['agent-dm-fe'].inboundAt).toBe(T0 + 100)
      // 只写这一把钥匙:工作区分栏树等其他 UI 状态不该被顺手改写。
      expect(Object.keys(patch)).toEqual(['sessionReadMarks'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('重启:恢复出来的水位仍然判定未读', () => {
    const store = seed()
    store.hydrateReadMarks({
      version: 1,
      marks: { 'room-1': { readAt: T0 + 100, inboundAt: T0 + 200 } },
    })
    expect(store.isUnreadSession('room-1')).toBe(true)
  })

  it('恢复时正被看着的那个会话不带着旧红点回来', () => {
    const store = seed()
    showOnScreen('agent-dm-fe')
    store.hydrateReadMarks({
      version: 1,
      marks: { 'agent-dm-fe': { readAt: T0 + 100, inboundAt: T0 + 200 } },
    })
    expect(store.isUnreadSession('agent-dm-fe')).toBe(false)
  })

  it('已删除的会话被剪掉,这份表不会只增不减', () => {
    const marks = parsePersistedReadMarks(
      {
        version: 1,
        marks: {
          'room-1': { readAt: T0, inboundAt: T0 + 1 },
          'gone-1': { readAt: T0, inboundAt: T0 + 1 },
        },
      },
      id => id === 'room-1',
    )
    expect([...marks.keys()]).toEqual(['room-1'])

    const persisted = serializeReadMarks(marks, () => false)
    expect(persisted.marks).toEqual({})
  })

  it('版本不认识 / 时间戳非法 → 当作没有水位(宁可漏报不误报)', () => {
    expect(
      parsePersistedReadMarks(
        { version: 99, marks: {} } as unknown as PersistedSessionReadMarks,
        () => true,
      ).size,
    ).toBe(0)
    const marks = parsePersistedReadMarks(
      {
        version: 1,
        marks: {
          'room-1': { readAt: Number.NaN, inboundAt: -1 } as never,
          'room-2': { readAt: 0, inboundAt: T0 } as never,
        },
      },
      () => true,
    )
    // 全非法 → 空条目被丢掉;部分合法 → 只留合法那一半。
    expect([...marks.keys()]).toEqual(['room-2'])
    expect(marks.get('room-2')).toEqual({ readAt: 0, inboundAt: T0 })
  })
})
