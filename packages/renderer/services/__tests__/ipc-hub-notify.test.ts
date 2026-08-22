// @vitest-environment happy-dom
/**
 * 落库消息 → 系统通知(docs/design/agent-dm-user.md §4.3)。
 *
 * 规则本身在 `notify-inbound.ts` 的单测里钉着;这里钉的是**接线**:hub 有没有
 * 把真的 store 状态喂进那条规则,以及"是不是用户私聊房"读的是不是 store 的
 * selector(而不是在 hub 里自己写一遍 `room.dm`)。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SessionEventCallback = (envelope: {
  sessionId: string
  event: Record<string, unknown>
}) => void

const T0 = 1_700_000_000_000
const DM_ROOM = 'agent-dm-fe'
const GROUP_ROOM = 'room-1'

describe('IPC hub → 私聊系统通知', () => {
  let sessionEventCallback: SessionEventCallback | undefined
  let showNotification: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    setActivePinia(createPinia())
    sessionEventCallback = undefined
    showNotification = vi.fn(async () => ({ success: true }))
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onSessionEvent: vi.fn((callback: SessionEventCallback) => {
          sessionEventCallback = callback
          return vi.fn()
        }),
        onSessionStream: vi.fn(() => vi.fn()),
        saveUIState: vi.fn(async () => ({ success: true })),
        // 设置 store 的 setup 会挂这个监听 —— 通知开关读的是它那份 settings。
        onSystemThemeChanged: vi.fn(() => vi.fn()),
        getSystemTheme: vi.fn(async () => ({ success: true, theme: 'light' })),
        // A1-a:弹通知走宿主壳路由(notifyRouter),桩里这条 dispatcher 是那条通道的替身。
        shellInvoke: vi.fn(async (request: any) => {
          if (request?.domain === 'notify' && request.method === 'show') {
            return { ok: true, data: await (showNotification as (payload: unknown) => Promise<unknown>)(request.payload) }
          }
          return { ok: true, data: { success: true } }
        }),
        notify: {
          onActivate: vi.fn(() => vi.fn()),
        },
      },
    })
  })

  async function boot() {
    const { initializeIPCHub } = await import('../ipc-hub')
    const { useSessionsStore } = await import('@/stores/sessions')
    const { useAgentsStore } = await import('@/stores/agents')
    const sessionsStore = useSessionsStore()
    useAgentsStore().agents.push({ id: 'fe', name: '小李' } as never)
    sessionsStore.sessions.push(
      {
        id: DM_ROOM,
        name: '小李',
        kind: 'room',
        room: { memberAgentIds: ['fe'], dm: true },
        createdAt: T0,
        updatedAt: T0,
      } as never,
      {
        id: GROUP_ROOM,
        name: '官网改版组',
        kind: 'room',
        room: { memberAgentIds: ['fe', 'pm'] },
        createdAt: T0,
        updatedAt: T0,
      } as never,
    )
    sessionsStore.hydrateReadMarks(null)
    // 不在场:窗口在后台 —— 覆盖"失焦"与"开着别的房"里更容易构造的那一种。
    sessionsStore.setWindowFocused(false)
    initializeIPCHub()
    return sessionsStore
  }

  /**
   * 事件经 dynamic import 才落到 store(hub 一贯的解环手法),等模块解析完。
   * 固定拍数不够 —— 首次解析一颗 store 可能跨好几个宏任务,而"提前断言"会把
   * 上一条用例的通知算到下一条头上(实测踩过)。
   */
  async function settle(): Promise<void> {
    for (let i = 0; i < 40; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  }

  function say(sessionId: string, message: Record<string, unknown>) {
    sessionEventCallback?.({
      sessionId,
      event: { type: 'message:user-created', message },
    })
  }

  it('私聊里对方说话且不在场 → 弹,标题是发言人', async () => {
    await boot()
    say(DM_ROOM, { id: 'm1', role: 'assistant', agentId: 'fe', content: '**跑完了**', timestamp: T0 + 1 })
    await settle()

    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification).toHaveBeenCalledWith({
      title: '小李',
      body: '跑完了',
      sessionId: DM_ROOM,
    })
  })

  it('自己说的话不弹', async () => {
    await boot()
    say(DM_ROOM, { id: 'm1', role: 'user', content: '收到', timestamp: T0 + 1 })
    await settle()
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('群聊不弹(P2 的范围只有用户私聊房)', async () => {
    await boot()
    say(GROUP_ROOM, { id: 'm1', role: 'assistant', agentId: 'fe', content: '在的', timestamp: T0 + 1 })
    await settle()
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('窗口回到前台并看着这间房时不弹', async () => {
    const sessionsStore = await boot()
    const { useWorkspaceStore } = await import('@/stores/workspace')
    useWorkspaceStore().openSession(DM_ROOM)
    sessionsStore.setWindowFocused(true)

    say(DM_ROOM, { id: 'm1', role: 'assistant', agentId: 'fe', content: '在的', timestamp: T0 + 1 })
    await settle()
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('连发只响一次(60s 冷却窗)', async () => {
    await boot()
    say(DM_ROOM, { id: 'm1', role: 'assistant', agentId: 'fe', content: '一', timestamp: T0 + 1 })
    await settle()
    say(DM_ROOM, { id: 'm2', role: 'assistant', agentId: 'fe', content: '二', timestamp: T0 + 2 })
    say(DM_ROOM, { id: 'm3', role: 'assistant', agentId: 'fe', content: '三', timestamp: T0 + 3 })
    await settle()
    expect(showNotification).toHaveBeenCalledTimes(1)
  })

  it('设置关掉后不弹', async () => {
    await boot()
    const { useSettingsStore } = await import('@/stores/settings')
    useSettingsStore().settings.general.dmNotifications = false

    say(DM_ROOM, { id: 'm1', role: 'assistant', agentId: 'fe', content: '在的', timestamp: T0 + 1 })
    await settle()
    expect(showNotification).not.toHaveBeenCalled()
  })
})
