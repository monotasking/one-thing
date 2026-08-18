// @vitest-environment happy-dom
/**
 * P1 通知面收敛(docs/design/context-compact-fix-2026-08.md §4)。
 *
 * 压缩的开始/结束通知从此只有一条正路:session:event 信封里的
 * context:compact-started / -completed。这里钉的是那条路**真的接上了 UI 状态**
 * —— 从前专用 IPC 通道主进程从没发过、web 端靠嗅探消息内容,而 renderer 里
 * 一个消费者都没有。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SessionEventCallback = (envelope: {
  sessionId: string
  event: Record<string, unknown>
}) => void

describe('IPC hub → compactingSessions', () => {
  let sessionEventCallback: SessionEventCallback | undefined

  beforeEach(() => {
    vi.resetModules()
    setActivePinia(createPinia())
    sessionEventCallback = undefined
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onSessionEvent: vi.fn((callback: SessionEventCallback) => {
          sessionEventCallback = callback
          return vi.fn()
        }),
        onSessionStream: vi.fn(() => vi.fn()),
        saveUIState: vi.fn(async () => ({ success: true })),
      },
    })
  })

  async function boot() {
    const { initializeIPCHub } = await import('../ipc-hub')
    const { useChatStore } = await import('@/stores/chat')
    initializeIPCHub()
    return useChatStore()
  }

  it('started 置位、completed 清位', async () => {
    const chatStore = await boot()

    expect(chatStore.isSessionCompacting('s1')).toBe(false)

    sessionEventCallback?.({
      sessionId: 's1',
      event: { type: 'context:compact-started', requestId: 'req-1' },
    })
    expect(chatStore.isSessionCompacting('s1')).toBe(true)
    // per-session:别的会话不受影响。
    expect(chatStore.isSessionCompacting('s2')).toBe(false)

    sessionEventCallback?.({
      sessionId: 's1',
      event: { type: 'context:compact-completed', requestId: 'req-1', success: true },
    })
    expect(chatStore.isSessionCompacting('s1')).toBe(false)
  })

  it('失败的 completed 同样清位', async () => {
    const chatStore = await boot()

    sessionEventCallback?.({ sessionId: 's1', event: { type: 'context:compact-started' } })
    sessionEventCallback?.({
      sessionId: 's1',
      event: { type: 'context:compact-completed', success: false, error: 'too large' },
    })

    expect(chatStore.isSessionCompacting('s1')).toBe(false)
  })

  it('C6:progress 写进 compactProgress;started 清零、completed 清除', async () => {
    const chatStore = await boot()

    sessionEventCallback?.({ sessionId: 's1', event: { type: 'context:compact-started' } })
    expect(chatStore.getSessionCompactProgress('s1')).toBeNull()

    sessionEventCallback?.({
      sessionId: 's1',
      event: { type: 'context:compact-progress', chunk: 2, totalChunks: 5 },
    })
    expect(chatStore.getSessionCompactProgress('s1')).toEqual({ chunk: 2, totalChunks: 5 })
    // per-session:别的会话不受影响。
    expect(chatStore.getSessionCompactProgress('s2')).toBeNull()

    // 新一轮开始 → 上一轮的 2/5 不该留在状态条上。
    sessionEventCallback?.({ sessionId: 's1', event: { type: 'context:compact-started' } })
    expect(chatStore.getSessionCompactProgress('s1')).toBeNull()

    sessionEventCallback?.({
      sessionId: 's1',
      event: { type: 'context:compact-progress', chunk: 1, totalChunks: 3 },
    })
    sessionEventCallback?.({
      sessionId: 's1',
      event: { type: 'context:compact-completed', success: true },
    })
    expect(chatStore.getSessionCompactProgress('s1')).toBeNull()
    expect(chatStore.isSessionCompacting('s1')).toBe(false)
  })

  it('stream:error 不清这个位 —— 压缩是会话级后台作业,和某条流的死活无关', async () => {
    const chatStore = await boot()

    sessionEventCallback?.({ sessionId: 's1', event: { type: 'context:compact-started' } })
    sessionEventCallback?.({
      sessionId: 's1',
      event: { type: 'stream:error', data: { error: 'boom' } },
    })

    expect(chatStore.isSessionCompacting('s1')).toBe(true)
  })
})
